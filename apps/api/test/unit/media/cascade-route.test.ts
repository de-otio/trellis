/**
 * cascade-route: which axis-A verdicts get escalated to the deferred lane.
 *
 * The properties that matter here are SAFETY properties, and they are asserted
 * as properties rather than as examples because each of them is a statement
 * about every possible verdict, not about the ones somebody thought of:
 *
 *   - escalation never changes a decision;
 *   - a verdict that is not `review` is never escalated;
 *   - τ = 0 (or the lane switched off) escalates nothing, ever, which is the
 *     configuration this ships in;
 *   - raising τ is monotone — it can only ever escalate MORE.
 *
 * The last one is the operator's cost dial. If it were not monotone, turning
 * the knob would be unpredictable in the direction that costs money.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createCascadeRoute,
  CascadeRouteConfigError,
  routeOnConfidence,
  type CascadeRouteConfig,
} from "../../../src/lib/media/cascade-route.js";
import {
  explainFromLabels,
  type LabelPolicyConfig,
  type LabelPolicyExplanation,
  type LabelPolicyGround,
} from "../../../src/lib/media/label-policy.js";
import {
  MOCK_CATEGORY_A,
  MOCK_CATEGORY_B,
  type ModerationVerdict,
} from "../../../src/lib/media/moderation-provider.js";
import type { ModerationDecision } from "../../../src/lib/media/media-lifecycle.js";

const MOCK_VERSION = "mock-taxonomy-1";
const OTHER_VERSION = "mock-taxonomy-2";
const UNMAPPED = "mock-category-nobody-mapped";

const CATEGORIES = {
  [MOCK_CATEGORY_A]: { review: 0.5, quarantine: 0.9 },
  [MOCK_CATEGORY_B]: { review: 0.5, quarantine: 0.9 },
} as const;

const POLICY: LabelPolicyConfig = {
  categories: CATEGORIES,
  pinMode: "none",
  acceptUnpinnedTaxonomy: true,
};

const PINNED_POLICY: LabelPolicyConfig = {
  categories: CATEGORIES,
  pinMode: "config",
  expectedModelVersion: MOCK_VERSION,
};

/** An obviously-mock τ. Not an operative threshold; the real one is config. */
const MOCK_TAU = 0.75;

