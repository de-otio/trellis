/**
 * Thin AWS entrypoint for the nightly cron (WS-2 T3b).
 *
 * EventBridge `cron(2:00 daily)`. The work lives in
 * `lib/workers/nightly-cron.ts`; this entrypoint wires the AWS concretes:
 * Prisma via `getLambdaPrisma`, the `cron`-namespace `DynamoKvStore`
 * CronLock, S3 batch deletion + staging cleanup, Cognito identity deletion,
 * the DynamoDB profile-cache cleanup, SES completion email (gated on
 * `DOMAIN`, exactly as before), the EMF MetricsPort (Trellis/Deletion), and
 * the `buildEnv()` self-call for the age-tier/digest steps.
 */

import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics } from "@aws-lambda-powertools/metrics";
import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { marshall } from "@aws-sdk/util-dynamodb";
import { getLambdaPrisma as getPrisma } from "../lib/lambda-prisma.js";
import { getKvStore } from "../lib/kv/kv-provider.js";
import { getLogger } from "../lib/logger.js";
import { makeKvCronLock } from "../lib/workers/cron-lock.js";
import {
  runNightlyCron,
  type DeletionEmailPort,
} from "../lib/workers/nightly-cron.js";
import type { IdentityAdminPort } from "../lib/workers/identity-admin-port.js";
import { makeEmfMetricsPort } from "./emf-metrics-adapter.js";

const logger = new Logger({ serviceName: "nightly-cron" });
const metrics = new Metrics({ namespace: "Trellis/Deletion", serviceName: "nightly-cron" });

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const s3 = new S3Client({ region: process.env.AWS_REGION });
const TABLE = process.env.DYNAMODB_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET_NAME!;

function makeCognitoIdentityPort(): IdentityAdminPort | undefined {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (!userPoolId) return undefined;
  return {
    async deleteUser({ email }) {
      const cognito = new CognitoIdentityProviderClient({
        region: process.env.AWS_REGION,
      });
      await cognito.send(
        new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }),
      );
    },
  };
}

function makeSesEmailPort(): DeletionEmailPort | undefined {
  const domain = process.env.DOMAIN;
  if (!domain) return undefined;
  return {
    async sendAccountDeleted({ to, subject, textBody, htmlBody }) {
      const ses = new SESClient({
        region: process.env.SES_REGION || process.env.AWS_REGION,
      });
      await ses.send(
        new SendEmailCommand({
          Source: `Trellis <noreply@${domain}>`,
          Destination: { ToAddresses: [to] },
          Message: {
            Subject: { Data: subject },
            Body: { Text: { Data: textBody }, Html: { Data: htmlBody } },
          },
        }),
      );
    },
  };
}

export const handler = async (): Promise<void> => {
  try {
    await runNightlyCron({
      getDb: () => getPrisma(),
      logger: getLogger(),
      metrics: makeEmfMetricsPort(metrics),
      cronLock: makeKvCronLock(getKvStore("cron")),
      clock: Date.now,
      identity: makeCognitoIdentityPort(),
      email: makeSesEmailPort(),
      resolvePseudonymSecret: async () => {
        const { resolvePseudonymSecret } = await import(
          "../lib/services/user-data-deletion.js"
        );
        return resolvePseudonymSecret();
      },
      deleteStagingObjects: async (keys) => {
        const { deleteStagingObjects } = await import(
          "../lib/media/staging-object-cleanup.js"
        );
        return deleteStagingObjects(s3, MEDIA_BUCKET, keys);
      },
      objectStore: {
        deleteObjects: async (keys) => {
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: MEDIA_BUCKET,
              Delete: { Objects: keys.map((Key) => ({ Key })) },
            }),
          );
        },
      },
      userCacheCleanup: async (userId) => {
        await dynamo.send(
          new DeleteItemCommand({
            TableName: TABLE,
            Key: marshall({ pk: `user:${userId}`, sk: "profile" }),
          }),
        );
      },
      getAppEnv: async () => {
        const { buildEnv } = await import("../env.js");
        return buildEnv();
      },
    });
  } catch (err) {
    logger.error("Nightly cron failed", { error: err });
    throw err;
  }
};
