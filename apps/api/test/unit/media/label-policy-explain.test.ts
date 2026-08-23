/**
 * The explanation half of label-policy: `explainFromLabels` reports WHICH of
 * the several situations that collapse onto `review` actually applied.
 *
 * Two kinds of test here, and the second is the load-bearing one:
 *
 *  1. Table-driven ground assertions.
 *  2. A BEHAVIOUR COMPARISON against the pre-refactor implementation of
 *     `decideFromLabels`, transcribed verbatim below. `decideFromLabels` now
 *     delegates to `explainFromLabels`, so asserting the two agree with each
 *     other would be tautological — it would pass no matter how wrong the
 *     shared implementation became. The reference is an INDEPENDENT oracle, and
 *     the property test drives it with arbitrary verdicts including malformed
 *     ones.
 *
 * The negative control for that comparison is at the bottom: a deliberately
 * broken reference must make the property FAIL. A comparison that cannot fail
 * proves nothing, which is the same lesson as a `try` block that only logs.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  decideFromLabels,
  explainFromLabels,
  createLabelPolicy,
  type LabelPolicyConfig,
  type LabelPolicyGround,
} from "../../../src/lib/media/label-policy.js";
import {
  MOCK_CATEGORY_A,
  MOCK_CATEGORY_B,
  type ModerationVerdict,
} from "../../../src/lib/media/moderation-provider.js";
import type { ModerationDecision } from "../../../src/lib/media/media-lifecycle.js";

// Obviously-mock tokens and obviously-mock bars. Nothing here is, or resembles,
// an operative threshold.
const MOCK_VERSION = "mock-taxonomy-1";
const OTHER_VERSION = "mock-taxonomy-2";
const UNMAPPED = "mock-category-nobody-mapped";

const CATEGORIES = {
  [MOCK_CATEGORY_A]: { review: 0.5, quarantine: 0.9 },
  [MOCK_CATEGORY_B]: { review: 0.5, quarantine: 0.9 },
} as const;

function config(over: Partial<LabelPolicyConfig> = {}): LabelPolicyConfig {
  return {
    categories: CATEGORIES,
    pinMode: "none",
    acceptUnpinnedTaxonomy: true,
    ...over,
  };
}

function verdict(over: Partial<ModerationVerdict> = {}): ModerationVerdict {
  return {
    decision: "approved",
    labels: [],
    provider: "mock",
    modelVersion: MOCK_VERSION,
    ...over,
  } as ModerationVerdict;
}

// ---------------------------------------------------------------------------
// 1. Grounds
// ---------------------------------------------------------------------------

describe("explainFromLabels — the ground a decision rests on", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly verdict: ModerationVerdict;
    readonly config?: LabelPolicyConfig;
    readonly decision: ModerationDecision;
    readonly ground: LabelPolicyGround;
    readonly drivingConfidence: number | null;
  }> = [
    {
      name: "an approved verdict with no labels is clean",
      verdict: verdict(),
      decision: "approved",
      ground: "clean",
      drivingConfidence: null,
    },
    {
      name: "a label in the grey band reports its own confidence",
      verdict: verdict({ labels: [{ category: MOCK_CATEGORY_A, confidence: 0.7 }] }),
      decision: "review",
      ground: "over-review-bar",
      drivingConfidence: 0.7,
    },
    {
      name: "the STRONGEST grey-band label drives, not the first",
      verdict: verdict({
        labels: [
          { category: MOCK_CATEGORY_A, confidence: 0.55 },
          { category: MOCK_CATEGORY_B, confidence: 0.8 },
          { category: MOCK_CATEGORY_A, confidence: 0.6 },
        ],
      }),
      decision: "review",
      ground: "over-review-bar",
      drivingConfidence: 0.8,
    },
    {
      name: "a label at the quarantine bar reports over-quarantine-bar",
      verdict: verdict({ labels: [{ category: MOCK_CATEGORY_A, confidence: 0.95 }] }),
      decision: "quarantine",
      ground: "over-quarantine-bar",
      drivingConfidence: 0.95,
    },
    {
      name: "an unmapped category is unmapped-category, not over-quarantine-bar",
      verdict: verdict({ labels: [{ category: UNMAPPED, confidence: 0.1 }] }),
      decision: "quarantine",
      ground: "unmapped-category",
      drivingConfidence: null,
    },
    {
      name: "a label with no usable name is also unmapped-category",
      verdict: verdict({
        labels: [{ confidence: 0.1 } as unknown as { category: string; confidence: number }],
      }),
      decision: "quarantine",
      ground: "unmapped-category",
      drivingConfidence: null,
    },
    {
      name: "a mapped category with an unusable confidence reports unreadable-confidence",
      verdict: verdict({
        labels: [
          {
            category: MOCK_CATEGORY_A,
            confidence: Number.NaN,
          },
        ],
      }),
      decision: "review",
      ground: "unreadable-confidence",
      drivingConfidence: null,
    },
    {
      name: "the seam's fail-closed shape reports provider-floor",
      verdict: verdict({ decision: "review", labels: [] }),
      decision: "review",
      ground: "provider-floor",
      drivingConfidence: null,
    },
    {
      name: "a provider quarantine with clean labels reports provider-floor",
      verdict: verdict({ decision: "quarantine", labels: [] }),
      decision: "quarantine",
      ground: "provider-floor",
      drivingConfidence: null,
    },
    {
      name: "a failed config pin reports taxonomy-pin-failed",
      verdict: verdict({ modelVersion: OTHER_VERSION }),
      config: config({ pinMode: "config", expectedModelVersion: MOCK_VERSION }),
      decision: "review",
      ground: "taxonomy-pin-failed",
      drivingConfidence: null,
    },
    {
      name: "an absent version under a pinned mode reports taxonomy-pin-failed",
      verdict: verdict({ modelVersion: undefined }),
      config: config({ pinMode: "response" }),
      decision: "review",
      ground: "taxonomy-pin-failed",
      drivingConfidence: null,
    },
    {
      name: "a non-object verdict reports malformed-verdict",
      verdict: null as unknown as ModerationVerdict,
      decision: "review",
      ground: "malformed-verdict",
      drivingConfidence: null,
    },
    {
      name: "a verdict with no label array reports malformed-verdict",
      verdict: verdict({ labels: undefined as unknown as [] }),
      decision: "review",
      ground: "malformed-verdict",
      drivingConfidence: null,
    },
    {
      name: "no label array but a provider quarantine keeps the provider's ground",
      verdict: verdict({ decision: "quarantine", labels: undefined as unknown as [] }),
      decision: "quarantine",
      ground: "provider-floor",
      drivingConfidence: null,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = explainFromLabels(c.verdict, c.config ?? config());
      expect(result.decision).toBe(c.decision);
      expect(result.ground).toBe(c.ground);
      expect(result.drivingConfidence).toBe(c.drivingConfidence);
    });
  }

  it("prefers taxonomy-pin-failed over a grey-band label", () => {
    // Both apply. The pin fault must win, because it is the one no amount of
    // re-classification can fix — and the cascade route reads this to decide
    // whether to spend money.
    const result = explainFromLabels(
      verdict({
        modelVersion: OTHER_VERSION,
        labels: [{ category: MOCK_CATEGORY_A, confidence: 0.7 }],
      }),
      config({ pinMode: "config", expectedModelVersion: MOCK_VERSION }),
    );
    expect(result.decision).toBe("review");
    expect(result.ground).toBe("taxonomy-pin-failed");
  });

  it("prefers a grey-band label over the provider floor", () => {
    const result = explainFromLabels(
      verdict({ decision: "review", labels: [{ category: MOCK_CATEGORY_A, confidence: 0.7 }] }),
      config(),
    );
    expect(result.ground).toBe("over-review-bar");
    expect(result.drivingConfidence).toBe(0.7);
  });

  it("prefers a grey-band label over an unreadable one", () => {
    const result = explainFromLabels(
      verdict({
        labels: [
          { category: MOCK_CATEGORY_A, confidence: Number.POSITIVE_INFINITY },
          { category: MOCK_CATEGORY_B, confidence: 0.6 },
        ],
      }),
      config(),
    );
    expect(result.ground).toBe("over-review-bar");
    expect(result.drivingConfidence).toBe(0.6);
  });

  it("is exposed on the constructed policy, not only as a free function", () => {
    const policy = createLabelPolicy(config());
    const v = verdict({ labels: [{ category: MOCK_CATEGORY_A, confidence: 0.7 }] });
    expect(policy.explain(v).ground).toBe("over-review-bar");
    expect(policy.explain(v).decision).toBe(policy.decide(v));
  });
});

// ---------------------------------------------------------------------------
// 2. Behaviour comparison against the pre-refactor implementation
// ---------------------------------------------------------------------------

/**
 * `decideFromLabels` EXACTLY as it stood before `explainFromLabels` was
 * extracted from it. Transcribed, not imported — the whole point is that it is
 * a second, independent statement of the same rules.
 */
