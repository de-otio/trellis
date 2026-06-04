import { DynamoDBClient, DeleteItemCommand, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "cleanup-cron" });

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE = process.env.DYNAMODB_TABLE!;

export const handler = async (): Promise<void> => {
  const now = Math.floor(Date.now() / 1000);

  // DynamoDB TTL handles most cleanup automatically.
  // This cron handles cleanup that TTL alone can't do.

  // Acquire cron lock (prevent overlapping executions)
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: marshall({
          pk: "cron:cleanup",
          sk: "lock",
          ttl: now + 300, // 5 min TTL
          lockedAt: now,
        }),
        ConditionExpression: "attribute_not_exists(pk) OR #ttl < :now",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: marshall({ ":now": now }),
      }),
    );
  } catch {
    logger.info("Cleanup cron already running, skipping");
    return;
  }

  logger.info("Cleanup cron started");
  // Additional cleanup logic goes here
  logger.info("Cleanup cron complete");
};