function routeConfig(over: Partial<CascadeRouteConfig> = {}): CascadeRouteConfig {
  return { tau: MOCK_TAU, enabled: true, ...over };
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

function explanation(
  ground: LabelPolicyGround,
  decision: ModerationDecision,
  drivingConfidence: number | null = null,
): LabelPolicyExplanation {
  return { ground, decision, drivingConfidence };
}

// ---------------------------------------------------------------------------
// Construction refuses rather than defaulting
// ---------------------------------------------------------------------------

describe("createCascadeRoute — refuses to invent a threshold", () => {
  it.each([
    ["absent τ", { enabled: true } as unknown as CascadeRouteConfig],
    ["a non-numeric τ", routeConfig({ tau: "0.5" as unknown as number })],
    ["a NaN τ", routeConfig({ tau: Number.NaN })],
    ["an infinite τ", routeConfig({ tau: Number.POSITIVE_INFINITY })],
    ["a negative τ", routeConfig({ tau: -0.1 })],
    ["an absent enabled flag", { tau: MOCK_TAU } as unknown as CascadeRouteConfig],
    ["a truthy non-boolean enabled", routeConfig({ enabled: 1 as unknown as boolean })],
    ["no config at all", null as unknown as CascadeRouteConfig],
  ])("refuses %s", (_name, cfg) => {
    expect(() => createCascadeRoute(cfg, POLICY)).toThrow(CascadeRouteConfigError);
  });

  it("ACCEPTS τ = 0 — escalating nothing is a posture, not a misconfiguration", () => {
    const route = createCascadeRoute(routeConfig({ tau: 0 }), POLICY);
    expect(route.inert).toBe(true);
  });

  it("reports inert when the lane is switched off", () => {
    expect(createCascadeRoute(routeConfig({ enabled: false }), POLICY).inert).toBe(true);
    expect(createCascadeRoute(routeConfig(), POLICY).inert).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The routing table
// ---------------------------------------------------------------------------

describe("routeOnConfidence — what escalates", () => {
  it("escalates a grey-band label below τ, reporting its own confidence", () => {
    const r = routeOnConfidence(explanation("over-review-bar", "review", 0.6), routeConfig());
    expect(r).toEqual({ kind: "escalate", confidence: 0.6, cause: "grey-band" });
  });

  it("settles a grey-band label AT τ — the bar is `>=`, like every other bar here", () => {
    const r = routeOnConfidence(
      explanation("over-review-bar", "review", MOCK_TAU),
      routeConfig(),
    );
    expect(r).toEqual({ kind: "settle", decision: "review", reason: "confident" });
  });

  it("escalates an unreadable confidence at q̂ = 0 — absence of a number, not a low one", () => {
    const r = routeOnConfidence(
      explanation("unreadable-confidence", "review"),
      routeConfig(),
    );
    expect(r).toEqual({ kind: "escalate", confidence: 0, cause: "unreadable-confidence" });
  });

  it("escalates the provider's fail-closed abstention at q̂ = 0", () => {
    const r = routeOnConfidence(explanation("provider-floor", "review"), routeConfig());
    expect(r).toEqual({ kind: "escalate", confidence: 0, cause: "provider-abstained" });
  });

  it("does NOT escalate a taxonomy pin failure — re-classifying cannot fix a config fault", () => {
    const r = routeOnConfidence(explanation("taxonomy-pin-failed", "review"), routeConfig());
    expect(r).toEqual({ kind: "settle", decision: "review", reason: "taxonomy-unpinned" });
  });

  it("does NOT escalate a malformed verdict", () => {
    const r = routeOnConfidence(explanation("malformed-verdict", "review"), routeConfig());
    expect(r).toEqual({ kind: "settle", decision: "review", reason: "malformed" });
  });

  it("does NOT escalate a quarantine — the lane cannot approve, so it could only confirm", () => {
    for (const ground of ["unmapped-category", "over-quarantine-bar", "provider-floor"] as const) {
      const r = routeOnConfidence(explanation(ground, "quarantine", 0.95), routeConfig());
      expect(r).toEqual({ kind: "settle", decision: "quarantine", reason: "decided" });
    }
  });

  it("does NOT escalate an approval — approved is an answer, not a dead end", () => {
    const r = routeOnConfidence(explanation("clean", "approved"), routeConfig());
    expect(r).toEqual({ kind: "settle", decision: "approved", reason: "decided" });
  });

  it("escalates nothing at all when τ = 0", () => {
    const r = routeOnConfidence(
      explanation("over-review-bar", "review", 0),
      routeConfig({ tau: 0 }),
    );
    expect(r).toEqual({ kind: "settle", decision: "review", reason: "lane-closed" });
  });

  it("escalates nothing at all when the lane is switched off", () => {
    const r = routeOnConfidence(
      explanation("over-review-bar", "review", 0.1),
      routeConfig({ enabled: false }),
    );
    expect(r).toEqual({ kind: "settle", decision: "review", reason: "lane-closed" });
  });
});

// ---------------------------------------------------------------------------
// End to end, through a real policy
// ---------------------------------------------------------------------------

describe("createCascadeRoute — over real verdicts", () => {
  const route = createCascadeRoute(routeConfig(), POLICY);

  it("escalates a weak grey-band signal", () => {
    const r = route.route(verdict({ labels: [{ category: MOCK_CATEGORY_A, confidence: 0.55 }] }));
    expect(r.kind).toBe("escalate");
  });

  it("settles a strong grey-band signal", () => {
    const r = route.route(verdict({ labels: [{ category: MOCK_CATEGORY_A, confidence: 0.85 }] }));
    expect(r).toEqual({ kind: "settle", decision: "review", reason: "confident" });
  });

  it("settles an unmapped category as the quarantine it already is", () => {
    const r = route.route(verdict({ labels: [{ category: UNMAPPED, confidence: 0.1 }] }));
    expect(r).toEqual({ kind: "settle", decision: "quarantine", reason: "decided" });
  });

  it("THE PIN TRAP: a slow model's verdict under a config pin never escalates", () => {
    // The escalation runs a different model reporting a different version. Read
    // by the INLINE lane's pinned policy it floors at review with a pin fault —
    // and this route correctly refuses to escalate it, because escalating it
    // again would produce another unpinnable verdict, forever. The lane needs
    // its own policy instance; see the module comment.
    const pinnedRoute = createCascadeRoute(routeConfig(), PINNED_POLICY);
    const slowModelVerdict = verdict({
      modelVersion: OTHER_VERSION,
      labels: [{ category: MOCK_CATEGORY_A, confidence: 0.55 }],
    });
    expect(pinnedRoute.route(slowModelVerdict)).toEqual({
      kind: "settle",
      decision: "review",
      reason: "taxonomy-unpinned",
    });
  });
});

// ---------------------------------------------------------------------------
// Safety properties
// ---------------------------------------------------------------------------

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
          fc.constant(undefined),
        ),
      }),
      { maxLength: 5 },
    ),
    fc.constant(undefined),
  ),
  provider: fc.constant("mock"),
  modelVersion: fc.oneof(fc.constantFrom(MOCK_VERSION, OTHER_VERSION), fc.constant(undefined)),
}) as unknown as fc.Arbitrary<ModerationVerdict>;

