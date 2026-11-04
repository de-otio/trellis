/**
 * transcript-moderation.ts — pure functional core
 *
 * Maps a raw transcript string through the injected TextModerationProvider and
 * folds the resulting ModerationVerdict into the canonical 3-value
 * ModerationDecision understood by the media pipeline.
 *
 * Failure handling distinguishes WHOSE fault it was:
 *   - The provider is down or throttled (error marked `retryable` or
 *     `infraFault`)                           => RE-THROWN. The infrastructure
 *     failed, not the media; turning that into `review` would spend a human's
 *     attention on a fault a retry fixes. The completion worker lets the throw
 *     propagate so the delivery is retried.
 *   - Any other thrown error                  => "review" (fail closed).
 *   - A verdict that is not an object, or whose
 *     decision is not one of the three known
 *     values (a malformed verdict)            => "review" (fail closed).
 *   - An empty or whitespace-only transcript  => "approved", reason
 *     `no-speech`, WITHOUT consulting the seam: there is no text to classify.
 *     The reason is returned so the caller can record that the approval rests
 *     on silence rather than on a classified transcript.
 *
 * Callers must tell "no speech" apart from "no transcript": a transcription
 * that did not produce a transcript at all is not silence, and the caller must
 * not hand us an empty string to stand in for it.
 *
 * Pure functional core: no I/O, no clock, no random, no cloud SDK.
 * Ships in the PUBLIC npm tarball: NO thresholds, secrets, or real-category
 * vocabulary.
 */

import type { ModerationDecision } from "./media-lifecycle.js";
import type { TextModerationProvider } from "./text-moderation.js";

/** The three known classifier decisions (kept local — not re-exported). */
const KNOWN_DECISIONS = new Set<string>(["approved", "review", "quarantine"]);

/** Why a decision was reached without consulting the seam. */
export type TranscriptModerationReason = "no-speech";

/** A decision, plus the reason it was reached when the seam was not consulted. */
export interface TranscriptModerationResult {
  readonly decision: ModerationDecision;
  /** Present only for `"no-speech"`; absent when the seam decided. */
  readonly reason?: TranscriptModerationReason;
}

/**
 * True for an error the caller should retry rather than record: the provider
 * marked it `retryable`, or marked it an `infraFault`. Structural, not
 * `instanceof`, for the reason `isModerationProviderError` gives.
 */
function isRetryableFault(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const o = err as { retryable?: unknown; infraFault?: unknown };
  return o.retryable === true || o.infraFault === true;
}

/**
 * Run `transcript` through the injected `textMod` seam.
 *
 *   - Empty / whitespace-only transcript     => `approved`, reason `no-speech`
 *   - Seam throws a retryable/infra error    => the error is RE-THROWN
 *   - Seam throws anything else              => `review`
 *   - Seam resolves to an unknown decision   => `review`
 *   - Seam resolves to a known decision      => that decision
 *
 * @param transcript  The raw transcript string (may be empty for silent audio).
 * @param textMod     The injected text-moderation seam.
 */
export async function moderateTranscript(
  transcript: string,
  textMod: TextModerationProvider,
): Promise<TranscriptModerationResult> {
  if (typeof transcript === "string" && transcript.trim().length === 0) {
    return { decision: "approved", reason: "no-speech" };
  }

  let verdict;
  try {
    verdict = await textMod.moderateText(transcript);
  } catch (err) {
    if (isRetryableFault(err)) throw err;
    // The seam failed for a reason a retry will not fix — fail closed.
    return { decision: "review" };
  }

  // Guard against garbage/null/undefined verdict objects (defensive — the
  // contract says the seam returns ModerationVerdict, but an adapter could
  // be buggy).
  if (verdict == null || typeof verdict !== "object") {
    return { decision: "review" };
  }

  const { decision } = verdict;

  // Only the three known decisions are honoured.  Anything else — including
  // undefined, a future union member, or a typo from a misbehaving adapter —
  // resolves to "review" (fail closed).
  if (!KNOWN_DECISIONS.has(decision)) {
    return { decision: "review" };
  }

  return { decision: decision as ModerationDecision };
}

/**
 * {@link moderateTranscript} with the reason discarded, for callers that only
 * need the decision. Same throw behaviour: a retryable/infra fault propagates.
 */
export async function transcriptToModerationDecision(
  transcript: string,
  textMod: TextModerationProvider,
): Promise<ModerationDecision> {
  return (await moderateTranscript(transcript, textMod)).decision;
}
