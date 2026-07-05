/**
 * @de-otio/trellis — Public API
 *
 * Verticals import from this module to register extensions and start the server.
 */

export { startServer } from "./server.js";
export { registerExtension, getExtension, getExtensions } from "./extensions.js";
// Realtime transport seam: a consuming app (e.g. Skybber) injects a concrete
// transport (AppSync Events) before serving; core ships the poll/noop default.
export { setRealtimeProvider } from "./lib/realtime/index.js";
// Push transport seam (T8): a consuming app injects the concrete APNs/FCM
// delivery (e.g. an SNS-platform adapter) before serving; core ships NO
// default — un-wired deploys never attempt a push. Frozen contract:
// lib/doc/push-device-contract.md.
export { setPushTransportProvider } from "./lib/push/index.js";
export type {
  PushTransport,
  PushDeviceTarget,
  PushSendOutcome,
  PushPlatformWire,
} from "./lib/push/index.js";
// Media moderation seam: a consuming app injects a concrete image-moderation
// provider before serving; core ships a fail-closed Null default (every verdict
// = "review", so un-wired deploys never auto-approve).
export { setMediaModerationProvider } from "./lib/media/request-moderation.js";
// Text moderation seam: a consuming app injects a concrete text-moderation
// provider (an adapter over the hosted moderation API) before serving; core
// ships a fail-closed Null default (every verdict = "review", so un-wired
// deploys hold text for review and never auto-approve). Gates post/comment
// create + edit text.
export { setTextModerationProvider } from "./lib/media/request-text-moderation.js";
