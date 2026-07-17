/**
 * Orphaned Media Handler
 *
 * Manages orphaned media cleanup for optimistic image uploads.
 * Provides functionality to mark media as orphaned and clean up old orphaned media.
 */

import type { Env } from "../env.js";
import { getLogger, Logger } from "./logger.js";

export class OrphanedMediaHandler {
  private logger: Logger;

  constructor(env?: Env) {
    this.logger = env ? getLogger() : ({} as Logger);
  }

  /**
   * Mark a media file as orphaned
   * Sets orphanedAt timestamp and attachedToPost to false
   *
   * Note: mediaId can be either a MediaFile.id or a contentHash
   * We check both to handle the case where the media was just uploaded
   * and the MediaFile record hasn't been created yet (async reconciliation)
   */
  async markMediaAsOrphaned(
    mediaId: string,
    userId: string,
    region: string,
    env: Env,
  ): Promise<{ success: boolean; error?: string }> {
    const startTime = Date.now();
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );

    try {
      // Verify media exists and belongs to user
      // Note: mediaId can be either a MediaFile.id or a contentHash
      // We check both to handle the case where the media was just uploaded
      // and the MediaFile record hasn't been created yet (async reconciliation)
      const media = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env,
        (db) =>
          db.mediaFile.findFirst({
            where: {
              OR: [
                { id: mediaId, uploadedBy: userId },
                { contentHash: mediaId, uploadedBy: userId },
              ],
            },
          }),
        {
          ...QueryTimeoutPresets.STANDARD,
          context: {
            operation: "verifyMediaOwnership",
            mediaId,
            userId,
          },
        },
      );

      if (!media) {
        // Media not found - this is expected if the upload just completed
        // and the reconciliation queue hasn't processed it yet
        // We'll treat this as a successful operation since there's nothing to mark
        this.logger.info("Media not yet reconciled, treating as success", {
          mediaId,
          userId,
          duration: Date.now() - startTime,
        });
        return { success: true };
      }

