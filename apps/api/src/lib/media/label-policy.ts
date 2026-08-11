/**
 * label-policy.ts — pure functional core: turn a provider's labels into one of
 * the three decisions, under an operator-supplied policy.
 *
 * This is the module that decides whether media is approved, so it is written
 * to be readable as a safety argument rather than as a lookup table:
 *
 *  1. **It refuses to exist without a policy.** {@link createLabelPolicy}
 *     throws when the category map is missing. There is no compiled-in default
 *     map and no default confidence bar — this file ships in a public npm
 *     tarball, and a threshold compiled into it is a published threshold. An
 *     operator who configures nothing gets a hard failure at wiring time, not a
 *     silent policy nobody chose.
 *  2. **An unmapped category quarantines.** A category the operator has not
 *     ruled on is not a category to shrug at: the provider is reporting
 *     something and the policy has no opinion, which is precisely when a human
 *     should look. It dominates — one unmapped label quarantines the object
 *     however benign every other label is.
 *  3. **Approval requires a verifiable taxonomy.** A category→action map is
 *     only meaningful against the taxonomy it was written for. If the provider
 *     silently reships its model under the same category names, the map keeps
 *     "working" while meaning something else. So under the pinned modes the
 *     verdict must carry a `modelVersion` that matches what the operator
 *     pinned; drift or absence degrades to `review`. Pin failure FLOORS the
 *     decision at review — it never lifts a quarantine.
 *  4. **No labels is not automatically approval.** Zero labels approves only
 *     when the pin verified. A provider that returns an empty label array
 *     because it errored internally, or because its taxonomy moved, must not
 *     be able to approve by saying nothing.
 *
 * PURITY: no I/O, no clock, no randomness, and no numbers of its own.
 */

import type { ModerationDecision } from "./media-lifecycle.js";
import type { ModerationVerdict } from "./moderation-provider.js";

/** Severity ladder, shared with frame aggregation. Higher is worse. */
const SEVERITY: Readonly<Record<ModerationDecision, number>> = {
  approved: 0,
  review: 1,
  quarantine: 2,
};

function worse(a: ModerationDecision, b: ModerationDecision): ModerationDecision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/**
 * How the taxonomy behind the category map is pinned.
 *
 * - `"response"` — the provider must REPORT a `modelVersion` on every verdict,
 *   and when the caller knows which version a job started under (video: the
 *   version captured at job start) it must still match at completion. Detects
 *   a mid-job taxonomy change.
 * - `"config"` — the operator names the exact version their category map was
 *   written for. Any other version, or none, is drift.
 * - `"none"` — no taxonomy pin. Requires an explicit opt-in, and the resulting
 *   policy carries a standing {@link LabelPolicy.unpinnedTaxonomy} flag so the
 *   operations surface can show the posture continuously. A boot-time log line
 *   would not do: nobody re-reads boot logs, and this is a condition that
 *   persists for as long as the deployment does.
 */
export type TaxonomyPinMode = "response" | "config" | "none";

/** Confidence boundaries for one opaque category token. */
export interface CategoryPolicy {
  /** At or above this confidence, the category means `review`. */
  readonly review: number;
  /** At or above this confidence, the category means `quarantine`. */
  readonly quarantine: number;
}

/**
 * The operator-supplied policy. Every value here comes from runtime config
 * (env/SSM/feature toggles); none of it has a default in this file.
 *
 * `categories` maps the provider's OPAQUE category tokens to confidence bars.
 * The tokens and the bars must be expressed on the same scale the provider
 * reports confidences on — core never rescales, because a rescale is a policy
 * decision disguised as arithmetic.
 */
export interface LabelPolicyConfig {
  readonly categories: Readonly<Record<string, CategoryPolicy>>;
  readonly pinMode: TaxonomyPinMode;
  /** The pinned taxonomy version. REQUIRED when `pinMode` is `"config"`. */
  readonly expectedModelVersion?: string;
  /** Must be explicitly `true` when `pinMode` is `"none"`. */
  readonly acceptUnpinnedTaxonomy?: boolean;
}

/** Thrown at wiring time when the policy is unusable. Never thrown per-verdict. */
export class LabelPolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabelPolicyConfigError";
  }
}

/** Context the caller knows that the verdict itself does not. */
export interface LabelPolicyContext {
  /**
   * The taxonomy version recorded when this job STARTED, for the async video
   * path. Under `"response"` mode a completion whose version differs from the
   * one the job began under is drift, even though both are self-reported.
   */
  readonly pinnedModelVersion?: string;
}

export interface LabelPolicy {
  /** Interpret one verdict. Total: never throws, for any verdict shape. */
  decide(
    verdict: ModerationVerdict,
    context?: LabelPolicyContext,
  ): ModerationDecision;
  /**
   * True when this policy runs WITHOUT a taxonomy pin. A standing flag for the
   * operations surface, not a one-shot log line.
   */
  readonly unpinnedTaxonomy: boolean;
}

