import type { SQSHandler } from "aws-lambda";
import { PrismaClient } from "@prisma/client";
import { S3Client } from "@aws-sdk/client-s3";
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { Logger } from "@aws-lambda-powertools/logger";
import { getLambdaPrisma as getPrisma } from "../lib/lambda-prisma.js";

const logger = new Logger({ serviceName: "delete-account-worker" });

const s3 = new S3Client({ region: process.env.AWS_REGION });

export const handler: SQSHandler = async (event) => {
  const failedIds: string[] = [];
  const db = await getPrisma();

  for (const record of event.Records) {
    try {
      const { userId } = JSON.parse(record.body) as { userId: string };

      // 1. Look up user email before deleting DB records (needed for Cognito)
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });

      if (!user) {
        logger.warn("User not found, may already be deleted", { userId });
        continue;
      }

      // 2. Delete all database records. Media erasure happens inside
      //    deleteUserData (AR7 / GDPR Art. 17): the user's MediaFile rows are
      //    soft-deleted into the nightly GC purge, which reclaims their CAS
      //    bytes (`cas/{tenantId}/{contentHash}`) within its bounded window.
      //    The old code here enumerated `originals/user-{id}/` — a prefix that
      //    does not exist under the CAS key scheme, so it deleted zero bytes.
      const { deleteUserData } = await import("../lib/services/user-data-deletion.js");
      const result = await deleteUserData(db, userId);

      // 3. Delete the user-scoped STAGING objects (`pending/…`,
      //    `processing/…`) reported by the erasure — the GC purge does not
      //    cover staging keys. Never touches `cas/*`.
      const { deleteStagingObjects } = await import("../lib/media/staging-object-cleanup.js");
      const staging = await deleteStagingObjects(
        s3,
        process.env.MEDIA_BUCKET_NAME!,
        result.mediaStagingKeys,
      );
      if (staging.failedBatches > 0 || staging.truncated) {
        logger.warn("Staging object cleanup incomplete", { userId, ...staging });
      }

      // 4. Delete Cognito identity
      if (process.env.COGNITO_USER_POOL_ID) {
        try {
          const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
          await cognito.send(new AdminDeleteUserCommand({
            UserPoolId: process.env.COGNITO_USER_POOL_ID,
            Username: user.email,
          }));
        } catch (cognitoErr) {
          logger.warn("Cognito deletion failed", { userId, error: cognitoErr });
        }
      }

      logger.info("Account deleted", {
        userId,
        itemsDeleted: { ...result, mediaStagingKeys: result.mediaStagingKeys.length },
      });
    } catch (err) {
      logger.error("Failed to delete account", { error: err, messageId: record.messageId });
      failedIds.push(record.messageId);
    }
  }

  if (failedIds.length > 0) {
    return { batchItemFailures: failedIds.map((id) => ({ itemIdentifier: id })) };
  }
};
