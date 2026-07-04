/**
 * Chunked S3 batch delete for user-scoped staging objects (AR7).
 *
 * Used by the account-deletion paths (delete-account worker, nightly cron) to
 * remove the `pending/…` / `processing/…` staging objects reported by
 * `deleteUserData().mediaStagingKeys`. CAS bytes (`cas/*`) are NEVER deleted
 * here — reclamation of approved bytes goes through the nightly
 * soft-deleted-media purge (the shared storage-accounting invariant; see
 * lib/media/storage-accounting.ts).
 */

import { DeleteObjectsCommand } from "@aws-sdk/client-s3";

/** Minimal structural S3 client (the AWS SDK v3 `send` shape). */
export interface S3Sender {
  send(command: DeleteObjectsCommand): Promise<unknown>;
}

/** S3 DeleteObjects accepts at most 1000 keys per call. */
const MAX_KEYS_PER_BATCH = 1000;
/** Circuit breaker (repo rule: every loop has a max iteration count). */
const MAX_BATCHES = 100;

export interface StagingCleanupResult {
  /** Keys submitted for deletion. */
  requested: number;
  /** Batches that failed (their keys were NOT deleted). */
  failedBatches: number;
  /** True when the circuit breaker truncated the run. */
  truncated: boolean;
}

/**
 * Delete the given object keys in DeleteObjects batches. Defensively refuses
 * `cas/*` keys — byte reclamation for approved content is the GC purge's job,
 * and the staging cleanup must never be able to race it.
 */
export async function deleteStagingObjects(
  s3: S3Sender,
  bucket: string,
  keys: string[],
): Promise<StagingCleanupResult> {
  const safeKeys = keys.filter((k) => !k.startsWith("cas/"));
  let requested = 0;
  let failedBatches = 0;
  let truncated = false;

  for (let i = 0; i < safeKeys.length; i += MAX_KEYS_PER_BATCH) {
    if (i / MAX_KEYS_PER_BATCH >= MAX_BATCHES) {
      truncated = true;
      break;
    }
    const batch = safeKeys.slice(i, i + MAX_KEYS_PER_BATCH);
    try {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        }),
      );
      requested += batch.length;
    } catch {
      failedBatches++;
    }
  }

  return { requested, failedBatches, truncated };
}
