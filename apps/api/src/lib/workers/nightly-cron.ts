/**
 * nightly cron core (WS-2 T3b), extracted from `lambda/nightly-cron.ts` —
 * the heaviest cron. Steps (each fail-open with its own try/catch, exactly
 * as the Lambda handler was):
 *
 *  1. Hard-delete soft-deleted media older than 7 days + batch-remove their
 *     object-storage keys (the GC purge that reclaims CAS bytes).
 *  2. Clean up expired invitations.
 *  4. Process scheduled account deletions (GDPR Art. 17): `deleteUserData`
 *     (with the FAIL-CLOSED pseudonym tombstone key, findings 2+7), staging
 *     cleanup, best-effort external-identity deletion + profile-cache
 *     cleanup, audit row, completion email, deletion metrics.
 *  5. Age-tier transitions (Safer Social Design).
 *  6. Sentiment-digest notifications.
 *
 * All I/O via injected ports; metrics via MetricsPort (one empty-dims
 * grouped emit = the old addMetric×3 + publishStoredMetrics); no
 * `process.env` reads — transitively.
 */

import { deleteUserData } from "../services/user-data-deletion.js";
import type { Env } from "../../env.js";
import type { WorkerContext } from "./context.js";
import { withCronLock, type WithCronLockResult } from "./cron-lock.js";

export const NIGHTLY_CRON_LOCK_NAME = "nightly";
/** 1 h — matches the old inline `ttl: now + 3600`; ≫ observed runtime, with
 *  the heartbeat as the primary finding-5 guard for long batch loops. */
export const NIGHTLY_CRON_LOCK_TTL_SECONDS = 3600;

/** Provider-neutral "account deleted" completion-email port. The core
 *  composes the content; the adapter owns transport + sender identity. */
export interface DeletionEmailPort {
  sendAccountDeleted(input: {
    readonly to: string;
    readonly subject: string;
    readonly textBody: string;
    readonly htmlBody: string;
  }): Promise<void>;
}

export type NightlyCronContext = Pick<
  WorkerContext,
  "logger" | "metrics" | "cronLock" | "clock" | "identity"
> &
  Required<
    Pick<
      WorkerContext,
      "getDb" | "resolvePseudonymSecret" | "deleteStagingObjects" | "objectStore"
    >
  > & {
    /** Best-effort per-user profile-cache cleanup (old step 4d DynamoDB
     *  DeleteItem). Failures are swallowed by the core. */
    readonly userCacheCleanup?: (userId: string) => Promise<void>;
    /** Present only when a sender is configured (old `if (DOMAIN)` gate). */
    readonly email?: DeletionEmailPort;
    /** Lazy app-Env for steps 5/6 (the old `buildEnv()` self-call). */
    readonly getAppEnv: () => Promise<Env>;
  };

