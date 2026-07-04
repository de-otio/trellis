/**
 * Storage-accounting object-state predicate — the SHARED definition.
 *
 * This module implements the single object-state predicate defined in the
 * launch plan's "Cross-check: storage-accounting invariant" section
 * (skybber `analysis/fable-analysis/02-agent-execution-plan.md`, T15 ⇄ T16;
 * reused verbatim by the GDPR media-erasure fix, 07 AR7). Do NOT introduce a
 * parallel definition of "what counts as a user's stored bytes" or "when is a
 * CAS object reclaimable" — change it HERE and flag the quota (T16) and
 * lifecycle (T15) owners.
 *
 * The predicate:
 * - A MediaFile row COUNTS (is "live") iff `deletedAt IS NULL` — the same
 *   predicate the upload-quota count uses (routes/media.ts quota check:
 *   `where: { tenantId, deletedAt: null }`).
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
