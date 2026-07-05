// T8 — public barrel for the push seam
// (frozen contract: apps/api/src/lib/doc/push-device-contract.md).

export type {
  PushPlatformWire,
  PushDeviceTarget,
  PushSendOutcome,
  PushTransport,
} from "./push-transport.js";

export {
  setPushTransportProvider,
  resolvePushTransport,
  __resetPushTransportProviderForTests,
} from "./push-transport.js";

export {
  PushDispatcher,
  MAX_PUSH_DEVICES_PER_USER,
  platformToWire,
} from "./push-dispatcher.js";
export type {
  PushDeviceStore,
  PushDispatchInput,
  PushDispatchResult,
} from "./push-dispatcher.js";

export { PushDeviceHandler, wireToPlatform } from "./push-device-handler.js";
export type { RegisteredDeviceDto } from "./push-device-handler.js";

export { hashDeviceToken } from "./token-crypto.js";