function referenceDecide(
  v: ModerationVerdict,
  cfg: LabelPolicyConfig,
  opts: { readonly breakIt?: boolean } = {},
): ModerationDecision {
  const SEVERITY: Record<ModerationDecision, number> = {
    approved: 0,
    review: 1,
    quarantine: 2,
  };
  const worse = (a: ModerationDecision, b: ModerationDecision): ModerationDecision =>
    SEVERITY[a] >= SEVERITY[b] ? a : b;

  const pinOk = referenceVerifyPin(v, cfg);
  const floor: ModerationDecision = pinOk ? "approved" : "review";

  if (v === null || typeof v !== "object") return "review";

  const providerFloor: ModerationDecision =
    v.decision === "approved" || v.decision === "review" || v.decision === "quarantine"
      ? v.decision
      : "review";

  const labels = Array.isArray(v.labels) ? v.labels : null;
  if (labels === null) return worse("review", providerFloor);

  let decision: ModerationDecision = "approved";
  for (const label of labels) {
    const category =
      label !== null && typeof label === "object" && typeof label.category === "string"
        ? label.category
        : null;
    if (category === null) return "quarantine";
    const policy = Object.prototype.hasOwnProperty.call(cfg.categories, category)
      ? cfg.categories[category]
      : undefined;
    if (policy === undefined) return "quarantine";
    const confidence =
      typeof label.confidence === "number" && Number.isFinite(label.confidence)
        ? label.confidence
        : null;
    if (confidence === null) {
      // THE MUTATION: the negative control flips this doubt into silence.
      if (opts.breakIt !== true) decision = worse(decision, "review");
      continue;
    }
    if (confidence >= policy.quarantine) return "quarantine";
    if (confidence >= policy.review) decision = worse(decision, "review");
  }

  return worse(worse(decision, floor), providerFloor);
}