      // Mark media as orphaned
      // Use media.id (not mediaId) since mediaId might be a contentHash
      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env,
        (db) =>
          db.mediaFile.update({
            where: { id: media.id },
            data: {
              orphanedAt: new Date(),
              attachedToPost: false,
              lastAccessedAt: new Date(),
            },
          }),
        {
          ...QueryTimeoutPresets.STANDARD,
          context: {
            operation: "markMediaOrphaned",
            mediaId: media.id,
            userId,
          },
        },
      );

      this.logger.info("Media marked as orphaned", {
        mediaId: media.id,
        inputMediaId: mediaId,
        userId,
        duration: Date.now() - startTime,
      });

      return { success: true };
    } catch (error) {
      this.logger.error("Failed to mark media as orphaned", {
        mediaId,
        userId,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Clean up orphaned media older than the grace period (24 hours)
   * Soft deletes media by setting deletedAt timestamp
   *
   * Scalability features:
   * - Processes in batches to avoid memory issues
   * - Uses cursor-based pagination for large datasets
   * - Continues on errors (doesn't fail entire job)
   * - Respects Cloudflare Worker CPU time limits
   */
  async cleanupOrphanedMedia(
    region: string,
    env: Env,
    options: {
      batchSize?: number;
      maxBatches?: number;
    } = {},
  ): Promise<{
    cleanedCount: number;
    scheduledForDeletion: string[];
    hasMore: boolean;
  }> {
    const startTime = Date.now();
    const batchSize = options.batchSize || 100; // Process 100 at a time
    const maxBatches = options.maxBatches || 10; // Max 10 batches per run (1000 items)

    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );

    try {
      // Calculate grace period cutoff (24 hours ago)
      const gracePeriodCutoff = new Date();
      gracePeriodCutoff.setHours(gracePeriodCutoff.getHours() - 24);

      let totalCleaned = 0;
      let allScheduledIds: string[] = [];
      let batchCount = 0;
      let hasMore = false;

      // Process in batches with cursor-based pagination
      while (batchCount < maxBatches) {
        // Layer 2: Repair stale attachedToPost=false flags for files that have PostMedia refs.
        // These files are genuinely attached to posts but the flag was never updated.
        const orphanedWithRefs = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env,
          (db) =>
            db.mediaFile.findMany({
              where: {
                attachedToPost: false,
                orphanedAt: { lte: gracePeriodCutoff },
                deletedAt: null,
                posts: { some: {} }, // has live PostMedia refs — flag is wrong
              },
              select: { id: true },
              take: batchSize,
            }),
          {
            ...QueryTimeoutPresets.BACKGROUND,
            context: {
              operation: "findStaleAttachedMedia",
              batchNumber: batchCount + 1,
            },
          },
        );

        if (orphanedWithRefs.length > 0) {
          await withQueryTimeoutAndRetry(
            sharedDatabaseConnectionManager,
            region,
            env,
            (db) =>
              db.mediaFile.updateMany({
                where: { id: { in: orphanedWithRefs.map((m) => m.id) } },
                data: { attachedToPost: true, orphanedAt: null },
              }),
            {
              ...QueryTimeoutPresets.BACKGROUND,
              context: {
                operation: "repairStaleAttachedMedia",
                count: orphanedWithRefs.length,
                batchNumber: batchCount + 1,
              },
            },
          );
          this.logger.warn("Repaired stale attachedToPost flags", {
            count: orphanedWithRefs.length,
            region,
          });
        }

        // Layer 0: Find orphaned media older than grace period (one batch).
        // The postMedia: { none: {} } filter ensures we never soft-delete a file
        // that is still referenced by a PostMedia record.
        const orphanedMedia = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env,
          (db) =>
            db.mediaFile.findMany({
              where: {
                attachedToPost: false,
                orphanedAt: {
                  lte: gracePeriodCutoff,
                },
                deletedAt: null, // Not already soft-deleted
                posts: { none: {} }, // Skip files still referenced by posts
              },
              select: {
                id: true,
                contentHash: true,
                originalKey: true,
              },
              take: batchSize,
              orderBy: {
                orphanedAt: "asc", // Oldest first
              },
            }),
          {
            ...QueryTimeoutPresets.BACKGROUND,
            context: {
              operation: "findOrphanedMedia",
              gracePeriodCutoff: gracePeriodCutoff.toISOString(),
              batchSize,
              batchNumber: batchCount + 1,
            },
          },
        );

        if (orphanedMedia.length === 0) {
          // No more orphaned media to process
          break;
        }

        // Soft delete this batch
        const mediaIds = orphanedMedia.map((m) => m.id);
        await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env,
          (db) =>
            db.mediaFile.updateMany({
              where: {
                id: { in: mediaIds },
              },
              data: {
                deletedAt: new Date(),
              },
            }),
          {
            ...QueryTimeoutPresets.BACKGROUND,
            context: {
              operation: "softDeleteOrphanedMedia",
              count: mediaIds.length,
              batchNumber: batchCount + 1,
            },
          },
        );

        totalCleaned += orphanedMedia.length;
        allScheduledIds.push(...mediaIds);
        batchCount++;

        this.logger.info("Orphaned media batch processed", {
          batchNumber: batchCount,
          batchSize: orphanedMedia.length,
          totalCleaned,
          region,
        });

        // If we got a full batch, there might be more
        if (orphanedMedia.length === batchSize) {
          hasMore = true;
        } else {
          // Partial batch means we're done
          hasMore = false;
          break;
        }

        // Check if we're approaching CPU time limit (25 seconds for safety)
        if (Date.now() - startTime > 25000) {
          this.logger.warn("Approaching CPU time limit, stopping cleanup", {
            batchesProcessed: batchCount,
            totalCleaned,
            duration: Date.now() - startTime,
          });
          hasMore = true;
          break;
        }
      }

      if (totalCleaned === 0) {
        this.logger.info("No orphaned media to clean up", {
          gracePeriodCutoff: gracePeriodCutoff.toISOString(),
          region,
          duration: Date.now() - startTime,
        });
      } else {
        this.logger.info("Orphaned media cleanup completed", {
          count: totalCleaned,
          batchesProcessed: batchCount,
          hasMore,
          region,
          gracePeriodCutoff: gracePeriodCutoff.toISOString(),
          duration: Date.now() - startTime,
        });
      }

      return {
        cleanedCount: totalCleaned,
        scheduledForDeletion: allScheduledIds,
        hasMore,
      };
    } catch (error) {
      this.logger.error("Failed to clean up orphaned media", {
        error: error instanceof Error ? error.message : String(error),
        region,
        duration: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Schedule R2 deletion for soft-deleted media
   * Deletes media from R2 that has been soft-deleted for 7 days
   *
   * Scalability features:
   * - Processes in batches to avoid memory issues
   * - Continues on R2 errors (logs but doesn't fail)
   * - Respects CPU time limits
   */
  async scheduleR2Deletion(
    region: string,
    env: Env,
    options: {
      batchSize?: number;
      maxBatches?: number;
    } = {},
  ): Promise<{
    deletedCount: number;
    deletedKeys: number;
    errors: number;
    hasMore: boolean;
  }> {
    const startTime = Date.now();
    const batchSize = options.batchSize || 50; // Smaller batches for R2 operations
    const maxBatches = options.maxBatches || 10; // Max 10 batches per run (500 items)

    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );
    // Evidence-hold guard (compliance plan 08 §2.3 item 5): this is the SAME
    // 7-day `deletedAt` hard-delete purge as lambda/nightly-cron.ts step 1, so
    // it must apply the SAME exemption — never destroy an original that is under
    // a live evidence/legal hold while an authority case is open. The exempt
    // predicate is the single source of truth in restrict-content.ts.
    const { evidenceHoldExemptWhere } = await import(
      "./compliance/restrict-content.js"
    );

    try {
      // Calculate R2 deletion cutoff (7 days after soft delete)
      const deletionCutoff = new Date();
      deletionCutoff.setDate(deletionCutoff.getDate() - 7);

      let totalDeleted = 0;
      let totalKeysDeleted = 0;
      let totalErrors = 0;
      let batchCount = 0;
      let hasMore = false;

      // Get R2 bucket
      const r2Bucket = (env as any).MEDIA_BUCKET_R2 || (env as any).R2_BUCKET;
      if (!r2Bucket) {
        this.logger.error("R2 bucket not configured");
        throw new Error("R2 bucket not configured");
      }

      // Process in batches
      while (batchCount < maxBatches) {
        // Find soft-deleted media older than 7 days (one batch)
        const mediaToDelete = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env,
          (db) =>
            db.mediaFile.findMany({
              where: {
                deletedAt: {
                  lte: deletionCutoff,
                },
                ...evidenceHoldExemptWhere(),
              },
              select: {
                id: true,
                contentHash: true,
                originalKey: true,
                thumbnailKey: true,
                optimizedKey: true,
              },
              take: batchSize,
              orderBy: {
                deletedAt: "asc", // Oldest first
              },
            }),
          {
            ...QueryTimeoutPresets.BACKGROUND,
            context: {
              operation: "findMediaForR2Deletion",
              deletionCutoff: deletionCutoff.toISOString(),
              batchSize,
              batchNumber: batchCount + 1,
            },
          },
        );

        if (mediaToDelete.length === 0) {
          // No more media to delete
          break;
        }

        // Delete from R2 (continue on errors)
        let batchKeysDeleted = 0;
        let batchErrors = 0;

        for (const media of mediaToDelete) {
          const keysToDelete = [
            media.originalKey,
            media.thumbnailKey,
            media.optimizedKey,
          ].filter((key): key is string => !!key);

          for (const key of keysToDelete) {
            try {
              await r2Bucket.delete(key);
              batchKeysDeleted++;
              this.logger.debug("Deleted R2 object", {
                key,
                mediaId: media.id,
                region,
              });
            } catch (error) {
              batchErrors++;
              this.logger.warn("Failed to delete R2 object", {
                key,
                mediaId: media.id,
                region,
                error: error instanceof Error ? error.message : String(error),
              });
              // Continue with next key
            }
          }
        }

        // Hard delete from database (even if some R2 deletions failed)
        const mediaIds = mediaToDelete.map((m) => m.id);
        try {
          await withQueryTimeoutAndRetry(
            sharedDatabaseConnectionManager,
            region,
            env,
            (db) =>
              db.mediaFile.deleteMany({
                where: {
                  id: { in: mediaIds },
                  // Re-assert the hold exemption atomically at delete time: a row
                  // placed under an evidence hold between the SELECT above and this
                  // DELETE must not be swept (mirrors the select-then-re-assert
                  // pattern used by stale-media-reap).
                  ...evidenceHoldExemptWhere(),
                },
              }),
            {
              ...QueryTimeoutPresets.BACKGROUND,
              context: {
                operation: "hardDeleteMedia",
                count: mediaIds.length,
                batchNumber: batchCount + 1,
              },
            },
          );
        } catch (error) {
          this.logger.error("Failed to hard delete media from database", {
            mediaIds,
            region,
            error: error instanceof Error ? error.message : String(error),
          });
          batchErrors++;
          // Continue to next batch
        }

        totalDeleted += mediaToDelete.length;
        totalKeysDeleted += batchKeysDeleted;
        totalErrors += batchErrors;
        batchCount++;

        this.logger.info("R2 deletion batch completed", {
          batchNumber: batchCount,
          mediaDeleted: mediaToDelete.length,
          keysDeleted: batchKeysDeleted,
          errors: batchErrors,
          totalDeleted,
          region,
        });

        // If we got a full batch, there might be more
        if (mediaToDelete.length === batchSize) {
          hasMore = true;
        } else {
          hasMore = false;
          break;
        }

        // Check CPU time limit
        if (Date.now() - startTime > 25000) {
          this.logger.warn("Approaching CPU time limit, stopping R2 deletion", {
            batchesProcessed: batchCount,
            totalDeleted,
            duration: Date.now() - startTime,
          });
          hasMore = true;
          break;
        }
      }

      if (totalDeleted === 0) {
        this.logger.info("No media ready for R2 deletion", {
          deletionCutoff: deletionCutoff.toISOString(),
          region,
          duration: Date.now() - startTime,
        });
      } else {
        this.logger.info("R2 deletion completed", {
          mediaDeleted: totalDeleted,
          keysDeleted: totalKeysDeleted,
          errors: totalErrors,
          batchesProcessed: batchCount,
          hasMore,
          region,
          deletionCutoff: deletionCutoff.toISOString(),
          duration: Date.now() - startTime,
        });
      }

      return {
        deletedCount: totalDeleted,
        deletedKeys: totalKeysDeleted,
        errors: totalErrors,
        hasMore,
      };
    } catch (error) {
      this.logger.error("Failed to schedule R2 deletion", {
        error: error instanceof Error ? error.message : String(error),
        region,
        duration: Date.now() - startTime,
      });
      throw error;
    }
  }
}
