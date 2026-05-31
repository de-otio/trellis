/**
 * E2E Test Data Sweeper (User-Scoped)
 *
 * Safety net for leaked test data. Runs hourly.
 *
 * Instead of querying the database directly, this sweeper:
 * 1. Lists Cognito users with __e2e_ email prefix older than 2 hours
 * 2. Queues their deletion via the delete-account SQS queue
 *    (same pipeline used by GDPR account deletions)
 * 3. Deletes the Cognito user
 *
 * The delete-account-worker handles the actual cleanup:
 * DB cascade (deleteUserData) → S3 media → Cognito identity
 *
 * This approach eliminates the risk of a WHERE clause bug deleting real user data.
 */

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION || "eu-central-1";
const stage = process.env.STAGE || "dev";
const userPoolId = process.env.COGNITO_USER_POOL_ID!;
const deleteQueueUrl = process.env.DELETE_ACCOUNT_QUEUE_URL!;
const dynamoTable = process.env.DYNAMODB_TABLE!;

const cognito = new CognitoIdentityProviderClient({ region });
const sqs = new SQSClient({ region });
const cloudwatch = new CloudWatchClient({ region });
const dynamo = new DynamoDBClient({ region });

const STALE_THRESHOLD_HOURS = 2;
const E2E_PREFIX = "__e2e_";
const MAX_PAGES = 20;

export const handler = async (): Promise<void> => {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_HOURS * 60 * 60 * 1000);
  const now = Math.floor(Date.now() / 1000);

  // Acquire distributed lock
  try {
    await dynamo.send(new PutItemCommand({
      TableName: dynamoTable,
      Item: marshall({ pk: "cron:e2e-sweeper", sk: "lock", ttl: now + 300, lockedAt: now }),
      ConditionExpression: "attribute_not_exists(pk) OR #ttl < :now",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: marshall({ ":now": now }),
    }));
  } catch {
    console.log(JSON.stringify({ level: "info", msg: "E2E sweeper already running, skipping" }));
    return;
  }

  console.log(JSON.stringify({ level: "info", msg: "E2E sweeper started", cutoff: cutoff.toISOString() }));

  let totalQueued = 0;

  // Step 1: List stale __e2e_ Cognito users
  try {
    let paginationToken: string | undefined;
    let pages = 0;

    do {
      const res = await cognito.send(new ListUsersCommand({
        UserPoolId: userPoolId,
        Filter: `email ^= "${E2E_PREFIX}"`,
        Limit: 60,
        PaginationToken: paginationToken,
      }));

      for (const user of res.Users || []) {
        if (!user.UserCreateDate || user.UserCreateDate >= cutoff) continue;
        if (!user.Username) continue;

        const email = user.Attributes?.find(a => a.Name === "email")?.Value || user.Username;
        const sub = user.Attributes?.find(a => a.Name === "sub")?.Value;

        // Step 2: Queue database + S3 deletion via delete-account worker
        if (sub) {
          try {
            await sqs.send(new SendMessageCommand({
              QueueUrl: deleteQueueUrl,
              MessageBody: JSON.stringify({ userId: sub }),
            }));
            totalQueued++;
            console.log(JSON.stringify({ level: "info", msg: `Queued deletion for ${email}`, userId: sub }));
          } catch (err) {
            console.warn(JSON.stringify({ level: "warn", msg: `Failed to queue deletion for ${email}`, error: String(err) }));
          }
        }

        // Step 3: Delete Cognito user immediately
        // (worker also tries Cognito deletion, but we do it here too
        //  since the worker may process the message after a delay)
        try {
          await cognito.send(new AdminDeleteUserCommand({
            UserPoolId: userPoolId,
            Username: user.Username,
          }));
          console.log(JSON.stringify({ level: "info", msg: `Deleted Cognito user ${email}` }));
        } catch (err) {
          console.warn(JSON.stringify({ level: "warn", msg: `Cognito delete failed for ${email}`, error: String(err) }));
        }
      }

      paginationToken = res.PaginationToken;
      pages++;
    } while (paginationToken && pages < MAX_PAGES);

  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Failed to list Cognito users", error: String(err) }));
  }

  // Step 4: Emit metric
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: "Trellis/E2E",
      MetricData: [{
        MetricName: "E2eLeakedRecords",
        Value: totalQueued,
        Unit: "Count",
        Dimensions: [{ Name: "Stage", Value: stage }],
      }],
    }));
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Failed to emit metric", error: String(err) }));
  }

  console.log(JSON.stringify({ level: "info", msg: "E2E sweeper complete", totalQueued }));
};
