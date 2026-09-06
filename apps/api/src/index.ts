/**
 * @de-otio/trellis — Public API
 *
 * Verticals import from this module to register extensions and start the server.
 */

export { startServer } from "./server.js";
export { registerExtension, getExtension, getExtensions } from "./extensions.js";
export { shutdownTrellis } from "./shutdown.js";
export type { ShutdownResult } from "./shutdown.js";

// Version-compatibility rules, public so a conformance check can apply the
// SAME rule core applies at boot rather than reimplementing the 0.x
// minor-is-breaking policy and drifting from it.
//
// `EXTENSION_API_VERSION` is re-exported rather than left to the caller's own
// `@de-otio/trellis-extension-api` import because those can be different
// copies. The question a conformance check asks is "is this extension
// compatible with the core it is about to run against", and only core can
// answer which contract version *it* loaded.
export { EXTENSION_API_VERSION } from "@de-otio/trellis-extension-api";
export { classifyApiVersion, parseApiVersion } from "./lib/extension-validator.js";
export type { ApiVersionVerdict, ParsedApiVersion } from "./lib/extension-validator.js";
// NOT re-exported here, deliberately: `csrfMiddleware`, `requireSessionMiddleware`
// and `isCoreGateMiddleware` (`lib/middleware.js`), and `CORE_SECRET_ENV_KEYS`
// (`lib/extension-config-keys.js`). A vertical with raw `ext.routes` reaches the
// two gates through the package's subpath export —
// `@de-otio/trellis/dist/lib/middleware.js` — which is how every other core
// internal is reached today. Promoting them to this module widens the top-level
// `@de-otio/trellis` surface and moves `etc/public-api.snapshot.d.ts`, which is
// a reviewed contract change rather than part of the sweep fix. Worth doing —
// "attach a core gate" deserves a first-class import — but as its own decision.
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
// Label policy: makes the OPERATOR's category map authoritative over the
// provider's own decision. Optional — without one the provider's decision
// stands — and it can only ever degrade a verdict, never loosen it.
export { setMediaLabelPolicy } from "./lib/media/request-moderation.js";
export {
  createLabelPolicy,
  explainFromLabels,
  LabelPolicyConfigError,
} from "./lib/media/label-policy.js";
export type {
  LabelPolicy,
  LabelPolicyConfig,
  LabelPolicyContext,
  LabelPolicyExplanation,
  LabelPolicyGround,
  CategoryPolicy,
  TaxonomyPinMode,
} from "./lib/media/label-policy.js";
// The deferred moderation lane (plan 030 / plan 031) — EVALUATION SCAFFOLDING.
// Exported because the consuming app owns the wiring: it supplies τ, the lane's
// operator config, and the slow-model provider. All of it is inert by default —
// τ = 0 and `enabled: false` route every verdict to today's behaviour, and the
// approval flag ships closed. The Hatchet workflow that consumes these lives in
// the worker app; nothing here imports an SDK.
export {
  createCascadeRoute,
  routeOnConfidence,
  CascadeRouteConfigError,
} from "./lib/media/cascade-route.js";
export type {
  CascadeRoute,
  CascadeRouteConfig,
  CascadeRouter,
  EscalationCause,
  SettleReason,
} from "./lib/media/cascade-route.js";
export {
  clampEscalatedDecision,
  createDeferredLaneConfig,
  dispositionForDeadlineBreach,
  dispositionForError,
  DeferredLaneConfigError,
  DEFERRED_LANE_RETRIES,
} from "./lib/media/deferred-lane.js";
export type {
  DeferredLaneConfig,
  Disposition,
  ShedCause,
} from "./lib/media/deferred-lane.js";
// Human-review promotion: wiring this is what makes a moderator's approval
// actually copy the reviewed bytes to the serve prefix. Without it, approval
// applies the lifecycle transition and promotes nothing — and says so.
export { setMediaReviewPromotion } from "./lib/media/media-review-handler.js";
export type { ReviewPromotionPort, ReviewPromoteCoords } from "./lib/media/media-review-handler.js";
// Moderation observability: aggregate, closed-window counters for an
// AUTHENTICATED operations surface. Never expose these to a client.
export { ModerationMetrics } from "./lib/media/moderation-metrics.js";
export type {
  ModerationMetricsConfig,
  ModerationMetricsSnapshot,
  ModerationPublicHealth,
} from "./lib/media/moderation-metrics.js";
// Frame-sampled video moderation: lets an IMAGE-ONLY classifier satisfy the
// video half of the moderation seam. Core samples, classifies and aggregates.
export { FrameSamplingVideoModerationAdapter } from "./lib/media/frame-sampling-adapter.js";
export type { FrameSamplingConfig, FrameSamplingDeps } from "./lib/media/frame-sampling-adapter.js";
// Deadline wrapper: bounds every seam call and commits the decision at the
// deadline, so a late provider answer cannot overturn a fail-closed verdict.
export {
  withModerationDeadline,
  ModerationDeadlineConfigError,
} from "./lib/media/moderation-deadline.js";
// Read media bytes for a classifier that takes an image in its request body,
// without giving that adapter storage credentials of its own.
export { createMediaBytesAccess, MediaBytesTooLargeError } from "./lib/media/media-bytes-access.js";
export type { MediaBytesAccess } from "./lib/media/media-bytes-access.js";
// The first concrete provider: a generic OpenAI-compatible vision classifier
// (Scaleway Generative APIs). A MECHANISM — taxonomy prompt, category tokens,
// endpoint, key and thresholds are all operator config; no vocabulary here.
export { ScalewayVisionModerationProvider } from "./lib/media/scaleway-vision-provider.js";
export type { ScalewayVisionModerationConfig } from "./lib/media/scaleway-vision-provider.js";
// The injection-resistant second signal: a coarse pass/block VERDICT gate. The
// category scorer above is defeated by image-borne prompt injection (probe 16);
// the verdict-enum shape held. Compose the two under CrossCheckModerationProvider
// (worst-wins) so a hijacked scorer cannot approve on its own. Same mechanism
// rules — prompt, endpoint, key, block decision are all operator config.
export { ScalewayVerdictModerationProvider } from "./lib/media/scaleway-verdict-provider.js";
export type { ScalewayVerdictModerationConfig } from "./lib/media/scaleway-verdict-provider.js";
// Two-signal cross-check: composes two providers and returns the WORST verdict,
// so a single signal hijacked by image-borne prompt injection cannot approve on
// its own. A pass requires both to pass. Wrap the category scorer + an
// injection-resistant verdict gate; compose under the frame-sampling adapter
// for video. A mechanism — each composed provider carries its own config.
export { CrossCheckModerationProvider } from "./lib/media/cross-check-provider.js";
export type { CrossCheckModerationConfig } from "./lib/media/cross-check-provider.js";
// The minimum-content intake gate: a deterministic pre-model check that stops
// degenerate images (below-floor dimensions, near-zero entropy) from reaching
// any classifier at all — wrap it around the cross-check so it sits in front
// of BOTH signals. A mechanism: the floors and the mapped decision are
// operator config, and construction refuses when a floor is missing.
export { MinimumContentGateModerationProvider } from "./lib/media/minimum-content-gate.js";
export type {
  MinimumContentGateConfig,
  MinimumContentGateDecision,
} from "./lib/media/minimum-content-gate.js";
// The moderation seam's own contract, so an adapter can implement it against
// published types rather than a deep import.
export {
  ModerationProviderError,
  isModerationProviderError,
  NullModerationProvider,
  assertModerationProviderAllowed,
  moderationProviderName,
  UNKNOWN_PROVIDER_NAME,
} from "./lib/media/moderation-provider.js";
export type {
  MediaModerationProvider,
  MediaPin,
  ImageRef,
  S3Ref,
  ModerationVerdict,
  ModerationLabel,
  ModerationCallOptions,
  VideoModerationStart,
} from "./lib/media/moderation-provider.js";
// The canonical completion envelope a backend publishes when an async job
// finishes, plus its producer.
export {
  completionEnvelopeBody,
  parseCompletionEnvelope,
} from "./lib/media/completion-envelope.js";
export type { ModerationCompletionEnvelope } from "./lib/media/completion-envelope.js";
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
// Compliance enforcement (plan 08 Phase 2 / spec 07 §4 — Lane A2).
// - `restrictContent` orchestrates takedown (hide → preserve → statement → audit).
// - The deployment injects the affected-user statement delivery transport and an
//   alarm hook for repeated evidence-preservation failure.
// - `ILLEGAL_SUSPECTED_LABEL` is the reserved, provider-neutral token a
//   deployment's moderation adapter emits to signal the illegal-suspected class.
// - Authority-report lifecycle: created `pending` (NEVER auto-submitted);
//   operator confirms `submitted`; `closed` releases the evidence hold.
export {
  restrictContent,
  evidenceHoldExemptWhere,
  setComplianceAlarmHook,
} from "./lib/compliance/restrict-content.js";
export type {
  RestrictContentRef,
  RestrictContentOpts,
  RestrictContentResult,
  ComplianceAlarm,
  ComplianceAlarmHook,
} from "./lib/compliance/restrict-content.js";
export { setStatementDelivery } from "./lib/compliance/statement-of-reasons.js";
export type { StatementDelivery } from "./lib/compliance/statement-of-reasons.js";
export {
  ILLEGAL_SUSPECTED_LABEL,
  deriveBlockClass,
  isAppealable,
} from "./lib/compliance/block-class.js";
export {
  createPendingAuthorityReport,
  markAuthorityReportSubmitted,
  markAuthorityReportClosed,
} from "./lib/compliance/authority-report.js";
// Agent-surface content seam (plan 034): a consuming app supplies its own
// GET /llms.txt and GET /security.txt bodies via `Env.agentSurface` (the
// AGENT_SURFACE_LLMS_TXT / AGENT_SURFACE_SECURITY_TXT env vars, the same
// app-configuration path as APP_DOMAIN/ALLOWED_ORIGINS). Core ships a
// generic, truthful llms.txt default and NO security.txt default — an
// unconfigured deployment 404s rather than serve a placeholder contact.
export type { AgentSurfaceContent } from "./lib/routes/agent-surface.js";
