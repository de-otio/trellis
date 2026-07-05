/**
 * Property + example tests for the consolidated media lifecycle state machine
 * (T14/AR4 — one machine replacing moderationStatus + uploadStatus).
 *
 * The state machine is the load-bearing safety primitive: it must never let a
 * QUARANTINED/REJECTED object reach APPROVED without an explicit human approve,
 * an illegal transition must never coerce into APPROVED, a decision must never
 * act on unconfirmed bytes (AWAITING_UPLOAD), and a replayed `bytes-arrived`
 * must never rewind a resolved verdict. These are encoded as fast-check
 * properties (seeded for determinism) plus labeled-edge example tests covering
 * EVERY legal edge.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  ALL_MODERATION_DECISIONS,
  ALL_MEDIA_LIFECYCLES,
  MODERATION_RESOLVED_LIFECYCLES,
  decisionToStatus,
  nextLifecycle,
  type ModerationDecision,
  type MediaLifecycleEvent,
  type MediaLifecycle,
  type TransitionResult,
} from "../../../src/lib/media/media-lifecycle";

// Seed fast-check so the property suite is deterministic (CLAUDE.md: pin
// nondeterminism). numRuns kept generous since the input space is tiny.
const FC = { seed: 0x5eed, numRuns: 1000 } as const;

// --- arbitraries ----------------------------------------------------------

const statusArb: fc.Arbitrary<MediaLifecycle> = fc.constantFrom(
  ...ALL_MEDIA_LIFECYCLES,
);

const decisionArb: fc.Arbitrary<ModerationDecision> = fc.constantFrom(
  ...ALL_MODERATION_DECISIONS,
);

const eventArb: fc.Arbitrary<MediaLifecycleEvent> = fc.oneof(
  fc.constant({ kind: "bytes-arrived" } as const),
  decisionArb.map((decision) => ({ kind: "decision", decision }) as const),
  fc
    .constantFrom("approve" as const, "reject" as const)
    .map((action) => ({ kind: "human", action }) as const),
  fc.constant({ kind: "csam" } as const),
  fc.constant({ kind: "over-duration" } as const),
  fc.constant({ kind: "upload-failed" } as const),
);

// Non-CSAM events only — used to prove absorbing states stay absorbing.
const nonCsamEventArb: fc.Arbitrary<MediaLifecycleEvent> = fc.oneof(
  fc.constant({ kind: "bytes-arrived" } as const),
  decisionArb.map((decision) => ({ kind: "decision", decision }) as const),
  fc
    .constantFrom("approve" as const, "reject" as const)
    .map((action) => ({ kind: "human", action }) as const),
  fc.constant({ kind: "over-duration" } as const),
  fc.constant({ kind: "upload-failed" } as const),
);

/** Apply a sequence of events, stopping at the first illegal transition. */
function run(
  start: MediaLifecycle,
  events: readonly MediaLifecycleEvent[],
): { status: MediaLifecycle; results: TransitionResult[] } {
  let status = start;
  const results: TransitionResult[] = [];
  for (const event of events) {
    const result = nextLifecycle(status, event);
    results.push(result);
    if (result.ok) status = result.status;
  }
  return { status, results };
}

// --- properties -----------------------------------------------------------

describe("nextLifecycle — properties", () => {
  it("is a total function: every (status, event) returns ok or a typed illegal", () => {
    fc.assert(
      fc.property(statusArb, eventArb, (status, event) => {
        const result = nextLifecycle(status, event);
        if (result.ok) {
          expect(ALL_MEDIA_LIFECYCLES).toContain(result.status);
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
        const result = nextLifecycle(status, event);
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
        const result = nextLifecycle(status, { kind: "csam" });
        expect(result).toEqual({ ok: true, status: "REJECTED" });
      }),
      FC,
    );
  });

  it("APPROVED, REJECTED, and UPLOAD_FAILED are absorbing under any non-CSAM event", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<MediaLifecycle>("APPROVED", "REJECTED", "UPLOAD_FAILED"),
        nonCsamEventArb,
        (status, event) => {
          const result = nextLifecycle(status, event);
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
        fc.constantFrom<MediaLifecycle>("QUARANTINED", "REJECTED"),
        fc.array(nonCsamEventArb, { maxLength: 12 }),
        (start, events) => {
          const { status, results } = run(start, events);
          if (status === "APPROVED") {
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

  it("no event sequence starting before UPLOADED reaches APPROVED without a decision or human approve", () => {
    // The presigned-flow safety property: neither bytes-arrived nor the
    // completion call (which only drives bytes-arrived) can approve anything.
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant({ kind: "bytes-arrived" } as const),
            fc.constant({ kind: "upload-failed" } as const),
            fc.constant({ kind: "over-duration" } as const),
          ),
          { maxLength: 12 },
        ),
        (events) => {
          const { status } = run("AWAITING_UPLOAD", events);
          expect(status).not.toBe("APPROVED");
        },
      ),
      FC,
    );
  });

  it("REJECTED never escapes (no non-CSAM path leaves it)", () => {
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

  it("a 'decision' event is only legal from UPLOADED — never from unconfirmed bytes", () => {
    fc.assert(
      fc.property(statusArb, decisionArb, (status, decision) => {
        const result = nextLifecycle(status, { kind: "decision", decision });
        if (status === "UPLOADED") {
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
          const result = nextLifecycle(status, { kind: "human", action });
          const legal = status === "REVIEW" || status === "QUARANTINED";
          expect(result.ok).toBe(legal);
        },
      ),
      FC,
    );
  });

  it("'bytes-arrived' never leaves {AWAITING_UPLOAD, UPLOADED} — a replayed S3 event cannot rewind a verdict", () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        const result = nextLifecycle(status, { kind: "bytes-arrived" });
        if (status === "AWAITING_UPLOAD" || status === "UPLOADED") {
          expect(result).toEqual({ ok: true, status: "UPLOADED" });
        } else {
          expect(result.ok).toBe(false);
        }
      }),
      FC,
    );
  });

  it("'over-duration' is only legal from UPLOADED and always lands on REJECTED", () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        const result = nextLifecycle(status, { kind: "over-duration" });
        if (status === "UPLOADED") {
          expect(result).toEqual({ ok: true, status: "REJECTED" });
        } else {
          expect(result.ok).toBe(false);
        }
      }),
      FC,
    );
  });

  it("'upload-failed' is only legal from AWAITING_UPLOAD/UPLOADED and lands on UPLOAD_FAILED", () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        const result = nextLifecycle(status, { kind: "upload-failed" });
        if (status === "AWAITING_UPLOAD" || status === "UPLOADED") {
          expect(result).toEqual({ ok: true, status: "UPLOAD_FAILED" });
        } else {
          expect(result.ok).toBe(false);
        }
      }),
      FC,
    );
  });
});

