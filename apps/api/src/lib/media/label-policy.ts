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
 *  5. **The policy can only ever DEGRADE the provider's verdict.** The result
 *     is floored at what the provider itself said, so a policy can turn an
 *     `approved` into a `review` and never the reverse.
 *
 *     This one is load-bearing and easy to get wrong, because the natural
 *     implementation — derive a decision from the labels and return it — is
 *     wrong in a way that inverts the whole pipeline. A provider that hits an
 *     internal fault does what the seam contract REQUIRES: it returns
 *     `{ decision: "review", labels: [] }`. Interpreting that from labels alone
 *     yields "no labels, pin fine, therefore approved" — the fail-closed
 *     verdict becomes an approval, and the fail-closed Null provider approves
 *     everything. Some verdicts are also not expressible as labels at all (a
 *     hash match, a rate-limit refusal), and those must survive interpretation
 *     untouched.
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
   * The same interpretation, with the ground it rests on. `review` collapses
   * several distinct situations and only some of them are worth escalating to
   * the deferred lane; this is how a caller tells them apart. See
   * {@link explainFromLabels}.
   *
   * OPTIONAL, and deliberately so. `LabelPolicy` is exported from the package
   * index and injected through the public `setMediaLabelPolicy` seam, so a
   * consuming app may be passing a hand-rolled object. A required method here
   * would break every such implementation on upgrade, for a capability none of
   * them asked for. `createLabelPolicy` always provides it, and the cascade
   * route calls {@link explainFromLabels} directly rather than depending on
   * this — so a policy without it degrades to "no escalation", never to a
   * crash.
   */
  explain?(
    verdict: ModerationVerdict,
    context?: LabelPolicyContext,
  ): LabelPolicyExplanation;
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
    explain(verdict, context) {
      return explainFromLabels(verdict, frozen, context);
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
  return explainFromLabels(verdict, config, context).decision;
}

/**
 * WHY a verdict decided the way it did.
 *
 * `decide` collapses several distinct situations onto the same `review`, and
 * for the cascade route (`cascade-route.ts`) that collapse is exactly the
 * information it needs back: "the scorer saw a weak signal" and "the taxonomy
 * pin failed" are both `review`, and only the first is worth paying a
 * reasoning-model call to resolve. Rather than re-deriving the reason from the
 * labels at the call site — two readings of one policy is how they drift apart
 * — the policy reports it.
 *
 * `"provider-floor"` means the provider's own verdict dominated, which under
 * the seam's fail-closed contract (`{ decision: "review", labels: [] }`) is
 * also how an internally-faulted provider reports. It is not distinguishable
 * from a deliberate provider `review`, and the cascade route treats both the
 * same way, deliberately.
 */
export type LabelPolicyGround =
  /** Nothing fired: approved on the merits. */
  | "clean"
  /** A label the policy has no rule for (rule 2). Always `quarantine`. */
  | "unmapped-category"
  /** A mapped label at or above its quarantine bar. */
  | "over-quarantine-bar"
  /** A mapped label in the grey band — at/above `review`, below `quarantine`. */
  | "over-review-bar"
  /** A mapped label whose confidence was not a usable number. */
  | "unreadable-confidence"
  /** The taxonomy pin did not verify, so the decision was floored at `review`. */
  | "taxonomy-pin-failed"
  /** The provider's own decision dominated everything the labels said. */
  | "provider-floor"
  /** The verdict was not a usable object, or carried no label array. */
  | "malformed-verdict";

/** A decision plus the ground it rests on. */
export interface LabelPolicyExplanation {
  readonly decision: ModerationDecision;
  readonly ground: LabelPolicyGround;
  /**
   * The confidence of the label that produced `ground`, on the PROVIDER's own
   * scale — never rescaled, for the reason {@link LabelPolicyConfig} gives.
   * `null` when no single label drove the result (a pin failure, a malformed
   * verdict, a provider floor, an unreadable confidence — which is precisely
   * the absence of a usable number).
   */
  readonly drivingConfidence: number | null;
}

