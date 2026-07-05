import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  decidePromotion,
  type PromotionInput,
} from "../../../src/lib/media/promote-decision.js";
import type { TrackOutcome } from "../../../src/lib/media/track-verdict.js";
import {
  ALL_MODERATION_DECISIONS,
  ALL_MEDIA_LIFECYCLES,
  type MediaLifecycle,
} from "../../../src/lib/media/media-lifecycle.js";

// ---------------------------------------------------------------------------
// Arbitraries — drive the full TrackOutcome x TrackOutcome x status x present grid
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

const statusArb: fc.Arbitrary<MediaLifecycle> = fc.constantFrom(
  ...ALL_MEDIA_LIFECYCLES,
);

const inputArb: fc.Arbitrary<PromotionInput> = fc.record({
  visual: outcomeArb,
  audio: outcomeArb,
  currentStatus: statusArb,
  casObjectPresent: fc.boolean(),
});

/** Enumerate every concrete TrackOutcome (3 decided + errored + absent). */
const ALL_OUTCOMES: readonly TrackOutcome[] = [
  ...ALL_MODERATION_DECISIONS.map(
    (decision) => ({ state: "decided", decision }) as const,
  ),
  { state: "errored" } as const,
  { state: "absent" } as const,
];

function isDecidedApproved(o: TrackOutcome): boolean {
  return o.state === "decided" && o.decision === "approved";
}

// ---------------------------------------------------------------------------
// Concrete grid: every TrackOutcome x TrackOutcome at PENDING
// ---------------------------------------------------------------------------

describe("decidePromotion — full TrackOutcome x TrackOutcome grid (from PENDING)", () => {
  for (const visual of ALL_OUTCOMES) {
    for (const audio of ALL_OUTCOMES) {
      const label = `${describeOutcome(visual)} x ${describeOutcome(audio)}`;
      const bothApproved = isDecidedApproved(visual) && isDecidedApproved(audio);

      it(`present CAS: ${label} -> promote=${bothApproved}`, () => {
        const action = decidePromotion({
          visual,
          audio,
          currentStatus: "UPLOADED",
          casObjectPresent: true,
        });

        // From PENDING, a decision is always a LEGAL transition.
        expect(action.transition.ok).toBe(true);
        expect(action.shouldPersistStatus).toBe(true);
        expect(action.shouldEmitResolved).toBe(true);

        // APPROVED is reached IFF both tracks are decided-approved.
        if (action.transition.ok) {
          expect(action.transition.status === "APPROVED").toBe(bothApproved);
        }
        // Promotion follows APPROVED when CAS present.
        expect(action.shouldPromote).toBe(bothApproved);
      });

      it(`absent CAS: ${label} -> promote=false`, () => {
        const action = decidePromotion({
          visual,
          audio,
          currentStatus: "UPLOADED",
          casObjectPresent: false,
        });
        // CAS absent => never promote, regardless of approval.
        expect(action.shouldPromote).toBe(false);
        // But a legal transition still persists + emits.
        expect(action.shouldPersistStatus).toBe(true);
        expect(action.shouldEmitResolved).toBe(true);
      });
    }
  }
});

function describeOutcome(o: TrackOutcome): string {
  return o.state === "decided" ? `decided:${o.decision}` : o.state;
}

// ---------------------------------------------------------------------------
// SAFETY: shouldPromote true ⇒ both decided-approved AND status APPROVED
// ---------------------------------------------------------------------------

