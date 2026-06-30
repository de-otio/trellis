/**
 * Property + example tests for the moderation lifecycle state machine.
 *
 * The state machine is the load-bearing safety primitive: it must never let a
 * QUARANTINED/REJECTED object reach APPROVED without an explicit human approve,
 * and an illegal transition must never coerce into APPROVED. These are encoded
 * as fast-check properties (seeded for determinism) plus labeled-edge example
 * tests.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  ALL_MODERATION_DECISIONS,
  ALL_MODERATION_STATUSES,
  decisionToStatus,
  nextStatus,
  type ModerationDecision,
  type ModerationEvent,
  type ModerationStatus,
  type TransitionResult,
} from "../../../src/lib/media/moderation-status";

// Seed fast-check so the property suite is deterministic (CLAUDE.md: pin
// nondeterminism). numRuns kept generous since the input space is tiny.
const FC = { seed: 0x5eed, numRuns: 1000 } as const;

// --- arbitraries ----------------------------------------------------------

const statusArb: fc.Arbitrary<ModerationStatus> = fc.constantFrom(
  ...ALL_MODERATION_STATUSES,
);

const decisionArb: fc.Arbitrary<ModerationDecision> = fc.constantFrom(
  ...ALL_MODERATION_DECISIONS,
);

const eventArb: fc.Arbitrary<ModerationEvent> = fc.oneof(
  decisionArb.map((decision) => ({ kind: "decision", decision }) as const),
  fc
    .constantFrom("approve" as const, "reject" as const)
    .map((action) => ({ kind: "human", action }) as const),
  fc.constant({ kind: "csam" } as const),
);

// Non-CSAM events only — used to prove absorbing states stay absorbing.
const nonCsamEventArb: fc.Arbitrary<ModerationEvent> = fc.oneof(
  decisionArb.map((decision) => ({ kind: "decision", decision }) as const),
  fc
    .constantFrom("approve" as const, "reject" as const)
    .map((action) => ({ kind: "human", action }) as const),
);

/** Apply a sequence of events, stopping at the first illegal transition. */
function run(
  start: ModerationStatus,
  events: readonly ModerationEvent[],
): { status: ModerationStatus; results: TransitionResult[] } {
  let status = start;
  const results: TransitionResult[] = [];
  for (const event of events) {
    const result = nextStatus(status, event);
    results.push(result);
    if (result.ok) status = result.status;
  }
  return { status, results };
}

// --- properties -----------------------------------------------------------

