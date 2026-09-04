/**
 * Thin AWS entrypoint for the followers-events queue (WS-2 T5).
 *
 * The fail-closed contract lives in `lib/workers/followers-events.ts`: the
 * core throws on any payload, so the WHOLE BATCH returns to the queue
 * (nothing acked), retries, and dead-letters onto the DLQ.
 */

import type { SQSHandler } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { getLogger } from "../lib/logger.js";
import { runFollowersEvents } from "../lib/workers/followers-events.js";

const logger = new Logger({ serviceName: "followers-events-worker" });

export const handler: SQSHandler = async (event) => {
  logger.error(
    "followers-events-worker is not implemented — failing closed; batch will retry and dead-letter",
    { messageIds: event.Records.map((r) => r.messageId) },
  );
  await runFollowersEvents(event.Records, { logger: getLogger() });
};
