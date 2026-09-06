// Reporter-notification templates (plan 08 §2.2 / §2.7 / §3.3).
//
// Art. 16(4) receipt + Art. 16(5) decision notices are DEPLOYMENT-supplied,
// localized, and counsel-red-lined. Core must NOT ship jurisdiction/legal copy —
// so this module is pure template-KEY indirection: call sites reference a stable
// key (`REPORT_RECEIPT`, …); the deployment injects the real localized text via
// `setReportTemplates()` (from registerComplianceProfile). Core ships only a
// NEUTRAL, jurisdiction-free English fallback so an un-wired deploy still sends
// a sensible, non-legal acknowledgement rather than an empty message.
//
// The template body supports `{param}` placeholders filled from `params`.

/** Stable template keys. Values are the keys the deployment map is keyed by. */
export const REPORT_TEMPLATE_KEYS = {
  /** Art. 16(4) — receipt confirmation on report creation. */
  RECEIPT: "report.receipt",
  /** Art. 16(5) — terminal outcome: the report was actioned. */
  DECISION_ACTIONED: "report.decision.actioned",
  /** Art. 16(5) — terminal outcome: the report was rejected/closed no-action. */
  DECISION_REJECTED: "report.decision.rejected",
  /**
   * Art. 16(5) — the redress information that must accompany a decision
   * ("information on the possibilities for redress"). Kept a SEPARATE key from
   * the two decision notices because the redress routes are identical whatever
   * the outcome, and because it is the part counsel is most likely to redline
   * on its own.
   */
  REDRESS: "report.redress",
} as const;

export type ReportTemplateKey =
  (typeof REPORT_TEMPLATE_KEYS)[keyof typeof REPORT_TEMPLATE_KEYS];

/** A single localized template. `body` may contain `{param}` placeholders. */
export interface ReportTemplate {
  readonly title: string;
  readonly body: string;
}

/** Deployment-supplied template map, keyed by template key. */
export type ReportTemplateMap = Readonly<Record<string, ReportTemplate>>;

/**
 * Neutral, jurisdiction-free fallbacks. Deliberately NOT legal text — plain,
 * honest acknowledgements. A deployment overrides every key with counsel-
 * approved, localized copy before enabling reporting.
 */
const NEUTRAL_FALLBACKS: ReportTemplateMap = {
  [REPORT_TEMPLATE_KEYS.RECEIPT]: {
    title: "We received your report",
    body:
      "Thanks — we've received your report (reference {reportId}) and will " +
      "review it. We'll let you know when there's an outcome.",
  },
  [REPORT_TEMPLATE_KEYS.DECISION_ACTIONED]: {
    title: "Update on your report",
    body:
      "We've reviewed your report (reference {reportId}) and taken action. " +
      "Thanks for helping keep the community safe.",
  },
  [REPORT_TEMPLATE_KEYS.DECISION_REJECTED]: {
    title: "Update on your report",
    body:
      "We've reviewed your report (reference {reportId}). We didn't find a " +
      "rule violation this time, so no action was taken. Thanks for letting us know.",
  },
  [REPORT_TEMPLATE_KEYS.REDRESS]: {
    title: "If you disagree with this outcome",
    // Deliberately NOT legal text and deliberately NOT jurisdiction-specific:
    // core cannot know which redress routes (internal complaint handling,
    // out-of-court settlement, courts) a given deployment actually offers, and
    // naming one it does not is worse than naming none. A deployment overrides
    // this key with counsel-approved copy before enabling reporting.
    body:
      "You can ask us to look at your report (reference {reportId}) again. " +
      "Depending on where you live you may also have other ways to challenge " +
      "this outcome; our terms explain which apply to you.",
  },
};

let injectedTemplates: ReportTemplateMap | undefined;

/**
 * Consuming app injects localized, counsel-approved templates at startup (via
 * registerComplianceProfile). Keys not present in the injected map fall back to
 * the neutral core copy — so a partial deployment map never yields an empty
 * notification.
 */
export function setReportTemplates(templates: ReportTemplateMap): void {
  injectedTemplates = templates;
}

/** Test-only: clear injected templates so tests don't leak across cases. */
export function __resetReportTemplatesForTests(): void {
  injectedTemplates = undefined;
}

function interpolate(text: string, params: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match,
  );
}

/**
 * Resolve a template by key and fill its `{param}` placeholders. Prefers the
 * injected deployment template; falls back to the neutral core copy. Throws only
 * if a key has neither an injected nor a fallback template (a programming error).
 */
export function resolveReportTemplate(
  key: ReportTemplateKey,
  params: Record<string, string> = {},
): ReportTemplate {
  const template = injectedTemplates?.[key] ?? NEUTRAL_FALLBACKS[key];
  if (!template) {
    throw new Error(`No report template registered for key "${key}"`);
  }
  return {
    title: interpolate(template.title, params),
    body: interpolate(template.body, params),
  };
}
