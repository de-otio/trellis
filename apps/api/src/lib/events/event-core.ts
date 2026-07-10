/**
 * Events primitive — PURE functional core (R1, P1-A).
 *
 * Side-effect-free decision arithmetic for RSVP capacity, guest-count changes,
 * and waitlist promotion ordering. No I/O, no Prisma, no clock: every function
 * is a total, deterministic map from its arguments to its result, and `now` is
 * always passed in where time matters (functional-core / imperative-shell,
 * design default #2; pin nondeterminism, default #7).
 *
 * IMPORTANT — where the guarantee lives (plan §4.3 MED-1): the
 * no-over-capacity GUARANTEE is enforced by the handler's atomic
 * affected-rows SQL, NOT by these functions. `decideRsvpOutcome` only decides
 * the *intended* seat; the shell then attempts that seat claim atomically and
 * re-decides if a concurrent claim won the race. These functions are therefore
 * property-tested for arithmetic/ordering correctness only — the concurrency
 * proof is an integration test.
 *
 * Fail-closed convention (mirrors `media/quota-check.ts`): on non-finite /
 * nonsensical numeric inputs a capacity decision resolves to the SAFE side —
 * WAITLISTED, never GOING — so a malformed input can never over-seat an event.
 *
 * Design: plans/events-primitive/README.md §4.3, §5.
 */

import type {
  EventStatusLiteral,
  RsvpDecisionInput,
  RsvpDecisionStatus,
  RsvpOutcome,
} from "./event-core-types.js";

// ---------------------------------------------------------------------------
// Party arithmetic
// ---------------------------------------------------------------------------

/**
 * Party size for an RSVP = the member (1) plus their accompanying `guests`.
 * `guests` is expected to be a non-negative integer already clamped at the Zod
 * boundary to `env.event.maxGuestsPerRsvp` (plan §4.3 SEC-1); this is pure
 * arithmetic and does not itself re-clamp — use {@link isGuestCountValid} for
 * the defensive bound check.
 */
export function partySize(guests: number): number {
  return 1 + guests;
}

/**
 * Defensive validity check for a client-supplied `guests` count against the
 * threshold-secret `maxGuests` cap (plan §4.3 SEC-1, §4.8). Belt to the Zod
 * boundary's suspenders: a finite integer in `[0, maxGuests]`. Anything else
 * (NaN, Infinity, negative, fractional, over the cap) is invalid.
 */
export function isGuestCountValid(guests: number, maxGuests: number): boolean {
  return (
    Number.isInteger(guests) &&
    guests >= 0 &&
    Number.isInteger(maxGuests) &&
    maxGuests >= 0 &&
    guests <= maxGuests
  );
}

// ---------------------------------------------------------------------------
// RSVP seat decision (fresh / GOING attempt)
// ---------------------------------------------------------------------------

/**
 * Decide whether a fresh (or promoted-to-GOING) RSVP of `party` seats fits
 * within `capacity` given the current `currentCount` of claimed seats.
 *
 *  - `capacity === null` → unlimited → always GOING.
 *  - `currentCount + party <= capacity` → GOING.
 *  - otherwise → WAITLISTED.
 *
 * Fail-closed: if any operand needed for the comparison is non-finite (NaN /
 * ±Infinity), the decision is WAITLISTED — never grant a seat on an input we
 * cannot trust. This preserves the core property that GOING is returned only
 * when `currentCount + party <= capacity` for a finite capacity.
 *
 * The returned `rsvpCountDelta` / `waitlistCountDelta` are the amounts the
 * shell adds to `Event.rsvpCount` / `Event.waitlistCount` iff the corresponding
 * atomic claim succeeds (plan §4.3).
 */
export function decideRsvpOutcome(input: RsvpDecisionInput): RsvpOutcome {
  const { currentCount, capacity, party } = input;

  const finiteCount = Number.isFinite(currentCount);
  const finiteParty = Number.isFinite(party);

  const fits =
    finiteCount &&
    finiteParty &&
    (capacity === null ||
      (Number.isFinite(capacity) && currentCount + party <= capacity));

  const status: RsvpDecisionStatus = fits ? "GOING" : "WAITLISTED";

  // Guard the deltas so a non-finite party never propagates into a count.
  const safeParty = finiteParty ? party : 0;

  return {
    status,
    party: safeParty,
    rsvpCountDelta: status === "GOING" ? safeParty : 0,
    waitlistCountDelta: status === "WAITLISTED" ? safeParty : 0,
  };
}

// ---------------------------------------------------------------------------
// Guest-count change on an existing GOING RSVP (plan §4.3 SEC-1)
// ---------------------------------------------------------------------------

/** Inputs to a guest-count change on an already-GOING RSVP. */
export interface GuestDeltaInput {
  /**
   * `Event.rsvpCount` as it stands NOW — it already INCLUDES this RSVP's
   * existing `oldParty` seats (the row is currently GOING).
   */
  readonly currentCount: number;
  /** Event capacity; null = unlimited. */
  readonly capacity: number | null;
  /** Existing party size on the GOING RSVP (1 + old guests). */
  readonly oldParty: number;
  /** Requested new party size (1 + new guests). */
  readonly newParty: number;
}