describe("nextStatus — properties", () => {
  it("is a total function: every (status, event) returns ok or a typed illegal", () => {
    fc.assert(
      fc.property(statusArb, eventArb, (status, event) => {
        const result = nextStatus(status, event);
        if (result.ok) {
          expect(ALL_MODERATION_STATUSES).toContain(result.status);
        } else {
          expect(result.reason).toBe("illegal-transition");
          expect(result.from).toBe(status);
          expect(result.event).toEqual(event);
        }
      }),
      FC,
    );
  });

  it("never silently coerces an illegal transition into APPROVED", () => {
    fc.assert(
      fc.property(statusArb, eventArb, (status, event) => {
        const result = nextStatus(status, event);
        // An APPROVED outcome is only ever an *ok* outcome, never the silent
        // fallthrough of an illegal transition.
        if (!result.ok) {
          // illegal results carry no status at all — nothing to approve.
          expect("status" in result).toBe(false);
        }
      }),
      FC,
    );
  });

  it("a CSAM event drives ANY state to REJECTED", () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        const result = nextStatus(status, { kind: "csam" });
        expect(result).toEqual({ ok: true, status: "REJECTED" });
      }),
      FC,
    );
  });

  it("APPROVED and REJECTED are absorbing under any non-CSAM event", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ModerationStatus>("APPROVED", "REJECTED"),
        nonCsamEventArb,
        (status, event) => {
          const result = nextStatus(status, event);
          // No legal transition out of a terminal state except CSAM.
          expect(result.ok).toBe(false);
        },
      ),
      FC,
    );
  });

  it("no non-CSAM event sequence reaches APPROVED from QUARANTINED/REJECTED without a human approve", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ModerationStatus>("QUARANTINED", "REJECTED"),
        fc.array(nonCsamEventArb, { maxLength: 12 }),
        (start, events) => {
          const { status, results } = run(start, events);
          if (status === "APPROVED") {
            // The only legal way into APPROVED from these starts is a human
            // approve applied to QUARANTINED. REJECTED can never get there.
            const sawHumanApprove = results.some(
              (r, i) =>
                r.ok &&
                events[i].kind === "human" &&
                (events[i] as { action: string }).action === "approve",
            );
            expect(sawHumanApprove).toBe(true);
            expect(start).not.toBe("REJECTED");
          }
        },
      ),
      FC,
    );
  });

  it("REJECTED is unreachable-from and never escapes (no non-CSAM path leaves it)", () => {
    fc.assert(
      fc.property(fc.array(nonCsamEventArb, { maxLength: 12 }), (events) => {
        const { status } = run("REJECTED", events);
        expect(status).toBe("REJECTED");
      }),
      FC,
    );
  });

  it("APPROVED stays APPROVED under any non-CSAM event sequence", () => {
    fc.assert(
      fc.property(fc.array(nonCsamEventArb, { maxLength: 12 }), (events) => {
        const { status } = run("APPROVED", events);
        expect(status).toBe("APPROVED");
      }),
      FC,
    );
  });

  it("a 'decision' event is only legal from PENDING", () => {
    fc.assert(
      fc.property(statusArb, decisionArb, (status, decision) => {
        const result = nextStatus(status, { kind: "decision", decision });
        if (status === "PENDING") {
          expect(result.ok).toBe(true);
        } else {
          expect(result.ok).toBe(false);
        }
      }),
      FC,
    );
  });

  it("a 'human' event is only legal from REVIEW or QUARANTINED", () => {
    fc.assert(
      fc.property(
        statusArb,
        fc.constantFrom("approve" as const, "reject" as const),
        (status, action) => {
          const result = nextStatus(status, { kind: "human", action });
          const legal = status === "REVIEW" || status === "QUARANTINED";
          expect(result.ok).toBe(legal);
        },
      ),
      FC,
    );
  });
});

// --- exhaustiveness guard -------------------------------------------------

describe("ALL_MODERATION_STATUSES — union/array agreement", () => {
  // The anti-oracle property suites (serve gate) iterate this array to prove NO
  // status !== APPROVED ever serves. If the array could silently drift from the
  // ModerationStatus union (e.g. a new status added to the type + state machine
  // but forgotten here), a new servable-by-omission status would never be
  // exercised. The `satisfies Record<ModerationStatus, true>` guard in the
  // source makes the drift a compile error; this test pins the runtime shape.
  it("contains exactly the five lifecycle states, no more, no fewer", () => {
    expect([...ALL_MODERATION_STATUSES].sort()).toEqual(
      ["APPROVED", "PENDING", "QUARANTINED", "REJECTED", "REVIEW"].sort(),
    );
    expect(ALL_MODERATION_STATUSES).toHaveLength(5);
    expect(new Set(ALL_MODERATION_STATUSES).size).toBe(5); // no duplicates
  });

  it("every enumerated member is a value the state machine accepts as a start state", () => {
    // A member that the machine treats as unknown (hits the `default` illegal
    // branch under a human event) would reveal an array/union mismatch.
    for (const status of ALL_MODERATION_STATUSES) {
      const csam = nextStatus(status, { kind: "csam" });
      expect(csam).toEqual({ ok: true, status: "REJECTED" });
    }
  });
});

// --- labeled-edge example tests -------------------------------------------

