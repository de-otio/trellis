// CONTRACT: stable — coordinate changes. See types.ts banner.
//
// The DeliveryPolicyResolver port and the CalmDeliveryResolver default. Per §3
// of the frozen contract, WS1 (not WS4) owns migrating the existing hardcoded
// notification floor into CalmDeliveryResolver, under a golden test that pins
// byte-identical behavior. The same resolver decision drives BOTH the
// persistence `deliveredAt` choice AND the (default-off) push hand-off.

import type {
  DeliveryContext,
  DeliveryDecision,
  DeliveryPolicyResolver,
} from "./types.js";
import type { NotificationType } from "@prisma/client";

/**
 * Notification types that ALWAYS deliver — they bypass user preference and
 * quiet hours. Migrated verbatim from `notification-handler.ts`'s
 * `ALWAYS_DELIVER_TYPES`. This is the critical-always floor.
 */
export const ALWAYS_DELIVER_TYPES: ReadonlySet<NotificationType> = new Set<
  NotificationType
>(["SAFETY_ALERT", "PARENTAL_LINK"]);

/**
 * Reproduce the existing `notification-handler.ts` quiet-hours check exactly.
 *
 * The core encodes `User.quietHoursStart/End` (minutes-since-midnight integers)
 * as decimal strings in `QuietHoursConfig.start/end`, and derives the current
 * minute from `ctx.now` (rather than an ambient `new Date()`), so the decision
 * is deterministic. The wrap-around / same-day arithmetic mirrors
 * `NotificationHandler.isInQuietHours`.
 */
function isInQuietHours(
  quietHours: DeliveryContext["quietHours"],
  now: Date,
): boolean {
  if (!quietHours || !quietHours.enabled) return false;
  const start = Number.parseInt(quietHours.start, 10);
  const end = Number.parseInt(quietHours.end, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;

  const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();

  // Overnight window (e.g. 22:00 -> 07:00).
  if (start > end) {
    return minutesSinceMidnight >= start || minutesSinceMidnight < end;
  }
  // Same-day window (e.g. 13:00 -> 15:00).
  return minutesSinceMidnight >= start && minutesSinceMidnight < end;
}

/**
 * Track D runtime config for the floor. The minor-protection rule needs the set
 * of "manipulative re-engagement" NotificationTypes to deny to non-adults. Per
 * the threshold-secrecy invariant (CLAUDE.md rule 8) this list is RUNTIME CONFIG
 * — passed in here, never a compiled-in constant sprinkled at a call site.
 * v1 ships it EMPTY (no such type exists yet); a deployment populates it via env.
 */
export interface DeliveryFloorConfig {
  /** NotificationTypes that re-engage and are denied to non-adult recipients. */
  reengagementTypes?: ReadonlySet<NotificationType>;
}

/**
 * The WS1 + Track D default resolver. Pure and synchronous over `DeliveryContext`
 * (the caller does any async lookups and passes resolved signals in):
 *
 *  1. ALWAYS_DELIVER_TYPES (SAFETY_ALERT, PARENTAL_LINK) bypass everything ->
 *     `{ deliver: true }`. Safety must NOT be over-blocked: this wins over the
 *     blocked-sender and minor-protection floor below.
 *  2. Non-configurable FLOOR (checked only when the caller supplies the input):
 *       - blocked sender: the caller resolves block-set membership async (via
 *         BlockStore) and populates `ctx.senderUserId` ONLY when the sender is
 *         blocked — so presence of `senderUserId` == "in the recipient's block
 *         set". The decision is a hard drop no preference can override.
 *       - minor-protection: a non-adult recipient (`recipientAgeTier` CHILD/TEEN)
 *         targeted by a configured re-engagement type is dropped.
 *  3. Else honor preference (caller pre-resolves `deliver:false`/`preference`)
 *     and quiet hours.
 *
 * Note on preference: in the existing handler the type-preference check happens
 * BEFORE creating the row (preference-off => no row at all), which is a
 * different outcome from quiet-hours (row created with deliveredAt=null). The
 * caller maps the decision reasons accordingly. To keep the resolver pure and
 * total it accepts the preference outcome via `ctx` indirectly: the caller only
 * invokes the resolver's quiet-hours path once preference has passed. For a
 * single source of truth the resolver still exposes the full decision so a
 * push-only caller (WS4) can gate solely on it.
 */
export class CalmDeliveryResolver implements DeliveryPolicyResolver {
  private readonly reengagementTypes: ReadonlySet<NotificationType>;

  constructor(config: DeliveryFloorConfig = {}) {
    this.reengagementTypes =
      config.reengagementTypes ?? new Set<NotificationType>();
  }

  decide(ctx: DeliveryContext): DeliveryDecision {
    // 1. Critical-always bypass — wins over the floor so safety is never
    //    over-blocked (a blocked sender or a minor still gets SAFETY_ALERT /
    //    PARENTAL_LINK).
    if (ALWAYS_DELIVER_TYPES.has(ctx.type)) {
      return { deliver: true };
    }

    // 2. Non-configurable floor.
    //    2a. Blocked sender. The caller has already resolved block-set
    //        membership and only sets `senderUserId` when the sender IS blocked,
    //        so its presence is the deny signal. Hard drop, no override.
    if (ctx.senderUserId !== undefined) {
      return { deliver: false, reason: "blocked_sender" };
    }
    //    2b. Minor protection. A non-adult recipient targeted by a configured
    //        manipulative re-engagement type is dropped (FLOOR, not preference).
    if (
      ctx.recipientAgeTier !== undefined &&
      ctx.recipientAgeTier !== "ADULT" &&
      this.reengagementTypes.has(ctx.type)
    ) {
      return { deliver: false, reason: "floor" };
    }

    // 3. Quiet hours (preference is handled by the caller; see class doc).
    if (isInQuietHours(ctx.quietHours, ctx.now)) {
      return { deliver: false, reason: "quiet_hours" };
    }

    return { deliver: true };
  }
}
