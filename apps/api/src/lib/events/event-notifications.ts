/**
 * Events primitive — NotificationProducer implementation (R1, P1-E).
 *
 * Fans EVENT_UPDATED / EVENT_CANCELLED out to an event's CURRENT GOING
 * attendees. Imitates the direct `db.notification.create` pattern in
 * `age-tier-transition.ts` (rather than routing through `NotificationHandler`,
 * whose `createNotification` has no `batchId` parameter and whose
 * `isTypeEnabled` does not yet cover `EVENT_*` — see the Phase-0 handoff note
 * in seams.ts / the plan). The quiet-hours + minor-protection floor is reused
 * from the SAME shared `CalmDeliveryResolver` `NotificationHandler` uses, so
 * the delivery decision stays byte-identical across the codebase.
 *
 * - Preference gate: `NotificationPreference.eventEnabled` (default true when
 *   no row exists, matching `NotificationHandler`'s "no row => allow" rule).
 * - Delivery gate: `CalmDeliveryResolver` (quiet hours + minor-protection
 *   floor); a `deliver:false` "floor"/"blocked_sender" result also suppresses
 *   the row entirely (blocked-sender never applies here — there is no actor
 *   to block — but the floor is still evaluated for parity with the shared
 *   resolver contract).
 * - Batching: every notification created in one fan-out round shares a
 *   `batchId` of the form `evt-<updated|cancelled>-<eventId>-<epochMs>`. The
 *   SAME prefix (`evt-<kind>-<eventId>-`) is how the per-event debounce below
 *   finds the most recent round without a new schema column.
 * - Debounce (SEC-5/SEC-9): before fanning out, look up the most recent
 *   notification whose `batchId` starts with this event+kind's prefix; if it
 *   is younger than `env.event.updateNotifyCooldownSeconds`, suppress the
 *   whole round.
 * - Bounded fan-out (Infinite Loop Prevention house rule): attendees are
 *   paged in fixed-size pages with a hard page-count ceiling, so an
 *   unlimited-capacity event can never drive an unbounded query loop.
 * - Best-effort: every public method swallows its own errors (logged) so a
 *   notification failure never propagates into the event-update/cancel path.
 *
 * Design: plans/events-primitive/README.md §4.6 (HIGH-1, SEC-5, SEC-9), §5.
 */

import type { NotificationType, Prisma } from "@prisma/client";
import type { Env } from "../../env.js";
import { createPrisma } from "../../db.js";
import { getLogger } from "../logger.js";
import {
  CalmDeliveryResolver,
  type DeliveryContext,
  type DeliveryPolicyResolver,
} from "../realtime/index.js";
import type {
  EventNotificationContext,
  EventUpdatedNotification,
  NotificationProducer,
} from "./seams.js";

/**
 * Hard ceiling on attendees notified per fan-out round, and the page size used
 * to get there. Not env-driven (no dedicated threshold was added to the
 * Phase-0 `event` config seam for this) — a local, generous safety bound, per
 * the "Infinite Loop Prevention" house rule (max iteration count + circuit
 * breaker), not a tunable operational parameter.
 */
const FANOUT_PAGE_SIZE = 100;
const MAX_FANOUT_PAGES = 10;
const MAX_FANOUT_RECIPIENTS = FANOUT_PAGE_SIZE * MAX_FANOUT_PAGES;

type EventNotificationKind = "updated" | "cancelled";

function batchPrefix(kind: EventNotificationKind, eventId: string): string {
  return `evt-${kind}-${eventId}-`;
}

interface NotificationCopy {
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, unknown>;
}

/** Pure copy builder for EVENT_UPDATED (readable field names, no PII). */
function buildUpdatedCopy(input: EventUpdatedNotification): NotificationCopy {
  const changed = describeChangedFields(input.changedFields);
  return {
    title: `Event updated: ${input.title}`,
    body: `${changed} for "${input.title}" — check the event for details.`,
    data: {
      eventId: input.eventId,
      startsAt: input.startsAt,
      changedFields: input.changedFields,
    },
  };
}

