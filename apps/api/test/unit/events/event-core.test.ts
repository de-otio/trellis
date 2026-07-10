/**
 * Unit + property tests for the events pure functional core (P1-A).
 *
 * Covers the capacity seat decision, party arithmetic, guest-count-change
 * validation, and waitlist promotion ordering. The central property
 * (plan §4.3): `decideRsvpOutcome` NEVER returns GOING when
 * `currentCount + party > capacity` for a finite capacity.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  canRsvp,
  decideGuestDelta,
  decideRsvpOutcome,
  isGuestCountValid,
  orderWaitlistForPromotion,
  partySize,
  selectNextPromotion,
  type WaitlistCandidate,
} from "../../../src/lib/events/event-core.js";
import type {
  EventStatusLiteral,
  RsvpDecisionInput,
} from "../../../src/lib/events/event-core-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decision(
  currentCount: number,
  capacity: number | null,
  party: number,
): RsvpDecisionInput {
  return { currentCount, capacity, party };
}

// ===========================================================================
// partySize
// ===========================================================================

describe("partySize", () => {
  it("is 1 for a lone member (0 guests)", () => {
    expect(partySize(0)).toBe(1);
  });

  it("is 1 + guests", () => {
    expect(partySize(1)).toBe(2);
    expect(partySize(5)).toBe(6);
  });
});

// ===========================================================================
// isGuestCountValid
// ===========================================================================

describe("isGuestCountValid", () => {
  it("accepts 0 up to and including maxGuests", () => {
    expect(isGuestCountValid(0, 10)).toBe(true);
    expect(isGuestCountValid(10, 10)).toBe(true);
    expect(isGuestCountValid(5, 10)).toBe(true);
  });

  it("rejects guests above maxGuests", () => {
    expect(isGuestCountValid(11, 10)).toBe(false);
  });

  it("rejects negative guests", () => {
    expect(isGuestCountValid(-1, 10)).toBe(false);
  });

  it("rejects fractional guests", () => {
    expect(isGuestCountValid(1.5, 10)).toBe(false);
  });

  it("rejects non-finite guests", () => {
    expect(isGuestCountValid(NaN, 10)).toBe(false);
    expect(isGuestCountValid(Infinity, 10)).toBe(false);
    expect(isGuestCountValid(-Infinity, 10)).toBe(false);
  });

  it("rejects a non-integer / negative maxGuests bound", () => {
    expect(isGuestCountValid(0, 1.5)).toBe(false);
    expect(isGuestCountValid(0, -1)).toBe(false);
    expect(isGuestCountValid(0, NaN)).toBe(false);
  });

  it("with maxGuests 0 only a lone member (0 guests) is valid", () => {
    expect(isGuestCountValid(0, 0)).toBe(true);
    expect(isGuestCountValid(1, 0)).toBe(false);
  });
});

// ===========================================================================
// decideRsvpOutcome — boundary cases
// ===========================================================================

describe("decideRsvpOutcome — unlimited capacity", () => {
  it("always GOING when capacity is null", () => {
    const out = decideRsvpOutcome(decision(1_000_000, null, 3));
    expect(out.status).toBe("GOING");
    expect(out.rsvpCountDelta).toBe(3);
    expect(out.waitlistCountDelta).toBe(0);
    expect(out.party).toBe(3);
  });
});

describe("decideRsvpOutcome — capacity boundary", () => {
  it("GOING when count + party is exactly capacity", () => {
    const out = decideRsvpOutcome(decision(8, 10, 2));
    expect(out.status).toBe("GOING");
    expect(out.rsvpCountDelta).toBe(2);
    expect(out.waitlistCountDelta).toBe(0);
  });

  it("GOING when count + party is one below capacity", () => {
    const out = decideRsvpOutcome(decision(7, 10, 2));
    expect(out.status).toBe("GOING");
  });

  it("WAITLISTED when count + party is one over capacity", () => {
    const out = decideRsvpOutcome(decision(9, 10, 2));
    expect(out.status).toBe("WAITLISTED");
    expect(out.rsvpCountDelta).toBe(0);
    expect(out.waitlistCountDelta).toBe(2);
    expect(out.party).toBe(2);
  });

  it("WAITLISTED when the event is already exactly full", () => {
    const out = decideRsvpOutcome(decision(10, 10, 1));
    expect(out.status).toBe("WAITLISTED");
    expect(out.waitlistCountDelta).toBe(1);
  });

  it("WAITLISTED when a single party of 1 cannot fit a zero-capacity event", () => {
    const out = decideRsvpOutcome(decision(0, 0, 1));
    expect(out.status).toBe("WAITLISTED");
  });

  it("GOING for a first party that exactly fills capacity", () => {
    const out = decideRsvpOutcome(decision(0, 5, 5));
    expect(out.status).toBe("GOING");
    expect(out.rsvpCountDelta).toBe(5);
  });
});

describe("decideRsvpOutcome — fail-closed on bad inputs", () => {
  it("WAITLISTED when capacity is Infinity (untrustworthy limit)", () => {
    const out = decideRsvpOutcome(decision(0, Infinity, 1));
    expect(out.status).toBe("WAITLISTED");
  });

  it("WAITLISTED when currentCount is NaN", () => {
    const out = decideRsvpOutcome(decision(NaN, 10, 1));
    expect(out.status).toBe("WAITLISTED");
  });

  it("WAITLISTED when party is NaN, and deltas do not propagate NaN", () => {
    const out = decideRsvpOutcome(decision(0, 10, NaN));
    expect(out.status).toBe("WAITLISTED");
    expect(out.party).toBe(0);
    expect(out.rsvpCountDelta).toBe(0);
    expect(out.waitlistCountDelta).toBe(0);
  });

  it("WAITLISTED when capacity is NaN", () => {
    const out = decideRsvpOutcome(decision(0, NaN, 1));
    expect(out.status).toBe("WAITLISTED");
  });

  it("WAITLISTED when party is Infinity", () => {
    const out = decideRsvpOutcome(decision(0, 10, Infinity));
    expect(out.status).toBe("WAITLISTED");
    expect(out.rsvpCountDelta).toBe(0);
    expect(out.waitlistCountDelta).toBe(0);
  });

  it("GOING with an unlimited (null) capacity even if count is huge", () => {
    const out = decideRsvpOutcome(decision(Number.MAX_SAFE_INTEGER, null, 1));
    expect(out.status).toBe("GOING");
  });
});

// ===========================================================================
// decideRsvpOutcome — properties
// ===========================================================================

describe("decideRsvpOutcome — properties", () => {
  const nat = fc.integer({ min: 0, max: 1_000_000 });
  const party = fc.integer({ min: 1, max: 100 });

  it("PROPERTY: never GOING when count + party > capacity (finite capacity)", () => {
    fc.assert(
      fc.property(nat, fc.integer({ min: 0, max: 1_000_000 }), party, (count, cap, p) => {
        const out = decideRsvpOutcome(decision(count, cap, p));
        if (count + p > cap) {
          return out.status === "WAITLISTED";
        }
        return out.status === "GOING";
      }),
    );
  });

  it("PROPERTY: unlimited (null) capacity is always GOING", () => {
    fc.assert(
      fc.property(nat, party, (count, p) => {
        return decideRsvpOutcome(decision(count, null, p)).status === "GOING";
      }),
    );
  });

  it("PROPERTY: exactly one of the two count deltas is the party, the other 0", () => {
    fc.assert(
      fc.property(nat, fc.oneof(fc.constant(null), nat), party, (count, cap, p) => {
        const out = decideRsvpOutcome(decision(count, cap, p));
        if (out.status === "GOING") {
          return out.rsvpCountDelta === p && out.waitlistCountDelta === 0;
        }
        return out.rsvpCountDelta === 0 && out.waitlistCountDelta === p;
      }),
    );
  });

  it("PROPERTY: GOING implies the seat claim fits capacity", () => {
    fc.assert(
      fc.property(nat, fc.oneof(fc.constant(null), nat), party, (count, cap, p) => {
        const out = decideRsvpOutcome(decision(count, cap, p));
        if (out.status !== "GOING") return true;
        return cap === null || count + p <= cap;
      }),
    );
  });
});

// ===========================================================================
// decideGuestDelta
// ===========================================================================

describe("decideGuestDelta — shrinking or unchanged", () => {
  it("allows an unchanged party (delta 0)", () => {
    const out = decideGuestDelta({ currentCount: 10, capacity: 10, oldParty: 2, newParty: 2 });
    expect(out.allowed).toBe(true);
    expect(out.delta).toBe(0);
    expect(out.rsvpCountDelta).toBe(0);
  });

  it("allows shrinking even on a full event and frees seats", () => {
    const out = decideGuestDelta({ currentCount: 10, capacity: 10, oldParty: 3, newParty: 1 });
    expect(out.allowed).toBe(true);
    expect(out.delta).toBe(-2);
    expect(out.rsvpCountDelta).toBe(-2);
  });
});

describe("decideGuestDelta — growing", () => {
  it("allows a positive delta that still fits", () => {
    const out = decideGuestDelta({ currentCount: 5, capacity: 10, oldParty: 1, newParty: 3 });
    expect(out.allowed).toBe(true);
    expect(out.delta).toBe(2);
    expect(out.rsvpCountDelta).toBe(2);
  });

  it("allows a positive delta that exactly reaches capacity", () => {
    const out = decideGuestDelta({ currentCount: 8, capacity: 10, oldParty: 1, newParty: 3 });
    expect(out.allowed).toBe(true);
    expect(out.rsvpCountDelta).toBe(2);
  });

  it("rejects a positive delta that would exceed capacity, keeping the old size", () => {
    const out = decideGuestDelta({ currentCount: 9, capacity: 10, oldParty: 1, newParty: 3 });
    expect(out.allowed).toBe(false);
    expect(out.delta).toBe(2);
    expect(out.rsvpCountDelta).toBe(0);
  });

  it("allows any positive delta when capacity is unlimited (null)", () => {
    const out = decideGuestDelta({ currentCount: 1_000, capacity: null, oldParty: 1, newParty: 50 });
    expect(out.allowed).toBe(true);
    expect(out.rsvpCountDelta).toBe(49);
  });
});

describe("decideGuestDelta — fail-closed", () => {
  it("rejects a positive delta when currentCount is non-finite", () => {
    const out = decideGuestDelta({ currentCount: NaN, capacity: 10, oldParty: 1, newParty: 3 });
    expect(out.allowed).toBe(false);
    expect(out.rsvpCountDelta).toBe(0);
  });

  it("rejects a positive delta when capacity is Infinity", () => {
    const out = decideGuestDelta({ currentCount: 0, capacity: Infinity, oldParty: 1, newParty: 3 });
    expect(out.allowed).toBe(false);
  });

  it("rejects when the delta itself is non-finite", () => {
    const out = decideGuestDelta({ currentCount: 0, capacity: 10, oldParty: 1, newParty: Infinity });
    expect(out.allowed).toBe(false);
    expect(out.rsvpCountDelta).toBe(0);
    expect(out.delta).toBe(Infinity);
  });

  it("rejects when the delta is NaN", () => {
    const out = decideGuestDelta({ currentCount: 0, capacity: 10, oldParty: NaN, newParty: 3 });
    expect(out.allowed).toBe(false);
    expect(Number.isNaN(out.delta)).toBe(true);
  });
});

describe("decideGuestDelta — properties", () => {
  const nat = fc.integer({ min: 0, max: 1_000_000 });
  const partyN = fc.integer({ min: 1, max: 100 });

  it("PROPERTY: a non-positive delta is always allowed", () => {
    fc.assert(
      fc.property(nat, fc.oneof(fc.constant(null), nat), partyN, partyN, (count, cap, oldP, newP) => {
        const lo = Math.min(oldP, newP);
        const hi = Math.max(oldP, newP);
        // newParty <= oldParty
        const out = decideGuestDelta({ currentCount: count, capacity: cap, oldParty: hi, newParty: lo });
        return out.allowed === true && out.rsvpCountDelta === lo - hi;
      }),
    );
  });

  it("PROPERTY: a positive delta is allowed iff it fits the finite capacity", () => {
    fc.assert(
      fc.property(nat, nat, partyN, (count, cap, extra) => {
        const oldP = 1;
        const newP = 1 + extra; // strictly positive delta of `extra`
        const out = decideGuestDelta({ currentCount: count, capacity: cap, oldParty: oldP, newParty: newP });
        const fits = count + extra <= cap;
        return out.allowed === fits && out.rsvpCountDelta === (fits ? extra : 0);
      }),
    );
  });

  it("PROPERTY: never allows a positive delta that overflows finite capacity", () => {
    fc.assert(
      fc.property(nat, nat, partyN, (count, cap, extra) => {
        const out = decideGuestDelta({ currentCount: count, capacity: cap, oldParty: 1, newParty: 1 + extra });
        if (count + extra > cap) return out.allowed === false && out.rsvpCountDelta === 0;
        return true;
      }),
    );
  });
});

// ===========================================================================
// orderWaitlistForPromotion / selectNextPromotion
// ===========================================================================

describe("orderWaitlistForPromotion", () => {
  it("returns an empty array unchanged", () => {
    expect(orderWaitlistForPromotion([])).toEqual([]);
  });

  it("orders oldest createdAt first (FIFO)", () => {
    const cs: WaitlistCandidate[] = [
      { id: "c", createdAt: 300 },
      { id: "a", createdAt: 100 },
      { id: "b", createdAt: 200 },
    ];
    expect(orderWaitlistForPromotion(cs).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks createdAt ties by ascending id (deterministic)", () => {
    const cs: WaitlistCandidate[] = [
      { id: "z", createdAt: 100 },
      { id: "a", createdAt: 100 },
      { id: "m", createdAt: 100 },
    ];
    expect(orderWaitlistForPromotion(cs).map((c) => c.id)).toEqual(["a", "m", "z"]);
  });

  it("keeps fully-equal entries (same createdAt and id) stable", () => {
    const cs: WaitlistCandidate[] = [
      { id: "a", createdAt: 100 },
      { id: "a", createdAt: 100 },
    ];
    expect(orderWaitlistForPromotion(cs).map((c) => c.id)).toEqual(["a", "a"]);
  });

  it("does not mutate the input array", () => {
    const cs: WaitlistCandidate[] = [
      { id: "b", createdAt: 200 },
      { id: "a", createdAt: 100 },
    ];
    const before = cs.map((c) => c.id);
    orderWaitlistForPromotion(cs);
    expect(cs.map((c) => c.id)).toEqual(before);
  });

  it("is idempotent — ordering the output again is a no-op", () => {
    const cs: WaitlistCandidate[] = [
      { id: "c", createdAt: 300 },
      { id: "a", createdAt: 100 },
      { id: "b", createdAt: 100 },
    ];
    const once = orderWaitlistForPromotion(cs);
    const twice = orderWaitlistForPromotion(once);
    expect(twice).toEqual(once);
  });
});

describe("selectNextPromotion", () => {
  it("returns null for an empty waitlist", () => {
    expect(selectNextPromotion([])).toBeNull();
  });

  it("returns the oldest candidate", () => {
    const cs: WaitlistCandidate[] = [
      { id: "b", createdAt: 200 },
      { id: "a", createdAt: 100 },
    ];
    expect(selectNextPromotion(cs)?.id).toBe("a");
  });

  it("returns the lexicographically-smallest id on a createdAt tie", () => {
    const cs: WaitlistCandidate[] = [
      { id: "z", createdAt: 100 },
      { id: "a", createdAt: 100 },
    ];
    expect(selectNextPromotion(cs)?.id).toBe("a");
  });
});

describe("orderWaitlistForPromotion — properties", () => {
  const candidateArb = fc.array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 8 }),
      createdAt: fc.integer({ min: 0, max: 1_000_000 }),
    }),
    { maxLength: 40 },
  );

  it("PROPERTY: output is a permutation (same multiset of ids) of the input", () => {
    fc.assert(
      fc.property(candidateArb, (cs) => {
        const out = orderWaitlistForPromotion(cs);
        if (out.length !== cs.length) return false;
        const sortIds = (xs: readonly { id: string }[]) => xs.map((x) => x.id).sort();
        return JSON.stringify(sortIds(out)) === JSON.stringify(sortIds(cs));
      }),
    );
  });

  it("PROPERTY: output is non-decreasing by createdAt, ties non-decreasing by id", () => {
    fc.assert(
      fc.property(candidateArb, (cs) => {
        const out = orderWaitlistForPromotion(cs);
        for (let i = 1; i < out.length; i++) {
          const prev = out[i - 1]!;
          const cur = out[i]!;
          if (prev.createdAt > cur.createdAt) return false;
          if (prev.createdAt === cur.createdAt && prev.id > cur.id) return false;
        }
        return true;
      }),
    );
  });

  it("PROPERTY: selectNextPromotion equals the head of the ordered list", () => {
    fc.assert(
      fc.property(candidateArb, (cs) => {
        const head = orderWaitlistForPromotion(cs)[0] ?? null;
        const next = selectNextPromotion(cs);
        if (head === null) return next === null;
        return next !== null && next.id === head.id && next.createdAt === head.createdAt;
      }),
    );
  });
});

// ===========================================================================
// canRsvp
// ===========================================================================

describe("canRsvp", () => {
  const start = 2_000;
  const before = 1_000;
  const after = 3_000;

  it("allows an RSVP to a PUBLISHED, not-yet-started event", () => {
    expect(canRsvp("PUBLISHED", start, before)).toEqual({ allowed: true });
  });

  it("refuses a DRAFT event", () => {
    expect(canRsvp("DRAFT", start, before)).toEqual({
      allowed: false,
      reason: "event-not-published",
    });
  });

  it("refuses a CANCELLED event", () => {
    expect(canRsvp("CANCELLED", start, before)).toEqual({
      allowed: false,
      reason: "event-not-published",
    });
  });

  it("refuses once the event has started (now === startsAt)", () => {
    expect(canRsvp("PUBLISHED", start, start)).toEqual({
      allowed: false,
      reason: "event-started",
    });
  });

  it("refuses after the event has started (now > startsAt)", () => {
    expect(canRsvp("PUBLISHED", start, after)).toEqual({
      allowed: false,
      reason: "event-started",
    });
  });

  it("refuses on non-finite startsAt", () => {
    expect(canRsvp("PUBLISHED", NaN, before).reason).toBe("invalid-time");
    expect(canRsvp("PUBLISHED", Infinity, before).reason).toBe("invalid-time");
  });

  it("refuses on non-finite now", () => {
    expect(canRsvp("PUBLISHED", start, NaN).reason).toBe("invalid-time");
  });

  it("PROPERTY: a PUBLISHED event is RSVP-able exactly while now < startsAt", () => {
    const ts = fc.integer({ min: -1_000_000, max: 1_000_000 });
    fc.assert(
      fc.property(ts, ts, (startsAt, now) => {
        const res = canRsvp("PUBLISHED", startsAt, now);
        return res.allowed === now < startsAt;
      }),
    );
  });

  it("PROPERTY: a non-PUBLISHED status is never RSVP-able regardless of time", () => {
    const ts = fc.integer({ min: -1_000_000, max: 1_000_000 });
    const nonPublished = fc.constantFrom<EventStatusLiteral>("DRAFT", "CANCELLED");
    fc.assert(
      fc.property(nonPublished, ts, ts, (status, startsAt, now) => {
        return canRsvp(status, startsAt, now).allowed === false;
      }),
    );
  });
});