const arbTau = fc.double({ min: 0, max: 1, noNaN: true });

describe("cascade route — safety properties", () => {
  it("a settle NEVER changes the policy's decision", () => {
    fc.assert(
      fc.property(arbVerdict, arbTau, fc.boolean(), (v, tau, enabled) => {
        const r = routeOnConfidence(explainFromLabels(v, POLICY), { tau, enabled });
        if (r.kind === "settle") {
          expect(r.decision).toBe(explainFromLabels(v, POLICY).decision);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("only a `review` is ever escalated", () => {
    fc.assert(
      fc.property(arbVerdict, arbTau, (v, tau) => {
        const explained = explainFromLabels(v, POLICY);
        const r = routeOnConfidence(explained, { tau, enabled: true });
        if (r.kind === "escalate") {
          expect(explained.decision).toBe("review");
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("τ = 0 escalates nothing, for any verdict", () => {
    fc.assert(
      fc.property(arbVerdict, (v) => {
        const r = routeOnConfidence(explainFromLabels(v, POLICY), { tau: 0, enabled: true });
        expect(r.kind).toBe("settle");
      }),
      { numRuns: 2000 },
    );
  });

  it("a disabled lane escalates nothing, for any verdict and any τ", () => {
    fc.assert(
      fc.property(arbVerdict, arbTau, (v, tau) => {
        const r = routeOnConfidence(explainFromLabels(v, POLICY), { tau, enabled: false });
        expect(r.kind).toBe("settle");
      }),
      { numRuns: 2000 },
    );
  });

  it("τ is MONOTONE: raising it can only ever escalate more", () => {
    // The operator's cost dial. A non-monotone knob is one nobody can turn
    // safely, because the direction that costs money would be unpredictable.
    fc.assert(
      fc.property(arbVerdict, arbTau, arbTau, (v, a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const explained = explainFromLabels(v, POLICY);
        const atLo = routeOnConfidence(explained, { tau: lo, enabled: true });
        const atHi = routeOnConfidence(explained, { tau: hi, enabled: true });
        if (atLo.kind === "escalate" && lo > 0) {
          expect(atHi.kind).toBe("escalate");
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("never throws, for any verdict at all", () => {
    const route = createCascadeRoute(routeConfig(), POLICY);
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(() => route.route(v as ModerationVerdict)).not.toThrow();
      }),
      { numRuns: 1000 },
    );
  });
});
