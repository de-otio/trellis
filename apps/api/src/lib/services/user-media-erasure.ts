/**
 * GDPR media erasure for account deletion (AR7).
 *
 * The old account-deletion path deleted the S3 prefix `originals/user-{id}/`,
 * which does not exist under the tenant-scoped CAS key scheme
 * (`cas/{tenantId}/{contentHash}` for approved bytes,
 * `processing/{tenantId}/{contentHash}` and `pending/{tenantId}/{uploadId}`
 * for staging — see lib/media/cas-keys.ts). Result: account deletion removed
 * ZERO media bytes — a GDPR Art. 17 erasure gap.
 *
 * This service erases the DB side and routes byte reclamation through the
 * EXISTING GC path:
 *
 * 1. Every MediaFile row uploaded by the user is inspected.
 * 2. A row still referenced by another user's content — a `PostMedia` /
 *    `PostCommentMedia` reference surviving the deletion of the user's own
 *    posts/comments (within-tenant dedup gives subsequent uploaders a
 *    *reference* to the canonical row, see lib/media/media-upsert.ts), or
 *    another LIVE row sharing `(tenantId, contentHash)` per the shared
 *    storage-accounting predicate — is RETAINED: only the personal link
 *    (`uploadedBy`) is scrubbed. Deleting those bytes would destroy another
 *    user's published content (and `PostMedia.media` is `onDelete: Restrict`
 *    anyway).
 * 3. Every other row is SOFT-DELETED (`deletedAt` set, `uploadedBy` scrubbed).
 *    Soft-delete is the enqueue-for-GC operation of the shared
 *    storage-accounting invariant: the nightly cron's soft-deleted-media purge
 *    (lambda/nightly-cron.ts step 1) hard-deletes the row and batch-deletes
 *    its S3 objects (originalKey/thumbnailKey/optimizedKey) within a bounded
 *    7-day window. `cas/*` is deliberately IAM-immutable to the workers, so
 *    the worker never deletes CAS bytes directly.
 * 4. The user-scoped STAGING objects (`pending/…`, `processing/…`) are not
 *    tracked by any column the purge reads, so their keys are computed here
 *    (via the canonical cas-keys builders) and returned for the caller — the
 *    delete-account worker / nightly cron, which hold S3 clients — to delete
 *    directly.
 *
 * PRECONDITION: the caller must already have deleted the user's own posts,
 * comments, and their PostMedia/PostCommentMedia junction rows (deleteUserData
 * does this before invoking us) — otherwise every row looks "referenced by
 * another user" and nothing is erased.
 */

import {
  isCasKeyError,
  pendingKey,
  processingKey,
} from "../media/cas-keys.js";
import { hasOtherLiveCasReference } from "../media/storage-accounting.js";

/** Structural slice of the Prisma client this service needs. */
export interface UserMediaErasureDb {
  mediaFile: {
    findMany(args: {
      where: { uploadedBy: string };
      select: {
        id: true;
        tenantId: true;
        contentHash: true;
        uploadId: true;
        deletedAt: true;
      };
      take: number;
    }): Promise<
      Array<{
        id: string;
        tenantId: string;
        contentHash: string | null;
        uploadId: string | null;
        deletedAt: Date | null;
      }>
    >;
    updateMany(args: {
      where: { id: { in: string[] }; deletedAt?: null };
      data: { uploadedBy: null; deletedAt?: Date };
    }): Promise<{ count: number }>;
    count(args: {
      where: {
        tenantId: string;
        contentHash: string;
        deletedAt: null;
        id: { notIn: string[] };
      };
    }): Promise<number>;
  };
  postMedia: {
    groupBy(args: {
      by: ["mediaId"];
      where: { mediaId: { in: string[] } };
    }): Promise<Array<{ mediaId: string }>>;
  };
  postCommentMedia: {
    groupBy(args: {
      by: ["mediaId"];
      where: { mediaId: { in: string[] } };
    }): Promise<Array<{ mediaId: string }>>;
  };
}

