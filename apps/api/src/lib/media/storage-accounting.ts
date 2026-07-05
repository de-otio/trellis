/**
 * Storage-accounting object-state predicate — the SHARED definition.
 *
 * This module implements the single object-state predicate defined in the
 * launch plan's "Cross-check: storage-accounting invariant" section
 * (skybber `analysis/fable-analysis/02-agent-execution-plan.md`, T15 ⇄ T16;
 * reused verbatim by the GDPR media-erasure fix, 07 AR7). Do NOT introduce a
 * parallel definition of "what counts as a user's stored bytes" or "when is a
 * CAS object reclaimable" — change it HERE and flag the quota (T16) and
 * lifecycle (T15) owners. The pinned decisions live in ONE doc section:
 * `doc/02-technical/operations/storage-accounting.md`.
 *
 * THE INVARIANT (T15 ⇄ T16, pinned): every stored S3 object falls into
 * exactly one of two buckets, whose union is the total —
 *
 *  1. COUNTS against the tenant's quota ⇒ user-reclaimable.
 *     A MediaFile row counts iff `lifecycle === APPROVED && deletedAt IS NULL`
 *     ({@link quotaUsageWhere}). Users are never charged for content the
 *     platform blocked (REVIEW/QUARANTINED/REJECTED) or that never finished
 *     uploading (AWAITING_UPLOAD/UPLOADED/UPLOAD_FAILED). Deleting media
 *     frees quota IMMEDIATELY (soft-delete sets `deletedAt`, excluding the
 *     row from the usage aggregate); the bytes are hard-deleted within
 *     N = 7 days by the nightly cron's soft-deleted-media purge
 *     (`lambda/nightly-cron.ts`, step 1).
 *
 *  2. Does NOT count ⇒ platform-reclaimed by a lifecycle rule with a short
 *     TTL. Non-approved rows and abandoned/incomplete upload sessions are
 *     bounded by the review-rate cap (`env.media.reviewRateCap`, enforced at
 *     the upload gate — lib/media/review-rate-cap.ts) plus:
 *       - DB rows: the stale-media reap (X = 24 h default,
 *         `MEDIA_STALE_REAP_WINDOW_MS`; lib/media/stale-media-reap.ts) for
 *         non-verdict states; REVIEW/QUARANTINED rows await a human verdict.
 *       - S3 staging bytes: the consumer's bucket lifecycle rules
 *         (skybber CdnStack) — `pending/` expires after 3 days (raw upload
 *         staging; > the 24 h DB reap + the 3-day processing-queue retention),
 *         `processing/` after 30 days (cleaned-but-unapproved bytes await the
 *         human REVIEW verdict up to the moderation SLA).
 *     No object may escape BOTH buckets — that would be unbounded free
 *     storage (cost leak + abuse channel).
 *
 * The predicate:
 * - A MediaFile row COUNTS against quota iff
 *   `lifecycle === APPROVED && deletedAt IS NULL` — the predicate the
 *   upload-quota usage aggregate uses ({@link quotaUsageWhere}; consumed by
 *   routes/media.ts and presigned-upload-handler.ts).
 * - A MediaFile row is LIVE (holds a CAS reference) iff `deletedAt IS NULL` —
 *   deliberately WIDER than the quota predicate: a REVIEW/QUARANTINED row
 *   still references bytes that must not be GC'd out from under a pending
 *   verdict.
 * - A CAS object `cas/{tenantId}/{contentHash}` is UNREFERENCED iff no live
 *   MediaFile row with that `(tenantId, contentHash)` remains. Under the
 *   schema's `@@unique([tenantId, contentHash])` at most one such row can
 *   exist, but the predicate is stated (and queried) in reference terms so it
 *   stays correct if the dedup model ever changes.
 * - Reclamation regime: soft-delete (set `deletedAt`) frees quota immediately
 *   and hands the object to the existing GC path — the nightly cron's
 *   soft-deleted-media purge, which hard-deletes rows older than 7 days and
 *   batch-deletes their S3 objects (`lambda/nightly-cron.ts`, step 1).
 */

import type { MediaLifecycle } from "./media-lifecycle.js";

/**
 * The ONLY lifecycle value that counts against a tenant's storage quota
 * (bucket 1 of the invariant above). Everything else is platform-reclaimed.
 */
export const QUOTA_COUNTED_LIFECYCLE: MediaLifecycle = "APPROVED";

/**
 * Prisma `where` shape for the quota usage aggregate (count + sum(size)).
 * Hand-declared (not the generated `MediaFileWhereInput`) so the quota gates
 * and tests share the exact same object — the T16 single-definition rule.
 */
export interface QuotaUsageWhere {
  tenantId: string;
  lifecycle: MediaLifecycle;
  deletedAt: null;
}

/**
 * Build the quota-usage scope for a tenant. BOTH quota gates (the proxied
 * upload path in routes/media.ts and the presigned path in
 * presigned-upload-handler.ts) MUST build their count/aggregate `where`
 * through this function — never inline the predicate.
 */
export function quotaUsageWhere(tenantId: string): QuotaUsageWhere {
  return {
    tenantId,
    lifecycle: QUOTA_COUNTED_LIFECYCLE,
    deletedAt: null,
  };
}

/** Structural slice of the Prisma client this module needs (keeps the pure
 *  predicate testable and independent of a regenerated client). */
export interface StorageAccountingDb {
  mediaFile: {
    count(args: {
      where: {
        tenantId: string;
        contentHash: string;
        deletedAt: null;
        id: { notIn: string[] };
      };
    }): Promise<number>;
  };
}

/**
 * Is the CAS object for `(tenantId, contentHash)` still referenced by a LIVE
 * MediaFile row other than the ones being erased?
 *
 * Returns true when another live (non-soft-deleted) row shares the hash within
 * the tenant scope — in that case the object's bytes are still someone else's
 * content and must be RETAINED (not handed to GC).
 */
export async function hasOtherLiveCasReference(
  db: StorageAccountingDb,
  tenantId: string,
  contentHash: string,
  excludeMediaFileIds: string[],
): Promise<boolean> {
  const others = await db.mediaFile.count({
    where: {
      tenantId,
      contentHash,
      deletedAt: null,
      id: { notIn: excludeMediaFileIds },
    },
  });
  return others > 0;
}
