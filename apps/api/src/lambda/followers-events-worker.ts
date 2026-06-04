import type { SQSHandler } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "followers-events-worker" });

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    logger.info("Processing record", { messageId: record.messageId });
    // TODO: implement
  }
};
