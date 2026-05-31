import type { SQSHandler } from "aws-lambda";

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    console.log(JSON.stringify({ level: "info", msg: "Processing record", messageId: record.messageId }));
    // TODO: implement
  }
};
