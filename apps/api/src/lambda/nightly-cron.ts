import { DynamoDBClient, PutItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { S3Client, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { marshall } from "@aws-sdk/util-dynamodb";
import { PrismaClient } from "@prisma/client";

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });
const s3 = new S3Client({ region: process.env.AWS_REGION });
const TABLE = process.env.DYNAMODB_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET_NAME!;

let prisma: PrismaClient | null = null;

async function getPrisma(): Promise<PrismaClient> {
  if (prisma) return prisma;
  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN! }));
  const { username, password, host, port, dbname } = JSON.parse(secret.SecretString!);
  prisma = new PrismaClient({
    datasources: { db: { url: `postgresql://${username}:${encodeURIComponent(password)}@${host}:${port}/${dbname}?connection_limit=1` } },
  });
  return prisma;
}

export const handler = async (): Promise<void> => {
  const now = Math.floor(Date.now() / 1000);

  // Acquire cron lock
  try {
    await dynamo.send(new PutItemCommand({
      TableName: TABLE,
      Item: marshall({
        pk: "cron:nightly",
        sk: "lock",
        ttl: now + 3600,
        lockedAt: now,
      }),
      ConditionExpression: "attribute_not_exists(pk) OR #ttl < :now",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: marshall({ ":now": now }),
    }));
  } catch {
    console.log(JSON.stringify({ level: "info", msg: "Nightly cron already running, skipping" }));
    return;
  }

  console.log(JSON.stringify({ level: "info", msg: "Nightly cron started" }));

  const db = await getPrisma();

  // 1. Hard-delete soft-deleted media older than 7 days + remove S3 objects
  try {
    const deletionCutoff = new Date();
    deletionCutoff.setDate(deletionCutoff.getDate() - 7);

    const mediaToDelete = await db.mediaFile.findMany({
      where: { deletedAt: { lte: deletionCutoff } },
      select: { id: true, originalKey: true, thumbnailKey: true, optimizedKey: true },
      take: 200,
    });

    if (mediaToDelete.length > 0) {
      // Delete S3 objects in batch
      const keys = mediaToDelete.flatMap((m) =>
        [m.originalKey, m.thumbnailKey, m.optimizedKey].filter((k): k is string => !!k),
      );

      if (keys.length > 0) {
        // S3 DeleteObjects supports up to 1000 keys per call
        for (let i = 0; i < keys.length; i += 1000) {
          const batch = keys.slice(i, i + 1000);
          try {
            await s3.send(new DeleteObjectsCommand({
              Bucket: MEDIA_BUCKET,
              Delete: { Objects: batch.map((Key) => ({ Key })) },
            }));
          } catch (err) {
            console.error(JSON.stringify({ level: "error", msg: "S3 batch delete failed", error: String(err), batchSize: batch.length }));
          }
        }
      }

      // Hard-delete DB records
      const result = await db.mediaFile.deleteMany({
        where: { id: { in: mediaToDelete.map((m) => m.id) } },
      });
      console.log(JSON.stringify({ level: "info", msg: "Soft-deleted media purged", dbDeleted: result.count, s3Keys: keys.length }));
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Media purge failed", error: String(err) }));
  }

  // 2. Clean up expired invitations
  try {
    const result = await db.invitation.deleteMany({
      where: { expiresAt: { lte: new Date() }, usedAt: null },
    });
    if (result.count > 0) {
      console.log(JSON.stringify({ level: "info", msg: "Expired invitations cleaned", deleted: result.count }));
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Invitation cleanup failed", error: String(err) }));
  }

  // 3. Follower counts removed — relationships now live in graph DB (AuraDB)
  // TODO: Add graph-side consistency check when reconciliation service is wired up

  // 4. Process scheduled account deletions (GDPR Article 17 compliance)
  try {
    const { deleteUserData } = await import("../lib/services/user-data-deletion.js");

    const usersToDelete = await db.user.findMany({
      where: {
        deletionScheduledAt: { lte: new Date() },
        deletionConfirmedAt: { not: null },
      },
      select: { id: true, email: true, deletionRequestedAt: true, deletionConfirmedAt: true },
      take: 50,
    });

    let deletedCount = 0;
    let failedCount = 0;

    for (const user of usersToDelete) {
      try {
        // 4a. Delete all database records
        const result = await deleteUserData(db, user.id);

        // 4b. Delete S3 media files
        try {
          const prefix = `originals/user-${user.id}/`;
          let continuationToken: string | undefined;
          let pages = 0;
          const MAX_PAGES = 100;
          do {
            if (pages >= MAX_PAGES) {
              console.log(JSON.stringify({ level: "warn", msg: "S3 pagination circuit breaker hit", userId: user.id, pages: MAX_PAGES }));
              break;
            }
            const list = await s3.send(new ListObjectsV2Command({
              Bucket: MEDIA_BUCKET, Prefix: prefix, ContinuationToken: continuationToken,
            }));
            if (list.Contents?.length) {
              await s3.send(new DeleteObjectsCommand({
                Bucket: MEDIA_BUCKET,
                Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key! })) },
              }));
            }
            continuationToken = list.NextContinuationToken;
            pages++;
          } while (continuationToken);
        } catch (s3Err) {
          console.error(JSON.stringify({ level: "error", msg: "S3 media deletion failed", userId: user.id, error: String(s3Err) }));
        }

        // 4c. Delete Cognito identity
        if (process.env.COGNITO_USER_POOL_ID) {
          try {
            const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
            await cognito.send(new AdminDeleteUserCommand({
              UserPoolId: process.env.COGNITO_USER_POOL_ID,
              Username: user.email,
            }));
          } catch (cognitoErr) {
            // Log but don't fail — user may already be deleted from Cognito
            console.warn(JSON.stringify({ level: "warn", msg: "Cognito deletion failed", userId: user.id, error: String(cognitoErr) }));
          }
        }

        // 4d. Clean up DynamoDB cache entries
        try {
          await dynamo.send(new DeleteItemCommand({
            TableName: TABLE,
            Key: marshall({ pk: `user:${user.id}`, sk: "profile" }),
          }));
        } catch {
          // Best-effort cleanup
        }

        // 4e. Write audit log entry (compliance proof)
        try {
          await db.deletionAuditLog.create({
            data: {
              userId: user.id,
              email: user.email,
              requestedAt: user.deletionRequestedAt!,
              confirmedAt: user.deletionConfirmedAt,
              itemsDeleted: result as any,
            },
          });
        } catch (auditErr) {
          console.error(JSON.stringify({ level: "error", msg: "Audit log write failed", userId: user.id, error: String(auditErr) }));
        }

        // 4f. Send deletion completion email
        if (process.env.DOMAIN) {
          try {
            const ses = new SESClient({ region: process.env.SES_REGION || process.env.AWS_REGION });
            const domain = process.env.DOMAIN;
            await ses.send(new SendEmailCommand({
              Source: `Trellis <noreply@${domain}>`,
              Destination: { ToAddresses: [user.email] },
              Message: {
                Subject: { Data: "Your Trellis account has been deleted" },
                Body: {
                  Text: { Data: `Your Trellis account and all associated data have been permanently deleted in accordance with your GDPR deletion request.\n\nDeleted: ${result.posts} posts, ${result.comments} comments, ${result.entities} entities.\n\nIf you did not request this deletion, please contact support immediately.` },
                  Html: { Data: `<h2>Account Deletion Complete</h2><p>Your Trellis account and all associated data have been permanently deleted in accordance with your GDPR deletion request.</p><p>Deleted: ${result.posts} posts, ${result.comments} comments, ${result.entities} entities.</p><p>If you did not request this deletion, please contact support immediately.</p>` },
                },
              },
            }));
          } catch (emailErr) {
            console.warn(JSON.stringify({ level: "warn", msg: "Deletion email failed", userId: user.id, error: String(emailErr) }));
          }
        }

        deletedCount++;
        console.log(JSON.stringify({
          level: "info",
          msg: "Account deleted",
          userId: user.id,
          itemsDeleted: result,
        }));
      } catch (err) {
        failedCount++;
        console.error(JSON.stringify({ level: "error", msg: "Account deletion failed", userId: user.id, error: String(err) }));
      }
    }

    // Count pending deletions (for monitoring backlog)
    const pendingCount = await db.user.count({
      where: {
        deletionScheduledAt: { not: null },
        deletionConfirmedAt: { not: null },
      },
    });

    // Emit CloudWatch metrics
    try {
      const cw = new CloudWatchClient({ region: process.env.AWS_REGION });
      const timestamp = new Date();
      await cw.send(new PutMetricDataCommand({
        Namespace: "Trellis/Deletion",
        MetricData: [
          { MetricName: "ProcessedCount", Value: deletedCount, Unit: "Count", Timestamp: timestamp },
          { MetricName: "FailedCount", Value: failedCount, Unit: "Count", Timestamp: timestamp },
          { MetricName: "PendingCount", Value: pendingCount, Unit: "Count", Timestamp: timestamp },
        ],
      }));
    } catch (cwErr) {
      console.error(JSON.stringify({ level: "error", msg: "CloudWatch metrics failed", error: String(cwErr) }));
    }

    if (usersToDelete.length > 0) {
      console.log(JSON.stringify({
        level: "info",
        msg: "Scheduled account deletions processed",
        total: usersToDelete.length,
        deleted: deletedCount,
        failed: failedCount,
        pending: pendingCount,
      }));
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Scheduled deletion processing failed", error: String(err) }));
  }

  // 5. Check age tier transitions (Safer Social Design)
  try {
    const { checkAgeTierTransitions } = await import("../lib/age-tier-transition.js");
    const { buildEnv } = await import("../env.js");
    const appEnv = await buildEnv();
    const result = await checkAgeTierTransitions(appEnv);
    if (result.transitioned > 0 || result.errors > 0) {
      console.log(JSON.stringify({ level: "info", msg: "Age tier transitions processed", transitioned: result.transitioned, errors: result.errors }));
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Age tier transition check failed", error: String(err) }));
  }

  // 6. Generate sentiment digest notifications (Safer Social Design)
  try {
    const { generateSentimentDigest } = await import("../lib/sentiment-digest.js");
    const { NotificationHandler } = await import("../lib/notification-handler.js");
    const { buildEnv } = await import("../env.js");
    const appEnv = await buildEnv();
    const notificationHandler = new NotificationHandler();

    const since = new Date();
    since.setDate(since.getDate() - 1); // Last 24 hours

    // Find users with digest notifications enabled
    const usersWithDigest = await db.user.findMany({
      where: {
        dateOfBirth: { not: null },
        suspended: false,
        personalTenantId: { not: null },
      },
      select: { id: true, ageTier: true, personalTenantId: true },
      take: 500, // Circuit breaker
    });

    let digestCount = 0;
    for (const user of usersWithDigest) {
      if (!user.personalTenantId) continue;
      try {
        const digest = await generateSentimentDigest(user.id, since, appEnv);
        if (digest.posts.length > 0) {
          const sentimentNames = [...new Set(digest.posts.flatMap((p: any) => p.sentiments))];
          const body = sentimentNames.length > 0
            ? `People responded to your posts with ${sentimentNames.slice(0, 3).join(", ")} today`
            : "Your posts received new reactions today";

          await notificationHandler.createNotification(
            user.id,
            "SENTIMENT_DIGEST",
            "Daily Sentiment Summary",
            body,
            { postCount: digest.posts.length },
            appEnv,
            user.personalTenantId,
          );
          digestCount++;
        }
      } catch (digestErr) {
        // Don't fail the whole batch for one user
        console.error(JSON.stringify({ level: "error", msg: "Digest generation failed for user", userId: user.id, error: String(digestErr) }));
      }
    }

    if (digestCount > 0) {
      console.log(JSON.stringify({ level: "info", msg: "Sentiment digest notifications created", count: digestCount }));
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Sentiment digest delivery failed", error: String(err) }));
  }

  console.log(JSON.stringify({ level: "info", msg: "Nightly cron complete" }));
};
