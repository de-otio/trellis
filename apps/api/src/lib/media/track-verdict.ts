// CONTRACT: stable — coordinate changes. Shared P0b functional-core unit.
//
// Combine the per-track moderation outcomes of a single media object into ONE
// object-level decision. A video has up to two independently-moderated tracks
// (a VISUAL track via the image/video moderation provider and an AUDIO track
// via the text-moderation seam over a transcript); an audio-only object has
// only the AUDIO track; an image has only the VISUAL track.
//
// FAIL-CLOSED is the whole point: a missing track, an errored track, or any
// "review" outcome must never let the object reach "approved". Only the case
// where BOTH tracks are present, decided, and approved yields "approved".
//
// Pure functional core: no I/O, no clock, no random. Total over its inputs.
// Lives in the PUBLIC npm tarball: NO thresholds, secrets, or real-category
// vocabulary here.

import type { ModerationDecision } from "./media-lifecycle.js";

/** The two moderation tracks a media object can carry. */
export type Track = "VISUAL" | "AUDIO";

/**
 * The outcome of moderating a single track.
 *
 * - `decided`  — the track was moderated and produced a 3-value decision.
 * - `errored`  — the track was expected but moderation faulted (no usable
 *                verdict). Fail-closed: treated as "must not approve".
 * - `absent`   — the track does not apply to this object (e.g. no audio track
 *                on a silent video, or no visual track on an audio-only object).
 *                Absence alone is NOT approval: combining with a present-and-
 *                approved track still degrades to "review", because we cannot
 *                certify a track we never inspected. The shell decides, per
 *                media kind, whether a single-track object should even call
 *                this combinator — see the obligations below.
 */
export type TrackOutcome =
  | { readonly state: "decided"; readonly decision: ModerationDecision }
  | { readonly state: "errored" }
  | { readonly state: "absent" };

/**
 * Combine two per-track outcomes into the object-level {@link ModerationDecision}.
 *
 * Precedence (checked in this order; total):
 *  1. If EITHER track is decided-"quarantine" => "quarantine". A confirmed
 *     flag on any track wins over everything: it is strictly more restrictive
 *     than "review", and a quarantine that decayed to "review" because the
 *     other track was absent/errored would be a safety regression.
 *  2. Else, "approved" IFF BOTH tracks are state "decided" AND BOTH decisions
 *     are "approved".
 *  3. Else (any "review", any "errored", any "absent", or any mix) => "review".
 *
 * Consequences (property-tested):
 *  - One missing/failed track NEVER yields "approved".
 *  - "approved" requires positive evidence on BOTH tracks.
 *  - "quarantine" is sticky across an absent/errored sibling track.
 *  - The function never returns "approved" from doubt.
 */
export function combineTrackVerdicts(
  visual: TrackOutcome,
  audio: TrackOutcome,
): ModerationDecision {
  // 1. Quarantine on either decided track dominates.
  if (isDecidedQuarantine(visual) || isDecidedQuarantine(audio)) {
    return "quarantine";
  }

  // 2. Approve only with positive evidence on BOTH tracks.
  if (isDecidedApproved(visual) && isDecidedApproved(audio)) {
    return "approved";
  }

  // 3. Everything else fails closed to human review.
  return "review";
}

function isDecidedQuarantine(o: TrackOutcome): boolean {
  return o.state === "decided" && o.decision === "quarantine";
}

function isDecidedApproved(o: TrackOutcome): boolean {
  return o.state === "decided" && o.decision === "approved";
}
