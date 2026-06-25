/**
 * Anti-oracle resolved payload for media moderation.
 *
 * When the moderation pipeline settles, downstream consumers (CDN gate,
 * client notifications) need exactly one bit of information: is this
 * media object ready to serve? They must NOT receive the verdict, labels,
 * confidence score, or any other signal that lets a caller infer why a
 * piece of content was held back — that would publish operational
 * thresholds and give bad actors a tuning signal.
 *
 * This module enforces the anti-oracle contract at the type level: the
 * payload type has exactly two fields and the constructor function accepts
 * a full ModerationStatus but discards everything except the binary
 * ready/not-ready distinction.
 *
 * Pure functional core: no I/O, no clock, no randomness. Deterministic
 * in => deterministic out.
 */

import type { ModerationStatus } from "./moderation-status.js";

/**
 * The only view of a moderation outcome that leaves the moderation domain.
 *
 * Invariants enforced by the type (structural, not just convention):
 * - Exactly two keys: `mediaId` and `status`. No third key is possible
 *   without a type error — there is no `decision`, `labels`, `confidence`,
 *   `reason`, or per-track field.
 * - `status` is a binary flag: `"ready"` or `"not-ready"`. The caller
 *   cannot distinguish PENDING from REVIEW from QUARANTINED from REJECTED —
 *   all four collapse to `"not-ready"`.
 */
export interface ModerationResolvedPayload {
  readonly mediaId: string;
  readonly status: "ready" | "not-ready";
}

/**
 * Construct the anti-oracle resolved payload from a full ModerationStatus.
 *
 * `"ready"` if and only if `status === "APPROVED"`. Every other status —
 * `PENDING`, `REVIEW`, `QUARANTINED`, `REJECTED` — maps to `"not-ready"`.
 * The asymmetry is intentional and fail-closed: uncertainty never yields
 * `"ready"`.
 *
 * @param mediaId - The stable identifier of the media object.
 * @param status  - The settled ModerationStatus (sourced from Env.media /
 *                  the moderation state machine; never hard-coded here).
 */
export function moderationResolvedPayload(
  mediaId: string,
  status: ModerationStatus,
): ModerationResolvedPayload {
  return {
    mediaId,
    status: status === "APPROVED" ? "ready" : "not-ready",
  };
}
