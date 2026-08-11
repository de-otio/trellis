import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  aggregateFrameVerdicts,
  expectedFrameCount,
  planFrameSampling,
  type FrameVerdict,
} from "../../../src/lib/media/frame-aggregation.js";
import type { ModerationDecision } from "../../../src/lib/media/media-lifecycle.js";

// Seeded so a failure is reproducible; the same seed runs in CI and locally.
const SEED = 20260811;
const RUNS = { seed: SEED, numRuns: 300 } as const;

const DECISIONS: ModerationDecision[] = ["approved", "review", "quarantine"];
const SEVERITY: Record<ModerationDecision, number> = {
  approved: 0,
  review: 1,
  quarantine: 2,
};

const frameArb = fc.constantFrom<FrameVerdict>(
  { decision: "approved" },
  { decision: "review" },
  { decision: "quarantine" },
  { decision: null },
);

describe("expectedFrameCount", () => {
  it("floors duration x rate, never below one frame", () => {
    expect(expectedFrameCount(10, 1, 100)).toBe(10);
    expect(expectedFrameCount(0.5, 1, 100)).toBe(1);
    expect(expectedFrameCount(0, 1, 100)).toBe(1);
    expect(expectedFrameCount(10, 0.25, 100)).toBe(2);
  });

  it("never exceeds the ceiling", () => {
    expect(expectedFrameCount(1000, 10, 5)).toBe(5);
  });

  it("collapses hostile inputs to one rather than to zero", () => {
    // A zero expectation would make the shortfall rule vacuous exactly when the
    // inputs are suspicious.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(expectedFrameCount(bad, 1, 100)).toBeGreaterThanOrEqual(1);
      expect(expectedFrameCount(10, bad, 100)).toBeGreaterThanOrEqual(1);
      expect(expectedFrameCount(10, 1, bad)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("planFrameSampling", () => {
  it("refuses when the operator configured no rate or no ceiling", () => {
    expect(planFrameSampling({ durationSeconds: 10 })).toEqual({
      ok: false,
      reason: "config-absent",
    });
    expect(
      planFrameSampling({ durationSeconds: 10, framesPerSecond: 1 }),
    ).toEqual({ ok: false, reason: "config-absent" });
    expect(planFrameSampling({ durationSeconds: 10, maxFrames: 10 })).toEqual({
      ok: false,
      reason: "config-absent",
    });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        planFrameSampling({
          durationSeconds: 10,
          framesPerSecond: bad,
          maxFrames: 10,
        }).ok,
      ).toBe(false);
    }
  });

  it("refuses rather than silently under-sampling when the ceiling is exceeded", () => {
    expect(
      planFrameSampling({
        durationSeconds: 100,
        framesPerSecond: 1,
        maxFrames: 10,
      }),
    ).toEqual({ ok: false, reason: "ceiling-exceeded" });
  });

  it("plans within the ceiling", () => {
    expect(
      planFrameSampling({ durationSeconds: 10, framesPerSecond: 1, maxFrames: 10 }),
    ).toEqual({ ok: true, expectedFrames: 10 });
  });

  it("property: an ok plan never exceeds the ceiling", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 3600, noNaN: true }),
        fc.double({ min: 0.01, max: 30, noNaN: true }),
        fc.integer({ min: 1, max: 500 }),
        (durationSeconds, framesPerSecond, maxFrames) => {
          const plan = planFrameSampling({
            durationSeconds,
            framesPerSecond,
            maxFrames,
          });
          if (plan.ok) {
            expect(plan.expectedFrames).toBeLessThanOrEqual(maxFrames);
            expect(plan.expectedFrames).toBeGreaterThanOrEqual(1);
          }
        },
      ),
      RUNS,
    );
  });
});

