import { describe, expect, it } from "vitest";

import {
  createLabelPolicy,
  decideFromLabels,
  LabelPolicyConfigError,
  type LabelPolicyConfig,
} from "../../../src/lib/media/label-policy.js";
import {
  MOCK_CATEGORY_A,
  MOCK_CATEGORY_B,
  type ModerationVerdict,
} from "../../../src/lib/media/moderation-provider.js";

// Obviously-mock category tokens and obviously-mock bars. Nothing here is, or
// resembles, an operative threshold.
const MOCK_VERSION = "mock-taxonomy-1";
const OTHER_VERSION = "mock-taxonomy-2";

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

function verdictOf(
  labels: Array<{ category: string; confidence: number }>,
  modelVersion?: string,
): ModerationVerdict {
  return {
    decision: "review",
    labels,
    provider: "mock",
    ...(modelVersion !== undefined && { modelVersion }),
  };
}

describe("createLabelPolicy — refuses to construct without a policy", () => {
  it("throws when the category map is missing", () => {
    expect(() =>
      createLabelPolicy({ pinMode: "none", acceptUnpinnedTaxonomy: true } as never),
    ).toThrow(LabelPolicyConfigError);
  });

  it("throws when the category map is not an object", () => {
    expect(() =>
      createLabelPolicy({
        categories: "everything" as never,
        pinMode: "none",
        acceptUnpinnedTaxonomy: true,
      }),
    ).toThrow(LabelPolicyConfigError);
  });

  it("accepts an EMPTY map — that is a coherent policy, not a missing one", () => {
    const policy = createLabelPolicy(config({ categories: {} }));
    // Every reported category is therefore unmapped.
    expect(
      policy.decide(verdictOf([{ category: MOCK_CATEGORY_A, confidence: 0 }])),
    ).toBe("quarantine");
    // ...but a verdict with no labels at all still approves.
    expect(policy.decide(verdictOf([]))).toBe("approved");
  });

  it("throws on an unrecognised pin mode", () => {
    expect(() =>
      createLabelPolicy(config({ pinMode: "whatever" as never })),
    ).toThrow(LabelPolicyConfigError);
  });

  it('throws when "config" mode names no version', () => {
    expect(() => createLabelPolicy(config({ pinMode: "config" }))).toThrow(
      LabelPolicyConfigError,
    );
    expect(() =>
      createLabelPolicy(config({ pinMode: "config", expectedModelVersion: "" })),
    ).toThrow(LabelPolicyConfigError);
  });

  it('throws when "none" mode was requested without the explicit opt-in', () => {
    expect(() =>
      createLabelPolicy({ categories: CATEGORIES, pinMode: "none" }),
    ).toThrow(LabelPolicyConfigError);
    expect(() =>
      createLabelPolicy({
        categories: CATEGORIES,
        pinMode: "none",
        acceptUnpinnedTaxonomy: false,
      }),
    ).toThrow(LabelPolicyConfigError);
  });

  it("exposes unpinnedTaxonomy as a standing flag", () => {
    expect(createLabelPolicy(config()).unpinnedTaxonomy).toBe(true);
    expect(
      createLabelPolicy(
        config({ pinMode: "config", expectedModelVersion: MOCK_VERSION }),
      ).unpinnedTaxonomy,
    ).toBe(false);
    expect(
      createLabelPolicy(config({ pinMode: "response" })).unpinnedTaxonomy,
    ).toBe(false);
  });
});

describe("decideFromLabels — category mapping", () => {
  const unpinned = config();

  const table: Array<{
    name: string;
    labels: Array<{ category: string; confidence: number }>;
    expected: string;
  }> = [
    { name: "no labels", labels: [], expected: "approved" },
    {
      name: "below every bar",
      labels: [{ category: MOCK_CATEGORY_A, confidence: 0.1 }],
      expected: "approved",
    },
    {
      name: "at the review bar",
      labels: [{ category: MOCK_CATEGORY_A, confidence: 0.5 }],
      expected: "review",
    },
    {
      name: "at the quarantine bar",
      labels: [{ category: MOCK_CATEGORY_A, confidence: 0.9 }],
      expected: "quarantine",
    },
    {
      name: "worst label wins",
      labels: [
        { category: MOCK_CATEGORY_A, confidence: 0.1 },
        { category: MOCK_CATEGORY_B, confidence: 0.6 },
      ],
      expected: "review",
    },
    {
      name: "quarantine dominates a benign majority",
      labels: [
        { category: MOCK_CATEGORY_A, confidence: 0.0 },
        { category: MOCK_CATEGORY_A, confidence: 0.0 },
        { category: MOCK_CATEGORY_B, confidence: 0.95 },
      ],
      expected: "quarantine",
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      expect(decideFromLabels(verdictOf(row.labels), unpinned)).toBe(row.expected);
    });
  }

  it("quarantines an unmapped category even when every other label approves", () => {
    const labels = [
      { category: MOCK_CATEGORY_A, confidence: 0 },
      { category: "mock_category_unmapped", confidence: 0 },
      { category: MOCK_CATEGORY_B, confidence: 0 },
    ];
    expect(decideFromLabels(verdictOf(labels), unpinned)).toBe("quarantine");
  });

  it("does not treat inherited object properties as a mapped category", () => {
    // "constructor" and "toString" exist on every object's prototype chain; a
    // naive lookup would read them as configured categories.
    for (const category of ["constructor", "toString", "__proto__"]) {
      expect(
        decideFromLabels(verdictOf([{ category, confidence: 0 }]), unpinned),
      ).toBe("quarantine");
    }
  });

  it("reviews a mapped category whose confidence is unusable", () => {
    const labels = [
      { category: MOCK_CATEGORY_A, confidence: Number.NaN },
    ] as Array<{ category: string; confidence: number }>;
    expect(decideFromLabels(verdictOf(labels), unpinned)).toBe("review");
  });

  it("is total against malformed verdicts and never approves them", () => {
    const malformed: unknown[] = [
      null,
      undefined,
      {},
      { labels: null },
      { labels: "not-an-array" },
      { labels: [null] },
      { labels: [{ confidence: 1 }] },
      { labels: [{ category: 42, confidence: 1 }] },
    ];
    for (const v of malformed) {
      const result = decideFromLabels(v as ModerationVerdict, unpinned);
      expect(() => decideFromLabels(v as ModerationVerdict, unpinned)).not.toThrow();
      expect(result).not.toBe("approved");
    }
  });
});

