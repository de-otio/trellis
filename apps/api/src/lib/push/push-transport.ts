// CONTRACT: frozen — see apps/api/src/lib/doc/push-device-contract.md (T8).
//
// The PushTransport capability seam. Core ships NO concrete APNs/FCM/SNS
// implementation — a consuming app (Skybber's infra lane) injects one via
// setPushTransportProvider() before serving, mirroring setRealtimeProvider().
// Nothing in this module may import an AWS SDK or a push vendor SDK.
//
// Binding rules for every transport implementor:
//   - `payload` is the encoded content-free WakeupEnvelope bytes (built ONLY
//     by buildNotificationWakeup()). The transport is a BLIND RELAY: it must
//     ship the bytes as a data-only / content-available push and MUST NOT
//     synthesize alert title/body from them.
//   - send() MUST NOT throw for per-device delivery failures — map them to a
//     PushSendOutcome. The dispatcher treats a throw as "transient".
//   - "unregistered" is the token-invalidation signal: the dispatcher deletes
//     the PushDevice row when a transport reports it.

/** Wire form of the PushPlatform enum ("apns" | "fcm" | "web"). */
export type PushPlatformWire = "apns" | "fcm" | "web";

/** One registered device the dispatcher resolved for a wakeup. */
export interface PushDeviceTarget {
  /** PushDevice.id — for invalidation bookkeeping in the transport's logs. */
  deviceId: string;
  platform: PushPlatformWire;
  /** Decrypted raw platform token. Never logged, never echoed to clients. */
  token: string;
}

/** Outcome of ONE send attempt to ONE device. */
export type PushSendOutcome =
  | { ok: true }
  | { ok: false; reason: "unregistered" | "transient" | "config" };

export interface PushTransport {
  /** Implementation label (e.g. "sns-platform", "fcm-v1") — logging only. */
  readonly kind: string;
  /** Deliver one content-free wakeup payload to one device. */
  send(
    device: PushDeviceTarget,
    payload: Uint8Array,
  ): Promise<PushSendOutcome>;
}

// ---------------------------------------------------------------------------
// Provider-injection hook (mirrors setRealtimeProvider). A consuming app calls
// setPushTransportProvider() at startup, BEFORE serving. resolvePushTransport()
// returns the injected transport or undefined — there is deliberately no core
// default: un-wired deploys never attempt a push (contract invariant 3).
// ---------------------------------------------------------------------------

let injected: PushTransport | undefined;

/**
 * Consuming app (Skybber) calls this at startup with its concrete transport
 * (e.g. an SNS-platform-endpoint adapter). MUST run before serving.
 */
export function setPushTransportProvider(transport: PushTransport): void {
  injected = transport;
}

/** Returns the injected transport, or undefined when none was registered. */
export function resolvePushTransport(): PushTransport | undefined {
  return injected;
}

/** Test-only: clear the injected provider so tests don't leak across cases. */
export function __resetPushTransportProviderForTests(): void {
  injected = undefined;
}
