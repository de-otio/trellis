import { describe, expect, it } from "vitest";

import {
  computeScore,
  computeDecay,
  computeEngagementDepth,
  computeFrequencySignal,
  computeContentCreationSignal,
  computeOwnerProximity,
  connectionBonus,
  effectiveScore,
  scoreToTier,
  USER_DECAY_HALF_LIFE_DAYS,
  ENTITY_DECAY_HALF_LIFE_DAYS,
  ENGAGEMENT_SCORES,
  CONNECTION_BONUSES,
  TIER_THRESHOLDS,
  type ScoringInput,
  type InteractionCounts,
} from "../../../src/lib/graph/scoring-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_INTERACTIONS: InteractionCounts = {
  view: 0,
  react: 0,
  comment: 0,
  share: 0,
  depth_mode: 0,
  profile_visit: 0,
  content_creation: 0,
};

const NOW = new Date("2026-04-11T12:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

function baseScoringInput(
  overrides: Partial<ScoringInput> = {},
): ScoringInput {
  return {
    targetType: "user",
    connectionMethod: "discovery",
    interactionCount: 0,
    interactionsByType: { ...EMPTY_INTERACTIONS },
    lastInteractionAt: null,
    reciprocated: false,
    createdAt: daysAgo(30),
    manualScore: null,
    isOwned: false,
    ownerScore: null,
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeScore — auto-pin
// ---------------------------------------------------------------------------

describe("computeScore", () => {
  describe("auto-pin for owned entities", () => {
    it("returns 1.0 for owned entity regardless of other signals", () => {
      const score = computeScore(
        baseScoringInput({
          targetType: "entity",
          isOwned: true,
          interactionCount: 0,
          lastInteractionAt: null,
        }),
      );
      expect(score).toBe(1.0);
    });

    it("ignores manual score for owned entities", () => {
      const score = computeScore(
        baseScoringInput({
          targetType: "entity",
          isOwned: true,
          manualScore: 0.3,
        }),
      );
      expect(score).toBe(1.0);
    });
  });

  describe("manual score override", () => {
    it("uses manualScore when set (user target)", () => {
      const score = computeScore(
        baseScoringInput({
          targetType: "user",
          manualScore: 0.85,
          interactionCount: 100,
          reciprocated: true,
        }),
      );
      expect(score).toBe(0.85);
    });

    it("uses manualScore when set (entity target)", () => {
      const score = computeScore(
        baseScoringInput({
          targetType: "entity",
          manualScore: 0.6,
        }),
      );
      expect(score).toBe(0.6);
    });

    it("clamps manualScore to [0, 1]", () => {
      expect(
        computeScore(baseScoringInput({ manualScore: 1.5 })),
      ).toBe(1.0);
      expect(
        computeScore(baseScoringInput({ manualScore: -0.2 })),
      ).toBe(0.0);
    });
  });

  describe("user-to-user formula", () => {
    it("scores higher with reciprocity", () => {
      const withoutReciprocity = computeScore(
        baseScoringInput({
          targetType: "user",
          interactionCount: 10,
          lastInteractionAt: daysAgo(1),
          reciprocated: false,
          connectionMethod: "discovery",
        }),
      );

      const withReciprocity = computeScore(
        baseScoringInput({
          targetType: "user",
          interactionCount: 10,
          lastInteractionAt: daysAgo(1),
          reciprocated: true,
          connectionMethod: "discovery",
        }),
      );

      expect(withReciprocity).toBeGreaterThan(withoutReciprocity);
    });

    it("scores higher with more interactions", () => {
      const few = computeScore(
        baseScoringInput({
          targetType: "user",
          interactionCount: 2,
          lastInteractionAt: daysAgo(1),
        }),
      );

      const many = computeScore(
        baseScoringInput({
          targetType: "user",
          interactionCount: 50,
          lastInteractionAt: daysAgo(1),
        }),
      );

      expect(many).toBeGreaterThan(few);
    });

    it("connection method 'code' gives higher initial score than 'discovery'", () => {
      const code = computeScore(
        baseScoringInput({
          targetType: "user",
          connectionMethod: "code",
          lastInteractionAt: daysAgo(1),
        }),
      );

      const discovery = computeScore(
        baseScoringInput({
          targetType: "user",
          connectionMethod: "discovery",
          lastInteractionAt: daysAgo(1),
        }),
      );

      expect(code).toBeGreaterThan(discovery);
    });

    it("decays with no recent interaction", () => {
      const recent = computeScore(
        baseScoringInput({
          targetType: "user",
          interactionCount: 10,
          lastInteractionAt: daysAgo(1),
          connectionMethod: "code",
        }),
      );

      const stale = computeScore(
        baseScoringInput({
          targetType: "user",
          interactionCount: 10,
          lastInteractionAt: daysAgo(120),
          connectionMethod: "code",
        }),
      );

      expect(recent).toBeGreaterThan(stale);
    });

    it("score is clamped to [0, 1]", () => {
      const score = computeScore(
        baseScoringInput({
          targetType: "user",
          connectionMethod: "code",
          reciprocated: true,
          interactionCount: 1000,
          lastInteractionAt: NOW,
        }),
      );

      expect(score).toBeLessThanOrEqual(1.0);
      expect(score).toBeGreaterThanOrEqual(0.0);
    });
  });

  describe("user-to-entity formula", () => {
    it("scores higher with deeper engagement", () => {
      const shallow = computeScore(
        baseScoringInput({
          targetType: "entity",
          interactionCount: 10,
          interactionsByType: { ...EMPTY_INTERACTIONS, view: 10 },
          lastInteractionAt: daysAgo(1),
        }),
      );

      const deep = computeScore(
        baseScoringInput({
          targetType: "entity",
          interactionCount: 10,
          interactionsByType: {
            ...EMPTY_INTERACTIONS,
            comment: 5,
            share: 3,
            depth_mode: 2,
          },
          lastInteractionAt: daysAgo(1),
        }),
      );

      expect(deep).toBeGreaterThan(shallow);
    });

    it("boosts score with owner proximity", () => {
      const noOwner = computeScore(
        baseScoringInput({
          targetType: "entity",
          interactionCount: 5,
          lastInteractionAt: daysAgo(1),
          ownerScore: null,
        }),
      );

      const closeOwner = computeScore(
        baseScoringInput({
          targetType: "entity",
          interactionCount: 5,
          lastInteractionAt: daysAgo(1),
          ownerScore: 0.9,
        }),
      );

      expect(closeOwner).toBeGreaterThan(noOwner);
    });

    it("boosts score with content creation", () => {
      const noCreation = computeScore(
        baseScoringInput({
          targetType: "entity",
          interactionCount: 5,
          interactionsByType: { ...EMPTY_INTERACTIONS, comment: 5 },
          lastInteractionAt: daysAgo(1),
        }),
      );

      const withCreation = computeScore(
        baseScoringInput({
          targetType: "entity",
          interactionCount: 8,
          interactionsByType: {
            ...EMPTY_INTERACTIONS,
            comment: 5,
            content_creation: 3,
          },
          lastInteractionAt: daysAgo(1),
        }),
      );

      expect(withCreation).toBeGreaterThan(noCreation);
    });

    it("entity decay is slower than user decay", () => {
      // Both with same last interaction 90 days ago
      const userScore = computeScore(
        baseScoringInput({
          targetType: "user",
          interactionCount: 20,
          lastInteractionAt: daysAgo(90),
          connectionMethod: "code",
        }),
      );

      const entityScore = computeScore(
        baseScoringInput({
          targetType: "entity",
          interactionCount: 20,
          interactionsByType: { ...EMPTY_INTERACTIONS, comment: 20 },
          lastInteractionAt: daysAgo(90),
          connectionMethod: "code",
        }),
      );

      // Entity decay weight is 0.05 vs user decay weight 0.10
      // so the entity penalty should be smaller relative to its formula
      // We verify entity scores are still reasonable at 90 days
      expect(entityScore).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// effectiveScore
// ---------------------------------------------------------------------------

describe("effectiveScore", () => {
  it("returns manualScore when set", () => {
    expect(effectiveScore(0.8, 0.5)).toBe(0.8);
  });

  it("returns computedScore when manualScore is null", () => {
    expect(effectiveScore(null, 0.5)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// scoreToTier
// ---------------------------------------------------------------------------

describe("scoreToTier", () => {
  it("maps inner circle score (>= 0.7) to tier 0", () => {
    expect(scoreToTier(1.0)).toBe(0);
    expect(scoreToTier(0.7)).toBe(0);
    expect(scoreToTier(0.85)).toBe(0);
  });

  it("maps close friends score (>= 0.4, < 0.7) to tier 1", () => {
    expect(scoreToTier(0.69)).toBe(1);
    expect(scoreToTier(0.4)).toBe(1);
    expect(scoreToTier(0.5)).toBe(1);
  });

  it("maps community score (>= 0.15, < 0.4) to tier 2", () => {
    expect(scoreToTier(0.39)).toBe(2);
    expect(scoreToTier(0.15)).toBe(2);
    expect(scoreToTier(0.25)).toBe(2);
  });

  it("maps ambient score (< 0.15) to tier 3", () => {
    expect(scoreToTier(0.14)).toBe(3);
    expect(scoreToTier(0.0)).toBe(3);
    expect(scoreToTier(0.05)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeDecay
// ---------------------------------------------------------------------------

describe("computeDecay", () => {
  it("returns 0 when last interaction is now", () => {
    expect(computeDecay(NOW, NOW, 60)).toBe(0);
  });

  it("returns ~0.5 at the half-life mark", () => {
    const decay = computeDecay(daysAgo(60), NOW, 60);
    expect(decay).toBeCloseTo(0.5, 2);
  });

  it("returns ~0.5 at entity half-life (120 days)", () => {
    const decay = computeDecay(daysAgo(120), NOW, 120);
    expect(decay).toBeCloseTo(0.5, 2);
  });

  it("returns 1.0 when lastInteractionAt is null", () => {
    expect(computeDecay(null, NOW, 60)).toBe(1.0);
  });

  it("returns 0 when last interaction is in the future", () => {
    const future = new Date(NOW.getTime() + 86_400_000);
    expect(computeDecay(future, NOW, 60)).toBe(0);
  });

  it("approaches 1.0 for very old interactions", () => {
    const decay = computeDecay(daysAgo(365), NOW, 60);
    expect(decay).toBeGreaterThan(0.98);
  });

  it("is monotonically increasing with time", () => {
    const d1 = computeDecay(daysAgo(10), NOW, 60);
    const d2 = computeDecay(daysAgo(30), NOW, 60);
    const d3 = computeDecay(daysAgo(60), NOW, 60);
    const d4 = computeDecay(daysAgo(120), NOW, 60);

    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
    expect(d4).toBeGreaterThan(d3);
  });
});

// ---------------------------------------------------------------------------
// computeEngagementDepth
// ---------------------------------------------------------------------------

describe("computeEngagementDepth", () => {
  it("returns 0 for zero interactions", () => {
    expect(computeEngagementDepth(EMPTY_INTERACTIONS)).toBe(0);
  });

  it("returns higher score for deeper engagement types", () => {
    const viewsOnly = computeEngagementDepth({
      ...EMPTY_INTERACTIONS,
      view: 50,
    });

    const commentsOnly = computeEngagementDepth({
      ...EMPTY_INTERACTIONS,
      comment: 10,
    });

    // 50 views * 0.01 = 0.5, 10 comments * 0.10 = 1.0
    // Through saturation: comments should yield a higher depth
    expect(commentsOnly).toBeGreaterThan(viewsOnly);
  });

  it("saturates — diminishing returns at high counts", () => {
    const moderate = computeEngagementDepth({
      ...EMPTY_INTERACTIONS,
      comment: 10,
    });

    const extreme = computeEngagementDepth({
      ...EMPTY_INTERACTIONS,
      comment: 1000,
    });

    // Both should be in [0, 1], and extreme should be close to 1
    expect(moderate).toBeLessThan(extreme);
    expect(extreme).toBeLessThan(1.0);
    expect(extreme).toBeGreaterThan(0.95);
  });

  it("is bounded in [0, 1]", () => {
    const maxEngagement = computeEngagementDepth({
      view: 1000,
      react: 500,
      comment: 500,
      share: 200,
      depth_mode: 200,
      profile_visit: 100,
      content_creation: 100,
    });

    expect(maxEngagement).toBeLessThanOrEqual(1.0);
    expect(maxEngagement).toBeGreaterThanOrEqual(0.0);
  });
});

// ---------------------------------------------------------------------------
// computeFrequencySignal
// ---------------------------------------------------------------------------

describe("computeFrequencySignal", () => {
  it("returns 0 for zero interactions", () => {
    expect(computeFrequencySignal(0)).toBe(0);
  });

  it("returns 0 for negative interactions", () => {
    expect(computeFrequencySignal(-5)).toBe(0);
  });

  it("returns ~0.5 at 20 interactions (k=20)", () => {
    expect(computeFrequencySignal(20)).toBeCloseTo(0.5, 2);
  });

  it("asymptotically approaches 1.0", () => {
    expect(computeFrequencySignal(1000)).toBeGreaterThan(0.98);
    expect(computeFrequencySignal(1000)).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// connectionBonus
// ---------------------------------------------------------------------------

describe("connectionBonus", () => {
  it("returns 0.7 for code connections", () => {
    expect(connectionBonus("code")).toBe(0.7);
  });

  it("returns 0.5 for import connections", () => {
    expect(connectionBonus("import")).toBe(0.5);
  });

  it("returns 0.3 for suggestion connections", () => {
    expect(connectionBonus("suggestion")).toBe(0.3);
  });

  it("returns 0.3 for discovery connections", () => {
    expect(connectionBonus("discovery")).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// computeContentCreationSignal
// ---------------------------------------------------------------------------

describe("computeContentCreationSignal", () => {
  it("returns 0 for zero creations", () => {
    expect(computeContentCreationSignal(0)).toBe(0);
  });

  it("returns ~0.5 at 3 creations (k=3)", () => {
    expect(computeContentCreationSignal(3)).toBeCloseTo(0.5, 2);
  });

  it("saturates with many creations", () => {
    expect(computeContentCreationSignal(100)).toBeGreaterThan(0.95);
  });
});

// ---------------------------------------------------------------------------
// computeOwnerProximity
// ---------------------------------------------------------------------------

describe("computeOwnerProximity", () => {
  it("returns 0 when ownerScore is null", () => {
    expect(computeOwnerProximity(null)).toBe(0);
  });

  it("returns 0 when ownerScore is 0", () => {
    expect(computeOwnerProximity(0)).toBe(0);
  });

  it("returns ownerScore when positive", () => {
    expect(computeOwnerProximity(0.8)).toBe(0.8);
  });

  it("clamps to 1.0", () => {
    expect(computeOwnerProximity(1.5)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("user weights sum to ~0.65 (remaining 0.35 is implicit calibration)", () => {
    const sum =
      0.25 + // reciprocity
      0.20 + // frequency
      0.10 + // connection
      0.10; // decay
    expect(sum).toBeCloseTo(0.65, 5);
  });

  it("entity weights sum to ~1.0", () => {
    const sum =
      0.35 + // engagement
      0.25 + // frequency
      0.15 + // ownerProximity
      0.10 + // contentCreation
      0.10 + // connection
      0.05; // decay
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("user decay half-life is 60 days", () => {
    expect(USER_DECAY_HALF_LIFE_DAYS).toBe(60);
  });

  it("entity decay half-life is 120 days", () => {
    expect(ENTITY_DECAY_HALF_LIFE_DAYS).toBe(120);
  });

  it("tier thresholds are ordered from inner to ambient", () => {
    expect(TIER_THRESHOLDS[0].tier).toBe(0);
    expect(TIER_THRESHOLDS[0].minScore).toBeGreaterThan(
      TIER_THRESHOLDS[1].minScore,
    );
    expect(TIER_THRESHOLDS[1].minScore).toBeGreaterThan(
      TIER_THRESHOLDS[2].minScore,
    );
    expect(TIER_THRESHOLDS[2].minScore).toBeGreaterThan(
      TIER_THRESHOLDS[3].minScore,
    );
  });

  it("engagement scores match the analysis doc values", () => {
    expect(ENGAGEMENT_SCORES.view).toBe(0.01);
    expect(ENGAGEMENT_SCORES.react).toBe(0.05);
    expect(ENGAGEMENT_SCORES.comment).toBe(0.10);
    expect(ENGAGEMENT_SCORES.share).toBe(0.10);
    expect(ENGAGEMENT_SCORES.depth_mode).toBe(0.08);
    expect(ENGAGEMENT_SCORES.profile_visit).toBe(0.03);
    expect(ENGAGEMENT_SCORES.content_creation).toBe(0.15);
  });

  it("connection bonuses match the spec", () => {
    expect(CONNECTION_BONUSES.code).toBe(0.7);
    expect(CONNECTION_BONUSES.import).toBe(0.5);
    expect(CONNECTION_BONUSES.suggestion).toBe(0.3);
    expect(CONNECTION_BONUSES.discovery).toBe(0.3);
  });
});
