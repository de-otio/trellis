/**
 * deferred-lane: the config relationships and the disposition protocol.
 *
 * The most important test in this file is the rate-limit one. Plan 031 §5 calls
 * it "a constraint, not a preference" and asks for it to be asserted precisely
 * because it is the kind of thing that is true on the day it is configured and
 * quietly false a quarter later — with no symptom other than a lane that seems
 * to work and relieves nothing.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  clampEscalatedDecision,
  createDeferredLaneConfig,
  DeferredLaneConfigError,
  DEFERRED_LANE_RETRIES,
  dispositionForDeadlineBreach,
  dispositionForError,
  type DeferredLaneConfig,
} from "../../../src/lib/media/deferred-lane.js";
import { ModerationProviderError } from "../../../src/lib/media/moderation-provider.js";
import type { ModerationDecision } from "../../../src/lib/media/media-lifecycle.js";

/** Obviously-mock operator values. None of these is an operative threshold. */
const MOCK_REVIEW_RATE_CAP = 20;

function laneConfig(over: Partial<DeferredLaneConfig> = {}): DeferredLaneConfig {
  return {
    concurrency: 2,
    perTenantRateLimit: MOCK_REVIEW_RATE_CAP,
    evictionWindowMs: 60 * 60 * 1000,
    allowApprove: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("createDeferredLaneConfig — refuses rather than defaulting", () => {
  it.each([
    ["no config", null as unknown as DeferredLaneConfig],
    ["absent concurrency", laneConfig({ concurrency: undefined as unknown as number })],
    ["zero concurrency", laneConfig({ concurrency: 0 })],
    ["fractional concurrency", laneConfig({ concurrency: 1.5 })],
    ["absent rate limit", laneConfig({ perTenantRateLimit: undefined as unknown as number })],
    ["absent eviction window", laneConfig({ evictionWindowMs: undefined as unknown as number })],
    ["negative eviction window", laneConfig({ evictionWindowMs: -1 })],
    ["absent allowApprove", laneConfig({ allowApprove: undefined as unknown as boolean })],
    ["a truthy non-boolean allowApprove", laneConfig({ allowApprove: 1 as unknown as boolean })],
  ])("refuses %s", (_name, cfg) => {
    expect(() => createDeferredLaneConfig(cfg, MOCK_REVIEW_RATE_CAP)).toThrow(
      DeferredLaneConfigError,
    );
  });

  it("refuses when the review-rate cap it must check against is not a usable number", () => {
    expect(() => createDeferredLaneConfig(laneConfig(), Number.NaN)).toThrow(
      DeferredLaneConfigError,
    );
    expect(() =>
      createDeferredLaneConfig(laneConfig(), undefined as unknown as number),
    ).toThrow(DeferredLaneConfigError);
  });

  it("accepts a well-formed config and returns it frozen to its own fields", () => {
    const built = createDeferredLaneConfig(
      { ...laneConfig(), extra: "ignored" } as DeferredLaneConfig,
      MOCK_REVIEW_RATE_CAP,
    );
    expect(built).toEqual(laneConfig());
    expect(Object.keys(built).sort()).toEqual([
      "allowApprove",
      "concurrency",
      "evictionWindowMs",
      "perTenantRateLimit",
    ]);
  });
});

describe("the one rate-limit relationship that must hold", () => {
  it("REFUSES a per-tenant limit below the review-rate cap", () => {
    expect(() =>
      createDeferredLaneConfig(
        laneConfig({ perTenantRateLimit: MOCK_REVIEW_RATE_CAP - 1 }),
        MOCK_REVIEW_RATE_CAP,
      ),
    ).toThrow(/below the review-rate cap/);
  });

  it("accepts a limit exactly AT the cap", () => {
    expect(() =>
      createDeferredLaneConfig(
        laneConfig({ perTenantRateLimit: MOCK_REVIEW_RATE_CAP }),
        MOCK_REVIEW_RATE_CAP,
      ),
    ).not.toThrow();
  });

  it("holds for every pair of values, not just the ones written above", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        (limit, cap) => {
          const build = (): DeferredLaneConfig =>
            createDeferredLaneConfig(laneConfig({ perTenantRateLimit: limit }), cap);
          if (limit < cap) {
            expect(build).toThrow(DeferredLaneConfigError);
          } else {
            expect(build).not.toThrow();
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("retries", () => {
  it("mirrors the pipeline's maxReceiveCount and is not a config knob", () => {
    expect(DEFERRED_LANE_RETRIES).toBe(3);
    // If a `retries` field ever appears on the config, this fails and whoever
    // added it has to read plan 031 §4.2 first.
    expect(Object.keys(laneConfig())).not.toContain("retries");
  });
});

// ---------------------------------------------------------------------------
// The closed-by-default approval restriction
// ---------------------------------------------------------------------------

describe("clampEscalatedDecision — the lane ships unable to approve", () => {
  const closed = laneConfig({ allowApprove: false });
  const open = laneConfig({ allowApprove: true });

  it("turns an escalated approval into a review while closed", () => {
    expect(clampEscalatedDecision("approved", closed)).toBe("review");
  });

  it("leaves review and quarantine alone while closed", () => {
    expect(clampEscalatedDecision("review", closed)).toBe("review");
    expect(clampEscalatedDecision("quarantine", closed)).toBe("quarantine");
  });

  it("lets an approval through once the flag is opened", () => {
    expect(clampEscalatedDecision("approved", open)).toBe("approved");
  });

  it("can NEVER release content, under any config", () => {
    // The direction is the safety property: this function may only ever make a
    // verdict more conservative, exactly like label-policy's rule 5.
    const severity: Record<ModerationDecision, number> = {
      approved: 0,
      review: 1,
      quarantine: 2,
    };
    fc.assert(
      fc.property(
        fc.constantFrom<ModerationDecision>("approved", "review", "quarantine"),
        fc.boolean(),
        (decision, allowApprove) => {
          const out = clampEscalatedDecision(decision, laneConfig({ allowApprove }));
          expect(severity[out]).toBeGreaterThanOrEqual(severity[decision]);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("emits `approved` ONLY when the flag is open", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ModerationDecision>("approved", "review", "quarantine"),
        fc.boolean(),
        (decision, allowApprove) => {
          const out = clampEscalatedDecision(decision, laneConfig({ allowApprove }));
          if (out === "approved") expect(allowApprove).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Dispositions
// ---------------------------------------------------------------------------

describe("dispositionForError — a typed provider error wins over the heuristic", () => {
  it("maps a retryable typed error to fail (throw)", () => {
    const err = new ModerationProviderError("upstream unavailable", { retryable: true });
    expect(dispositionForError(err)).toEqual({ kind: "fail", infraFault: false });
  });

  it("maps a permanent typed error to ack-drop, not to three more expensive retries", () => {
    const err = new ModerationProviderError("rejected these bytes", { retryable: false });
    expect(dispositionForError(err)).toEqual({ kind: "ack-drop", cause: "poison", infraFault: false });
  });

  it("carries infraFault on the ACK-DROP, which is the only branch that can have it", () => {
    // `classifyWorkerErrorDetailed` sets infraFault on exactly one
    // classification — a typed PERMANENT error the adapter could not attribute
    // — and that classification is `poison`, which maps to ack-drop. So an
    // implementation that puts `infraFault` only on `fail` produces an alert
    // that is unreachable for every possible input while still reading, at the
    // call site, as though outages are announced.
    const unattributed = new ModerationProviderError("something, we cannot say what", {
      retryable: false,
      unknownCause: true,
    });
    expect(dispositionForError(unattributed)).toEqual({
      kind: "ack-drop",
      cause: "poison",
      infraFault: true,
    });
  });

  it("NEGATIVE CONTROL: an attributed permanent rejection does NOT set the flag", () => {
    // Without this, the assertion above would pass on an implementation that
    // hard-codes `infraFault: true`, and the alert would fire on every
    // unsupported-media upload.
    const attributed = new ModerationProviderError("unsupported media type", {
      retryable: false,
    });
    expect(dispositionForError(attributed)).toEqual({
      kind: "ack-drop",
      cause: "poison",
      infraFault: false,
    });
  });

  it("every disposition carries the flag, so no caller can read one and miss the other", () => {
    fc.assert(
      fc.property(fc.anything(), (e) => {
        const d = dispositionForError(e);
        expect(d).toHaveProperty("infraFault");
      }),
      { numRuns: 500 },
    );
  });

  it("A TYPED PERMANENT ERROR WHOSE MESSAGE SAYS `timeout` IS STILL PERMANENT", () => {
    // This is the precedence bug classifyWorkerErrorDetailed exists to prevent,
    // and the deferred lane is where it costs the most: three retries of a
    // 13–20 s reasoning call, against the daily spend cap, to reach the answer
    // the provider already gave.
    const err = new ModerationProviderError("request timeout: unsupported media", {
      retryable: false,
    });
    expect(dispositionForError(err)).toEqual({ kind: "ack-drop", cause: "poison", infraFault: false });
  });

  it("falls back to retryable for an unrecognised error", () => {
    expect(dispositionForError(new Error("who knows")).kind).toBe("fail");
  });

  it("is total — never throws, for anything at all", () => {
    fc.assert(
      fc.property(fc.anything(), (e) => {
        expect(() => dispositionForError(e)).not.toThrow();
      }),
      { numRuns: 1000 },
    );
  });

  it("only ever returns fail or ack-drop — there is no fourth outcome", () => {
    fc.assert(
      fc.property(fc.anything(), (e) => {
        expect(["fail", "ack-drop"]).toContain(dispositionForError(e).kind);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("dispositionForDeadlineBreach — chosen, not inherited", () => {
  it("ack-drops to REVIEW rather than retrying the expensive model three more times", () => {
    expect(dispositionForDeadlineBreach()).toEqual({ kind: "ack-drop", cause: "evicted", infraFault: false });
  });

  it("differs from what the inline deadline module would have said", () => {
    // moderation-deadline.ts throws `retryable: true` on a breach — correct for
    // a tens-of-milliseconds inline call, wrong here. Plan 031 §4.4 requires the
    // difference to be a choice; this asserts the choice was actually made and
    // not silently inherited.
    const asInline = dispositionForError(
      new ModerationProviderError("deadline exceeded", { retryable: true }),
    );
    expect(asInline.kind).toBe("fail");
    expect(dispositionForDeadlineBreach().kind).toBe("ack-drop");
  });
});