describe("aggregateFrameVerdicts — the law", () => {
  it("zero frames reviews", () => {
    expect(aggregateFrameVerdicts([], 0)).toBe("review");
    expect(aggregateFrameVerdicts([], 5)).toBe("review");
  });

  it("approves only when every expected frame approved", () => {
    const frames: FrameVerdict[] = [
      { decision: "approved" },
      { decision: "approved" },
    ];
    expect(aggregateFrameVerdicts(frames, 2)).toBe("approved");
  });

  it("quarantine dominates a benign majority", () => {
    const frames: FrameVerdict[] = [
      { decision: "approved" },
      { decision: "approved" },
      { decision: "quarantine" },
      { decision: "approved" },
    ];
    expect(aggregateFrameVerdicts(frames, 4)).toBe("quarantine");
  });

  it("an unclassified frame counts as review, never as approval", () => {
    const frames: FrameVerdict[] = [
      { decision: "approved" },
      { decision: null },
    ];
    expect(aggregateFrameVerdicts(frames, 2)).toBe("review");
  });

  it("an extraction shortfall reviews even when every extracted frame approved", () => {
    // The attack this rule exists for: harmful frames that fail to decode,
    // benign frames that decode fine.
    const frames: FrameVerdict[] = [
      { decision: "approved" },
      { decision: "approved" },
    ];
    expect(aggregateFrameVerdicts(frames, 10)).toBe("review");
  });

  it("a shortfall does not downgrade a quarantine to review", () => {
    const frames: FrameVerdict[] = [{ decision: "quarantine" }];
    expect(aggregateFrameVerdicts(frames, 10)).toBe("quarantine");
  });

  it("property: order-independent", () => {
    fc.assert(
      fc.property(
        fc.array(frameArb, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 0, max: 12 }),
        (frames, expected) => {
          const forward = aggregateFrameVerdicts(frames, expected);
          const reversed = aggregateFrameVerdicts([...frames].reverse(), expected);
          expect(reversed).toBe(forward);
        },
      ),
      RUNS,
    );
  });

  it("property: adding a frame never IMPROVES the verdict", () => {
    fc.assert(
      fc.property(
        fc.array(frameArb, { minLength: 1, maxLength: 10 }),
        frameArb,
        (frames, extra) => {
          // Hold `expected` at the original length so the added frame cannot
          // fix a shortfall — this isolates the monotonicity of the verdicts.
          const before = aggregateFrameVerdicts(frames, frames.length);
          const after = aggregateFrameVerdicts([...frames, extra], frames.length);
          expect(SEVERITY[after]).toBeGreaterThanOrEqual(SEVERITY[before]);
        },
      ),
      RUNS,
    );
  });

  it("property: approved requires a full set of approving frames", () => {
    fc.assert(
      fc.property(
        fc.array(frameArb, { minLength: 0, maxLength: 12 }),
        fc.integer({ min: 0, max: 12 }),
        (frames, expected) => {
          if (aggregateFrameVerdicts(frames, expected) !== "approved") return;
          expect(frames.length).toBeGreaterThan(0);
          expect(frames.length).toBeGreaterThanOrEqual(expected);
          for (const f of frames) expect(f.decision).toBe("approved");
        },
      ),
      RUNS,
    );
  });

  it("property: the result is always one of the three decisions", () => {
    fc.assert(
      fc.property(
        fc.array(frameArb, { maxLength: 12 }),
        fc.integer({ min: 0, max: 12 }),
        (frames, expected) => {
          expect(DECISIONS).toContain(aggregateFrameVerdicts(frames, expected));
        },
      ),
      RUNS,
    );
  });
});

describe("planFrameSampling — an unknown duration is doubt", () => {
  it("refuses rather than collapsing to a one-frame expectation", () => {
    // Coercing an unknown duration to "expect 1 frame" would switch OFF both
    // the shortfall rule and the ceiling rule: any single decoded frame would
    // satisfy the expectation, and no clip could ever breach the ceiling. A
    // probe that returns 0 or NaN on failure must not be able to disable the
    // law by failing.
    for (const durationSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        planFrameSampling({ durationSeconds, framesPerSecond: 1, maxFrames: 10 }),
      ).toEqual({ ok: false, reason: "duration-unknown" });
    }
  });

  it("still refuses on missing config before it looks at duration", () => {
    expect(planFrameSampling({ durationSeconds: 0 })).toEqual({
      ok: false,
      reason: "config-absent",
    });
  });
});
