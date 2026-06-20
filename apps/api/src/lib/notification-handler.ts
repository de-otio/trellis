/**
 * Notification Handler
 *
 * Manages notification creation, retrieval, and read status.
 * Respects user preferences and quiet hours.
 * SAFETY_ALERT and PARENTAL_LINK notifications always bypass preferences and quiet hours.
 * Part of Stream C: Notifications.
 */

import type { Env } from "../env.js";
import type { Session } from "./session-cookie.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { NotificationType, AgeTier } from "@prisma/client";
import { createPrisma } from "../db.js";
import { getLogger, Logger } from "./logger.js";
import { CalmDeliveryResolver } from "./realtime/index.js";
import { PushNotifier } from "./realtime/push-notifier.js";
import {
  PrismaBlockStore,
  type BlockStore,
} from "./realtime/block-store.js";
import type {
  DeliveryContext,
  DeliveryPolicyResolver,
  QuietHoursConfig,
} from "./realtime/index.js";

export interface NotificationListResponse {
  notifications: Array<{
    id: string;
    type: NotificationType;
    title: string;
    body: string;
    data: any;
    read: boolean;
    createdAt: string;
  }>;
  cursor?: string;
  hasMore: boolean;
}

/**
 * Notification types that always bypass preferences and quiet hours.
 * Kept here for the preference-gate short-circuit (preference-off => no row),
 * which is a DIFFERENT outcome from quiet-hours suppression. The deliver-time
 * decision (deliveredAt) is owned by the shared `DeliveryPolicyResolver` (WS1
 * `CalmDeliveryResolver`), which also carries the ALWAYS_DELIVER bypass.
 */
const ALWAYS_DELIVER_TYPES: NotificationType[] = [
  "SAFETY_ALERT",
  "PARENTAL_LINK",
];

/**
 * Recipient row shape the delivery decision needs. Extends the quiet-hours
 * fields WS1 read with the recipient `ageTier` (minor-protection floor input).
 */
interface RecipientRow {
  quietHoursEnabled: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  ageTier: AgeTier;
}

/**
 * Extract a candidate sender id from a notification's `data` payload, for the
 * blocked-sender floor input (`DeliveryContext.senderUserId`). Notification
 * producers conventionally stamp the actor under one of these keys; we read it
 * defensively (the payload is untyped JSON) and return `undefined` when absent
 * or non-string. This NEVER trusts the value as a security boundary — it is
 * only an input to the floor's blocked-sender check.
 */
