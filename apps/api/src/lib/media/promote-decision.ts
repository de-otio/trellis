// CONTRACT: stable — coordinate changes. C4 pure functional-core unit.
//
// Decide what the moderation worker SHOULD do once both per-track outcomes for
// a media object are known: combine the tracks into one object-level decision,
// run that decision through the lifecycle state machine, and report — as plain
// booleans — which side effects the imperative shell should perform.
//
// This function performs NO I/O. It only *reports* intent. The shell applies
// the reported actions in a fixed, safety-ordered sequence:
//
//   1. promote  (publish/adopt the CAS object so bytes can be served)
//   2. persist  (write the new moderationStatus)
//   3. emit     (publish the "resolved" moderation event)
//
// FAIL-CLOSED is the whole point. An illegal transition (e.g. a replayed
// decision on an already-terminal APPROVED/REJECTED object) is an idempotent
// no-op: every action boolean is false, so the shell touches nothing. And
// `shouldPromote` is true ONLY when the combined decision drove the object to
// APPROVED *and* the CAS object is actually present — doubt never serves.
//
// Pure functional core: no I/O, no clock, no random. Total over its inputs.
// Lives in the PUBLIC npm tarball: NO thresholds, secrets, or real-category
// vocabulary here.

import { combineTrackVerdicts, type TrackOutcome } from "./track-verdict.js";
import {
  nextStatus,
  type ModerationDecision,
  type ModerationStatus,
  type TransitionResult,
} from "./moderation-status.js";

/**
 * Everything {@link decidePromotion} needs to decide the worker's action.
 *
 * - `visual` / `audio` — the per-track outcomes (see {@link TrackOutcome}).
 * - `currentStatus`    — the object's persisted moderation status *before* this
 *                        decision is applied. Used to detect replay / illegal
 *                        transitions (terminal states absorb).
 * - `casObjectPresent` — whether the content-addressed object actually exists in
 *                        durable storage. Approval alone must not serve bytes
 *                        that are not there; promotion is gated on presence.
 */
export interface PromotionInput {
  readonly visual: TrackOutcome;
  readonly audio: TrackOutcome;
  readonly currentStatus: ModerationStatus;
  readonly casObjectPresent: boolean;
}

/**
 * The worker's decided action. All side effects are reported as booleans; the
 * shell performs them in the fixed order promote -> persist -> emit.
 *
 * - `combined`          — the object-level decision from {@link combineTrackVerdicts}.
 * - `transition`        — the result of running `combined` through the state
 *                         machine from `currentStatus`. `ok:false` means the
 *                         transition is illegal (e.g. replay on a terminal
 *                         status) and the action is a no-op.
 * - `shouldPromote`     — adopt/publish the CAS object so it can serve. True
 *                         IFF the transition is legal AND lands on APPROVED AND
 *                         the CAS object is present.
 * - `shouldPersistStatus` — write the new status. True IFF the transition is legal.
 * - `shouldEmitResolved`  — emit the "resolved" event. True IFF the transition is legal.
 */
export interface PromotionAction {
  readonly combined: ModerationDecision;
  readonly transition: TransitionResult;
  readonly shouldPromote: boolean;
  readonly shouldPersistStatus: boolean;
  readonly shouldEmitResolved: boolean;
}

/**
 * Decide the worker's action for a media object whose tracks have both resolved.
 *
 * Logic (total):
 *  1. `combined = combineTrackVerdicts(visual, audio)` — fail-closed track join.
 *  2. `transition = nextStatus(currentStatus, { kind: "decision", decision: combined })`.
 *  3. If `transition.ok === false` (illegal — e.g. replay on a terminal status):
 *     idempotent NO-OP — `shouldPromote`/`shouldPersistStatus`/`shouldEmitResolved`
 *     are all `false`.
 *  4. If `transition.ok === true`:
 *       - `shouldPersistStatus = true`
 *       - `shouldEmitResolved  = true`
 *       - `shouldPromote = transition.status === "APPROVED" && casObjectPresent`
 *
 * Safety invariants (property-tested):
 *  - `shouldPromote === true` ⇒ BOTH tracks were decided-and-approved AND the
 *    resulting status is APPROVED. Promotion never happens from doubt.
 *  - APPROVED is never reached unless both tracks are decided-approved.
 *  - A replay/illegal transition on a terminal status yields an all-false no-op.
 *  - `casObjectPresent === false` ⇒ `shouldPromote === false`, even at APPROVED.
 */
export function decidePromotion(input: PromotionInput): PromotionAction {
  const combined = combineTrackVerdicts(input.visual, input.audio);

  const transition = nextStatus(input.currentStatus, {
    kind: "decision",
    decision: combined,
  });

  if (transition.ok === false) {
    // Illegal transition (e.g. a replayed decision on an already-terminal
    // APPROVED/REJECTED object). Idempotent no-op: touch nothing.
    return {
      combined,
      transition,
      shouldPromote: false,
      shouldPersistStatus: false,
      shouldEmitResolved: false,
    };
  }

  // Legal transition: we will persist the new status and emit the resolved
  // event. We only promote (publish bytes) when the object actually became
  // APPROVED *and* the CAS object exists to serve.
  const shouldPromote =
    transition.status === "APPROVED" && input.casObjectPresent;

  return {
    combined,
    transition,
    shouldPromote,
    shouldPersistStatus: true,
    shouldEmitResolved: true,
  };
}