export interface UserMediaErasureResult {
  /** Rows soft-deleted (handed to the nightly GC purge). */
  erased: number;
  /** Rows retained because another user's content still references them
   *  (personal link scrubbed). */
  retainedShared: number;
  /** User-scoped staging S3 keys (`pending/…`, `processing/…`) the caller
   *  should delete directly — the GC purge does not cover staging. */
  stagingKeys: string[];
}

const PAGE_SIZE = 500;
/** Circuit breaker (repo rule: every loop has a max iteration count). */
const MAX_PAGES = 100;

/**
 * Erase (or scrub) every MediaFile row uploaded by `userId`.
 *
 * Drains by re-querying `uploadedBy: userId` after each page: both branches
 * scrub `uploadedBy`, so processed rows drop out of the next query.
 */
export async function eraseUserMedia(
  db: UserMediaErasureDb,
  userId: string,
): Promise<UserMediaErasureResult> {
  let erased = 0;
  let retainedShared = 0;
  const stagingKeys: string[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await db.mediaFile.findMany({
      where: { uploadedBy: userId },
      select: {
        id: true,
        tenantId: true,
        contentHash: true,
        uploadId: true,
        deletedAt: true,
      },
      take: PAGE_SIZE,
    });
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);

    // Remaining references from OTHER users' content. The user's own
    // PostMedia/PostCommentMedia rows were deleted by the caller, so any
    // survivor belongs to someone else's post/comment.
    const [postRefs, commentRefs] = await Promise.all([
      db.postMedia.groupBy({ by: ["mediaId"], where: { mediaId: { in: ids } } }),
      db.postCommentMedia.groupBy({
        by: ["mediaId"],
        where: { mediaId: { in: ids } },
      }),
    ]);
    const referencedIds = new Set(
      [...postRefs, ...commentRefs].map((r) => r.mediaId),
    );

    const retained: string[] = [];
    const eraseCandidates: typeof rows = [];
    for (const row of rows) {
      if (referencedIds.has(row.id)) retained.push(row.id);
      else eraseCandidates.push(row);
    }

    // Shared storage-accounting predicate: an object is unreferenced iff no
    // OTHER live MediaFile shares its (tenantId, contentHash). Structurally
    // empty under @@unique([tenantId, contentHash]), but queried per the
    // invariant's definition so this stays correct if dedup ever changes.
    const eraseIds = eraseCandidates.map((r) => r.id);
    const toErase: typeof rows = [];
    for (const row of eraseCandidates) {
      if (
        row.contentHash !== null &&
        (await hasOtherLiveCasReference(
          db,
          row.tenantId,
          row.contentHash,
          eraseIds,
        ))
      ) {
        retained.push(row.id);
      } else {
        toErase.push(row);
      }
    }

    if (retained.length > 0) {
      await db.mediaFile.updateMany({
        where: { id: { in: retained } },
        data: { uploadedBy: null },
      });
      retainedShared += retained.length;
    }

    if (toErase.length > 0) {
      const toEraseIds = toErase.map((r) => r.id);
      // Live rows: soft-delete = enqueue for the nightly GC purge.
      await db.mediaFile.updateMany({
        where: { id: { in: toEraseIds }, deletedAt: null },
        data: { uploadedBy: null, deletedAt: new Date() },
      });
      // Rows that were ALREADY soft-deleted (already in the GC pipeline):
      // scrub the personal link only — never move `deletedAt` forward, that
      // would delay their purge.
      await db.mediaFile.updateMany({
        where: { id: { in: toEraseIds } },
        data: { uploadedBy: null },
      });
      erased += toErase.length;

      // Staging keys for the caller to delete from S3 (built via the canonical
      // builders; a row that fails validation simply yields no key — its
      // staging object, if any, is covered by upload-session lifecycle rules).
      for (const row of toErase) {
        if (row.uploadId !== null) {
          const key = pendingKey(row.tenantId, row.uploadId);
          if (!isCasKeyError(key)) stagingKeys.push(key);
        }
        if (row.contentHash !== null) {
          const key = processingKey(row.tenantId, row.contentHash);
          if (!isCasKeyError(key)) stagingKeys.push(key);
        }
      }
    }
  }

  return { erased, retainedShared, stagingKeys };
}
