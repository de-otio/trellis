/**
 * Thin AWS entrypoint for the link-check queue (WS-2 T5).
 *
 * The fail-closed contract lives in `lib/workers/link-check.ts`: the core
 * throws on any payload, so the WHOLE BATCH returns to the queue (nothing
 * acked), retries, and dead-letters onto the DLQ where the alarm pages.
 * There is deliberately no `batchItemFailures` array here — "throw →
 * nothing acked" IS the contract for this live security control.
 */

import type { SQSHandler } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { getLogger } from "../lib/logger.js";
import { runLinkCheck } from "../lib/workers/link-check.js";

const logger = new Logger({ serviceName: "link-check-worker" });

export const handler: SQSHandler = async (event) => {
  logger.error(
    "link-check-worker is not implemented — failing closed; batch will retry and dead-letter",
    { messageIds: event.Records.map((r) => r.messageId) },
  );
  await runLinkCheck(event.Records, { logger: getLogger() });
};
