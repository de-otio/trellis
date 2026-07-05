/**
 * Media lifecycle: the ONE consolidated state machine for a media object
 * (T14/AR4). Replaces the former split between the Prisma `ModerationStatus`
 * enum + the `uploadStatus` string column (and the ad-hoc "orphan" reasoning
 * layered on top): one union, one event vocabulary, one pure total
 * `nextLifecycle()` function.
 *
 * This module is the **hand-written source of truth** for the lifecycle
 * states. It deliberately has **zero dependency on the Prisma-generated
 * client** so the serve gate and worker code can compile in worktrees that
 * have not regenerated the client. The Prisma `enum MediaLifecycle` mirrors
 * {@link MediaLifecycle} exactly; the imperative shell maps
 * `Prisma.MediaFile.lifecycle -> this union` at the I/O boundary.
 *
 * Pure functional core: no I/O, no clock, no Prisma import. Exhaustively
 * property-tested.
 *
 * Deliberately NOT part of the lifecycle (see prisma/schema.prisma):
 *  - `hidden` / `deletedAt` — reversible visibility + deletion audit; folding
 *    them in would destroy the moderation verdict on unhide. The serve gate
 *    (serve-gate.ts) combines them: APPROVED && !hidden && deletedAt == null.
 *  - `attachedToPost` / `orphanedAt` — attachment bookkeeping for orphan GC,
 *    orthogonal to upload/moderation.
 */

/**
 * The lifecycle state of a media object, persisted as `MediaFile.lifecycle`.
 * Hand-written source of truth — the Prisma enum must match this union
 * member-for-member.
 *
 * - `AWAITING_UPLOAD` — born here (presigned session issued; bytes not yet
 *                       confirmed). Nothing serves; nothing moderates.
 * - `UPLOADED`        — bytes confirmed in staging (S3 event pickup or the
 *                       client completion call, whichever lands first);
 *                       moderation pending/in-flight. Never serves.
 * - `APPROVED`        — the ONLY state that may serve bytes (with the
 *                       serve-gate's !hidden && !deleted checks).
 * - `REVIEW`          — classifier uncertain / pipeline poison; awaiting a
 *                       human moderator. Never serves.
 * - `QUARANTINED`     — classifier flagged it; awaiting a human moderator.
 * - `REJECTED`        — terminal; never serves. Includes over-duration
 *                       rejections and confirmed-CSAM.
 * - `UPLOAD_FAILED`   — terminal; the upload never became a moderatable
 *                       object (presign expired, abandoned, or reaped).
 */
export type MediaLifecycle =
  | "AWAITING_UPLOAD"
  | "UPLOADED"
  | "APPROVED"
  | "REVIEW"
  | "QUARANTINED"
  | "REJECTED"
  | "UPLOAD_FAILED";

/**
 * The 3-value classifier verdict (the `decision` field of a moderation
 * provider's result). This is intentionally **not** 4-value: `rejected` is a
 * lifecycle *status* a human (or the CSAM provider) produces, never a
 * classifier decision.
 */
export type ModerationDecision = "approved" | "review" | "quarantine";

/**
 * Events that drive a `lifecycle` transition.
 *
 * - `bytes-arrived`  — the staged object's existence was confirmed: either the
 *                      processing worker picked up the S3 OBJECT_CREATED event
 *                      or the client's completion call HEAD-verified the
 *                      object. Idempotent on `UPLOADED` (the two signals race
 *                      benignly); NEVER legal from a moderation-resolved state
 *                      (a replayed S3 event must not rewind a verdict).
 * - `decision`       — the classifier/worker verdict on an `UPLOADED` object.
 * - `human`          — a human moderator resolving REVIEW/QUARANTINED.
 * - `csam`           — a confirmed hit from the separate (statutory) CSAM
 *                      provider; drives `-> REJECTED` from *any* state, with
 *                      the preserve-and-report duty handled by the shell.
 * - `over-duration`  — the authoritative post-upload ffprobe gate: the clip
 *                      exceeds the configured duration cap. Terminal reject;
 *                      the shell deletes the staged bytes BEFORE moderation.
 * - `upload-failed`  — the session expired / was abandoned / was reaped
 *                      before the object became moderatable.
 */