/** Pure copy builder for EVENT_CANCELLED. */
function buildCancelledCopy(
  input: EventNotificationContext,
): NotificationCopy {
  return {
    title: `Event cancelled: ${input.title}`,
    body: `"${input.title}" has been cancelled.`,
    data: {
      eventId: input.eventId,
      startsAt: input.startsAt,
    },
  };
}

const CHANGED_FIELD_LABELS: Record<
  EventUpdatedNotification["changedFields"][number],
  string
> = {
  startsAt: "the start time",
  endsAt: "the end time",
  location: "the location",
};

function describeChangedFields(
  changedFields: EventUpdatedNotification["changedFields"],
): string {
  const labels = changedFields.map((field) => CHANGED_FIELD_LABELS[field]);
  if (labels.length === 0) return "Details changed";
  if (labels.length === 1) return `${capitalize(labels[0])} changed`;
  return `${capitalize(labels.slice(0, -1).join(", "))} and ${labels[labels.length - 1]} changed`;
}

/** `labels` from `describeChangedFields` are always non-empty string literals. */
function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

/**
 * Minimal shape queried per recipient for the delivery-floor decision. Mirrors
 * `notification-handler.ts`'s `RecipientRow`.
 */
interface RecipientRow {
  quietHoursEnabled: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  ageTier: "CHILD" | "TEEN" | "ADULT";
}

export class EventNotificationProducer implements NotificationProducer {
  /** Injectable for tests; defaults to the shared floor built from env. */
  private readonly injectedResolver: DeliveryPolicyResolver | null;
  /** Injectable clock so debounce tests are deterministic. */
  private readonly now: () => Date;

  constructor(
    deliveryResolver: DeliveryPolicyResolver | null = null,
    now: () => Date = () => new Date(),
  ) {
    this.injectedResolver = deliveryResolver;
    this.now = now;
  }

  private resolverFor(env: Env): DeliveryPolicyResolver {
    if (this.injectedResolver) return this.injectedResolver;
    return new CalmDeliveryResolver({
      reengagementTypes: env.REALTIME_REENGAGEMENT_TYPES,
    });
  }

  async notifyEventUpdated(
    input: EventUpdatedNotification,
    env: Env,
  ): Promise<void> {
    await this.fanOut("EVENT_UPDATED", "updated", input, env, buildUpdatedCopy(input));
  }

  async notifyEventCancelled(
    input: EventNotificationContext,
    env: Env,
  ): Promise<void> {
    await this.fanOut(
      "EVENT_CANCELLED",
      "cancelled",
      input,
      env,
      buildCancelledCopy(input),
    );
  }

