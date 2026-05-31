/**
 * Media Reconciliation Service
 *
 * Processes queued media uploads and creates database records
 * Handles deduplication, retries, and R2 metadata updates
 */

import type { R2Bucket } from "../../types/cloudflare-compat.js";
import { sharedDatabaseConnectionManager } from "../database-connection-manager.js";
import { getLogger, Logger } from "../logger.js";
import type { MediaReconciliationMessage } from "../types/media-reconciliation.js";

export class MediaReconciliationService {
  private env: any;
  private r2Bucket: R2Bucket;

  constructor(env: any) {
    this.env = env;
    this.r2Bucket = env.MEDIA_BUCKET_R2;
  }

  /**
   * Reconcile batch of media uploads
   */
  async reconcileBatch(messages: MediaReconciliationMessage[]): Promise<void> {
    const logger = getLogger();

    // Flatten all uploads from all messages
    const allUploads = messages.flatMap((m) => m.uploads);

    logger.info("[MediaReconciliation] Processing batch", {
      messageCount: messages.length,
      uploadCount: allUploads.length,
    });

    if (allUploads.length === 0) {
      logger.info("[MediaReconciliation] No uploads to process");
      return;
    }

    // Get database connection
    const region = "US"; // TODO: Get from env or config
    const managed = sharedDatabaseConnectionManager.acquireClient(
      region,
      this.env,
    );
    const db = managed.client;

    try {
      // 1. Check for existing records (deduplication)
      const hashes = allUploads.map((u) => u.contentHash);
      const existing = await (db as any).mediaFile.findMany({
        where: { contentHash: { in: hashes } },
        select: { id: true, contentHash: true },
      });

      const existingHashes = new Set(existing.map((m: any) => m.contentHash));

      logger.info("[MediaReconciliation] Deduplication check", {
        total: allUploads.length,
        existing: existing.length,
        new: allUploads.length - existing.length,
      });

      // 2. Filter to only new uploads
      const newUploads = allUploads.filter(
        (u) => !existingHashes.has(u.contentHash),
      );

      if (newUploads.length === 0) {
        logger.info("[MediaReconciliation] All uploads already reconciled");

        // Update R2 metadata for existing records
        await this.updateR2MetadataForExisting(allUploads, existing);
        return;
      }

      // 3. Batch create database records
      const mediaFiles = await (db as any).$transaction(
        newUploads.map((u: any) =>
          (db as any).mediaFile.create({
            data: {
              contentHash: u.contentHash,
              mimeType: u.mimeType,
              size: u.size,
              originalKey: u.originalKey,
              uploadStatus: "COMPLETE",
              uploadedBy: u.uploadedBy,
              uploadBatchId: messages[0].batchId,
              createdViaReconciliation: true,
              reconciledAt: new Date(),
              width: u.width,
              height: u.height,
              duration: u.duration,
            },
          }),
        ),
        { timeout: 30000 },
      );

      logger.info("[MediaReconciliation] Created MediaFile records", {
        count: mediaFiles.length,
      });

      // 4. Update R2 metadata (mark as reconciled)
      await this.updateR2Metadata(newUploads, mediaFiles);

      logger.info("[MediaReconciliation] Batch reconciliation complete", {
        messageCount: messages.length,
        uploadCount: allUploads.length,
        newRecords: mediaFiles.length,
      });
    } catch (error: any) {
      if (error.code === "P2002") {
        // Unique constraint violation - race condition
        logger.warn("[MediaReconciliation] Duplicate records detected", {
          error: error.message,
        });
        // Retry will handle this
        throw error;
      }

      logger.error("[MediaReconciliation] Reconciliation failed", {
        error: error.message,
        stack: error.stack,
        uploadCount: allUploads.length,
      });
      throw error;
    }
  }

  /**
   * Update R2 metadata for newly reconciled uploads
   */
  private async updateR2Metadata(
    uploads: any[],
    mediaFiles: any[],
  ): Promise<void> {
    const logger = getLogger();

    // Create map of contentHash -> mediaId
    const hashToId = new Map(mediaFiles.map((m: any) => [m.contentHash, m.id]));

    // Update R2 metadata in parallel
    const results = await Promise.allSettled(
      uploads.map(async (u) => {
        const mediaId = hashToId.get(u.contentHash);
        if (!mediaId) return;

        try {
          // Get existing object
          const obj = await this.r2Bucket.get(u.originalKey);
          if (!obj) {
            logger.warn("[MediaReconciliation] R2 object not found", {
              key: u.originalKey,
              contentHash: u.contentHash,
            });
            return;
          }

          // Re-upload with updated metadata
          await this.r2Bucket.put(u.originalKey, obj.body, {
            httpMetadata: obj.httpMetadata,
            customMetadata: {
              ...obj.customMetadata,
              mediaId,
              reconciled: "true",
              reconciledAt: new Date().toISOString(),
              needsReconciliation: "false",
            },
          });
        } catch (error: any) {
          logger.warn("[MediaReconciliation] Failed to update R2 metadata", {
            key: u.originalKey,
            error: error.message,
          });
        }
      }),
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      logger.warn("[MediaReconciliation] Some R2 metadata updates failed", {
        failedCount: failed.length,
        totalCount: uploads.length,
      });
    }
  }

  /**
   * Update R2 metadata for existing records (deduplication case)
   */
  private async updateR2MetadataForExisting(
    uploads: any[],
    existing: any[],
  ): Promise<void> {
    const logger = getLogger();

    const hashToId = new Map(existing.map((m: any) => [m.contentHash, m.id]));

    await Promise.allSettled(
      uploads.map(async (u) => {
        const mediaId = hashToId.get(u.contentHash);
        if (!mediaId) return;

        try {
          const obj = await this.r2Bucket.get(u.originalKey);
          if (!obj) return;

          // Only update if not already reconciled
          if (obj.customMetadata?.reconciled !== "true") {
            await this.r2Bucket.put(u.originalKey, obj.body, {
              httpMetadata: obj.httpMetadata,
              customMetadata: {
                ...obj.customMetadata,
                mediaId,
                reconciled: "true",
                reconciledAt: new Date().toISOString(),
                needsReconciliation: "false",
              },
            });
          }
        } catch (error: any) {
          logger.warn(
            "[MediaReconciliation] Failed to update existing R2 metadata",
            {
              key: u.originalKey,
              error: error.message,
            },
          );
        }
      }),
    );
  }
}
