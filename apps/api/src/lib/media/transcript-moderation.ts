/**
 * transcript-moderation.ts — pure functional core
 *
 * Maps a raw transcript string through the injected TextModerationProvider and
 * folds the resulting ModerationVerdict into the canonical 3-value
 * ModerationDecision understood by the media pipeline.
 *
 * Fail-closed contract (hard requirement):
 *   - Any thrown error from the seam             => "review"
 *   - Any verdict whose decision is not one of
 *     the three known values                      => "review"
 *   - An empty/whitespace-only transcript is
 *     passed to the seam unchanged; the seam's
 *     own decision is honoured.  If the seam
 *     throws on empty input that also resolves
 *     to "review" (error path above).
 *     RATIONALE: silent audio is not inherently
 *     safe — an empty transcript could be a
 *     decoding failure, a muted track, or
 *     legitimate silence.  Approving it
 *     unconditionally would bypass the seam
 *     for a whole class of inputs.  The seam
 *     is the authority; we defer to it.
 *
 * Pure functional core: no I/O, no clock, no random, no cloud SDK.  Only
 * node:crypto is permitted (deterministic, CPU-only) — not used here.
 * Ships in the PUBLIC npm tarball: NO thresholds, secrets, or real-category
 * vocabulary.
 */

import type { ModerationDecision } from "./media-lifecycle.js";
import type { TextModerationProvider } from "./text-moderation.js";

/** The three known classifier decisions (kept local — not re-exported). */
const KNOWN_DECISIONS = new Set<string>(["approved", "review", "quarantine"]);

/**
 * Run `transcript` through the injected `textMod` seam and return the
 * canonical {@link ModerationDecision}.
 *
 * Fail-closed on every failure path:
 *   - Seam throws                            => `"review"`
 *   - Seam resolves to an unknown decision   => `"review"`
 *   - Seam resolves to `"approved"`          => `"approved"` (only safe path)
 *   - Seam resolves to `"quarantine"`        => `"quarantine"`
 *   - Seam resolves to `"review"`            => `"review"`
 *
 * @param transcript  The raw transcript string (may be empty for silent audio).
 * @param textMod     The injected text-moderation seam.
 */
export async function transcriptToModerationDecision(
  transcript: string,
  textMod: TextModerationProvider,
): Promise<ModerationDecision> {
  let verdict;
  try {
    verdict = await textMod.moderateText(transcript);
  } catch {
    // Seam threw — fail closed.
    return "review";
  }

  // Guard against garbage/null/undefined verdict objects (defensive — the
  // contract says the seam returns ModerationVerdict, but an adapter could
  // be buggy).
  if (verdict == null || typeof verdict !== "object") {
    return "review";
  }

  const { decision } = verdict;

  // Only the three known decisions are honoured.  Anything else — including
  // undefined, a future union member, or a typo from a misbehaving adapter —
  // resolves to "review" (fail closed).
  if (!KNOWN_DECISIONS.has(decision)) {
    return "review";
  }

  return decision as ModerationDecision;
}