/**
 * The decision function, with its reasoning. {@link decideFromLabels} is this
 * function with the reasoning discarded — one implementation, so the reason a
 * caller acts on is always the reason the decision was actually made.
 *
 * GROUND PRECEDENCE, where several apply to one `review`, is ordered by what a
 * caller must not spend money on: `taxonomy-pin-failed` first, because a policy
 * whose map may no longer mean what it says is a configuration fault and no
 * amount of re-classification fixes it. Then the label-derived grounds, then
 * the provider floor.
 *
 * Total: never throws, for any verdict shape.
 */
export function explainFromLabels(
  verdict: ModerationVerdict,
  config: LabelPolicyConfig,
  context?: LabelPolicyContext,
): LabelPolicyExplanation {
  const pinOk = verifyTaxonomyPin(verdict, config, context);
  const floor: ModerationDecision = pinOk ? "approved" : "review";

  if (verdict === null || typeof verdict !== "object") {
    return { decision: "review", ground: "malformed-verdict", drivingConfidence: null };
  }

  // Rule 5: the provider's own decision is a FLOOR, never a starting point to
  // be overwritten. An unrecognised decision reads as `review` — this function
  // must not be a way to launder a malformed verdict into an approval.
  const providerFloor: ModerationDecision =
    verdict.decision === "approved" ||
    verdict.decision === "review" ||
    verdict.decision === "quarantine"
      ? verdict.decision
      : "review";

  const labels = Array.isArray(verdict.labels) ? verdict.labels : null;
  if (labels === null) {
    // A verdict that does not even carry a label array tells us nothing.
    const decision = worse("review", providerFloor);
    return {
      decision,
      // A quarantine here came from the provider; a review came from the
      // missing array, which is the more specific fault of the two.
      ground: decision === "quarantine" ? "provider-floor" : "malformed-verdict",
      drivingConfidence: null,
    };
  }

  let decision: ModerationDecision = "approved";
  // The strongest grey-band signal seen, and whether any mapped label came
  // with a confidence we could not read. Both are only consulted if the final
  // result is `review`; a `quarantine` returns early from inside the loop.
  let greyBandMax: number | null = null;
  let sawUnreadable = false;
  for (const label of labels) {
    const category =
      label !== null && typeof label === "object" && typeof label.category === "string"
        ? label.category
        : null;
    if (category === null) {
      // A label we cannot even name is an unmapped label.
      return {
        decision: "quarantine",
        ground: "unmapped-category",
        drivingConfidence: null,
      };
    }
    const policy = Object.prototype.hasOwnProperty.call(
      config.categories,
      category,
    )
      ? config.categories[category]
      : undefined;
    if (policy === undefined) {
      // Rule 2: unmapped dominates, whatever else is in the array.
      return {
        decision: "quarantine",
        ground: "unmapped-category",
        drivingConfidence: null,
      };
    }
    const confidence =
      typeof label.confidence === "number" && Number.isFinite(label.confidence)
        ? label.confidence
        : null;
    if (confidence === null) {
      // Mapped category, unusable confidence: we know the category matters and
      // cannot tell how much. That is doubt, and doubt reviews.
      decision = worse(decision, "review");
      sawUnreadable = true;
      continue;
    }
    if (confidence >= policy.quarantine) {
      return {
        decision: "quarantine",
        ground: "over-quarantine-bar",
        drivingConfidence: confidence,
      };
    }
    if (confidence >= policy.review) {
      decision = worse(decision, "review");
      greyBandMax = greyBandMax === null || confidence > greyBandMax ? confidence : greyBandMax;
    }
  }

  const result = worse(worse(decision, floor), providerFloor);

  if (result === "approved") {
    return { decision: result, ground: "clean", drivingConfidence: null };
  }
  if (result === "quarantine") {
    // Nothing in the loop reached a quarantine bar (those return early) and
    // the pin floor only ever reaches `review`, so this is the provider's.
    return { decision: result, ground: "provider-floor", drivingConfidence: null };
  }

  // A `review`, and possibly several grounds at once. Precedence per the
  // doc comment: the configuration fault first, then what the labels said,
  // then the provider.
  if (!pinOk) {
    return { decision: result, ground: "taxonomy-pin-failed", drivingConfidence: null };
  }
  if (greyBandMax !== null) {
    return { decision: result, ground: "over-review-bar", drivingConfidence: greyBandMax };
  }
  if (sawUnreadable) {
    return { decision: result, ground: "unreadable-confidence", drivingConfidence: null };
  }
  return { decision: result, ground: "provider-floor", drivingConfidence: null };
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
