/**
 * Media Reconciliation Queue Consumer
 *
 * Processes media reconciliation messages from the queue
 */

import type { MessageBatch } from "../../types/cloudflare-compat.js";
import { getLogger, Logger } from "../logger.js";
import { MediaReconciliationService } from "../services/media-reconciliation-service.js";
import type { MediaReconciliationMessage } from "../types/media-reconciliation.js";

export async function handleMediaReconciliation(
  batch: MessageBatch<MediaReconciliationMessage>,
  env: any,
): Promise<void> {
  const logger = getLogger();

  logger.info("[MediaReconciliationConsumer] Processing batch", {
    batchSize: batch.messages.length,
  });

  const service = new MediaReconciliationService(env);

  try {
    // Process all messages in batch
    const messages = batch.messages.map((m) => m.body);
    await service.reconcileBatch(messages);

    // Ack all messages
    batch.ackAll();

    logger.info("[MediaReconciliationConsumer] Batch completed", {
      batchSize: batch.messages.length,
    });
  } catch (error: any) {
    logger.error("[MediaReconciliationConsumer] Batch failed", {
      error: error.message,
      stack: error.stack,
      batchSize: batch.messages.length,
    });

    // Retry all messages (will go to DLQ after max retries)
    batch.retryAll();
  }
}
