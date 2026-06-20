// CONTRACT-adjacent — the CI transport. See types.ts banner.
//
// NoopRealtimeTransport: the same shape as PollTransport but with NO store and
// NO wire. It still runs the policy fence inside deliver() (so the fence-runs-
// on-every-transport invariant holds), then drops. getSetting/putSetting are
// inert (no store). Used in tests/CI where neither a store nor a socket exists.

import type {
  Channel,
  DeliveryContext,
  DeliveryPolicyResolver,
  DeliveryResult,
  DeliveryTarget,
  EncryptedBlob,
  PutResult,
  RealtimeTransport,
} from "./types.js";

function fenceContextFor(
  target: DeliveryTarget,
  channel: Channel,
): DeliveryContext {
  const type = channel.kind === "safety" ? "SAFETY_ALERT" : "SYSTEM";
  return {
    type,
    recipientUserId: target.userId,
    tenantId: target.tenantId,
    now: new Date(),
  };
}

export class NoopRealtimeTransport implements RealtimeTransport {
  readonly kind = "noop" as const;

  constructor(private readonly policy: DeliveryPolicyResolver) {}

  async deliver(
    target: DeliveryTarget,
    channel: Channel,
    _payload: Uint8Array,
  ): Promise<DeliveryResult> {
    // Best-effort: a transport-internal fault (e.g. a throwing resolver) is
    // caught and surfaced as transport_error, never a reject that could roll
    // back a persisted write (frozen contract §2.3).
    try {
      const decision = this.policy.decide(fenceContextFor(target, channel));
      if (!decision.deliver) {
        return { delivered: false, reason: "policy_denied" };
      }
      return { delivered: false, reason: "no_transport" };
    } catch {
      return { delivered: false, reason: "transport_error" };
    }
  }

  async getSetting(
    _userId: string,
    _namespace: string,
  ): Promise<EncryptedBlob | null> {
    return null;
  }

  async putSetting(
    _userId: string,
    _namespace: string,
    _blob: EncryptedBlob,
    _expectVersion: number,
  ): Promise<PutResult> {
    return { ok: false, reason: "not_found", current: null };
  }
}
