/**
 * transient-moderation-failure.ts — pure: did the synchronous image check fail
 * for a reason that says nothing about the image?
 *
 * Two outcomes exist when the check does not return a verdict:
 *
 *  - **Transient**: the infrastructure failed (throttling, a quota or spend
 *    cap, a credential fault, a deadline, a network error). The same bytes may
 *    classify fine a moment later, so the right answer is "try again", not a
 *    hold. A hold on a deployment with no standing moderator is a permanent
 *    block of a probably benign image.
 *  - **Not transient**: the failure is about the media. These keep their
 *    existing fail-closed treatment.
 *
 * Classification reuses the worker-error classifier so the request path and the
 * async worker cannot disagree about what a given error means. A typed
 * provider error is authoritative: it is transient when it is `retryable`
 * (this includes the deadline error), reports `capacity`, or reports `infraFault` (which
 * covers a credential fault that retrying will not clear by itself but which
 * is still not the image's doing). Untyped errors follow the classifier's
 * heuristic, including its retryable-on-unknown default.
 */

import { classifyWorkerErrorDetailed } from "./classify-worker-error.js";
import { isModerationProviderError } from "./moderation-provider.js";

export function isTransientModerationFailure(err: unknown): boolean {
  // A typed provider error that says it hit a capacity ceiling (rate, quota or
  // spend cap) is transient however its other flags are set.
  if (isModerationProviderError(err) && err.capacity === true) return true;
  const c = classifyWorkerErrorDetailed(err);
  return c.klass === "retryable" || c.infraFault;
}
