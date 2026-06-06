import type { KVNamespace, R2Bucket, CloudflareQueue, Queue } from "../../types/cloudflare-compat.js";
/**
 * Media Upload Service
 *
 * Implements Option 2 (Eventual Consistency) for media uploads:
 * 1. Upload to R2 immediately (fast, reliable)
 * 2. Queue reconciliation message (non-blocking)
 * 3. Return success to client
 * 4. Reconciliation worker creates database record asynchronously
 */

import { getLogger, Logger } from "../logger.js";
import type {
  MediaReconciliationMessage,
  R2MediaMetadata,
  UploadResult,
} from "../types/media-reconciliation.js";

/**
 * Generate unique batch ID
 */
function generateBatchId(): string {
  return `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate SHA-256 content hash for content-addressed storage
 */
async function generateContentHash(file: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", file);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMimeType(mimeType: string): string {
  const mimeMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  return mimeMap[mimeType] || "bin";
}

export class MediaUploadService {
  private r2Bucket: R2Bucket;
  private queue: Queue<MediaReconciliationMessage>;
  private apiDomain: string;
  private env: any;

  constructor(env: any) {
    this.env = env;
    this.r2Bucket = env.MEDIA_BUCKET_R2;
    this.queue = env.MEDIA_RECONCILIATION_QUEUE;
    this.apiDomain =
      env.ENVIRONMENT === "prod"
        ? "https://api.example.com"
        : "https://api.rkm1.de";
  }

  /**
   * Upload single file
   */
  async uploadSingle(
    file: File,
    userId: string,
    metadata?: { width?: number; height?: number; duration?: number },
    preReadBuffer?: ArrayBuffer,
  ): Promise<UploadResult> {
    const logger = getLogger();
    const batchId = generateBatchId();

    try {
      // 1. Generate content hash
      // Use pre-read buffer if provided (avoids double file.arrayBuffer() read
      // which may not work reliably on Cloudflare Workers for FormData Files)
      const fileBuffer = preReadBuffer ?? await file.arrayBuffer();
      const contentHash = await generateContentHash(fileBuffer);
      const ext = getExtensionFromMimeType(file.type);
      const originalKey = `originals/user-${userId}/${contentHash}.${ext}`;

      logger.info("[MediaUpload] Starting upload", {
        contentHash,
        mimeType: file.type,
        size: file.size,
        userId,
        batchId,
      });

      // 2. Upload to R2 with metadata
      const r2Metadata: R2MediaMetadata = {
        contentHash,
        uploadedBy: userId,
        uploadedAt: new Date().toISOString(),
        mimeType: file.type,
        needsReconciliation: "true",
        reconciled: "false",
        batchId,
        ...(metadata?.width && { width: metadata.width.toString() }),
        ...(metadata?.height && { height: metadata.height.toString() }),
        ...(metadata?.duration && { duration: metadata.duration.toString() }),
      };

      await this.r2Bucket.put(originalKey, fileBuffer, {
        httpMetadata: {
          contentType: file.type,
        },
        customMetadata: r2Metadata as unknown as Record<string, string>,
      });

      logger.info("[MediaUpload] R2 upload successful", {
        contentHash,
        originalKey,
      });

      // 3. Queue reconciliation (non-blocking)
      const message: MediaReconciliationMessage = {
        type: "SINGLE_UPLOAD",
        batchId,
        timestamp: Date.now(),
        uploads: [
          {
            contentHash,
            originalKey,
            mimeType: file.type,
            size: file.size,
            uploadedBy: userId,
            uploadedAt: new Date().toISOString(),
            ...(metadata?.width && { width: metadata.width }),
            ...(metadata?.height && { height: metadata.height }),
            ...(metadata?.duration && { duration: metadata.duration }),
          },
        ],
      };

      await this.queue.send(message);

      logger.info("[MediaUpload] Reconciliation queued", {
        contentHash,
        batchId,
      });

      // 4. Return success immediately
      return {
        success: true,
        contentHash,
        url: `${this.apiDomain}/api/media/${contentHash}`,
        status: "uploaded",
      };
    } catch (error: any) {
      logger.error("[MediaUpload] Upload failed", {
        error: error.message,
        userId,
        fileName: file.name,
      });
      throw error;
    }
  }

  /**
   * Upload batch of files
   */
  async uploadBatch(
    files: File[],
    userId: string,
    metadataArray?: Array<{
      width?: number;
      height?: number;
      duration?: number;
    }>,
  ): Promise<UploadResult[]> {
    const logger = getLogger();
    const batchId = generateBatchId();

    logger.info("[MediaUpload] Starting batch upload", {
      fileCount: files.length,
      userId,
      batchId,
    });

    // Upload all files to R2 in parallel
    const uploadResults = await Promise.allSettled(
      files.map(async (file, index) => {
        const fileBuffer = await file.arrayBuffer();
        const contentHash = await generateContentHash(fileBuffer);
        const ext = getExtensionFromMimeType(file.type);
        const originalKey = `originals/user-${userId}/${contentHash}.${ext}`;
        const metadata = metadataArray?.[index];

        const r2Metadata: R2MediaMetadata = {
          contentHash,
          uploadedBy: userId,
          uploadedAt: new Date().toISOString(),
          mimeType: file.type,
          needsReconciliation: "true",
          reconciled: "false",
          batchId,
          ...(metadata?.width && { width: metadata.width.toString() }),
          ...(metadata?.height && { height: metadata.height.toString() }),
          ...(metadata?.duration && { duration: metadata.duration.toString() }),
        };

        await this.r2Bucket.put(originalKey, fileBuffer, {
          httpMetadata: {
            contentType: file.type,
          },
          customMetadata: r2Metadata as unknown as Record<string, string>,
        });

        return {
          contentHash,
          originalKey,
          mimeType: file.type,
          size: file.size,
          uploadedBy: userId,
          uploadedAt: new Date().toISOString(),
          ...(metadata?.width && { width: metadata.width }),
          ...(metadata?.height && { height: metadata.height }),
          ...(metadata?.duration && { duration: metadata.duration }),
        };
      }),
    );

    // Collect successful uploads
    const successful = uploadResults
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
      .map((r) => r.value);

    logger.info("[MediaUpload] R2 batch upload complete", {
      total: files.length,
      successful: successful.length,
      failed: files.length - successful.length,
      batchId,
    });

    // Queue reconciliation for successful uploads
    if (successful.length > 0) {
      const message: MediaReconciliationMessage = {
        type: "BATCH_UPLOAD",
        batchId,
        timestamp: Date.now(),
        uploads: successful,
      };

      await this.queue.send(message);

      logger.info("[MediaUpload] Batch reconciliation queued", {
        count: successful.length,
        batchId,
      });
    }

    // Return results
    return uploadResults.map((result, index) => {
      if (result.status === "fulfilled") {
        return {
          success: true,
          contentHash: result.value.contentHash,
          url: `${this.apiDomain}/api/media/${result.value.contentHash}`,
          status: "uploaded" as const,
        };
      } else {
        return {
          success: false,
          contentHash: "",
          url: "",
          status: "uploaded" as const,
          warning: `Upload failed: ${result.reason.message}`,
        };
      }
    });
  }
}