// --- exhaustiveness guard -------------------------------------------------

describe("ALL_MEDIA_LIFECYCLES — union/array agreement", () => {
  // The anti-oracle property suites (serve gate) iterate this array to prove NO
  // status !== APPROVED ever serves. If the array could silently drift from the
  // MediaLifecycle union (e.g. a new status added to the type + state machine
  // but forgotten here), a new servable-by-omission status would never be
  // exercised. The `satisfies Record<MediaLifecycle, true>` guard in the
  // source makes the drift a compile error; this test pins the runtime shape.
  it("contains exactly the seven lifecycle states, no more, no fewer", () => {
    expect([...ALL_MEDIA_LIFECYCLES].sort()).toEqual(
      [
        "AWAITING_UPLOAD",
        "UPLOADED",
        "APPROVED",
        "REVIEW",
        "QUARANTINED",
        "REJECTED",
        "UPLOAD_FAILED",
      ].sort(),
    );
    expect(ALL_MEDIA_LIFECYCLES).toHaveLength(7);
    expect(new Set(ALL_MEDIA_LIFECYCLES).size).toBe(7); // no duplicates
  });

  it("the moderation-resolved subset is exactly the four verdict states", () => {
    expect([...MODERATION_RESOLVED_LIFECYCLES].sort()).toEqual(
      ["APPROVED", "QUARANTINED", "REJECTED", "REVIEW"].sort(),
    );
    for (const s of MODERATION_RESOLVED_LIFECYCLES) {
      expect(ALL_MEDIA_LIFECYCLES).toContain(s);
    }
  });

  it("every enumerated member is a value the state machine accepts as a start state", () => {
    for (const status of ALL_MEDIA_LIFECYCLES) {
      const csam = nextLifecycle(status, { kind: "csam" });
      expect(csam).toEqual({ ok: true, status: "REJECTED" });
    }
  });
});

// --- labeled-edge example tests (every legal edge + key illegal edges) -----

