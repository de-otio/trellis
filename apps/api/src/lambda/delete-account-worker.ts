import type { SQSHandler } from "aws-lambda";
import { PrismaClient } from "@prisma/client";
import { S3Client, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { Logger } from "@aws-lambda-powertools/logger";
import { getSecret } from "@aws-lambda-powertools/parameters/secrets";

const logger = new Logger({ serviceName: "delete-account-worker" });

const s3 = new S3Client({ region: process.env.AWS_REGION });

const MAX_PAGES = 100;

let prisma: PrismaClient | null = null;

async function getPrisma(): Promise<PrismaClient> {
  if (prisma) return prisma;
  const { username, password, host, port, dbname } = (await getSecret(process.env.DB_SECRET_ARN!, { transform: "json" })) as unknown as { username: string; password: string; host: string; port: string | number; dbname: string };
  prisma = new PrismaClient({
    datasources: { db: { url: `postgresql://${username}:${encodeURIComponent(password)}@${host}:${port}/${dbname}?connection_limit=1` } },
  });
  return prisma;
}

async function deleteUserMedia(userId: string, mediaBucket: string): Promise<void> {
  const prefix = `originals/user-${userId}/`;
  let continuationToken: string | undefined;
  let pages = 0;
  do {
    if (pages >= MAX_PAGES) {
      logger.warn("S3 pagination circuit breaker hit", { userId, pages: MAX_PAGES });
      break;
    }
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: mediaBucket, Prefix: prefix, ContinuationToken: continuationToken,
    }));
    if (list.Contents?.length) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: mediaBucket,
        Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key! })) },
      }));
    }
    continuationToken = list.NextContinuationToken;
    pages++;
  } while (continuationToken);
}

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

      // 2. Delete all database records
      const { deleteUserData } = await import("../lib/services/user-data-deletion.js");
      const result = await deleteUserData(db, userId);

      // 3. Delete S3 media files
      await deleteUserMedia(userId, process.env.MEDIA_BUCKET_NAME!);

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

      logger.info("Account deleted", { userId, itemsDeleted: result });
    } catch (err) {
      logger.error("Failed to delete account", { error: err, messageId: record.messageId });
      failedIds.push(record.messageId);
    }
  }

  if (failedIds.length > 0) {
    return { batchItemFailures: failedIds.map((id) => ({ itemIdentifier: id })) };
  }
};
