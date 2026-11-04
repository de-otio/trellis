/**
 * transient-moderation-failure.ts — pure: did the synchronous image check fail
 * for a reason that is KNOWN to say nothing about the image?
 *
 * Two outcomes exist when the check does not return a verdict:
 *
 *  - **Known transient**: the infrastructure failed in a way we can name
 *    (throttling, a quota or capacity ceiling, a deadline, a network error).
 *    The same bytes may classify fine a moment later, so the right answer is
 *    "try again" (503), not a hold.
 *  - **Anything else**: a failure about the media, or one we cannot identify.
 *    These keep the fail-closed treatment they had before: the item is held as
 *    REVIEW. An unrecognised error is never assumed to be transient: a
 *    hold is recoverable by a reviewer, an invented "try again" is not.
 *
 * This deliberately does NOT reuse the worker classifier's
 * retryable-on-unknown default. That default suits a queue worker, where a
 * delivery limit bounds the cost of a wrong guess; it would be wrong here,
 * where it would turn every unrecognised provider failure into a 503.
 *
 * Rule:
 *  - A typed provider error is authoritative. It is transient when it is
 *    `retryable` (this includes the deadline error) or reports `capacity: true`
 *    (a rate, quota or spend ceiling). Any other typed error, including one
 *    that only reports `infraFault` or `unknownCause`, holds as before.
 *  - An untyped error is transient only when it matches an explicit transient
 *    signal (retryable HTTP status, known transient name or code, transient
 *    message fragment) and no poison signal. An untyped error that matches
 *    nothing holds.
 */

import { isKnownTransientByHeuristic } from "./classify-worker-error.js";
import { isModerationProviderError } from "./moderation-provider.js";

export function isTransientModerationFailure(err: unknown): boolean {
  if (isModerationProviderError(err)) {
    return err.retryable === true || err.capacity === true;
  }
  return isKnownTransientByHeuristic(err);
}
