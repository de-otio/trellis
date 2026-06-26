import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  combineTrackVerdicts,
  type TrackOutcome,
} from "../../../src/lib/media/track-verdict.js";
import {
  ALL_MODERATION_DECISIONS,
  type ModerationDecision,
} from "../../../src/lib/media/moderation-status.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const decidedArb: fc.Arbitrary<TrackOutcome> = fc
  .constantFrom(...ALL_MODERATION_DECISIONS)
  .map((decision) => ({ state: "decided", decision }) as const);

const erroredArb: fc.Arbitrary<TrackOutcome> = fc.constant({
  state: "errored",
} as const);

const absentArb: fc.Arbitrary<TrackOutcome> = fc.constant({
  state: "absent",
} as const);

const outcomeArb: fc.Arbitrary<TrackOutcome> = fc.oneof(
  decidedArb,
  erroredArb,
  absentArb,
);

// Reference oracle, written independently of the implementation so the
// properties are not tautological. Precedence: quarantine > approve-iff-both >
// review.
function oracle(v: TrackOutcome, a: TrackOutcome): ModerationDecision {
  const isQ = (o: TrackOutcome) =>
    o.state === "decided" && o.decision === "quarantine";
  const isA = (o: TrackOutcome) =>
    o.state === "decided" && o.decision === "approved";
  if (isQ(v) || isQ(a)) return "quarantine";
  if (isA(v) && isA(a)) return "approved";
  return "review";
}

// Enumerate the full finite outcome space (5 outcomes x 5 outcomes = 25 pairs).
const ALL_OUTCOMES: TrackOutcome[] = [
  { state: "decided", decision: "approved" },
  { state: "decided", decision: "review" },
  { state: "decided", decision: "quarantine" },
  { state: "errored" },
  { state: "absent" },
];

describe("combineTrackVerdicts", () => {
  describe("approved IFF both decided-approved", () => {
    it("approves exactly when both tracks are decided-approved", () => {
      fc.assert(
        fc.property(outcomeArb, outcomeArb, (visual, audio) => {
          const bothApproved =
            visual.state === "decided" &&
            visual.decision === "approved" &&
            audio.state === "decided" &&
            audio.decision === "approved";
          expect(combineTrackVerdicts(visual, audio) === "approved").toBe(
            bothApproved,
          );
        }),
      );
    });

    it("the only approving pair in the whole space is (approved, approved)", () => {
      let approvingPairs = 0;
      for (const v of ALL_OUTCOMES) {
        for (const a of ALL_OUTCOMES) {
          if (combineTrackVerdicts(v, a) === "approved") approvingPairs += 1;
        }
      }
      expect(approvingPairs).toBe(1);
      expect(
        combineTrackVerdicts(
          { state: "decided", decision: "approved" },
          { state: "decided", decision: "approved" },
        ),
      ).toBe("approved");
    });
  });

  describe("quarantine precedence", () => {
    it("any decided-quarantine track => quarantine", () => {
      fc.assert(
        fc.property(outcomeArb, outcomeArb, (visual, audio) => {
          const anyQ =
            (visual.state === "decided" && visual.decision === "quarantine") ||
            (audio.state === "decided" && audio.decision === "quarantine");
          if (anyQ) {
            expect(combineTrackVerdicts(visual, audio)).toBe("quarantine");
          }
        }),
      );
    });

    it("quarantine is sticky across an absent or errored sibling", () => {
      const q = { state: "decided", decision: "quarantine" } as const;
      expect(combineTrackVerdicts(q, { state: "absent" })).toBe("quarantine");
      expect(combineTrackVerdicts({ state: "absent" }, q)).toBe("quarantine");
      expect(combineTrackVerdicts(q, { state: "errored" })).toBe("quarantine");
      expect(combineTrackVerdicts({ state: "errored" }, q)).toBe("quarantine");
    });
  });

  describe("fail-closed: a missing/failed track never approves", () => {
    it("absent or errored on either side => never approved", () => {
      fc.assert(
        fc.property(outcomeArb, outcomeArb, (visual, audio) => {
          const anyMissing =
            visual.state !== "decided" || audio.state !== "decided";
          if (anyMissing) {
            expect(combineTrackVerdicts(visual, audio)).not.toBe("approved");
          }
        }),
      );
    });

    it("approved + absent/errored degrades to review (not approved)", () => {
      const ap = { state: "decided", decision: "approved" } as const;
      expect(combineTrackVerdicts(ap, { state: "absent" })).toBe("review");
      expect(combineTrackVerdicts({ state: "absent" }, ap)).toBe("review");
      expect(combineTrackVerdicts(ap, { state: "errored" })).toBe("review");
      expect(combineTrackVerdicts({ state: "errored" }, ap)).toBe("review");
    });

    it("any decided-review (without a quarantine) => review", () => {
      const rv = { state: "decided", decision: "review" } as const;
      const ap = { state: "decided", decision: "approved" } as const;
      expect(combineTrackVerdicts(rv, ap)).toBe("review");
      expect(combineTrackVerdicts(ap, rv)).toBe("review");
      expect(combineTrackVerdicts(rv, rv)).toBe("review");
    });
  });

  describe("totality & oracle agreement", () => {
    it("always returns one of the three decisions", () => {
      fc.assert(
        fc.property(outcomeArb, outcomeArb, (visual, audio) => {
          expect(ALL_MODERATION_DECISIONS).toContain(
            combineTrackVerdicts(visual, audio),
          );
        }),
      );
    });

    it("agrees with an independent reference oracle over the whole space", () => {
      fc.assert(
        fc.property(outcomeArb, outcomeArb, (visual, audio) => {
          expect(combineTrackVerdicts(visual, audio)).toBe(
            oracle(visual, audio),
          );
        }),
      );
      // And exhaustively over the finite space.
      for (const v of ALL_OUTCOMES) {
        for (const a of ALL_OUTCOMES) {
          expect(combineTrackVerdicts(v, a)).toBe(oracle(v, a));
        }
      }
    });

    it("never returns rejected (not a classifier-combinator output)", () => {
      const REJECTED: string = "rejected";
      fc.assert(
        fc.property(outcomeArb, outcomeArb, (visual, audio) => {
          const result: string = combineTrackVerdicts(visual, audio);
          expect(result).not.toBe(REJECTED);
        }),
      );
    });
  });
});