export type MediaLifecycleEvent =
  | { readonly kind: "bytes-arrived" }
  | { readonly kind: "decision"; readonly decision: ModerationDecision }
  | { readonly kind: "human"; readonly action: "approve" | "reject" }
  | { readonly kind: "csam" }
  | { readonly kind: "over-duration" }
  | { readonly kind: "upload-failed" };

/**
 * A transition that the state machine refuses. Returned (never thrown) so the
 * machine stays a pure total function and callers must handle the illegal case
 * explicitly — an illegal transition must **never** silently no-op into
 * `APPROVED`.
 */
export type IllegalTransition = {
  readonly ok: false;
  readonly reason: "illegal-transition";
  readonly from: MediaLifecycle;
  readonly event: MediaLifecycleEvent;
};

/** A successful transition to a next lifecycle state. */
export type TransitionResult =
  | { readonly ok: true; readonly status: MediaLifecycle }
  | IllegalTransition;

/**
 * Map a classifier decision to the state it drives an `UPLOADED` object into.
 *
 * Fail-closed: any value that is not one of the three known decisions resolves
 * to `REVIEW` (never `APPROVED`). This is the only place the union is widened —
 * callers at the I/O boundary may hand us an unexpected provider string, and we
 * must degrade to human review, not to serving.
 */
