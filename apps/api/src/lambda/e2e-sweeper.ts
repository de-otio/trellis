/**
 * Thin AWS entrypoint for the E2E test-data sweeper (WS-2 T4).
 *
 * EventBridge `rate(1 hour)`. The work lives in `lib/workers/e2e-sweeper.ts`;
 * this entrypoint wires the AWS concretes: the Cognito-backed identity
 * directory (ListUsers filter `email ^= "__e2e_"` + AdminDeleteUser), the
 * raw SQS producer to the delete-account queue, the `cron`-namespace
 * DynamoKvStore CronLock, and the EMF MetricsPort (Trellis/E2E, Stage
 * dimension).
 */

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics } from "@aws-lambda-powertools/metrics";
import { getKvStore } from "../lib/kv/kv-provider.js";
import { getLogger } from "../lib/logger.js";
import { makeKvCronLock } from "../lib/workers/cron-lock.js";
import {
  runE2eSweeper,
  type E2eIdentityDirectoryPort,
} from "../lib/workers/e2e-sweeper.js";
import { makeEmfMetricsPort } from "./emf-metrics-adapter.js";

const logger = new Logger({ serviceName: "e2e-sweeper" });
const metrics = new Metrics({ namespace: "Trellis/E2E", serviceName: "e2e-sweeper" });

const region = process.env.AWS_REGION || "eu-central-1";
const stage = process.env.STAGE || "dev";
const userPoolId = process.env.COGNITO_USER_POOL_ID!;
const deleteQueueUrl = process.env.DELETE_ACCOUNT_QUEUE_URL!;

const cognito = new CognitoIdentityProviderClient({ region });
const sqs = new SQSClient({ region });

const directory: E2eIdentityDirectoryPort = {
  async listUsersByEmailPrefix({ prefix, limit, paginationToken }) {
    const res = await cognito.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        Filter: `email ^= "${prefix}"`,
        Limit: limit,
        PaginationToken: paginationToken,
      }),
    );
    return {
      users: (res.Users || []).map((u) => ({
        username: u.Username,
        email: u.Attributes?.find((a) => a.Name === "email")?.Value,
        sub: u.Attributes?.find((a) => a.Name === "sub")?.Value,
        createdAt: u.UserCreateDate,
      })),
      paginationToken: res.PaginationToken,
    };
  },
  async deleteUserByUsername(username) {
    await cognito.send(
      new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }),
    );
  },
};

export const handler = async (): Promise<void> => {
  try {
    await runE2eSweeper({
      logger: getLogger(),
      metrics: makeEmfMetricsPort(metrics),
      cronLock: makeKvCronLock(getKvStore("cron")),
      clock: Date.now,
      directory,
      deleteAccountQueue: {
        send: async (message) => {
          await sqs.send(
            new SendMessageCommand({
              QueueUrl: deleteQueueUrl,
              MessageBody: JSON.stringify(message),
            }),
          );
        },
      },
      stage,
    });
  } catch (err) {
    logger.error("E2E sweeper failed", { error: err });
    throw err;
  }
};
