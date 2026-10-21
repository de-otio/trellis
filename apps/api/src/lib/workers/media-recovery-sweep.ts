// The media recovery sweep — CONTRACT TYPES ONLY.
//
// A periodic sweep that finds media objects whose pipeline stalled (a lost
// processing message, a completion that never arrived, a promotion that did
// not finish) and decides what to do with each. This module defines the read
// model the planner consumes, the actions it may emit, and the config it runs
// under. No planner or shell lives here yet.
//
// Every number in the config is runtime config, never a constant in this file:
// the npm tarball is public.

import type { MediaLifecycle, ModerationDecision } from "../media/media-lifecycle.js";
import type { Track } from "../media/track-verdict.js";

/** Operator config for the sweep. All values are seconds except `batchSize`. */
export interface MediaRecoverySweepConfig {
  /**
   * How long a stalled object is left alone before the sweep acts on it. Must
   * outlast every redelivery the completion queue can still make, so the sweep
   * never races a completion that is merely slow.
   */
  readonly settleWindowSeconds: number;
  /**
   * Past this age an object that still has no verdict is settled as a
   * technical hold rather than re-driven. Strictly greater than the settle
   * window.
   */
  readonly maxMediaAgeSeconds: number;
  /** Maximum objects read per sweep run. */
  readonly batchSize: number;
}

/** One thing the sweep decided to do about one media object. */
export type RecoveryAction =
  | { readonly kind: "reenqueue-processing"; readonly mediaId: string }
  | { readonly kind: "repair-promotion"; readonly mediaId: string }
  | { readonly kind: "settle-technical"; readonly mediaId: string };

/** What the sweep knows about one moderation track of a candidate. */
export interface RecoveryTrackState {
  /** A job row for this track exists and has not been superseded. */
  readonly hasLiveRow: boolean;
  /** The track's resolved decision, or `null` while unresolved. */
  readonly decision: ModerationDecision | null;
}

/** The read model the planner needs for one media object. */
export interface RecoveryCandidate {
  readonly mediaId: string;
  readonly lifecycle: MediaLifecycle;
  readonly createdAt: Date;
  /** Keyed by track; a track the object is not moderated on is absent. */
  readonly tracks: Readonly<Partial<Record<Track, RecoveryTrackState>>>;
  /** The content-addressed object exists in storage. */
  readonly casObjectPresent: boolean;
}

/** The completion queue's settings the sweep config must be checked against. */
export interface CompletionQueueTiming {
  readonly completionVisibilitySeconds: number;
  readonly completionMaxReceive: number;
}

function isNonNegativeFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * Check a sweep config against the completion queue's timing. Pure and total:
 * returns every problem found, and an empty list when the config is usable.
 *
 *   - `settleWindowSeconds` ≥ visibility × max receive count, so the sweep
 *     cannot act while the queue could still redeliver a completion;
 *   - `maxMediaAgeSeconds` > `settleWindowSeconds`;
 *   - every value is a finite non-negative number and `batchSize` a positive
 *     integer, so a malformed value is reported rather than compared.
 */
export function validateRecoverySweepConfig(
  c: MediaRecoverySweepConfig,
  queue: CompletionQueueTiming,
): string[] {
  const errors: string[] = [];

  const numbersOk =
    isNonNegativeFinite(c.settleWindowSeconds) &&
    isNonNegativeFinite(c.maxMediaAgeSeconds) &&
    isNonNegativeFinite(queue.completionVisibilitySeconds) &&
    isNonNegativeFinite(queue.completionMaxReceive);

  if (!isNonNegativeFinite(c.settleWindowSeconds)) {
    errors.push("settleWindowSeconds must be a finite non-negative number");
  }
  if (!isNonNegativeFinite(c.maxMediaAgeSeconds)) {
    errors.push("maxMediaAgeSeconds must be a finite non-negative number");
  }
  if (!isNonNegativeFinite(queue.completionVisibilitySeconds)) {
    errors.push("completionVisibilitySeconds must be a finite non-negative number");
  }
  if (!isNonNegativeFinite(queue.completionMaxReceive)) {
    errors.push("completionMaxReceive must be a finite non-negative number");
  }
  if (!Number.isInteger(c.batchSize) || c.batchSize <= 0) {
    errors.push("batchSize must be a positive integer");
  }

  if (numbersOk) {
    const redeliveryHorizon =
      queue.completionVisibilitySeconds * queue.completionMaxReceive;
    if (c.settleWindowSeconds < redeliveryHorizon) {
      errors.push(
        "settleWindowSeconds must be at least completionVisibilitySeconds × completionMaxReceive",
      );
    }
    if (c.maxMediaAgeSeconds <= c.settleWindowSeconds) {
      errors.push("maxMediaAgeSeconds must be greater than settleWindowSeconds");
    }
  }

  return errors;
}
