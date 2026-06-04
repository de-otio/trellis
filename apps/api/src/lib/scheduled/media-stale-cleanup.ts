/**
 * Media Stale Cleanup Job
 *
 * Cleans up stale PENDING/FAILED media records older than 1 hour
 * Runs hourly via cron schedule
 */

import { sharedDatabaseConnectionManager } from "../database-connection-manager.js";
import { getLogger, Logger } from "../logger.js";

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

    // Find stale records (>1 hour old, PENDING or FAILED status)
    const oneHourAgo = new Date(Date.now() - 3600000);
    const staleRecords = await (db as any).mediaFile.findMany({
      where: {
        uploadStatus: { in: ["PENDING", "FAILED"] },
        createdAt: { lt: oneHourAgo },
      },
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

    // Delete from R2 in parallel
    const r2Results = await Promise.allSettled(
      staleRecords.map((record: any) => r2Bucket.delete(record.originalKey)),
    );

    const r2Errors = r2Results.filter((r) => r.status === "rejected").length;
    if (r2Errors > 0) {
      logger.warn("[MediaCleanup] Some R2 deletions failed", {
        failedCount: r2Errors,
        totalCount: staleRecords.length,
      });
    }

    // Delete database records in batch
    const deleteResult = await (db as any).mediaFile.deleteMany({
      where: {
        id: { in: staleRecords.map((r: any) => r.id) },
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
