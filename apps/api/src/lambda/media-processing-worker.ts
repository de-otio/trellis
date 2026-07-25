// media-processing-worker.ts — thin AWS entrypoint (WS-2 T6).
//
// The orchestration shell moved to `lib/workers/media-processing.ts`; this
// file re-exports its full public surface (so every existing deep import —
// including the consuming app's `setMediaProcessingDeps` cold-start wiring —
// keeps resolving to the SAME module state) and keeps only the AWS concerns:
// the `SQSHandler` shape, the batch loop with `reportBatchItemFailures`
// semantics, and the powertools logger.

import type { SQSHandler, SQSBatchResponse } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  getInjectedMediaProcessingDeps,
  processRecord,
  type RecordOutcome,
} from "../lib/workers/media-processing.js";

export {
  parsePendingKey,
  extractObjectKeys,
  processObjectKey,
  processRecord,
  setMediaProcessingDeps,
  __resetMediaProcessingDeps,
  getInjectedMediaProcessingDeps,
} from "../lib/workers/media-processing.js";
export type {
  MediaFileRow,
  ThresholdSnapshot,
  MediaPersistencePort,
  MediaProcessingConfig,
  MediaProcessingDeps,
  MediaWorkerLogger,
  QueueRecordLike,
  RecordOutcome,
} from "../lib/workers/media-processing.js";

const logger = new Logger({ serviceName: "media-processing-worker" });

/**
 * The SQS entry point. Preserves `reportBatchItemFailures` semantics: only the
 * messageIds whose records produced a retryable fault are returned as batch
 * item failures; everything else (success / drop / poison→REVIEW) is acked by
 * omission.
 *
 * If no concrete deps were injected, the handler fails CLOSED: it throws, so the
 * whole batch is retried rather than silently dropped. An un-wired worker must
 * never ack-drop real uploads.
 */
export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const deps = getInjectedMediaProcessingDeps();
  if (deps === undefined) {
    // Fail closed: no backend wired ⇒ retry the batch, never drop. The
    // consuming app must call setMediaProcessingDeps() at startup.
    logger.error(
      "media-processing-worker invoked with no injected deps — refusing to" +
        " process. Call setMediaProcessingDeps() at cold start.",
    );
    throw new Error("media-processing-worker: deps not injected");
  }

  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    let outcome: RecordOutcome;
    try {
      outcome = await processRecord(record, deps);
    } catch (err) {
      // Defensive: processRecord is designed not to throw, but if it does, treat
      // it as retryable (fail closed for retry; DLQ + alert is the backstop).
      logger.error("Unexpected throw from processRecord — retrying record", {
        messageId: record.messageId,
        error: err,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    if (outcome.disposition === "fail") {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