describe("nextLifecycle — labeled edges", () => {
  const ok = (status: MediaLifecycle): TransitionResult => ({
    ok: true,
    status,
  });

  it("AWAITING_UPLOAD --bytes-arrived--> UPLOADED", () => {
    expect(nextLifecycle("AWAITING_UPLOAD", { kind: "bytes-arrived" })).toEqual(
      ok("UPLOADED"),
    );
  });

  it("AWAITING_UPLOAD --upload-failed--> UPLOAD_FAILED", () => {
    expect(nextLifecycle("AWAITING_UPLOAD", { kind: "upload-failed" })).toEqual(
      ok("UPLOAD_FAILED"),
    );
  });

  it("UPLOADED --bytes-arrived--> UPLOADED (idempotent race of worker + completion call)", () => {
    expect(nextLifecycle("UPLOADED", { kind: "bytes-arrived" })).toEqual(
      ok("UPLOADED"),
    );
  });

  it("UPLOADED --decision approved--> APPROVED", () => {
    expect(
      nextLifecycle("UPLOADED", { kind: "decision", decision: "approved" }),
    ).toEqual(ok("APPROVED"));
  });

  it("UPLOADED --decision review--> REVIEW", () => {
    expect(
      nextLifecycle("UPLOADED", { kind: "decision", decision: "review" }),
    ).toEqual(ok("REVIEW"));
  });

  it("UPLOADED --decision quarantine--> QUARANTINED", () => {
    expect(
      nextLifecycle("UPLOADED", { kind: "decision", decision: "quarantine" }),
    ).toEqual(ok("QUARANTINED"));
  });

  it("UPLOADED --over-duration--> REJECTED (ffprobe gate; terminal)", () => {
    expect(nextLifecycle("UPLOADED", { kind: "over-duration" })).toEqual(
      ok("REJECTED"),
    );
  });

  it("UPLOADED --upload-failed--> UPLOAD_FAILED (stuck-pipeline reap)", () => {
    expect(nextLifecycle("UPLOADED", { kind: "upload-failed" })).toEqual(
      ok("UPLOAD_FAILED"),
    );
  });

  it("REVIEW --human approve--> APPROVED", () => {
    expect(
      nextLifecycle("REVIEW", { kind: "human", action: "approve" }),
    ).toEqual(ok("APPROVED"));
  });

  it("REVIEW --human reject--> REJECTED", () => {
    expect(
      nextLifecycle("REVIEW", { kind: "human", action: "reject" }),
    ).toEqual(ok("REJECTED"));
  });

  it("QUARANTINED --human approve--> APPROVED", () => {
    expect(
      nextLifecycle("QUARANTINED", { kind: "human", action: "approve" }),
    ).toEqual(ok("APPROVED"));
  });

  it("QUARANTINED --human reject--> REJECTED", () => {
    expect(
      nextLifecycle("QUARANTINED", { kind: "human", action: "reject" }),
    ).toEqual(ok("REJECTED"));
  });

  it("any state --csam--> REJECTED", () => {
    for (const status of ALL_MEDIA_LIFECYCLES) {
      expect(nextLifecycle(status, { kind: "csam" })).toEqual(ok("REJECTED"));
    }
  });

  // Illegal edges — must report, never approve.
  it("AWAITING_UPLOAD --decision approved--> illegal (no verdict on unconfirmed bytes)", () => {
    const result = nextLifecycle("AWAITING_UPLOAD", {
      kind: "decision",
      decision: "approved",
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      reason: "illegal-transition",
      from: "AWAITING_UPLOAD",
    });
  });

  it("AWAITING_UPLOAD --over-duration--> illegal (nothing probed yet)", () => {
    expect(
      nextLifecycle("AWAITING_UPLOAD", { kind: "over-duration" }).ok,
    ).toBe(false);
  });

  it("UPLOADED --human approve--> illegal (no human acts pre-verdict)", () => {
    const result = nextLifecycle("UPLOADED", {
      kind: "human",
      action: "approve",
    });
    expect(result.ok).toBe(false);
  });

  it("APPROVED --bytes-arrived--> illegal (replayed S3 event cannot rewind)", () => {
    expect(nextLifecycle("APPROVED", { kind: "bytes-arrived" }).ok).toBe(false);
  });

  it("REVIEW --bytes-arrived--> illegal (replayed S3 event cannot rewind)", () => {
    expect(nextLifecycle("REVIEW", { kind: "bytes-arrived" }).ok).toBe(false);
  });

  it("APPROVED --human reject--> illegal (terminal)", () => {
    expect(
      nextLifecycle("APPROVED", { kind: "human", action: "reject" }).ok,
    ).toBe(false);
  });

  it("REJECTED --human approve--> illegal (terminal; no resurrection)", () => {
    expect(
      nextLifecycle("REJECTED", { kind: "human", action: "approve" }).ok,
    ).toBe(false);
  });

  it("UPLOAD_FAILED --bytes-arrived--> illegal (terminal; a failed upload stays failed)", () => {
    expect(nextLifecycle("UPLOAD_FAILED", { kind: "bytes-arrived" }).ok).toBe(
      false,
    );
  });

  it("REVIEW --decision approved--> illegal (classifier does not re-decide)", () => {
    expect(
      nextLifecycle("REVIEW", { kind: "decision", decision: "approved" }).ok,
    ).toBe(false);
  });

  // Fail-closed widening at the I/O boundary.
  it("an unknown decision value from UPLOADED fails closed to REVIEW", () => {
    const result = nextLifecycle("UPLOADED", {
      kind: "decision",
      decision: "bogus" as ModerationDecision,
    });
    expect(result).toEqual(ok("REVIEW"));
  });
});

describe("decisionToStatus — sync-image verdict mapping", () => {
  const EXPECTED: Record<ModerationDecision, MediaLifecycle> = {
    approved: "APPROVED",
    review: "REVIEW",
    quarantine: "QUARANTINED",
  };

  it("maps each decision to its labeled status", () => {
    expect(decisionToStatus("approved")).toBe("APPROVED");
    expect(decisionToStatus("review")).toBe("REVIEW");
    expect(decisionToStatus("quarantine")).toBe("QUARANTINED");
  });

  it("property: equals the status nextLifecycle drives an UPLOADED object into", () => {
    fc.assert(
      fc.property(decisionArb, (decision) => {
        const viaMachine = nextLifecycle("UPLOADED", {
          kind: "decision",
          decision,
        });
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
    expect(decisionToStatus("bogus" as ModerationDecision)).toBe("REVIEW");
  });
});