/**
 * Build a policy, or refuse.
 *
 * Refuses when: there is no category map at all; `pinMode` is unrecognised;
 * `"config"` mode names no version; or `"none"` mode was requested without the
 * explicit `acceptUnpinnedTaxonomy: true`. An EMPTY category map is allowed and
 * is not the same as a missing one — it is a coherent policy meaning "every
 * category the provider can report is unmapped, so quarantine all of them" —
 * but a `categories` that is absent or not an object is a wiring mistake.
 */
export function createLabelPolicy(config: LabelPolicyConfig): LabelPolicy {
  if (
    config === null ||
    typeof config !== "object" ||
    config.categories === null ||
    typeof config.categories !== "object"
  ) {
    throw new LabelPolicyConfigError(
      "label policy requires a category map; refusing to construct a policy nobody configured",
    );
  }
  if (
    config.pinMode !== "response" &&
    config.pinMode !== "config" &&
    config.pinMode !== "none"
  ) {
    throw new LabelPolicyConfigError(
      `label policy pinMode must be "response", "config" or "none"`,
    );
  }
  if (
    config.pinMode === "config" &&
    (typeof config.expectedModelVersion !== "string" ||
      config.expectedModelVersion.length === 0)
  ) {
    throw new LabelPolicyConfigError(
      'label policy pinMode "config" requires expectedModelVersion',
    );
  }
  if (config.pinMode === "none" && config.acceptUnpinnedTaxonomy !== true) {
    throw new LabelPolicyConfigError(
      'label policy pinMode "none" requires acceptUnpinnedTaxonomy: true — running an unpinned taxonomy is a decision, not a default',
    );
  }

  const frozen: LabelPolicyConfig = {
    categories: { ...config.categories },
    pinMode: config.pinMode,
    ...(config.expectedModelVersion !== undefined && {
      expectedModelVersion: config.expectedModelVersion,
    }),
    ...(config.acceptUnpinnedTaxonomy !== undefined && {
      acceptUnpinnedTaxonomy: config.acceptUnpinnedTaxonomy,
    }),
  };

  return {
    unpinnedTaxonomy: frozen.pinMode === "none",
    decide(verdict, context) {
      return decideFromLabels(verdict, frozen, context);
    },
  };
}

/**
 * The decision function itself, exported for direct table-driven testing.
 *
 * Total by construction: a malformed verdict (null, no labels array, a label
 * with a non-numeric confidence) yields at worst `review`, never `approved`.
 */
export function decideFromLabels(
  verdict: ModerationVerdict,
  config: LabelPolicyConfig,
  context?: LabelPolicyContext,
): ModerationDecision {
  const pinOk = verifyTaxonomyPin(verdict, config, context);
  const floor: ModerationDecision = pinOk ? "approved" : "review";

  if (verdict === null || typeof verdict !== "object") return "review";
  const labels = Array.isArray(verdict.labels) ? verdict.labels : null;
  if (labels === null) {
    // A verdict that does not even carry a label array tells us nothing.
    return "review";
  }

  let decision: ModerationDecision = "approved";
  for (const label of labels) {
    const category =
      label !== null && typeof label === "object" && typeof label.category === "string"
        ? label.category
        : null;
    if (category === null) {
      // A label we cannot even name is an unmapped label.
      return "quarantine";
    }
    const policy = Object.prototype.hasOwnProperty.call(
      config.categories,
      category,
    )
      ? config.categories[category]
      : undefined;
    if (policy === undefined) {
      // Rule 2: unmapped dominates, whatever else is in the array.
      return "quarantine";
    }
    const confidence =
      typeof label.confidence === "number" && Number.isFinite(label.confidence)
        ? label.confidence
        : null;
    if (confidence === null) {
      // Mapped category, unusable confidence: we know the category matters and
      // cannot tell how much. That is doubt, and doubt reviews.
      decision = worse(decision, "review");
      continue;
    }
    if (confidence >= policy.quarantine) return "quarantine";
    if (confidence >= policy.review) decision = worse(decision, "review");
  }

  return worse(decision, floor);
}

/**
 * Does the verdict's taxonomy match what the operator pinned?
 *
 * `"none"` always passes (that is what the opt-in bought). The pinned modes
 * require a self-reported version, and `"config"` additionally requires it to
 * equal the configured one. Under `"response"`, a caller-supplied
 * `pinnedModelVersion` (captured when an async job started) must also match —
 * that is the only way to notice a taxonomy that moved mid-job.
 */
function verifyTaxonomyPin(
  verdict: ModerationVerdict,
  config: LabelPolicyConfig,
  context?: LabelPolicyContext,
): boolean {
  if (config.pinMode === "none") return true;

  const reported =
    verdict !== null &&
    typeof verdict === "object" &&
    typeof verdict.modelVersion === "string" &&
    verdict.modelVersion.length > 0
      ? verdict.modelVersion
      : null;
  if (reported === null) return false;

  if (config.pinMode === "config") {
    return reported === config.expectedModelVersion;
  }

  // "response": self-reporting is enough unless the caller knows what the job
  // started under, in which case it must not have changed underneath it.
  const started = context?.pinnedModelVersion;
  if (typeof started === "string" && started.length > 0) {
    return reported === started;
  }
  return true;
}