function extractSenderUserId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const obj = data as Record<string, unknown>;
  for (const key of ["senderUserId", "senderId", "actorId", "fromUserId"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Build the realtime `DeliveryContext` from the recipient row.
 *
 * The resolver's quiet-hours window uses `QuietHoursConfig.start/end` as
 * decimal strings of minutes-since-midnight — the exact units the existing
 * `User.quietHoursStart/End` integers use — and reads the current minute from
 * `ctx.now`, so the decision is identical to the legacy inline check while
 * remaining deterministic.
 *
 * Track D enriches the context with `recipientAgeTier` (minor-protection floor)
 * and `senderUserId` (blocked-sender floor) so the non-configurable floor in
 * `CalmDeliveryResolver` has the inputs it needs. The resolver is pure/sync, so
 * the async block-set lookup happens in the caller: `blockedSenderUserId` is the
 * sender id ONLY when the recipient has blocked that sender (else undefined),
 * matching the resolver's "presence of senderUserId == in the block set"
 * contract. For ALWAYS_DELIVER types the recipient row is not fetched (the
 * bypass short-circuits before the user lookup), so `user` is null and the
 * enrichment fields are omitted — those types bypass the floor regardless.
 */
function buildDeliveryContext(
  type: NotificationType,
  recipientUserId: string,
  tenantId: string,
  now: Date,
  user: RecipientRow | null,
  blockedSenderUserId: string | undefined,
): DeliveryContext {
  let quietHours: QuietHoursConfig | null = null;
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
  if (blockedSenderUserId !== undefined)
    ctx.senderUserId = blockedSenderUserId;
  return ctx;
}

export class NotificationHandler {
  // The delivery floor is migrated into this shared resolver (WS1). The SAME
  // decision drives both the persistence `deliveredAt` choice and the
  // (default-off) push hand-off, so polling and pushing can never diverge.
  // Injectable so tests can exercise floor outcomes (blocked_sender, etc.)
  // without reaching into WS1-owned floor logic; defaults to the WS1 floor.
  // Injected resolver (tests) or null => build the default from env so the
  // re-engagement denylist (runtime config) reaches the floor. The SAME
  // decision drives both the persistence `deliveredAt`/drop choice and the
  // (default-off) push hand-off, so polling and pushing can never diverge.
  private readonly injectedResolver: DeliveryPolicyResolver | null;
  // Block-set port for the blocked-sender floor. Injectable so tests exercise
  // the drop without a live DB; defaults to a Prisma-backed store bound to the
  // per-call client. `null` = resolve from env's db (the production path).
  private readonly blockStore: BlockStore | null;

  constructor(
    deliveryResolver: DeliveryPolicyResolver | null = null,
    blockStore: BlockStore | null = null,
  ) {
    this.injectedResolver = deliveryResolver;
    this.blockStore = blockStore;
  }

  /**
   * The resolver for this call: the injected one (tests) or a default built
   * from env's runtime re-engagement denylist (threshold-secrecy: the denylist
   * is env-driven config, never a compiled-in constant).
   */
  private resolverFor(env: Env): DeliveryPolicyResolver {
    if (this.injectedResolver) return this.injectedResolver;
    return new CalmDeliveryResolver({
      reengagementTypes: env.REALTIME_REENGAGEMENT_TYPES,
    });
  }

  /**
   * Create a notification for a user.
   * Checks preferences (unless SAFETY_ALERT or PARENTAL_LINK) and quiet hours.
   */
  async createNotification(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data: any,
    env: Env,
    tenantId: string,
  ): Promise<{ id: string }> {
    const logger = getLogger();
    const db = createPrisma(env);

    try {
      const bypassPreferences = ALWAYS_DELIVER_TYPES.includes(type);

      // 1. Check user's NotificationPreference (skip for SAFETY_ALERT and PARENTAL_LINK)
      if (!bypassPreferences) {
        const prefs = await db.notificationPreference.findUnique({
          where: { userId },
        });

        if (prefs) {
          // 2. Check type-specific preference
          const enabled = this.isTypeEnabled(type, prefs);
          if (!enabled) {
            logger.info("Notification skipped due to preferences", {
              userId,
              type,
            });
            return { id: "" };
          }
        }
      }

      // 3. Resolve the delivery decision (quiet hours + ALWAYS_DELIVER bypass)
      //    via the shared policy resolver. Capture `now` once so the context
      //    clock and the persisted deliveredAt agree.
      const now = new Date();
      const user = bypassPreferences
        ? null
        : await db.user.findUnique({
            where: { id: userId },
            select: {
              quietHoursEnabled: true,
              quietHoursStart: true,
              quietHoursEnd: true,
              ageTier: true,
            },
          });

      // Enrich the floor inputs (Track D): blocked-sender comes from the
      // notification payload's actor stamp, resolved against the block set;
      // minor-protection comes from the recipient's ageTier loaded above.
      // ALWAYS_DELIVER types bypass the floor, so we skip the block lookup for
      // them (no row was fetched and the resolver short-circuits anyway).
      const candidateSenderUserId = extractSenderUserId(data);
      let blockedSenderUserId: string | undefined;
      if (!bypassPreferences && candidateSenderUserId !== undefined) {
        const blockStore = this.blockStore ?? new PrismaBlockStore(db);
        // The recipient (userId) is the blocker; the notification's sender is
        // the blocked candidate. Presence in the set => pass the id to the
        // resolver as the deny signal.
        const blocked = await blockStore.isBlocked(
          tenantId,
          userId,
          candidateSenderUserId,
        );
        if (blocked) blockedSenderUserId = candidateSenderUserId;
      }
      const deliveryContext = buildDeliveryContext(
        type,
        userId,
        tenantId,
        now,
        user,
        blockedSenderUserId,
      );
      const decision = this.resolverFor(env).decide(deliveryContext);

      // 4. Floor DROP vs DEFERRAL. A floor drop (blocked_sender / minor-floor)
      //    is a hard suppression — no row at all (same observable as a
      //    preference-off skip: `{ id: "" }`), so the dropped notification can
      //    never be read back via polling. A quiet-hours deferral keeps the row
      //    with deliveredAt=null (delivered on a later poll). This single
      //    decision also gates the push hand-off below, so polling and pushing
      //    can never diverge.
      if (
        !decision.deliver &&
        (decision.reason === "blocked_sender" || decision.reason === "floor")
      ) {
        logger.info("Notification dropped by delivery floor", {
          userId,
          type,
          reason: decision.reason,
        });
        return { id: "" };
      }

      // deliveredAt: now when the resolver says deliver, null when deferred
      // (quiet hours). ALWAYS_DELIVER types resolve to deliver => now.
      const deliveredAt: Date | null = decision.deliver ? now : null;

      // 5. Create notification
      const notification = await db.notification.create({
        data: {
          userId,
          type,
          title,
          body,
          data: data ?? undefined,
          deliveredAt,
          tenantId,
        },
      });

      // 6. Content-free push hand-off (default OFF — gated by
      //    features.realtimePush; WS4 owns this). Best-effort and non-fatal: a
      //    transport failure never blocks or rolls back persistence (polling
      //    still delivers on the next poll). We gate here on the SAME decision
      //    that set deliveredAt, so polling and pushing can never diverge; the
      //    policy fence ALSO re-runs inside the transport's deliver().
      //    ALWAYS_DELIVER types route to the floor "safety" channel; everything
      //    else to "wakeup". The payload is content-free by construction — it is
      //    built only via encodeWakeup() inside PushNotifier, so no title/body/
      //    data can ever reach the wire.
      if (env.features?.realtimePush && decision.deliver) {
        const kind = bypassPreferences ? "safety" : "wakeup";
        const pushNotifier = new PushNotifier(env.realtimeTransport, logger);
        await pushNotifier.notify({ target: { userId, tenantId }, kind });
      }

      return { id: notification.id };
    } catch (error) {
      logger.error("Error creating notification:", error);
      throw error;
    } finally {
      await db.release();
    }
  }

  /**
   * Get paginated notifications for a user.
   */
  async getNotifications(
    userId: string,
    cursor: string | null,
    limit: number,
    env: Env,
    tenantId: string,
  ): Promise<NotificationListResponse> {
    const db = createPrisma(env);

    try {
      const safeLimit = Math.min(Math.max(limit, 1), 50);

      const notifications = await db.notification.findMany({
        where: {
          userId,
          tenantId,
          ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: safeLimit + 1,
      });

      const hasMore = notifications.length > safeLimit;
      const items = notifications.slice(0, safeLimit);

      return {
        notifications: items.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          data: n.data,
          read: n.read,
          createdAt: n.createdAt.toISOString(),
        })),
        cursor: hasMore
          ? items[items.length - 1].createdAt.toISOString()
          : undefined,
        hasMore,
      };
    } finally {
      await db.release();
    }
  }

  /**
   * Mark a single notification as read. Verifies it belongs to the user.
   */
  async markRead(
    userId: string,
    notificationId: string,
    env: Env,
    tenantId: string,
  ): Promise<void> {
    const db = createPrisma(env);

    try {
      const notification = await db.notification.findFirst({
        where: { id: notificationId, userId, tenantId },
      });

      if (!notification) {
        throw new NotificationNotFoundError(notificationId);
      }

      await db.notification.update({
        where: { id: notificationId },
        data: { read: true },
      });
    } finally {
      await db.release();
    }
  }

  /**
   * Mark all unread notifications as read for a user.
   */
  async markAllRead(userId: string, env: Env, tenantId: string): Promise<void> {
    const db = createPrisma(env);

    try {
      await db.notification.updateMany({
        where: { userId, tenantId, read: false },
        data: { read: true },
      });
    } finally {
      await db.release();
    }
  }

  /**
   * Get unread notification count.
   * CHILD/TEEN: return { hasUnread: boolean } only (no exact count).
   * ADULT: return { hasUnread: boolean, count: number }.
   */
  async getUnreadCount(
    userId: string,
    ageTier: string,
    env: Env,
    tenantId: string,
  ): Promise<{ hasUnread: boolean; count?: number }> {
    const db = createPrisma(env);

    try {
      if (ageTier === "CHILD" || ageTier === "TEEN") {
        // For minors, only check existence (no exact count)
        const first = await db.notification.findFirst({
          where: { userId, tenantId, read: false },
          select: { id: true },
        });
        return { hasUnread: !!first };
      }

      // ADULT: return exact count
      const count = await db.notification.count({
        where: { userId, tenantId, read: false },
      });

      return { hasUnread: count > 0, count };
    } finally {
      await db.release();
    }
  }

  /**
   * Check whether a notification type is enabled in preferences.
   */
  private isTypeEnabled(
    type: NotificationType,
    prefs: {
      dmEnabled: boolean;
      followEnabled: boolean;
      digestEnabled: boolean;
      systemEnabled: boolean;
      relationshipEnabled: boolean;
    },
  ): boolean {
    switch (type) {
      case "DIRECT_MESSAGE":
        return prefs.dmEnabled;
      case "FOLLOW":
        return prefs.followEnabled;
      case "SENTIMENT_DIGEST":
        return prefs.digestEnabled;
      case "SYSTEM":
        return prefs.systemEnabled;
      case "RELATIONSHIP_CREATED":
      case "RELATIONSHIP_RECIPROCATED":
      case "TIER_CHANGED":
      case "ENTITY_RELATIONSHIP_PROPOSED":
      case "ENTITY_RELATIONSHIP_CONFIRMED":
      case "CONNECTION_CODE_REDEEMED":
        return prefs.relationshipEnabled;
      // SAFETY_ALERT and PARENTAL_LINK are handled before this check
      default:
        return true;
    }
  }
  // NOTE: the quiet-hours window check formerly inlined here now lives in the
  // shared `CalmDeliveryResolver` (realtime/delivery-policy.ts), driven from
  // `buildDeliveryContext` above. The golden test
  // (test/unit/notification-floor.golden.test.ts) pins byte-identical behavior.
}

export class NotificationNotFoundError extends Error {
  constructor(notificationId: string) {
    super(`Notification ${notificationId} not found`);
    this.name = "NotificationNotFoundError";
  }
}
