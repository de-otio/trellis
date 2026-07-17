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
// Compliance seams (plan 08 §2.5 / plan 07 §4.2) — a consuming app injects
// concrete adapters (S3 WORM evidence store, manual BKA channel, S3 analysis
// sink) before enabling any ILLEGAL_* report category. Fail-safe defaults throw
// (evidence + sink) or return a manual no-op (authority channel). Lane A ships
// the interface stubs; Lane A2 wires the enforcement flow to them.
export {
  setEvidencePreservationStore,
  setAuthorityReportChannel,
  setModerationFeedbackSink,
} from "./lib/media/compliance-seams.js";
export type {
  EvidencePreservationStore,
  AuthorityReportChannel,
  ModerationFeedbackSink,
  EvidenceBundle,
  AuthorityReportBundle,
  AuthorityReportResult,
  ModerationFeedbackRecord,
  BlockClass,
} from "./lib/media/compliance-seams.js";
// Reporter-notification templates (plan 08 §2.2 §3.3) — deployment injects
// localized, counsel-approved Art. 16(4)/(5) copy; core ships a neutral fallback.
export {
  setReportTemplates,
  REPORT_TEMPLATE_KEYS,
} from "./lib/report-templates.js";
export type { ReportTemplate, ReportTemplateMap } from "./lib/report-templates.js";
// Operator-alert hook (plan 08 §2.2) — ILLEGAL_* reports alert the operator;
// the deployment can inject a richer hook (default emails MODERATOR_EMAILS).
export {
  setOperatorAlertHook,
} from "./lib/report-operator-alert.js";
export type {
  OperatorAlert,
  OperatorAlertHook,
} from "./lib/report-operator-alert.js";
