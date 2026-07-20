/**
 * Thin AWS entrypoint for the delete-account queue (WS-2 T1).
 *
 * Owns the AWS concerns only: the SQS event shape, the per-record loop with
 * partial-batch semantics (`batchItemFailures`), and the AWS-concrete port
 * wiring (S3 staging cleanup, Cognito identity deletion, env-based pseudonym
 * secret resolution). The work itself lives in
 * `lib/workers/delete-account.ts` (`runDeleteAccount`), which is also hosted
 * by the provider-neutral worker container.
 *
 * Powertools stays HERE (entry/exit/batch outcome on the AWS-only path, per
 * §5.1); the core logs through the neutral `lib/logger.ts`.
 */

import type { SQSHandler } from "aws-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { Logger } from "@aws-lambda-powertools/logger";
import { getLambdaPrisma as getPrisma } from "../lib/lambda-prisma.js";
import { getLogger } from "../lib/logger.js";
import {
  runDeleteAccount,
  type DeleteAccountContext,
} from "../lib/workers/delete-account.js";
import { makeIdentityAdminPort } from "../lib/identity/identity-provider.js";

const logger = new Logger({ serviceName: "delete-account-worker" });

const s3 = new S3Client({ region: process.env.AWS_REGION });

async function buildContext(): Promise<DeleteAccountContext> {
  const db = await getPrisma();
  return {
    db,
    logger: getLogger(),
    // WS-3.3: the shared IdentityProviderPort (X6 absorbed) — byte-identical
    // AdminDeleteUser on the default cognito provider.
    identity: makeIdentityAdminPort(),
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
      return deleteStagingObjects(s3, process.env.MEDIA_BUCKET_NAME!, keys);
    },
  };
}

export const handler: SQSHandler = async (event) => {
  const failedIds: string[] = [];
  const ctx = await buildContext();

  for (const record of event.Records) {
    try {
      const payload = JSON.parse(record.body) as { userId: string };
      await runDeleteAccount(payload, ctx);
    } catch (err) {
      logger.error("Failed to delete account", { error: err, messageId: record.messageId });
      failedIds.push(record.messageId);
    }
  }

  if (failedIds.length > 0) {
    return { batchItemFailures: failedIds.map((id) => ({ itemIdentifier: id })) };
  }
};