describe("decidePromotion — promote implies approved-everywhere (property)", () => {
  it("shouldPromote ⇒ both tracks decided-approved, status APPROVED, CAS present", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const action = decidePromotion(input);
        if (action.shouldPromote) {
          // Promotion implies a legal transition landing on APPROVED.
          expect(action.transition.ok).toBe(true);
          if (action.transition.ok) {
            expect(action.transition.status).toBe("APPROVED");
          }
          // ...which requires positive evidence on BOTH tracks.
          expect(isDecidedApproved(input.visual)).toBe(true);
          expect(isDecidedApproved(input.audio)).toBe(true);
          // ...and the CAS object must exist.
          expect(input.casObjectPresent).toBe(true);
        }
      }),
    );
  });

  it("APPROVED transition is NEVER reached unless both tracks decided-approved", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const action = decidePromotion(input);
        if (action.transition.ok && action.transition.status === "APPROVED") {
          expect(isDecidedApproved(input.visual)).toBe(true);
          expect(isDecidedApproved(input.audio)).toBe(true);
        }
      }),
    );
  });

  it("CAS absent ⇒ shouldPromote false (property)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const action = decidePromotion({ ...input, casObjectPresent: false });
        expect(action.shouldPromote).toBe(false);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// REPLAY / illegal transition on terminal statuses => all-false no-op
// ---------------------------------------------------------------------------

describe("decidePromotion — replay on terminal status is an idempotent no-op", () => {
  for (const terminal of ["APPROVED", "REJECTED"] as const) {
    it(`any decision on ${terminal} => all-false no-op`, () => {
      fc.assert(
        fc.property(outcomeArb, outcomeArb, fc.boolean(), (visual, audio, present) => {
          const action = decidePromotion({
            visual,
            audio,
            currentStatus: terminal,
            casObjectPresent: present,
          });
          // Decision events are illegal from absorbing terminal states.
          expect(action.transition.ok).toBe(false);
          expect(action.shouldPromote).toBe(false);
          expect(action.shouldPersistStatus).toBe(false);
          expect(action.shouldEmitResolved).toBe(false);
        }),
      );
    });
  }

  it("a decision event from REVIEW/QUARANTINED is illegal => no-op", () => {
    // The state machine only accepts `human` events on REVIEW/QUARANTINED, so a
    // `decision` event there is an illegal transition and must no-op.
    fc.assert(
      fc.property(
        fc.constantFrom("REVIEW", "QUARANTINED") as fc.Arbitrary<MediaLifecycle>,
        outcomeArb,
        outcomeArb,
        fc.boolean(),
        (status, visual, audio, present) => {
          const action = decidePromotion({
            visual,
            audio,
            currentStatus: status,
            casObjectPresent: present,
          });
          expect(action.transition.ok).toBe(false);
          expect(action.shouldPromote).toBe(false);
          expect(action.shouldPersistStatus).toBe(false);
          expect(action.shouldEmitResolved).toBe(false);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Coherence: illegal ⇔ no-op; legal ⇔ persist+emit
// ---------------------------------------------------------------------------

describe("decidePromotion — action booleans cohere with transition legality", () => {
  it("illegal transition ⇔ all three actions false; legal ⇔ persist && emit", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const action = decidePromotion(input);
        if (action.transition.ok === false) {
          expect(action.shouldPromote).toBe(false);
          expect(action.shouldPersistStatus).toBe(false);
          expect(action.shouldEmitResolved).toBe(false);
        } else {
          // Legal => always persist + emit; promote is the gated extra.
          expect(action.shouldPersistStatus).toBe(true);
          expect(action.shouldEmitResolved).toBe(true);
          // promote only when it added serving capability.
          if (action.shouldPromote) {
            expect(action.transition.status).toBe("APPROVED");
          }
        }
      }),
    );
  });

  it("combined decision matches combineTrackVerdicts contract (review on any non-approved)", () => {
    // Spot-check a known case: one approved, one errored => review => REVIEW, no promote.
    const action = decidePromotion({
      visual: { state: "decided", decision: "approved" },
      audio: { state: "errored" },
      currentStatus: "UPLOADED",
      casObjectPresent: true,
    });
    expect(action.combined).toBe("review");
    expect(action.transition.ok).toBe(true);
    if (action.transition.ok) expect(action.transition.status).toBe("REVIEW");
    expect(action.shouldPromote).toBe(false);
    expect(action.shouldPersistStatus).toBe(true);
    expect(action.shouldEmitResolved).toBe(true);
  });

  it("quarantine on one track => QUARANTINED, no promote, persists+emits", () => {
    const action = decidePromotion({
      visual: { state: "decided", decision: "quarantine" },
      audio: { state: "decided", decision: "approved" },
      currentStatus: "UPLOADED",
      casObjectPresent: true,
    });
    expect(action.combined).toBe("quarantine");
    expect(action.transition.ok).toBe(true);
    if (action.transition.ok) expect(action.transition.status).toBe("QUARANTINED");
    expect(action.shouldPromote).toBe(false);
  });
});
