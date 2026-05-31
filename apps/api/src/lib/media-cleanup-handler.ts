/**
 * Media Cleanup Handler
 *
 * Handles cleanup of soft-deleted media files from R2 storage.
 *
 * This runs as a scheduled job to:
 * 1. Find media files marked as deleted (deletedAt is set)
 * 2. Wait for a grace period (default: 7 days) before actual deletion
 * 3. Delete R2 objects (original, thumbnail, optimized)
 * 4. Retry failed deletions with exponential backoff
 * 5. Log all operations for monitoring
 */

import type { R2Bucket } from "../types/cloudflare-compat.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";
import { sharedDatabaseConnectionManager } from "./database-connection-manager.js";
import {
  withQueryTimeoutAndRetry,
  QueryTimeoutPresets,
} from "./db-query-helper.js";
import { DataRouter } from "./data-router.js";


export interface Env extends LoggerEnv {
  MEDIA_BUCKET_R2?: R2Bucket;
  R2_BUCKET?: R2Bucket; // Alternative binding name
  DEFAULT_REGION?: string;
  MEDIA_CLEANUP_GRACE_PERIOD_DAYS?: string; // Default: 7 days
}

interface CleanupResult {
  processed: number;
  deleted: number;
  errors: number;
  skipped: number; // Still in grace period
}

export class MediaCleanupHandler {
  private logger: Logger;
  private gracePeriodDays: number;

  constructor(env: Env) {
    this.logger = getLogger();
    this.gracePeriodDays = parseInt(
      env.MEDIA_CLEANUP_GRACE_PERIOD_DAYS || "7",
      10,
    );
  }

  /**
   * Run cleanup job for all regions
   */
  async runCleanup(env: Env): Promise<CleanupResult> {
    this.logger.info("[MediaCleanup] Starting media cleanup job", {
      gracePeriodDays: this.gracePeriodDays,
    });

    const regions: Array<"US" | "EU" | "CN"> = ["US", "EU", "CN"];
    let totalProcessed = 0;
    let totalDeleted = 0;
    let totalErrors = 0;
    let totalSkipped = 0;

    for (const region of regions) {
      try {
        const result = await this.cleanupRegion(region, env);
        totalProcessed += result.processed;
        totalDeleted += result.deleted;
        totalErrors += result.errors;
        totalSkipped += result.skipped;
      } catch (error: any) {
        this.logger.error(`[MediaCleanup] Error cleaning up region ${region}`, {
          error: error.message,
          region,
        });
        totalErrors++;
      }
    }

    this.logger.info("[MediaCleanup] Cleanup job completed", {
      processed: totalProcessed,
      deleted: totalDeleted,
      errors: totalErrors,
      skipped: totalSkipped,
    });

    return {
      processed: totalProcessed,
      deleted: totalDeleted,
      errors: totalErrors,
      skipped: totalSkipped,
    };
  }

  /**
   * Cleanup media for a specific region
   */
  private async cleanupRegion(
    region: "US" | "EU" | "CN",
    env: Env,
  ): Promise<CleanupResult> {
    const r2Bucket = (env as any).MEDIA_BUCKET_R2 || (env as any).R2_BUCKET;
    if (!r2Bucket) {
      this.logger.warn(
        "[MediaCleanup] R2 bucket not configured, skipping cleanup",
      );
      return { processed: 0, deleted: 0, errors: 0, skipped: 0 };
    }

    // Calculate cutoff date (grace period)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.gracePeriodDays);

    // Find all deleted media files older than grace period
    const deletedMedia = await withQueryTimeoutAndRetry(
      sharedDatabaseConnectionManager,
      region,
      env as any,
      async (db) => {
        const dbAny = db as any;
        return await dbAny.mediaFile.findMany({
          where: {
            deletedAt: {
              not: null,
              lte: cutoffDate, // Deleted before cutoff date
            },
          },
          select: {
            id: true,
            contentHash: true,
            originalKey: true,
            thumbnailKey: true,
            optimizedKey: true,
            deletedAt: true,
          },
          take: 100, // Process in batches
        });
      },
      {
        ...QueryTimeoutPresets.BACKGROUND,
        maxRetries: 3,
        baseDelayMs: 100,
        context: {
          operation: "mediaCleanup_findDeleted",
          region,
        },
      },
    );

    let deleted = 0;
    let errors = 0;
    let skipped = 0;

    for (const media of deletedMedia) {
      try {
        // Delete R2 objects
        const deletedObjects = await this.deleteR2Objects(media, r2Bucket);

        if (deletedObjects > 0) {
          deleted++;
          this.logger.info("[MediaCleanup] Deleted media objects", {
            mediaId: media.id,
            contentHash: media.contentHash,
            deletedObjects,
            region,
          });
        } else {
          skipped++;
        }
      } catch (error: any) {
        errors++;
        this.logger.error("[MediaCleanup] Error deleting media", {
          mediaId: media.id,
          contentHash: media.contentHash,
          error: error.message,
          region,
        });
      }
    }

    return {
      processed: deletedMedia.length,
      deleted,
      errors,
      skipped,
    };
  }

  /**
   * Delete R2 objects for a media file
   * Returns number of objects deleted
   */
  private async deleteR2Objects(
    media: {
      originalKey: string;
      thumbnailKey: string | null;
      optimizedKey: string | null;
    },
    r2Bucket: R2Bucket,
  ): Promise<number> {
    let deletedCount = 0;

    // Delete original
    try {
      await r2Bucket.delete(media.originalKey);
      deletedCount++;
    } catch (error: any) {
      // Object might not exist, that's okay
      if (!error.message?.includes("No such key")) {
        throw error;
      }
    }

    // Delete thumbnail if exists
    if (media.thumbnailKey) {
      try {
        await r2Bucket.delete(media.thumbnailKey);
        deletedCount++;
      } catch (error: any) {
        if (!error.message?.includes("No such key")) {
          throw error;
        }
      }
    }

    // Delete optimized if exists
    if (media.optimizedKey) {
      try {
        await r2Bucket.delete(media.optimizedKey);
        deletedCount++;
      } catch (error: any) {
        if (!error.message?.includes("No such key")) {
          throw error;
        }
      }
    }

    return deletedCount;
  }
}