function referenceVerifyPin(v: ModerationVerdict, cfg: LabelPolicyConfig): boolean {
  if (cfg.pinMode === "none") return true;
  const reported =
    v !== null &&
    typeof v === "object" &&
    typeof v.modelVersion === "string" &&
    v.modelVersion.length > 0
      ? v.modelVersion
      : null;
  if (reported === null) return false;
  if (cfg.pinMode === "config") return reported === cfg.expectedModelVersion;
  return true;
}

/** Verdicts including every malformed shape the policy promises to survive. */
const arbVerdict = fc.record({
  decision: fc.oneof(
    fc.constantFrom("approved", "review", "quarantine"),
    fc.constant(undefined),
    fc.string(),
  ),
  labels: fc.oneof(
    fc.array(
      fc.record({
        category: fc.oneof(
          fc.constantFrom(MOCK_CATEGORY_A, MOCK_CATEGORY_B, UNMAPPED),
          fc.constant(undefined),
        ),
        confidence: fc.oneof(
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.constant(Number.NaN),
          fc.constant(Number.POSITIVE_INFINITY),
          fc.constant(undefined),
        ),
      }),
      { maxLength: 5 },
    ),
    fc.constant(undefined),
  ),
  provider: fc.constant("mock"),
  modelVersion: fc.oneof(
    fc.constantFrom(MOCK_VERSION, OTHER_VERSION),
    fc.constant(undefined),
  ),
}) as unknown as fc.Arbitrary<ModerationVerdict>;

const arbConfig = fc.oneof(
  fc.constant(config()),
  fc.constant(config({ pinMode: "response", acceptUnpinnedTaxonomy: undefined })),
  fc.constant(
    config({
      pinMode: "config",
      expectedModelVersion: MOCK_VERSION,
      acceptUnpinnedTaxonomy: undefined,
    }),
  ),
);

describe("explainFromLabels — behaviour comparison with the pre-refactor decision", () => {
  it("agrees with the reference implementation on arbitrary verdicts", () => {
    fc.assert(
      fc.property(arbVerdict, arbConfig, (v, cfg) => {
        expect(explainFromLabels(v, cfg).decision).toBe(referenceDecide(v, cfg));
      }),
      { numRuns: 2000 },
    );
  });

  it("decideFromLabels still agrees too", () => {
    fc.assert(
      fc.property(arbVerdict, arbConfig, (v, cfg) => {
        expect(decideFromLabels(v, cfg)).toBe(referenceDecide(v, cfg));
      }),
      { numRuns: 2000 },
    );
  });

  it("NEGATIVE CONTROL: a broken reference makes the comparison fail", () => {
    // If this passes, the two properties above are vacuous and prove nothing.
    // The mutation is one line — an unreadable confidence stops meaning doubt.
    let disagreed = false;
    try {
      fc.assert(
        fc.property(arbVerdict, arbConfig, (v, cfg) => {
          expect(explainFromLabels(v, cfg).decision).toBe(
            referenceDecide(v, cfg, { breakIt: true }),
          );
        }),
        { numRuns: 2000 },
      );
    } catch {
      disagreed = true;
    }
    expect(disagreed).toBe(true);
  });

  it("never throws, for any verdict at all", () => {
    fc.assert(
      fc.property(fc.anything(), arbConfig, (v, cfg) => {
        expect(() => explainFromLabels(v as ModerationVerdict, cfg)).not.toThrow();
      }),
      { numRuns: 1000 },
    );
  });
});