describe("nextStatus — labeled edges", () => {
  const ok = (status: ModerationStatus): TransitionResult => ({
    ok: true,
    status,
  });

  it("PENDING --decision approved--> APPROVED", () => {
    expect(
      nextStatus("PENDING", { kind: "decision", decision: "approved" }),
    ).toEqual(ok("APPROVED"));
  });

  it("PENDING --decision review--> REVIEW", () => {
    expect(
      nextStatus("PENDING", { kind: "decision", decision: "review" }),
    ).toEqual(ok("REVIEW"));
  });

  it("PENDING --decision quarantine--> QUARANTINED", () => {
    expect(
      nextStatus("PENDING", { kind: "decision", decision: "quarantine" }),
    ).toEqual(ok("QUARANTINED"));
  });

  it("REVIEW --human approve--> APPROVED", () => {
    expect(
      nextStatus("REVIEW", { kind: "human", action: "approve" }),
    ).toEqual(ok("APPROVED"));
  });

  it("REVIEW --human reject--> REJECTED", () => {
    expect(
      nextStatus("REVIEW", { kind: "human", action: "reject" }),
    ).toEqual(ok("REJECTED"));
  });

  it("QUARANTINED --human approve--> APPROVED", () => {
    expect(
      nextStatus("QUARANTINED", { kind: "human", action: "approve" }),
    ).toEqual(ok("APPROVED"));
  });

  it("QUARANTINED --human reject--> REJECTED", () => {
    expect(
      nextStatus("QUARANTINED", { kind: "human", action: "reject" }),
    ).toEqual(ok("REJECTED"));
  });

  it("any state --csam--> REJECTED", () => {
    for (const status of ALL_MODERATION_STATUSES) {
      expect(nextStatus(status, { kind: "csam" })).toEqual(ok("REJECTED"));
    }
  });

  // Illegal edges — must report, never approve.
  it("PENDING --human approve--> illegal (no human acts on PENDING)", () => {
    const result = nextStatus("PENDING", { kind: "human", action: "approve" });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "illegal-transition", from: "PENDING" });
  });

  it("APPROVED --human reject--> illegal (terminal)", () => {
    const result = nextStatus("APPROVED", { kind: "human", action: "reject" });
    expect(result.ok).toBe(false);
  });

  it("REJECTED --human approve--> illegal (terminal; no resurrection)", () => {
    const result = nextStatus("REJECTED", { kind: "human", action: "approve" });
    expect(result.ok).toBe(false);
  });

  it("REVIEW --decision approved--> illegal (classifier does not re-decide)", () => {
    const result = nextStatus("REVIEW", {
      kind: "decision",
      decision: "approved",
    });
    expect(result.ok).toBe(false);
  });

  // Fail-closed widening at the I/O boundary.
  it("an unknown decision value from PENDING fails closed to REVIEW", () => {
    const result = nextStatus("PENDING", {
      kind: "decision",
      decision: "bogus" as ModerationDecision,
    });
    expect(result).toEqual(ok("REVIEW"));
  });
});

describe("decisionToStatus — sync-image verdict mapping (T4)", () => {
  // The expected mapping is the same one statusForDecision applies inside the
  // state machine; we anchor it here so a drift in either turns this test red.
  const EXPECTED: Record<ModerationDecision, ModerationStatus> = {
    approved: "APPROVED",
    review: "REVIEW",
    quarantine: "QUARANTINED",
  };

  it("maps each decision to its labeled status", () => {
    expect(decisionToStatus("approved")).toBe("APPROVED");
    expect(decisionToStatus("review")).toBe("REVIEW");
    expect(decisionToStatus("quarantine")).toBe("QUARANTINED");
  });

  it("property: equals the status nextStatus drives a PENDING object into", () => {
    fc.assert(
      fc.property(decisionArb, (decision) => {
        const viaMachine = nextStatus("PENDING", { kind: "decision", decision });
        // The PENDING --decision--> transition is always legal.
        expect(viaMachine.ok).toBe(true);
        if (viaMachine.ok) {
          expect(decisionToStatus(decision)).toBe(viaMachine.status);
        }
        expect(decisionToStatus(decision)).toBe(EXPECTED[decision]);
      }),
      FC,
    );
  });

  it("fails closed to REVIEW for an unexpected (widened) decision value", () => {
    // Mirrors the I/O-boundary widening: a provider string outside the union
    // must degrade to human review, never to APPROVED.
    expect(decisionToStatus("bogus" as ModerationDecision)).toBe("REVIEW");
  });
});