describe("decideFromLabels — taxonomy pin modes", () => {
  const benign = [{ category: MOCK_CATEGORY_A, confidence: 0 }];
  const damning = [{ category: MOCK_CATEGORY_A, confidence: 0.95 }];

  const modes: Array<{
    name: string;
    cfg: LabelPolicyConfig;
    context?: { pinnedModelVersion?: string };
    version?: string;
    expected: string;
  }> = [
    // --- "none": never checks a version -------------------------------------
    { name: "none / version absent", cfg: config(), expected: "approved" },
    {
      name: "none / version present",
      cfg: config(),
      version: MOCK_VERSION,
      expected: "approved",
    },
    // --- "response": must self-report ---------------------------------------
    {
      name: "response / version absent",
      cfg: config({ pinMode: "response" }),
      expected: "review",
    },
    {
      name: "response / version present",
      cfg: config({ pinMode: "response" }),
      version: MOCK_VERSION,
      expected: "approved",
    },
    {
      name: "response / version matches what the job started under",
      cfg: config({ pinMode: "response" }),
      version: MOCK_VERSION,
      context: { pinnedModelVersion: MOCK_VERSION },
      expected: "approved",
    },
    {
      name: "response / version drifted mid-job",
      cfg: config({ pinMode: "response" }),
      version: OTHER_VERSION,
      context: { pinnedModelVersion: MOCK_VERSION },
      expected: "review",
    },
    // --- "config": must equal the configured version ------------------------
    {
      name: "config / version absent",
      cfg: config({ pinMode: "config", expectedModelVersion: MOCK_VERSION }),
      expected: "review",
    },
    {
      name: "config / version matches",
      cfg: config({ pinMode: "config", expectedModelVersion: MOCK_VERSION }),
      version: MOCK_VERSION,
      expected: "approved",
    },
    {
      name: "config / version drifted",
      cfg: config({ pinMode: "config", expectedModelVersion: MOCK_VERSION }),
      version: OTHER_VERSION,
      expected: "review",
    },
    {
      name: "config / empty version reported",
      cfg: config({ pinMode: "config", expectedModelVersion: MOCK_VERSION }),
      version: "",
      expected: "review",
    },
  ];

  for (const row of modes) {
    it(`zero labels — ${row.name}`, () => {
      expect(decideFromLabels(verdictOf([], row.version), row.cfg, row.context)).toBe(
        row.expected,
      );
    });

    it(`benign labels — ${row.name}`, () => {
      expect(
        decideFromLabels(verdictOf(benign, row.version), row.cfg, row.context),
      ).toBe(row.expected);
    });
  }

  it("pin failure floors at review — it never lifts a quarantine", () => {
    const cfg = config({ pinMode: "config", expectedModelVersion: MOCK_VERSION });
    // Version drifted AND a damning label: the worse of the two must survive.
    expect(decideFromLabels(verdictOf(damning, OTHER_VERSION), cfg)).toBe(
      "quarantine",
    );
    expect(
      decideFromLabels(
        verdictOf([{ category: "mock_category_unmapped", confidence: 0 }], undefined),
        cfg,
      ),
    ).toBe("quarantine");
  });

  it("a provider that says nothing cannot approve under a pinned mode", () => {
    for (const cfg of [
      config({ pinMode: "response" }),
      config({ pinMode: "config", expectedModelVersion: MOCK_VERSION }),
    ]) {
      expect(decideFromLabels(verdictOf([]), cfg)).toBe("review");
    }
  });
});
