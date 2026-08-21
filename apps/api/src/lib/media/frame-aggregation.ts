/**
 * frame-aggregation.ts — pure functional core for frame-sampled video
 * moderation. No I/O, no clock, no randomness.
 *
 * A video's visual verdict is derived from the verdicts of the still frames
 * sampled out of it. The whole safety of that derivation lives in this file, so
 * the law is stated here in full and the implementation is nothing but the law:
 *
 *  1. QUARANTINE DOMINATES. One quarantined frame quarantines the video,
 *     whatever every other frame says.
 *  2. OTHERWISE THE WORST FRAME WINS. `approved` only survives when every frame
 *     approved. Severity order is approved < review < quarantine.
 *  3. ZERO FRAMES ⇒ `review`. No evidence is not good evidence.
 *  4. A PER-FRAME CLASSIFY ERROR counts as `review` at best — an unclassified
 *     frame is an unknown frame, and an unknown frame cannot approve a video.
 *  5. EXTRACTION SHORTFALL ⇒ `review`, regardless of the per-frame verdicts.
 *     If fewer frames were successfully extracted than {@link expectedFrameCount}
 *     says the (duration, rate, ceiling) triple should have produced, the video
 *     is only PARTLY seen. This is the rule that stops the obvious attack:
 *     craft a clip whose harmful frames fail to decode and whose benign frames
 *     decode fine, and without this rule it approves on the frames that worked.
 *  6. CEILING BREACH ⇒ `review`. If the sampling plan wants more frames than
 *     the operator's absolute per-job ceiling allows, the job does NOT silently
 *     under-sample a long video down to a handful of frames — it fails closed
 *     and says why. (Enforced at plan time by {@link planFrameSampling}.)
 *
 * Every rule points the same way: this module can DEGRADE a verdict and can
 * never improve one. That is what makes it safe to run over attacker-supplied
 * media.
 */

import type { ModerationDecision } from "./media-lifecycle.js";

/**
 * Severity ladder. Higher is worse; the aggregate is the maximum.
 *
 * Exported as the single source of truth for "approved < review < quarantine"
 * so any other worst-wins combiner (e.g. the cross-check provider) ranks
 * decisions against the same ladder rather than hard-coding a second copy that
 * could drift if the decision union ever changes.
 */
export const SEVERITY: Readonly<Record<ModerationDecision, number>> = {
  approved: 0,
  review: 1,
  quarantine: 2,
};

/**
 * The worse of two decisions on the {@link SEVERITY} ladder. `approved` survives
 * only when BOTH inputs approved; any `quarantine` dominates. Used to combine
 * independent signals conservatively — an escalation can never be lifted by a
 * more lenient co-signal.
 */
export function worstDecision(
  a: ModerationDecision,
  b: ModerationDecision,
): ModerationDecision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/**
 * One frame's contribution. A frame that could not be classified carries
 * `decision: null` and is counted as `review` (rule 4) — the caller does not
 * get to decide how generous to be about its own failures.
 */
export interface FrameVerdict {
  readonly decision: ModerationDecision | null;
}

/**
 * How many frames a (duration, rate, ceiling) triple is expected to yield.
 *
 * Floor of `duration × rate`, never below 1 (a video always owes at least one
 * frame), never above the operator's absolute ceiling. Total: non-finite or
 * negative inputs collapse to 1 rather than to 0, because a 0 expectation would
 * make the shortfall rule vacuous exactly when the inputs are suspicious.
 */
export function expectedFrameCount(
  durationSeconds: number,
  framesPerSecond: number,
  maxFrames: number,
): number {
  const ceiling =
    Number.isFinite(maxFrames) && maxFrames >= 1 ? Math.floor(maxFrames) : 1;
  if (!Number.isFinite(durationSeconds) || !Number.isFinite(framesPerSecond)) {
    return 1;
  }
  if (durationSeconds <= 0 || framesPerSecond <= 0) return 1;
  const planned = Math.floor(durationSeconds * framesPerSecond);
  return Math.min(ceiling, Math.max(1, planned));
}

