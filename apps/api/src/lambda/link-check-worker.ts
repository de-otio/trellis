import type { SQSHandler } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "link-check-worker" });

/**
 * Link-check (link threat-intel) worker — NOT YET IMPLEMENTED.
 *
 * This queue is a LIVE SECURITY CONTROL: post/comment creation enqueues
 * async link checks here (post-handler / comment-handler /
 * link-security-handler), and the deployment wires the threat-intel API key
 * for this worker. Until the actual check is implemented, this handler
 * FAILS CLOSED: it throws, so the batch returns to the queue, is retried,
 * and dead-letters onto the DLQ where the DLQ alarm pages — instead of
 * silently acking (deleting) security work, which is what this stub used
 * to do.
 *
 * Do NOT replace the throw with a silent return; implementing the real
 * link check is the only valid way to make this handler succeed.
 */
export const handler: SQSHandler = async (event) => {
  logger.error(
    "link-check-worker is not implemented — failing closed; batch will retry and dead-letter",
    { messageIds: event.Records.map((r) => r.messageId) },
  );
  throw new Error(
    "link-check-worker: not implemented — failing closed so link-security checks are not silently dropped",
  );
};
