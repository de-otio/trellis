// WS4 — content-free push consumer.
//
// PushNotifier is the ONE place that turns a "deliver" decision into a wire
// wakeup. It exists so `notification-handler.ts` stays slim and so the
// content-free guarantee is structural, not a per-call-site discipline:
//
//   1. The payload is built ONLY via `encodeWakeup()` (the frozen WS1 envelope).
//      WS4 is FORBIDDEN by the contract from constructing arbitrary Uint8Array
//      for wakeup/setting_sync/safety kinds — there is no code path here that
//      can put a title/body/data on the wire (types.ts §2.4).
//   2. The channel is built ONLY via `channelFor()` — tenant- and user-scoped,
//      server-resolved, never client-asserted.
//   3. `transport.deliver()` is BEST-EFFORT: a transport throw is caught and
//      logged, NEVER rethrown, so it can never roll back the already-persisted
//      Notification row. Polling remains the floor.
//
// The policy fence (CalmDeliveryResolver floor) runs in TWO places by design:
// the caller gates on its decision (so a deferred/blocked/preference-off
// notification never reaches here), AND the transport re-runs the fence inside
// `deliver()`. PushNotifier itself does not re-decide — it relays the decision
// the caller already made onto the correct channel kind.

import type { Logger } from "../logger.js";
import { channelFor } from "./channel.js";
import { encodeWakeup } from "./types.js";
import type { ChannelKind, RealtimeTransport, WakeupEnvelope } from "./types.js";

/** The kinds WS4 routes a content-free notification wakeup onto. */
export type WakeupKind = Extract<ChannelKind, "wakeup" | "safety">;

export interface PushNotifierInput {
  /** Server-resolved recipient. */
  target: { userId: string; tenantId: string };
  /**
   * Channel kind: ALWAYS_DELIVER notifications route to "safety" (the floor
   * channel), everything else to "wakeup". Constrained to the two content-free
   * kinds WS4 owns — there is no overload that accepts "message"/"thread".
   */
  kind: WakeupKind;
}

/**
 * Build the content-free wakeup payload for a notification. The envelope is the
 * frozen WS1 `WakeupEnvelope` and carries NO notification content — only the
 * envelope version and the channel kind. There is deliberately no `changeToken`
 * for notification wakeups (that field is the setting_sync version pointer); a
 * notification wakeup says only "something changed on this surface; refetch".
 */
export function buildNotificationWakeup(kind: WakeupKind): Uint8Array {
  const envelope: WakeupEnvelope = { v: 1, kind };
  return encodeWakeup(envelope);
}

/**
 * Relay a content-free wakeup over the realtime transport, best-effort.
 *
 * Resolves to `true` if the transport reported a delivery, `false` otherwise
 * (policy-denied, no transport, transport error, or a thrown transport). NEVER
 * throws — the caller's persisted write is durable regardless.
 */
export class PushNotifier {
  constructor(
    private readonly transport: RealtimeTransport,
    private readonly logger: Logger,
  ) {}

  async notify(input: PushNotifierInput): Promise<boolean> {
    const { target, kind } = input;
    const channel = channelFor(kind, {
      tenantId: target.tenantId,
      userId: target.userId,
    });
    const payload = buildNotificationWakeup(kind);

    try {
      const result = await this.transport.deliver(
        { userId: target.userId, tenantId: target.tenantId },
        channel,
        payload,
      );
      if (!result.delivered) {
        // Not an error — poll/no-transport/policy are normal outcomes. Logged
        // at debug so the absence of a push is observable without noise.
        this.logger.debug("realtime wakeup not delivered", {
          reason: result.reason,
          kind,
        });
      }
      return result.delivered;
    } catch (err) {
      // BEST-EFFORT: a transport hiccup must never surface to the caller. The
      // notification row is already persisted; the next poll delivers it.
      this.logger.warn("realtime wakeup deliver threw (non-fatal)", err);
      return false;
    }
  }
}
