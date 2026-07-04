import type { SQSHandler } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "followers-events-worker" });

/**
 * Followers-events worker — NOT YET IMPLEMENTED.
 *
 * Nothing currently enqueues to this queue (the FOLLOWERS_EVENTS_QUEUE env
 * binding exists but has no producer), so this handler should never run.
 * If a producer is added before the worker is implemented, this handler
 * FAILS CLOSED: it throws, so the batch returns to the queue, is retried,
 * and dead-letters onto the DLQ where the DLQ alarm pages — instead of
 * silently acking follower events, which is what this stub used to do.
 *
 * Do NOT replace the throw with a silent return.
 */
export const handler: SQSHandler = async (event) => {
  logger.error(
    "followers-events-worker is not implemented — failing closed; batch will retry and dead-letter",
    { messageIds: event.Records.map((r) => r.messageId) },
  );
  throw new Error(
    "followers-events-worker: not implemented — failing closed so follower events are not silently dropped",
  );
};
