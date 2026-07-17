import { DynamoDBClient, PutItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { marshall } from "@aws-sdk/util-dynamodb";
import { PrismaClient } from "@prisma/client";
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { getLambdaPrisma as getPrisma } from "../lib/lambda-prisma.js";

const logger = new Logger({ serviceName: "nightly-cron" });
const metrics = new Metrics({ namespace: "Trellis/Deletion", serviceName: "nightly-cron" });

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const s3 = new S3Client({ region: process.env.AWS_REGION });
const TABLE = process.env.DYNAMODB_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET_NAME!;

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
    logger.info("Nightly cron already running, skipping");
    return;
  }

  logger.info("Nightly cron started");

  const db = await getPrisma();

  // 1. Hard-delete soft-deleted media older than 7 days + remove S3 objects
  try {
    const deletionCutoff = new Date();
    deletionCutoff.setDate(deletionCutoff.getDate() - 7);

    // Evidence-hold guard (compliance plan 08 §2.3 item 5): never hard-delete an
    // original that is under a live evidence/legal hold — the case is open. The
    // exempt predicate is the single source of truth in restrict-content.ts.
    const { evidenceHoldExemptWhere } = await import(
      "../lib/compliance/restrict-content.js"
    );
    const mediaToDelete = await db.mediaFile.findMany({
      where: { deletedAt: { lte: deletionCutoff }, ...evidenceHoldExemptWhere() },
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
            logger.error("S3 batch delete failed", { error: err, batchSize: batch.length });
          }
        }
      }

      // Hard-delete DB records
      const result = await db.mediaFile.deleteMany({
        where: { id: { in: mediaToDelete.map((m) => m.id) } },
      });
      logger.info("Soft-deleted media purged", { dbDeleted: result.count, s3Keys: keys.length });
    }
  } catch (err) {
    logger.error("Media purge failed", { error: err });
  }

  // 2. Clean up expired invitations
  try {
    const result = await db.invitation.deleteMany({
      where: { expiresAt: { lte: new Date() }, usedAt: null },
    });
    if (result.count > 0) {
      logger.info("Expired invitations cleaned", { deleted: result.count });
    }
  } catch (err) {
    logger.error("Invitation cleanup failed", { error: err });
  }

  // 3. Follower counts removed — relationships now live in graph edge tables (see graph-service.ts)

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
        // 4a. Delete all database records. Media erasure happens inside
        //     deleteUserData (AR7 / GDPR Art. 17): the user's MediaFile rows
        //     are soft-deleted into step 1's soft-deleted-media purge, which
        //     reclaims their CAS bytes (`cas/{tenantId}/{contentHash}`) within
        //     its bounded window. The old 4b here enumerated the obsolete
        //     `originals/user-{id}/` prefix and therefore deleted zero bytes.
        const result = await deleteUserData(db, user.id);

        // 4b. Delete the user-scoped STAGING objects (`pending/…`,
        //     `processing/…`) reported by the erasure — step 1's purge does
        //     not cover staging keys. Never touches `cas/*`.
        try {
          const { deleteStagingObjects } = await import("../lib/media/staging-object-cleanup.js");
          const staging = await deleteStagingObjects(s3, MEDIA_BUCKET, result.mediaStagingKeys);
          if (staging.failedBatches > 0 || staging.truncated) {
            logger.warn("Staging object cleanup incomplete", { userId: user.id, ...staging });
          }
        } catch (s3Err) {
          logger.error("S3 staging deletion failed", { userId: user.id, error: s3Err });
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
            logger.warn("Cognito deletion failed", { userId: user.id, error: cognitoErr });
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
              // Audit rows carry counts, not raw storage keys.
              itemsDeleted: { ...result, mediaStagingKeys: result.mediaStagingKeys.length } as any,
            },
          });
        } catch (auditErr) {
          logger.error("Audit log write failed", { userId: user.id, error: auditErr });
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
            logger.warn("Deletion email failed", { userId: user.id, error: emailErr });
          }
        }

        deletedCount++;
        logger.info("Account deleted", {
          userId: user.id,
          itemsDeleted: { ...result, mediaStagingKeys: result.mediaStagingKeys.length },
        });
      } catch (err) {
        failedCount++;
        logger.error("Account deletion failed", { userId: user.id, error: err });
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
      metrics.addMetric("ProcessedCount", MetricUnit.Count, deletedCount);
      metrics.addMetric("FailedCount", MetricUnit.Count, failedCount);
      metrics.addMetric("PendingCount", MetricUnit.Count, pendingCount);
      metrics.publishStoredMetrics();
    } catch (cwErr) {
      logger.error("CloudWatch metrics failed", { error: cwErr });
    }

    if (usersToDelete.length > 0) {
      logger.info("Scheduled account deletions processed", {
        total: usersToDelete.length,
        deleted: deletedCount,
        failed: failedCount,
        pending: pendingCount,
      });
    }
  } catch (err) {
    logger.error("Scheduled deletion processing failed", { error: err });
  }

  // 5. Check age tier transitions (Safer Social Design)
  try {
    const { checkAgeTierTransitions } = await import("../lib/age-tier-transition.js");
    const { buildEnv } = await import("../env.js");
    const appEnv = await buildEnv();
    const result = await checkAgeTierTransitions(appEnv);
    if (result.transitioned > 0 || result.errors > 0) {
      logger.info("Age tier transitions processed", { transitioned: result.transitioned, errors: result.errors });
    }
  } catch (err) {
    logger.error("Age tier transition check failed", { error: err });
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
        logger.error("Digest generation failed for user", { userId: user.id, error: digestErr });
      }
    }

    if (digestCount > 0) {
      logger.info("Sentiment digest notifications created", { count: digestCount });
    }
  } catch (err) {
    logger.error("Sentiment digest delivery failed", { error: err });
  }

  logger.info("Nightly cron complete");
};
