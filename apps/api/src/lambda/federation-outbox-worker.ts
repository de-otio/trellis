/**
 * Thin AWS entrypoint for the federation-outbox queue (WS-2 T5).
 *
 * Two-mode contract in `lib/workers/federation-outbox.ts`: feature OFF
 * (`ACTIVITYPUB_ENABLED !== "true"`, the default) → log-and-return (ack);
 * feature ON → fail-closed throw (whole batch redelivers → DLQ → page).
 * The entrypoint resolves the env flag; the core never reads process.env.
 */

import type { SQSHandler } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { getLogger } from "../lib/logger.js";
import { runFederationOutbox } from "../lib/workers/federation-outbox.js";

const logger = new Logger({ serviceName: "federation-outbox-worker" });

export const handler: SQSHandler = async (event) => {
  const messageIds = event.Records.map((r) => r.messageId);
  logger.info("federation-outbox-worker invoked", { messageIds });

  await runFederationOutbox(event.Records, {
    logger: getLogger(),
    federationEnabled: process.env.ACTIVITYPUB_ENABLED === "true",
  });
};