function statusForDecision(decision: ModerationDecision): MediaLifecycle {
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
 * The pure media lifecycle state machine.
 *
 * Transitions (everything else is an {@link IllegalTransition}):
 *
 * ```
 * AWAITING_UPLOAD    --bytes-arrived-->        UPLOADED
 * AWAITING_UPLOAD    --upload-failed-->        UPLOAD_FAILED
 * UPLOADED           --bytes-arrived-->        UPLOADED    (idempotent no-op)
 * UPLOADED           --decision approved-->    APPROVED
 * UPLOADED           --decision review-->      REVIEW
 * UPLOADED           --decision quarantine-->  QUARANTINED
 * UPLOADED           --over-duration-->        REJECTED
 * UPLOADED           --upload-failed-->        UPLOAD_FAILED  (stuck-pipeline reap)
 * REVIEW|QUARANTINED --human approve-->        APPROVED
 * REVIEW|QUARANTINED --human reject-->         REJECTED
 * (any)              --csam-->                 REJECTED    (terminal; from any state)
 * ```
 *
 * Invariants (property-tested):
 * - `APPROVED`, `REJECTED`, and `UPLOAD_FAILED` are absorbing under non-CSAM
 *   events.
 * - A CSAM event drives any state to `REJECTED`.
 * - `QUARANTINED`/`REJECTED` never reach `APPROVED` without a human approve.
 * - A `decision` is never legal from `AWAITING_UPLOAD` — unconfirmed bytes
 *   cannot acquire a verdict.
 * - `bytes-arrived` never leaves the {AWAITING_UPLOAD, UPLOADED} pair — a
 *   replayed S3 event cannot rewind a resolved verdict.
 * - An illegal transition is reported, never coerced to `APPROVED`.
 *
 * @param current the current persisted lifecycle state
 * @param event   the driving event
 */
export function nextLifecycle(
  current: MediaLifecycle,
  event: MediaLifecycleEvent,
): TransitionResult {
  // CSAM is terminal from any state — checked first so it overrides every
  // absorbing/illegal rule below.
  if (event.kind === "csam") {
    return { ok: true, status: "REJECTED" };
  }

  switch (current) {
    case "AWAITING_UPLOAD": {
      if (event.kind === "bytes-arrived") {
        return { ok: true, status: "UPLOADED" };
      }
      if (event.kind === "upload-failed") {
        return { ok: true, status: "UPLOAD_FAILED" };
      }
      // A decision/over-duration/human event on unconfirmed bytes is illegal:
      // nothing may acquire a verdict before the bytes exist.
      return illegal(current, event);
    }

    case "UPLOADED": {
      switch (event.kind) {
        case "bytes-arrived":
          // Idempotent: the S3-event pickup and the client completion call
          // race benignly; whichever lands second is a no-op.
          return { ok: true, status: "UPLOADED" };
        case "decision":
          return { ok: true, status: statusForDecision(event.decision) };
        case "over-duration":
          return { ok: true, status: "REJECTED" };
        case "upload-failed":
          // Stuck-pipeline reap: bytes arrived but the pipeline never engaged.
          return { ok: true, status: "UPLOAD_FAILED" };
        default:
          return illegal(current, event);
      }
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
    case "UPLOAD_FAILED":
      // Absorbing under any non-CSAM event.
      return illegal(current, event);

    default:
      return illegal(current, event);
  }
}

function illegal(
  from: MediaLifecycle,
  event: MediaLifecycleEvent,
): IllegalTransition {
  return { ok: false, reason: "illegal-transition", from, event };
}

/**
 * Map a classifier {@link ModerationDecision} to the {@link MediaLifecycle} an
 * `UPLOADED` object should land in — a thin shell over {@link nextLifecycle}
 * for the synchronous image-upload path (whose rows are created directly at
 * the resolved verdict, bytes + verdict being known atomically).
 *
 * Drives the transition `UPLOADED --decision <d>--> status` and returns the
 * resulting status. The transition out of UPLOADED on a `decision` event is
 * always legal, but should the machine ever report a not-ok transition we fail
 * closed to `REVIEW` (never `APPROVED`): an unexpected refusal must degrade to
 * human review, not to serving.
 */
export function decisionToStatus(
  decision: ModerationDecision,
): MediaLifecycle {
  const result = nextLifecycle("UPLOADED", { kind: "decision", decision });
  return result.ok ? result.status : "REVIEW";
}

/**
 * Compile-time exhaustiveness guard for {@link MediaLifecycle}.
 *
 * Keyed by the union, so adding a member to `MediaLifecycle` without adding it
 * here is a TYPE error (TS2741 "missing key"), and a stale key that is no longer
 * a union member is a TYPE error too. This makes it impossible for
 * {@link ALL_MEDIA_LIFECYCLES} below to silently drift from the union — a
 * drift that would let a new, un-enumerated state bypass the exhaustive
 * anti-oracle property tests (which iterate this array). Pure type-level, no
 * behavior.
 */
const MEDIA_LIFECYCLE_MEMBERS = {
  AWAITING_UPLOAD: true,
  UPLOADED: true,
  APPROVED: true,
  REVIEW: true,
  QUARANTINED: true,
  REJECTED: true,
  UPLOAD_FAILED: true,
} as const satisfies Record<MediaLifecycle, true>;

/** All lifecycle states, for exhaustive iteration in tests and the shell. */
export const ALL_MEDIA_LIFECYCLES: readonly MediaLifecycle[] = Object.keys(
  MEDIA_LIFECYCLE_MEMBERS,
) as MediaLifecycle[];

/** All classifier decisions, for exhaustive iteration in tests and the shell. */
export const ALL_MODERATION_DECISIONS: readonly ModerationDecision[] = [
  "approved",
  "review",
  "quarantine",
] as const;

/**
 * The moderation-phase subset of the lifecycle (what the former
 * `ModerationStatus` enum covered). Kept as a NAMED SUBSET (not a separate
 * machine) for shells that must map old persisted values or provider
 * vocabularies. `PENDING` intentionally does not exist any more — its two
 * meanings were split into `AWAITING_UPLOAD` and `UPLOADED`.
 */
export const MODERATION_RESOLVED_LIFECYCLES: readonly MediaLifecycle[] = [
  "APPROVED",
  "REVIEW",
  "QUARANTINED",
  "REJECTED",
] as const;
