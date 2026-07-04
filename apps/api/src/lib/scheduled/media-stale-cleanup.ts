/**
 * Media Stale Cleanup Job
 *
 * Reaps genuinely-abandoned PENDING/FAILED media records (and their staged
 * S3/R2 objects). Runs hourly via cron schedule.
 *
 * AR4: the reap scope is shared with the hourly Lambda cron via
 * `../media/stale-media-reap.ts` — a row the moderation pipeline has engaged
 * with (any MediaModerationJob), or one younger than the reap window
 * (≫ moderation SLA), is NEVER deleted. See that module for the invariant.
 */

import { sharedDatabaseConnectionManager } from "../database-connection-manager.js";
import { getLogger, Logger } from "../logger.js";
import {
  staleMediaReapCutoff,
  staleMediaReapWhere,
} from "../media/stale-media-reap.js";

export async function cleanupStaleMedia(env: any): Promise<{
  deleted: number;
  errors: number;
}> {
  const logger = getLogger();
  const r2Bucket = env.MEDIA_BUCKET_R2;

  logger.info("[MediaCleanup] Starting stale media cleanup");

  try {
    // Get database connection
    const region = "US";
    const managed = sharedDatabaseConnectionManager.acquireClient(region, env);
    const db = managed.client;

    // Find abandoned records: PENDING/FAILED, older than the reap window,
    // and NEVER inside the moderation pipeline (AR4 scope, shared with the
    // hourly Lambda cron).
    const cutoff = staleMediaReapCutoff();
    const staleRecords = await (db as any).mediaFile.findMany({
      where: staleMediaReapWhere(cutoff),
      take: 100, // Process in batches
      select: {
        id: true,
        contentHash: true,
        originalKey: true,
        uploadStatus: true,
        createdAt: true,
      },
    });

    if (staleRecords.length === 0) {
      logger.info("[MediaCleanup] No stale media to clean up");
      return { deleted: 0, errors: 0 };
    }

    logger.info("[MediaCleanup] Found stale media records", {
      count: staleRecords.length,
    });

    // Delete staged objects from R2 in parallel. Async-pending rows are born
    // with a NULL originalKey (the processing worker fills it post-transcode)
    // — skip those; there is no object to delete.
    const withKey = staleRecords.filter((r: any) => r.originalKey != null);
    const r2Results = await Promise.allSettled(
      withKey.map((record: any) => r2Bucket.delete(record.originalKey)),
    );

    const r2Errors = r2Results.filter((r) => r.status === "rejected").length;
    if (r2Errors > 0) {
      logger.warn("[MediaCleanup] Some R2 deletions failed", {
        failedCount: r2Errors,
        totalCount: withKey.length,
      });
    }

    // Delete database records in batch, RE-ASSERTING the full reap scope
    // (not id-only): a row that acquired a moderation job between the
    // findMany and this delete is re-excluded atomically at delete time.
    const deleteResult = await (db as any).mediaFile.deleteMany({
      where: {
        id: { in: staleRecords.map((r: any) => r.id) },
        ...staleMediaReapWhere(cutoff),
      },
    });

    logger.info("[MediaCleanup] Stale media cleanup complete", {
      deleted: deleteResult.count,
      r2Errors,
    });

    return {
      deleted: deleteResult.count,
      errors: r2Errors,
    };
  } catch (error: any) {
    logger.error("[MediaCleanup] Cleanup failed", {
      error: error.message,
      stack: error.stack,
    });
    return {
      deleted: 0,
      errors: 1,
    };
  }
}