/** Outcome of a guest-count change. */
export interface GuestDeltaDecision {
  /** `newParty - oldParty`; negative frees seats, positive claims more. */
  readonly delta: number;
  /** Whether the change is permitted (a positive delta may not fit). */
  readonly allowed: boolean;
  /**
   * Amount to add to `Event.rsvpCount` iff the atomic claim succeeds:
   * `delta` when allowed (may be negative), else 0.
   */
  readonly rsvpCountDelta: number;
}

/**
 * Decide a guest-count change on an already-GOING RSVP (plan §4.3 SEC-1):
 *  - A non-positive delta (shrinking or unchanged) is always allowed — freeing
 *    seats never needs capacity headroom.
 *  - A positive delta is allowed only if it still fits: `capacity === null` or
 *    `currentCount + delta <= capacity`. Otherwise the change is rejected and
 *    the RSVP stays at its old size (`rsvpCountDelta === 0`).
 *
 * Fail-closed: a positive delta with a non-finite operand is rejected.
 */
export function decideGuestDelta(input: GuestDeltaInput): GuestDeltaDecision {
  const { currentCount, capacity, oldParty, newParty } = input;
  const delta = newParty - oldParty;

  if (!Number.isFinite(delta)) {
    return { delta: Number.isNaN(delta) ? Number.NaN : delta, allowed: false, rsvpCountDelta: 0 };
  }

  // Shrinking or unchanged: always allowed, frees (or leaves) seats.
  if (delta <= 0) {
    return { delta, allowed: true, rsvpCountDelta: delta };
  }

  const fits =
    Number.isFinite(currentCount) &&
    (capacity === null ||
      (Number.isFinite(capacity) && currentCount + delta <= capacity));

  return { delta, allowed: fits, rsvpCountDelta: fits ? delta : 0 };
}

// ---------------------------------------------------------------------------
// Waitlist promotion ordering (plan §4.3 SEC-3)
// ---------------------------------------------------------------------------

/**
 * A waitlisted RSVP considered for promotion. Ordering is by `createdAt`
 * (FIFO — first waitlisted, first promoted), with `id` as a deterministic
 * tie-break so two entries created in the same millisecond promote in a stable
 * order (pin nondeterminism, design default #7). `createdAt` is epoch
 * milliseconds; the shell converts its `Date` column to a number.
 */
export interface WaitlistCandidate {
  readonly id: string;
  /** Epoch milliseconds the RSVP was waitlisted. */
  readonly createdAt: number;
}

/**
 * Order waitlisted candidates for promotion, oldest first (plan §4.3 SEC-3).
 * Pure: returns a NEW array; the input is never mutated (immutability, default
 * #3). Deterministic and idempotent — sorting the output again yields the same
 * order. Ties on `createdAt` break by ascending `id`.
 */
export function orderWaitlistForPromotion<T extends WaitlistCandidate>(
  candidates: readonly T[],
): readonly T[] {
  return [...candidates].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

/**
 * The single next candidate to promote on a freed seat (the DB counterpart is
 * `... ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, plan §4.3 SEC-3),
 * or `null` when the waitlist is empty. Pure — does not mutate the input.
 */
export function selectNextPromotion<T extends WaitlistCandidate>(
  candidates: readonly T[],
): T | null {
  const ordered = orderWaitlistForPromotion(candidates);
  return ordered.length > 0 ? ordered[0]! : null;
}

// ---------------------------------------------------------------------------
// RSVP eligibility gate (pure, takes `now`) — plan §5
// ---------------------------------------------------------------------------

/** Why an RSVP attempt is refused before any capacity decision is made. */
export type RsvpRejectionReason =
  | "event-not-published"
  | "event-started"
  | "invalid-time";

/** Result of the pre-capacity eligibility gate. */
export interface RsvpEligibility {
  readonly allowed: boolean;
  readonly reason?: RsvpRejectionReason;
}

/**
 * Pure eligibility gate for an RSVP attempt, evaluated BEFORE any capacity
 * decision (plan §5: "RSVP to past/CANCELLED rejected"). Takes `now` as a
 * parameter so the handler injects a frozen clock in tests.
 *
 *  - Only a PUBLISHED event accepts RSVPs (DRAFT / CANCELLED → refused).
 *  - Non-finite `startsAt` / `now` → refused (fail-closed).
 *  - An event that has already started (`now >= startsAt`) → refused.
 *
 * `startsAt` and `now` are epoch milliseconds.
 */
export function canRsvp(
  status: EventStatusLiteral,
  startsAt: number,
  now: number,
): RsvpEligibility {
  if (status !== "PUBLISHED") {
    return { allowed: false, reason: "event-not-published" };
  }
  if (!Number.isFinite(startsAt) || !Number.isFinite(now)) {
    return { allowed: false, reason: "invalid-time" };
  }
  if (now >= startsAt) {
    return { allowed: false, reason: "event-started" };
  }
  return { allowed: true };
}
