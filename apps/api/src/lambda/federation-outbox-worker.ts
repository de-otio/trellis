import type { SQSHandler } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "federation-outbox-worker" });

/**
 * Federation-outbox (ActivityPub outbound delivery) worker — NOT YET
 * IMPLEMENTED, and the federation feature is disabled by default
 * (fail-closed: only ACTIVITYPUB_ENABLED === "true" enables it; the
 * deployment gates the queue + this worker behind the same feature flag
 * and sets ACTIVITYPUB_ENABLED on this function only when the feature is
 * on).
 *
 * - Feature OFF (default): stay INERT. This worker should not be consuming
 *   at all — nothing enqueues outbound deliveries while federation is
 *   disabled, so any message that does arrive is spurious. Dropping it
 *   loses nothing (there is no outbound delivery to perform with
 *   federation off), and throwing would page for a feature that is off.
 *   A warning is logged so a misconfigured producer is still visible.
 *
 * - Feature ON: FAIL CLOSED like the other un-implemented workers — throw,
 *   so the batch retries and dead-letters onto the DLQ where the DLQ alarm
 *   pages, instead of silently acking outbound federation deliveries.
 */
export const handler: SQSHandler = async (event) => {
  const messageIds = event.Records.map((r) => r.messageId);

  if (process.env.ACTIVITYPUB_ENABLED !== "true") {
    logger.warn(
      "federation-outbox-worker invoked while federation is disabled (ACTIVITYPUB_ENABLED != 'true') — dropping; nothing should be enqueueing to this queue",
      { messageIds },
    );
    return;
  }

  logger.error(
    "federation-outbox-worker is not implemented — failing closed; batch will retry and dead-letter",
    { messageIds },
  );
  throw new Error(
    "federation-outbox-worker: not implemented — failing closed so outbound federation deliveries are not silently dropped",
  );
};
