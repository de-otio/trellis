/**
 * Tests for how the label policy treats the taxonomy VERSION a verdict reports:
 * accepting a set of versions, the `onUnacceptedVersion` action, and the rule
 * that an unmapped label is taxonomy drift whatever the version.
 *
 * Categories, bars and versions are obviously-mock tokens.
 */

import { describe, expect, it } from "vitest";

import {
  createLabelPolicy,
  explainFromLabels,
  LabelPolicyConfigError,
  type LabelPolicyConfig,
} from "../../../src/lib/media/label-policy.js";
import {
  MOCK_CATEGORY_A,
  MOCK_CATEGORY_B,
  type ModerationVerdict,
} from "../../../src/lib/media/moderation-provider.js";
import type { ModerationDecision } from "../../../src/lib/media/media-lifecycle.js";

const V1 = "mock-taxonomy-1";
const V2 = "mock-taxonomy-2";
const V3 = "mock-taxonomy-3";

const CATEGORIES = {
  [MOCK_CATEGORY_A]: { review: 0.5, quarantine: 0.9 },
  [MOCK_CATEGORY_B]: { review: 0.5, quarantine: 0.9 },
};

function cfg(over: Partial<LabelPolicyConfig> = {}): LabelPolicyConfig {
  return {
    categories: CATEGORIES,
    pinMode: "config",
    expectedModelVersion: V1,
    ...over,
  };
}

function verdictOf(
  labels: Array<{ category: string; confidence: number }>,
  modelVersion: string | undefined,
  decision: ModerationDecision = "approved",
): ModerationVerdict {
  return {
    decision,
    labels,
    provider: "mock",
    ...(modelVersion !== undefined && { modelVersion }),
  };
}

const CLEAN = [{ category: MOCK_CATEGORY_A, confidence: 0.01 }];
const UNMAPPED = [
  { category: MOCK_CATEGORY_A, confidence: 0.01 },
  { category: "mock_category_unmapped", confidence: 0.01 },
];

describe('onUnacceptedVersion: "warn"', () => {
  const warn = cfg({ onUnacceptedVersion: "warn" });

  it("decides normally and warns when the version is unaccepted and every label maps", () => {
    const out = explainFromLabels(verdictOf(CLEAN, V2), warn);
    expect(out.decision).toBe("approved");
    expect(out.ground).toBe("clean");
    expect(out.versionWarning).toBe(true);
  });

  it("applies the labels normally: a label over its bar still reviews / quarantines", () => {
    const grey = [{ category: MOCK_CATEGORY_A, confidence: 0.6 }];
    const hot = [{ category: MOCK_CATEGORY_A, confidence: 0.95 }];
    expect(explainFromLabels(verdictOf(grey, V2), warn)).toMatchObject({
      decision: "review",
      ground: "over-review-bar",
      versionWarning: true,
    });
    expect(explainFromLabels(verdictOf(hot, V2), warn)).toMatchObject({
      decision: "quarantine",
      versionWarning: true,
    });
  });

  it("holds as taxonomy-drift when one returned label is unmapped", () => {
    const out = explainFromLabels(verdictOf(UNMAPPED, V2), warn);
    expect(out.decision).toBe("review");
    expect(out.ground).toBe("taxonomy-drift");
  });

  it("does not warn when the version is accepted", () => {
    const out = explainFromLabels(verdictOf(CLEAN, V1), warn);
    expect(out.decision).toBe("approved");
    expect(out).not.toHaveProperty("versionWarning");
  });

  it("still holds a verdict that reports NO version: there is nothing to warn about", () => {
    const out = explainFromLabels(verdictOf(CLEAN, undefined), warn);
    expect(out).toMatchObject({ decision: "review", ground: "taxonomy-pin-failed" });
    expect(out).not.toHaveProperty("versionWarning");
  });

  it("does not approve an EMPTY label array from an unaccepted version", () => {
    const out = explainFromLabels(verdictOf([], V2), warn);
    expect(out).toMatchObject({ decision: "review", ground: "taxonomy-pin-failed" });
  });

  it("never lifts the provider's own decision", () => {
    const out = explainFromLabels(verdictOf(CLEAN, V2, "review"), warn);
    expect(out.decision).toBe("review");
  });

  it("is exposed through the constructed policy's explain()", () => {
    const policy = createLabelPolicy(warn);
    expect(policy.explain?.(verdictOf(CLEAN, V2))?.versionWarning).toBe(true);
    expect(policy.decide(verdictOf(CLEAN, V2))).toBe("approved");
  });

  it("is refused outside pinMode config", () => {
    expect(() =>
      createLabelPolicy({
        categories: CATEGORIES,
        pinMode: "response",
        onUnacceptedVersion: "warn",
      }),
    ).toThrow(LabelPolicyConfigError);
  });

  it("refuses an unrecognised action", () => {
    expect(() =>
      createLabelPolicy(cfg({ onUnacceptedVersion: "ignore" as never })),
    ).toThrow(LabelPolicyConfigError);
  });
});

