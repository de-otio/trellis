// CONTRACT: stable — coordinate changes. See types.ts banner.
//
// Public barrel for the RealtimeTransport seam — the ONLY import path consumers
// use (published as `@de-otio/trellis/realtime`). Re-exports the frozen types,
// the channel helpers, the ports + defaults, the two in-core transports, and
// the provider-injection hook a consuming app (Skybber) uses to plug in its
// AppSyncEventsTransport WITHOUT core importing any AWS SDK.

export type {
  // Channel taxonomy
  Channel,
  ChannelKind,
  ScopeType,
  // Authorization
  VerifiedIdentity,
  // Delivery
  DeliveryTarget,
  DeliveryResult,
  DeliveryContext,
  DeliveryDecision,
  QuietHoursConfig,
  // Wakeup
  WakeupEnvelope,
  // Settings
  EncryptedBlob,
  PutResult,
  SettingStore,
  // Offline backfill (Track C) — optional capability layered on SettingStore
  ChangedSettingMeta,
  ChangeCursorStore,
  // Transport + policy
  RealtimeTransport,
  DeliveryPolicyResolver,
} from "./types.js";

export { encodeWakeup, decodeWakeup, supportsChangeCursor } from "./types.js";

export {
  channelName,
  parseChannel,
  channelFor,
  authorizeSubscription,
} from "./channel.js";

export {
  CalmDeliveryResolver,
  ALWAYS_DELIVER_TYPES,
} from "./delivery-policy.js";

export { InMemorySettingStore } from "./setting-store.js";

export { PollTransport } from "./poll-transport.js";
export { NoopRealtimeTransport } from "./no-op-transport.js";

import type { RealtimeTransport } from "./types.js";

// ---------------------------------------------------------------------------
// Provider-injection hook (mirrors registerExtension). A consuming app calls
// setRealtimeProvider() at startup, BEFORE buildEnv-consumers serve, with its
// concrete transport. resolveRealtimeTransport() returns the injected transport
// if present, else the supplied fallback (the core Poll/Noop default).
// ---------------------------------------------------------------------------

let injected: RealtimeTransport | undefined;

/**
 * Consuming app (Skybber) calls this at startup with its concrete transport
 * (e.g. AppSyncEventsTransport). MUST run before buildEnv-consumers serve.
 */
export function setRealtimeProvider(transport: RealtimeTransport): void {
  injected = transport;
}

/**
 * Returns the injected transport if a provider was registered, else the
 * supplied fallback. `buildEnv` calls this with the default Poll/Noop transport.
 */
export function resolveRealtimeTransport(
  fallback: RealtimeTransport,
): RealtimeTransport {
  return injected ?? fallback;
}

/** Test-only: clear the injected provider so tests don't leak across cases. */
export function __resetRealtimeProviderForTests(): void {
  injected = undefined;
}
