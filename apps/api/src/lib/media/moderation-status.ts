/**
 * Media moderation lifecycle: status union, classifier-decision union, and the
 * pure `nextStatus()` state machine.
 *
 * This module is the **hand-written source of truth** for the moderation
 * lifecycle states. It deliberately has **zero dependency on the
 * Prisma-generated client** so the serve gate and key-adoption code can compile
 * in worktrees that have not regenerated the client. The Prisma
 * `enum ModerationStatus` mirrors {@link ModerationStatus} exactly; the
 * imperative shell maps `Prisma.MediaFile.moderationStatus -> this union` at the
 * I/O boundary.
 *
 * Pure functional core: no I/O, no clock, no Prisma import. Exhaustively
 * property-tested.
 */

/**
 * The lifecycle state of a media object's moderation, persisted as
 * `MediaFile.moderationStatus`. Hand-written source of truth — the Prisma enum
 * must match this union member-for-member.
 *
 * - `PENDING`     — born here; nothing serves until a verdict moves it forward.
 * - `APPROVED`    — the only state that serves bytes (the gate is APPROVED-only).
 * - `REVIEW`      — classifier was uncertain; awaiting a human moderator.
 * - `QUARANTINED` — classifier flagged it; awaiting a human moderator.
 * - `REJECTED`    — terminal; never serves.
 */
export type ModerationStatus =
  | "PENDING"
  | "APPROVED"
  | "REVIEW"
  | "QUARANTINED"
  | "REJECTED";

/**
 * The 3-value classifier verdict (the `decision` field of a moderation
 * provider's result). This is intentionally **not** 4-value: `rejected` is a
 * lifecycle *status* a human (or the CSAM provider) produces, never a classifier
 * decision.
 */
export type ModerationDecision = "approved" | "review" | "quarantine";

/**
 * Events that drive a `moderationStatus` transition.
 *
 * - `decision` — the classifier/worker verdict on a `PENDING` object.
 * - `human`    — a human moderator resolving a `REVIEW`/`QUARANTINED` object.
 * - `csam`     — a confirmed hit from the separate (statutory) CSAM provider;
 *                drives `-> REJECTED` from *any* state, with the preserve-and-
 *                report duty handled by the shell (a human checkpoint).
 */
export type ModerationEvent =
  | { readonly kind: "decision"; readonly decision: ModerationDecision }
  | { readonly kind: "human"; readonly action: "approve" | "reject" }
  | { readonly kind: "csam" };

/**
 * A transition that the state machine refuses. Returned (never thrown) so the
 * machine stays a pure total function and callers must handle the illegal case
 * explicitly — an illegal transition must **never** silently no-op into
 * `APPROVED`.
 */
export type IllegalTransition = {
  readonly ok: false;
  readonly reason: "illegal-transition";
  readonly from: ModerationStatus;
  readonly event: ModerationEvent;
};

/** A successful transition to a next status. */
export type TransitionResult =
  | { readonly ok: true; readonly status: ModerationStatus }
  | IllegalTransition;

/**
 * Map a classifier decision to the status it drives a `PENDING` object into.
 *
 * Fail-closed: any value that is not one of the three known decisions resolves
 * to `REVIEW` (never `APPROVED`). This is the only place the union is widened —
 * callers at the I/O boundary may hand us an unexpected provider string, and we
 * must degrade to human review, not to serving.
 */
function statusForDecision(decision: ModerationDecision): ModerationStatus {
  switch (decision) {
    case "approved":
      return "APPROVED";
    case "review":
      return "REVIEW";
    case "quarantine":
      return "QUARANTINED";
    default:
      // Unknown/unexpected decision => fail closed to human review.
      return "REVIEW";
  }
}