describe('onUnacceptedVersion: "hold" (default) — unchanged behaviour', () => {
  for (const [name, over] of [
    ["omitted", {}],
    ["explicit", { onUnacceptedVersion: "hold" as const }],
  ] as const) {
    it(`floors an unaccepted version at review (${name})`, () => {
      const out = explainFromLabels(verdictOf(CLEAN, V2), cfg(over));
      expect(out).toMatchObject({ decision: "review", ground: "taxonomy-pin-failed" });
      expect(out).not.toHaveProperty("versionWarning");
    });
  }

  it("never lifts a quarantine", () => {
    const hot = [{ category: MOCK_CATEGORY_A, confidence: 0.95 }];
    expect(explainFromLabels(verdictOf(hot, V2), cfg()).decision).toBe("quarantine");
  });
});

describe("a set of accepted versions", () => {
  const accepted = [
    ["Set", new Set([V1, V2])],
    ["array", [V1, V2]],
  ] as const;

  for (const [kind, expectedModelVersion] of accepted) {
    it(`accepts any member (${kind}) and holds a non-member`, () => {
      const policy = createLabelPolicy(cfg({ expectedModelVersion }));
      expect(policy.decide(verdictOf(CLEAN, V1))).toBe("approved");
      expect(policy.decide(verdictOf(CLEAN, V2))).toBe("approved");
      expect(policy.decide(verdictOf(CLEAN, V3))).toBe("review");
    });
  }

  it("refuses an empty set", () => {
    expect(() => createLabelPolicy(cfg({ expectedModelVersion: new Set() }))).toThrow(
      LabelPolicyConfigError,
    );
  });

  it("snapshots the set, so later mutation cannot widen the pin", () => {
    const mutable = new Set([V1]);
    const policy = createLabelPolicy(cfg({ expectedModelVersion: mutable }));
    mutable.add(V3);
    expect(policy.decide(verdictOf(CLEAN, V3))).toBe("review");
  });
});

describe("an unmapped label is taxonomy drift, whatever the version", () => {
  const pins: Array<[string, LabelPolicyConfig, string | undefined]> = [
    ["accepted version", cfg(), V1],
    ["unaccepted, hold", cfg(), V2],
    ["unaccepted, warn", cfg({ onUnacceptedVersion: "warn" }), V2],
    ["no version reported", cfg(), undefined],
    ["unpinned", cfg({ pinMode: "none", acceptUnpinnedTaxonomy: true }), undefined],
  ];
  for (const [name, config, version] of pins) {
    it(`reviews with ground taxonomy-drift (${name})`, () => {
      const out = explainFromLabels(verdictOf(UNMAPPED, version), config);
      expect(out.decision).toBe("review");
      expect(out.ground).toBe("taxonomy-drift");
    });
  }

  it("does not hide a mapped label over its quarantine bar", () => {
    const labels = [
      { category: "mock_category_unmapped", confidence: 0 },
      { category: MOCK_CATEGORY_B, confidence: 0.99 },
    ];
    expect(explainFromLabels(verdictOf(labels, V1), cfg()).decision).toBe("quarantine");
  });
});
