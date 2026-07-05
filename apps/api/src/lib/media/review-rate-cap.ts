// Pure functional-core unit — no I/O, no AWS SDK, no network, no Date.now
// (callers pass `now`). T15(c): the per-tenant REVIEW-rate cap.
//
// One tenant must not be able to torch the moderation budget: every upload
// that lands in REVIEW consumed paid AI moderation (Rekognition/Transcribe/
// Comprehend) AND holds staged bytes in the platform-reclaimed bucket of the
// storage-accounting invariant (storage-accounting.ts, bucket 2) until a
// human resolves it. The cap bounds bucket 2 per tenant: once a tenant has
// accumulated `cap` flagged objects (REVIEW or QUARANTINED — see
// REVIEW_RATE_COUNTED_LIFECYCLES) inside the rolling window, its
// NEW uploads are denied (429) until the window slides — enforced fail-closed
// at BOTH upload gates (routes/media.ts and presigned-upload-handler.ts),
// alongside the quota gate.
//
// The cap value is `env.media.reviewRateCap` (MEDIA_REVIEW_RATE_CAP —
// SSM-fed by the consumer; conservative dev default 20 in env.ts). The window
// is env-overridable with a compiled dev default, exactly like the
// stale-media-reap window (an operational window, not a secrecy threshold).

import type { MediaLifecycle } from "./media-lifecycle.js";

/**
 * The lifecycle states that count toward the cap. QUARANTINED counts too:
 * it is the harder verdict on the same "paid moderation flagged it, staged
 * bytes await a human" path — a tenant must not dodge the cap by uploading
 * content bad enough to quarantine instead of review.
 */
export const REVIEW_RATE_COUNTED_LIFECYCLES: readonly MediaLifecycle[] = [
  "REVIEW",
  "QUARANTINED",
];

/** Default rolling window: 24 hours. */
export const DEFAULT_REVIEW_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the rolling window, honoring `MEDIA_REVIEW_RATE_WINDOW_MS`
 * (a positive integer of milliseconds). Absent/invalid/non-positive values
 * fall back to the default — the gate must never end up with a zero or
 * negative window.
 */
export function reviewRateWindowMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.MEDIA_REVIEW_RATE_WINDOW_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return DEFAULT_REVIEW_RATE_WINDOW_MS;
}

/** The `updatedAt` cutoff: REVIEW rows younger than this count toward the cap. */
export function reviewRateWindowStart(
  now: Date = new Date(),
  windowMs: number = reviewRateWindowMs(),
): Date {
  return new Date(now.getTime() - windowMs);
}

/**
 * Prisma `where` shape for the per-tenant flagged-object count. Hand-declared
 * so both upload gates and the tests share the exact same object (mirrors
 * `quotaUsageWhere` in storage-accounting.ts).
 *
 * Deliberately does NOT filter on `deletedAt`: soft-deleting flagged objects
 * must not reset the cap (the paid moderation spend already happened, and a
 * delete-to-reset loop would defeat the guard). The window rides `updatedAt`
 * — the timestamp of the lifecycle flip into REVIEW/QUARANTINED.
 */
export interface ReviewRateWhere {
  tenantId: string;
  lifecycle: { in: MediaLifecycle[] };
  updatedAt: { gte: Date };
}

/** Build the flagged-object count scope for a tenant + window start. */
export function reviewRateWhere(
  tenantId: string,
  windowStart: Date,
): ReviewRateWhere {
  return {
    tenantId,
    lifecycle: { in: [...REVIEW_RATE_COUNTED_LIFECYCLES] },
    updatedAt: { gte: windowStart },
  };
}

/**
 * Is the tenant over its REVIEW-rate cap?
 *
 * FAIL-CLOSED: a non-finite count or cap denies (returns true). A negative
 * count is nonsensical input and also denies. `reviewCountInWindow >= cap`
 * denies — the cap is "at most `cap` REVIEW objects in the window", so the
 * cap-th object closes the gate for further uploads.
 */
export function isOverReviewRateCap(
  reviewCountInWindow: number,
  cap: number,
): boolean {
  if (!Number.isFinite(reviewCountInWindow) || !Number.isFinite(cap)) {
    return true;
  }
  if (reviewCountInWindow < 0) {
    return true;
  }
  return reviewCountInWindow >= cap;
}
