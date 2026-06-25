// Pure functional-core unit — no I/O, no AWS SDK, no network, no Date.now.
// FAIL-CLOSED: any input that cannot be safely reasoned about yields denied.

import type { QuotaState, QuotaLimits } from "./quota-types.js";

export type QuotaDenialReason = "object-cap" | "byte-cap";

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: QuotaDenialReason;
}

/**
 * Determine whether an incoming upload is permitted under the tenant's quota.
 *
 * Decision logic (evaluated in order; FAIL-CLOSED throughout):
 *   1. If any number argument is NaN or non-finite => denied (no reason tag, caller
 *      should treat this as a validation failure upstream).
 *   2. If incomingBytes < 0 => denied (same: malformed input, not a quota case).
 *   3. If currentObjects >= maxObjects => denied, reason "object-cap".
 *   4. If currentBytes + incomingBytes > maxBytes => denied, reason "byte-cap".
 *   5. Otherwise => allowed.
 *
 * Limits are ALWAYS supplied as arguments sourced from Env.media — this module
 * never hard-codes operational parameters.
 */
export function checkUploadQuota(
  state: QuotaState,
  incomingBytes: number,
  limits: QuotaLimits,
): QuotaCheckResult {
  const { currentObjects, currentBytes } = state;
  const { maxObjects, maxBytes } = limits;

  // FAIL-CLOSED: bad numbers => denied. Cover all inputs for completeness.
  if (
    !Number.isFinite(currentObjects) ||
    !Number.isFinite(currentBytes) ||
    !Number.isFinite(incomingBytes) ||
    !Number.isFinite(maxObjects) ||
    !Number.isFinite(maxBytes)
  ) {
    return { allowed: false };
  }

  // FAIL-CLOSED: negative incomingBytes is nonsensical => denied.
  if (incomingBytes < 0) {
    return { allowed: false };
  }

  // Object cap is checked before byte cap (object cap takes priority in ordering).
  if (currentObjects >= maxObjects) {
    return { allowed: false, reason: "object-cap" };
  }

  // Byte cap: currentBytes + incomingBytes must be <= maxBytes.
  if (currentBytes + incomingBytes > maxBytes) {
    return { allowed: false, reason: "byte-cap" };
  }

  return { allowed: true };
}