/** The outcome of planning a sampling run before any frame is extracted. */
export type FrameSamplingPlan =
  | { readonly ok: true; readonly expectedFrames: number }
  | {
      readonly ok: false;
      readonly reason: "ceiling-exceeded" | "config-absent" | "duration-unknown";
    };

/**
 * Decide whether this video may be frame-sampled at all, and how many frames to
 * expect. Fails closed twice over:
 *
 *  - `config-absent` when the operator supplied no rate or no ceiling. There is
 *    deliberately NO compiled-in default: the npm tarball is public, and a
 *    sampling rate baked into it is a published sampling rate. Absence means
 *    the feature refuses to run, not that it runs at a guessed rate.
 *  - `ceiling-exceeded` when `duration × rate` wants more frames than the
 *    ceiling permits. Silently truncating would mean a long video is scanned at
 *    an effective rate nobody chose, and the shortfall rule could not tell that
 *    apart from a decode failure.
 */
export function planFrameSampling(config: {
  readonly durationSeconds: number;
  readonly framesPerSecond?: number;
  readonly maxFrames?: number;
}): FrameSamplingPlan {
  const { framesPerSecond, maxFrames } = config;
  if (
    typeof framesPerSecond !== "number" ||
    !Number.isFinite(framesPerSecond) ||
    framesPerSecond <= 0 ||
    typeof maxFrames !== "number" ||
    !Number.isFinite(maxFrames) ||
    maxFrames < 1
  ) {
    return { ok: false, reason: "config-absent" };
  }
  // An unknown or zero duration is doubt, and doubt reviews. Coercing it to a
  // one-frame expectation would quietly switch OFF both the shortfall rule and
  // the ceiling rule — any single decoded frame would satisfy the expectation,
  // and no clip could ever breach the ceiling — which is the opposite of what
  // those rules are for. A probe that returns 0 or NaN on failure must not be
  // able to disable the law by failing.
  if (
    typeof config.durationSeconds !== "number" ||
    !Number.isFinite(config.durationSeconds) ||
    config.durationSeconds <= 0
  ) {
    return { ok: false, reason: "duration-unknown" };
  }
  const duration = config.durationSeconds;
  const planned = Math.max(1, Math.floor(duration * framesPerSecond));
  if (planned > Math.floor(maxFrames)) {
    return { ok: false, reason: "ceiling-exceeded" };
  }
  return { ok: true, expectedFrames: planned };
}

/**
 * Aggregate per-frame verdicts into the video's visual decision.
 *
 * `expectedFrames` is what {@link expectedFrameCount} / {@link planFrameSampling}
 * said this clip owed. Passing fewer verdicts than that is the shortfall case
 * (rule 5) and degrades the result to at least `review`.
 *
 * Order-independent, idempotent, and monotone: adding a worse frame can never
 * improve the result, and no permutation of the same frames differs.
 */
export function aggregateFrameVerdicts(
  frames: ReadonlyArray<FrameVerdict>,
  expectedFrames: number,
): ModerationDecision {
  // Rule 3: no frames at all.
  if (frames.length === 0) return "review";

  let worst = 0;
  for (const frame of frames) {
    // Rule 4: an unclassified frame is worth `review`, never `approved`.
    const severity =
      frame.decision === null ? SEVERITY.review : SEVERITY[frame.decision];
    if (severity > worst) worst = severity;
    // Rule 1: quarantine is absorbing — nothing below can lift it.
    if (worst === SEVERITY.quarantine) return "quarantine";
  }

  // Rule 5: partly-seen video cannot approve, but a quarantine already found
  // still stands (that is why this check runs AFTER the loop's early return).
  if (frames.length < expectedFrames && worst < SEVERITY.review) {
    return "review";
  }

  return worst === SEVERITY.approved ? "approved" : "review";
}