/**
 * The pure moderation state machine.
 *
 * Transitions (everything else is an {@link IllegalTransition}):
 *
 * ```
 * PENDING            --decision approved-->   APPROVED
 * PENDING            --decision review-->     REVIEW
 * PENDING            --decision quarantine--> QUARANTINED
 * REVIEW|QUARANTINED --human approve-->       APPROVED
 * REVIEW|QUARANTINED --human reject-->        REJECTED
 * (any)              --csam-->                REJECTED   (terminal; from any state)
 * ```
 *
 * Invariants (property-tested):
 * - `APPROVED` and `REJECTED` are absorbing under non-CSAM events.
 * - A CSAM event drives any state to `REJECTED`.
 * - `QUARANTINED`/`REJECTED` never reach `APPROVED` without a human approve.
 * - An illegal transition is reported, never coerced to `APPROVED`.
 *
 * @param current the current persisted status
 * @param event   the driving event
 */
export function nextStatus(
  current: ModerationStatus,
  event: ModerationEvent,
): TransitionResult {
  // CSAM is terminal from any state — checked first so it overrides every
  // absorbing/illegal rule below.
  if (event.kind === "csam") {
    return { ok: true, status: "REJECTED" };
  }

  switch (current) {
    case "PENDING": {
      // Only the classifier acts on a freshly-uploaded object.
      if (event.kind === "decision") {
        return { ok: true, status: statusForDecision(event.decision) };
      }
      return illegal(current, event);
    }

    case "REVIEW":
    case "QUARANTINED": {
      // Only a human moderator resolves these.
      if (event.kind === "human") {
        return {
          ok: true,
          status: event.action === "approve" ? "APPROVED" : "REJECTED",
        };
      }
      return illegal(current, event);
    }

    case "APPROVED":
    case "REJECTED":
      // Absorbing under any non-CSAM event.
      return illegal(current, event);

    default:
      return illegal(current, event);
  }
}

function illegal(
  from: ModerationStatus,
  event: ModerationEvent,
): IllegalTransition {
  return { ok: false, reason: "illegal-transition", from, event };
}

/**
 * Map a classifier {@link ModerationDecision} to the {@link ModerationStatus} a
 * freshly-uploaded (PENDING) object should land in — a thin shell over
 * {@link nextStatus} for the synchronous image-upload path.
 *
 * Drives the transition `PENDING --decision <d>--> status` and returns the
 * resulting status. The transition out of PENDING on a `decision` event is
 * always legal, but should the machine ever report a not-ok transition we fail
 * closed to `REVIEW` (never `APPROVED`): an unexpected refusal must degrade to
 * human review, not to serving.
 */
export function decisionToStatus(
  decision: ModerationDecision,
): ModerationStatus {
  const result = nextStatus("PENDING", { kind: "decision", decision });
  return result.ok ? result.status : "REVIEW";
}

/**
 * Compile-time exhaustiveness guard for {@link ModerationStatus}.
 *
 * Keyed by the union, so adding a member to `ModerationStatus` without adding it
 * here is a TYPE error (TS2741 "missing key"), and a stale key that is no longer
 * a union member is a TYPE error too. This makes it impossible for
 * {@link ALL_MODERATION_STATUSES} below to silently drift from the union — a
 * drift that would let a new, un-enumerated status bypass the exhaustive
 * anti-oracle property tests (which iterate this array). Pure type-level, no
 * behavior.
 */
const MODERATION_STATUS_MEMBERS = {
  PENDING: true,
  APPROVED: true,
  REVIEW: true,
  QUARANTINED: true,
  REJECTED: true,
} as const satisfies Record<ModerationStatus, true>;

/** All lifecycle states, for exhaustive iteration in tests and the shell. */
export const ALL_MODERATION_STATUSES: readonly ModerationStatus[] = Object.keys(
  MODERATION_STATUS_MEMBERS,
) as ModerationStatus[];

/** All classifier decisions, for exhaustive iteration in tests and the shell. */
export const ALL_MODERATION_DECISIONS: readonly ModerationDecision[] = [
  "approved",
  "review",
  "quarantine",
] as const;