  /**
   * Shared fan-out: debounce check -> page GOING attendees (bounded) ->
   * per-recipient preference + delivery-floor gate -> create. Best-effort:
   * catches and logs, never throws (contract in seams.ts).
   */
  private async fanOut(
    type: NotificationType,
    kind: EventNotificationKind,
    input: EventNotificationContext,
    env: Env,
    copy: NotificationCopy,
  ): Promise<void> {
    const logger = getLogger();
    const db = createPrisma(env);
    const prefix = batchPrefix(kind, input.eventId);

    try {
      const now = this.now();
      const cooldownMs = Math.max(0, env.event.updateNotifyCooldownSeconds) * 1000;

      if (cooldownMs > 0) {
        const lastRound = await db.notification.findFirst({
          where: { type, batchId: { startsWith: prefix } },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        if (lastRound && now.getTime() - lastRound.createdAt.getTime() < cooldownMs) {
          logger.info("Event notification round suppressed by debounce", {
            eventId: input.eventId,
            tenantId: input.tenantId,
            type,
          });
          return;
        }
      }

      const batchId = `${prefix}${now.getTime()}`;
      const resolver = this.resolverFor(env);

      let cursor: string | undefined;
      let notified = 0;

      // Page bound (MAX_FANOUT_PAGES) x page size (FANOUT_PAGE_SIZE) is exactly
      // MAX_FANOUT_RECIPIENTS, so the for-loop's own bound is the circuit
      // breaker — no separate mid-loop check can ever fire before it.
      for (let page = 0; page < MAX_FANOUT_PAGES; page++) {
        const rsvps = await db.rsvp.findMany({
          where: {
            eventId: input.eventId,
            tenantId: input.tenantId,
            status: "GOING",
          },
          select: { id: true, userId: true },
          orderBy: { id: "asc" },
          take: FANOUT_PAGE_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });

        if (rsvps.length === 0) break;

        for (const rsvp of rsvps) {
          try {
            await this.notifyOne(db, resolver, type, rsvp.userId, input, copy, batchId, now);
          } catch (err) {
            logger.error("Failed to notify event attendee", {
              eventId: input.eventId,
              userId: rsvp.userId,
              type,
              error: err,
            });
          }
        }
        notified += rsvps.length;

        cursor = rsvps[rsvps.length - 1].id;
        if (rsvps.length < FANOUT_PAGE_SIZE) break;
      }

      if (notified >= MAX_FANOUT_RECIPIENTS) {
        logger.info("Event notification fan-out hit the bound; remaining GOING attendees not notified this round", {
          eventId: input.eventId,
          type,
          bound: MAX_FANOUT_RECIPIENTS,
        });
      }
    } catch (error) {
      logger.error("Event notification fan-out failed", {
        eventId: input.eventId,
        tenantId: input.tenantId,
        type,
        error,
      });
      // Best-effort: MUST NOT throw into the event-update/cancel path.
    } finally {
      await db.release();
    }
  }

  /**
   * Gate + create for exactly one recipient: preference (eventEnabled) first
   * (preference-off => no row at all, matching `NotificationHandler`), then
   * the shared delivery-floor resolver (quiet hours => row with
   * `deliveredAt: null`; a hard floor drop => no row).
   */
  private async notifyOne(
    db: ReturnType<typeof createPrisma>,
    resolver: DeliveryPolicyResolver,
    type: NotificationType,
    userId: string,
    input: EventNotificationContext,
    copy: NotificationCopy,
    batchId: string,
    now: Date,
  ): Promise<void> {
    const prefs = await db.notificationPreference.findUnique({
      where: { userId },
    });
    if (prefs && !prefs.eventEnabled) {
      return;
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        quietHoursEnabled: true,
        quietHoursStart: true,
        quietHoursEnd: true,
        ageTier: true,
      },
    });

    const deliveryContext = buildDeliveryContext(type, userId, input.tenantId, now, user);
    const decision = resolver.decide(deliveryContext);

    if (!decision.deliver && (decision.reason === "blocked_sender" || decision.reason === "floor")) {
      return;
    }

    const deliveredAt: Date | null = decision.deliver ? now : null;

    await db.notification.create({
      data: {
        userId,
        tenantId: input.tenantId,
        type,
        title: copy.title,
        body: copy.body,
        data: copy.data as Prisma.InputJsonValue,
        deliveredAt,
        batchId,
      },
    });
  }
}

/** Mirrors `notification-handler.ts`'s `buildDeliveryContext` (no sender/blocking here). */
function buildDeliveryContext(
  type: NotificationType,
  recipientUserId: string,
  tenantId: string,
  now: Date,
  user: RecipientRow | null,
): DeliveryContext {
  let quietHours: DeliveryContext["quietHours"] = null;
  if (
    user?.quietHoursEnabled &&
    user.quietHoursStart != null &&
    user.quietHoursEnd != null
  ) {
    quietHours = {
      enabled: true,
      start: String(user.quietHoursStart),
      end: String(user.quietHoursEnd),
    };
  }
  const ctx: DeliveryContext = {
    type,
    recipientUserId,
    tenantId,
    now,
    quietHours,
  };
  if (user) ctx.recipientAgeTier = user.ageTier;
  return ctx;
}
