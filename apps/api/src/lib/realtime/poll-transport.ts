// CONTRACT-adjacent — the default transport. See types.ts banner.
//
// PollTransport makes core runnable and testable with NO realtime infra. It is
// a correctness default, explicitly NOT the scale answer.
//
//   deliver()  -> runs the policy fence, then NO-OPs the wire send and returns
//                 { delivered: false, reason: "no_transport" } (clients poll;
//                 the side-effecting persistence — the Notification row / the
//                 setting version bump — is what the next poll observes). The
//                 fence still runs so swapping in AppSync changes the pipe, not
//                 a single call site.
//   getSetting / putSetting -> delegate to the injected SettingStore (the real
//                 REST-backed sync path).

import type {
  Channel,
  DeliveryContext,
  DeliveryPolicyResolver,
  DeliveryResult,
  DeliveryTarget,
  EncryptedBlob,
  PutResult,
  RealtimeTransport,
  SettingStore,
} from "./types.js";

/**
 * Build the `DeliveryContext` the policy fence needs from a `deliver()` call.
 * PollTransport has no notification metadata at the wire boundary (the floor
 * decision was already made by the caller for persistence), so it constructs a
 * minimal, fence-running context. The interface keeps payloads opaque, so the
 * transport derives only routing-level inputs.
 */
function fenceContextFor(
  target: DeliveryTarget,
  channel: Channel,
): DeliveryContext {
  // Map the channel kind back onto a NotificationType-shaped floor input: the
  // "safety" kind is critical-always, everything else is best-effort. We do not
  // have the original NotificationType here, so we synthesize the floor-relevant
  // signal: a "safety" channel must never be suppressed.
  const type = channel.kind === "safety" ? "SAFETY_ALERT" : "SYSTEM";
  return {
    type,
    recipientUserId: target.userId,
    tenantId: target.tenantId,
    now: new Date(),
  };
}

export class PollTransport implements RealtimeTransport {
  readonly kind = "poll" as const;

  constructor(
    private readonly store: SettingStore,
    private readonly policy: DeliveryPolicyResolver,
  ) {}

  async deliver(
    target: DeliveryTarget,
    channel: Channel,
    _payload: Uint8Array,
  ): Promise<DeliveryResult> {
    // deliver() is BEST-EFFORT: it MUST NOT reject in a way that could roll back
    // a persisted write upstream. Any internal fault (e.g. a throwing resolver)
    // is caught and surfaced as transport_error (frozen contract §2.3 + the
    // realtime-transport.ts binding rules).
    try {
      // The policy fence runs on EVERY transport, even the no-op one.
      const decision = this.policy.decide(fenceContextFor(target, channel));
      if (!decision.deliver) {
        return { delivered: false, reason: "policy_denied" };
      }
      // Poll model: there is no socket. The client learns of the change on its
      // next poll, so the wire send is a deliberate no-op.
      return { delivered: false, reason: "no_transport" };
    } catch {
      return { delivered: false, reason: "transport_error" };
    }
  }

  getSetting(userId: string, namespace: string): Promise<EncryptedBlob | null> {
    return this.store.get(userId, namespace);
  }

  putSetting(
    userId: string,
    namespace: string,
    blob: EncryptedBlob,
    expectVersion: number,
  ): Promise<PutResult> {
    return this.store.put(userId, namespace, blob, expectVersion);
  }
}