export async function runNightlyCron(
  ctx: NightlyCronContext,
): Promise<WithCronLockResult> {
  const result = await withCronLock(
    ctx.cronLock,
    NIGHTLY_CRON_LOCK_NAME,
    NIGHTLY_CRON_LOCK_TTL_SECONDS,
    ctx.logger,
    async (signal) => {
      ctx.logger.info("Nightly cron started");
      // Lazy: only a fire that HOLDS the lock opens a DB connection.
      const db = await ctx.getDb();

      // 1. Hard-delete soft-deleted media older than 7 days + remove the
      //    stored objects
      try {
        const deletionCutoff = new Date(ctx.clock());
        deletionCutoff.setDate(deletionCutoff.getDate() - 7);

        // Evidence-hold guard (compliance plan 08 §2.3 item 5): never
        // hard-delete an original that is under a live evidence/legal hold —
        // the case is open. The exempt predicate is the single source of truth
        // in compliance/restrict-content.ts.
        const { evidenceHoldExemptWhere } = await import(
          "../compliance/restrict-content.js"
        );
        const mediaToDelete = await db.mediaFile.findMany({
          where: { deletedAt: { lte: deletionCutoff }, ...evidenceHoldExemptWhere() },
          select: { id: true, originalKey: true, thumbnailKey: true, optimizedKey: true },
          take: 200,
        });

        if (mediaToDelete.length > 0) {
          // Key → owning row. The row is hard-deleted only once EVERY key it
          // owns is gone from the store: the row is the only remaining record
          // of which objects exist, so deleting it after a failed object
          // delete strands those bytes permanently — nothing left to derive
          // the key from, and no way to reclaim them. Deferring instead is
          // self-healing: the row keeps its `deletedAt`, stays inside the
          // `lte: cutoff` window, and is retried on the next run.
          const ownerOf = new Map<string, string>();
          for (const m of mediaToDelete) {
            for (const k of [m.originalKey, m.thumbnailKey, m.optimizedKey]) {
              if (k) ownerOf.set(k, m.id);
            }
          }
          const keys = [...ownerOf.keys()];

          /** Rows with at least one key the store did not confirm deleted. */
          const deferred = new Set<string>();

          if (keys.length > 0) {
            // Batch object deletion supports up to 1000 keys per call.
            for (let i = 0; i < keys.length; i += 1000) {
              const batch = keys.slice(i, i + 1000);
              try {
                await ctx.objectStore.deleteObjects(batch);
              } catch (err) {
                for (const k of batch) {
                  const owner = ownerOf.get(k);
                  if (owner) deferred.add(owner);
                }
                ctx.logger.error("S3 batch delete failed", {
                  error: err,
                  batchSize: batch.length,
                });
              }
            }
          }

          const purgeable = mediaToDelete
            .map((m) => m.id)
            .filter((id) => !deferred.has(id));

          // Hard-delete only the rows whose objects are confirmed gone.
          const result =
            purgeable.length > 0
              ? await db.mediaFile.deleteMany({ where: { id: { in: purgeable } } })
              : { count: 0 };
          ctx.logger.info("Soft-deleted media purged", {
            dbDeleted: result.count,
            s3Keys: keys.length,
            // A number that only ever grows across runs means a key the store
            // will never accept — the rows are safe, but they are also stuck,
            // and they occupy the `take: 200` budget of every later run.
            purgeDeferred: deferred.size,
          });
        }
      } catch (err) {
        ctx.logger.error("Media purge failed", { error: err });
      }

      signal.throwIfAborted();

      // 2. Clean up expired invitations
      try {
        const result = await db.invitation.deleteMany({
          where: { expiresAt: { lte: new Date(ctx.clock()) }, usedAt: null },
        });
        if (result.count > 0) {
          ctx.logger.info("Expired invitations cleaned", { deleted: result.count });
        }
      } catch (err) {
        ctx.logger.error("Invitation cleanup failed", { error: err });
      }

      signal.throwIfAborted();

      // 3. Follower counts removed — relationships now live in graph edge tables

      // 4. Process scheduled account deletions (GDPR Article 17 compliance)
      try {
        // Fail-closed (findings 2+7): resolve the erasure-tombstone HMAC key
        // up front; empty/unresolvable throws into this step's catch and NO
        // deletion runs (never a reversible `HMAC("", …)` tombstone).
        // Hardened (test-critique F3): whitespace-only or non-string values
        // are rejected too, matching the delete-account/startup gates.
        const pseudonymSecret = await ctx.resolvePseudonymSecret();
        if (typeof pseudonymSecret !== "string" || pseudonymSecret.trim().length === 0) {
          throw new Error(
            "nightly-cron: empty/whitespace pseudonym tombstone secret — refusing scheduled deletions (fail-closed)",
          );
        }

        const usersToDelete = await db.user.findMany({
          where: {
            deletionScheduledAt: { lte: new Date(ctx.clock()) },
            deletionConfirmedAt: { not: null },
          },
          select: {
            id: true,
            email: true,
            deletionRequestedAt: true,
            deletionConfirmedAt: true,
          },
          take: 50,
        });

        let deletedCount = 0;
        let failedCount = 0;

        for (const user of usersToDelete) {
          signal.throwIfAborted();
          try {
            // 4a. Delete all database records. Media erasure happens inside
            //     deleteUserData (AR7 / GDPR Art. 17): the user's MediaFile
            //     rows are soft-deleted into step 1's purge.
            const result = await deleteUserData(db, user.id, { pseudonymSecret });

            // 4b. Delete the user-scoped STAGING objects reported by the
            //     erasure — step 1's purge does not cover staging keys.
            //     Never touches `cas/*`.
            try {
              const staging = await ctx.deleteStagingObjects(result.mediaStagingKeys);
              if (staging.failedBatches > 0 || staging.truncated) {
                // error, not warn: an Art. 17 erasure that left bytes behind
                // is a compliance failure, and the staging keys are derived
                // from MediaFile rows that step 1 hard-deletes once their
                // window closes — after which the objects are unreachable.
                ctx.logger.error("Staging object cleanup incomplete", {
                  userId: user.id,
                  ...staging,
                });
              }
            } catch (s3Err) {
              ctx.logger.error("S3 staging deletion failed", {
                userId: user.id,
                error: s3Err,
              });
            }

            // 4c. Delete the external identity (best-effort)
            if (ctx.identity) {
              try {
                await ctx.identity.deleteUser({ email: user.email });
              } catch (cognitoErr) {
                // Log but don't fail — user may already be deleted upstream
                ctx.logger.warn("Cognito deletion failed", {
                  userId: user.id,
                  error: cognitoErr,
                });
              }
            }

            // 4d. Clean up profile-cache entries (best-effort)
            if (ctx.userCacheCleanup) {
              try {
                await ctx.userCacheCleanup(user.id);
              } catch {
                // Best-effort cleanup
              }
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
                  itemsDeleted: {
                    ...result,
                    mediaStagingKeys: result.mediaStagingKeys.length,
                  } as never,
                },
              });
            } catch (auditErr) {
              ctx.logger.error("Audit log write failed", {
                userId: user.id,
                error: auditErr,
              });
            }

            // 4f. Send deletion completion email
            if (ctx.email) {
              try {
                await ctx.email.sendAccountDeleted({
                  to: user.email,
                  subject: "Your Trellis account has been deleted",
                  textBody: `Your Trellis account and all associated data have been permanently deleted in accordance with your GDPR deletion request.\n\nDeleted: ${result.posts} posts, ${result.comments} comments, ${result.entities} entities.\n\nIf you did not request this deletion, please contact support immediately.`,
                  htmlBody: `<h2>Account Deletion Complete</h2><p>Your Trellis account and all associated data have been permanently deleted in accordance with your GDPR deletion request.</p><p>Deleted: ${result.posts} posts, ${result.comments} comments, ${result.entities} entities.</p><p>If you did not request this deletion, please contact support immediately.</p>`,
                });
              } catch (emailErr) {
                ctx.logger.warn("Deletion email failed", {
                  userId: user.id,
                  error: emailErr,
                });
              }
            }

            deletedCount++;
            ctx.logger.info("Account deleted", {
              userId: user.id,
              itemsDeleted: {
                ...result,
                mediaStagingKeys: result.mediaStagingKeys.length,
              },
            });
          } catch (err) {
            failedCount++;
            ctx.logger.error("Account deletion failed", {
              userId: user.id,
              error: err,
            });
          }
        }

        // Count pending deletions (for monitoring backlog)
        const pendingCount = await db.user.count({
          where: {
            deletionScheduledAt: { not: null },
            deletionConfirmedAt: { not: null },
          },
        });

        // Emit deletion metrics (one grouped blob = the old stored-metrics
        // publish in the Trellis/Deletion namespace)
        try {
          ctx.metrics.emitCounts({}, [
            { name: "ProcessedCount", value: deletedCount },
            { name: "FailedCount", value: failedCount },
            { name: "PendingCount", value: pendingCount },
          ]);
        } catch (cwErr) {
          ctx.logger.error("CloudWatch metrics failed", { error: cwErr });
        }

        if (usersToDelete.length > 0) {
          ctx.logger.info("Scheduled account deletions processed", {
            total: usersToDelete.length,
            deleted: deletedCount,
            failed: failedCount,
            pending: pendingCount,
          });
        }
      } catch (err) {
        ctx.logger.error("Scheduled deletion processing failed", { error: err });
      }

      signal.throwIfAborted();

      // 5. Check age tier transitions (Safer Social Design)
      try {
        const { checkAgeTierTransitions } = await import("../age-tier-transition.js");
        const appEnv = await ctx.getAppEnv();
        const result = await checkAgeTierTransitions(appEnv);
        if (result.transitioned > 0 || result.errors > 0) {
          ctx.logger.info("Age tier transitions processed", {
            transitioned: result.transitioned,
            errors: result.errors,
          });
        }
      } catch (err) {
        ctx.logger.error("Age tier transition check failed", { error: err });
      }

      signal.throwIfAborted();

      // 6. Generate sentiment digest notifications (Safer Social Design)
      try {
        const { generateSentimentDigest } = await import("../sentiment-digest.js");
        const { NotificationHandler } = await import("../notification-handler.js");
        const appEnv = await ctx.getAppEnv();
        const notificationHandler = new NotificationHandler();

        const since = new Date(ctx.clock());
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
              const sentimentNames = [
                ...new Set(digest.posts.flatMap((p: { sentiments: string[] }) => p.sentiments)),
              ];
              const body =
                sentimentNames.length > 0
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
            ctx.logger.error("Digest generation failed for user", {
              userId: user.id,
              error: digestErr,
            });
          }
        }

        if (digestCount > 0) {
          ctx.logger.info("Sentiment digest notifications created", { count: digestCount });
        }
      } catch (err) {
        ctx.logger.error("Sentiment digest delivery failed", { error: err });
      }

      ctx.logger.info("Nightly cron complete");
    },
  );
  if (!result.acquired) {
    ctx.logger.info("Nightly cron already running, skipping");
  }
  return result;
}
