/**
 * Media Reconciliation Types
 *
 * Types for Option 2 (Eventual Consistency) media upload system
 */

/**
 * R2 Custom Metadata Schema
 */
export interface R2MediaMetadata {
  // Required
  contentHash: string;
  uploadedBy: string;
  uploadedAt: string; // ISO 8601
  mimeType: string;

  // Reconciliation tracking
  needsReconciliation: "true" | "false";
  reconciled: "true" | "false";
  reconciledAt?: string; // ISO 8601

  // Batch tracking
  batchId?: string;

  // Database reference (after reconciliation)
  mediaId?: string;

  // Error tracking
  reconcileAttempts?: string; // number as string
  lastReconcileError?: string;

  // Optional metadata
  width?: string;
  height?: string;
  duration?: string;
}

/**
 * Queue Message Schema
 */
export interface MediaReconciliationMessage {
  type: "SINGLE_UPLOAD" | "BATCH_UPLOAD";
  batchId: string;
  timestamp: number;

  uploads: Array<{
    contentHash: string;
    originalKey: string; // R2 key
    mimeType: string;
    size: number;
    uploadedBy: string;
    uploadedAt: string;

    // Optional metadata
    width?: number;
    height?: number;
    duration?: number;
  }>;
}

/**
 * Upload Result
 */
export interface UploadResult {
  success: boolean;
  contentHash: string;
  url: string;
  status: "uploaded" | "reconciled";
  mediaId?: string;
  warning?: string;
}

/**
 * Upload Error
 */
export interface UploadError {
  success: false;
  error: string;
  message: string;
  code?: string;
}
