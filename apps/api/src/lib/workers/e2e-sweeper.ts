/**
 * E2E test-data sweeper core (WS-2 T4), extracted from `lambda/e2e-sweeper.ts`.
 *
 * Safety net for leaked test data; runs hourly. Instead of querying the
 * database directly, it:
 *  1. Lists identity-provider users with the `__e2e_` email prefix older
 *     than 2 hours,
 *  2. Queues their deletion via the delete-account queue (the same pipeline
 *     GDPR account deletions use),
 *  3. Deletes the identity-provider user immediately (the worker also tries,
 *     but may process the message after a delay).
 *
 * This eliminates the risk of a WHERE-clause bug deleting real user data.
 *
 * The identity directory is a LOCAL port (list + delete-by-username), NOT an
 * extension of the provisional one-method `IdentityAdminPort` (X6 keeps that
 * port frozen at one method for WS-3.3); the queue produce goes through
 * `ctx.deleteAccountQueue`.
 */

import type { QueueProducer, WorkerContext } from "./context.js";
import { withCronLock, type WithCronLockResult } from "./cron-lock.js";

export const E2E_SWEEPER_LOCK_NAME = "e2e-sweeper";
/** 5 min — matches the old inline `ttl: now + 300`. */
export const E2E_SWEEPER_LOCK_TTL_SECONDS = 300;

export const E2E_STALE_THRESHOLD_HOURS = 2;
export const E2E_PREFIX = "__e2e_";
export const E2E_MAX_PAGES = 20;
export const E2E_PAGE_LIMIT = 60;

/** One listed identity-provider user (provider-neutral shape). */
export interface E2eDirectoryUser {
  readonly username?: string;
  readonly email?: string;
  readonly sub?: string;
  readonly createdAt?: Date;
}

/**
 * Identity-directory operations the sweeper needs. Local to this worker
 * (see module doc); Cognito-backed on AWS.
 */
export interface E2eIdentityDirectoryPort {
  listUsersByEmailPrefix(input: {
    readonly prefix: string;
    readonly limit: number;
    readonly paginationToken?: string;
  }): Promise<{
    readonly users: readonly E2eDirectoryUser[];
    readonly paginationToken?: string;
  }>;
  deleteUserByUsername(username: string): Promise<void>;
}

export type E2eSweeperContext = Pick<
  WorkerContext,
  "logger" | "metrics" | "cronLock" | "clock"
> & {
  readonly directory: E2eIdentityDirectoryPort;
  /** Producer for the delete-account queue (`{ userId }` messages). */
  readonly deleteAccountQueue: QueueProducer;
  /** Deployment stage for the metric dimension (entrypoint resolves it). */
  readonly stage: string;
};

export async function runE2eSweeper(
  ctx: E2eSweeperContext,
): Promise<WithCronLockResult> {
  const result = await withCronLock(
    ctx.cronLock,
    E2E_SWEEPER_LOCK_NAME,
    E2E_SWEEPER_LOCK_TTL_SECONDS,
    ctx.logger,
    async (signal) => {
      const cutoff = new Date(ctx.clock() - E2E_STALE_THRESHOLD_HOURS * 60 * 60 * 1000);
      ctx.logger.info("E2E sweeper started", { cutoff: cutoff.toISOString() });

      let totalQueued = 0;

      // Step 1: List stale __e2e_ users
      try {
        let paginationToken: string | undefined;
        let pages = 0;

        do {
          signal.throwIfAborted();
          const res = await ctx.directory.listUsersByEmailPrefix({
            prefix: E2E_PREFIX,
            limit: E2E_PAGE_LIMIT,
            paginationToken,
          });

          for (const user of res.users) {
            if (!user.createdAt || user.createdAt >= cutoff) continue;
            if (!user.username) continue;

            const email = user.email || user.username;
            const sub = user.sub;

            // Step 2: Queue database + storage deletion via the
            // delete-account worker
            if (sub) {
              try {
                await ctx.deleteAccountQueue.send({ userId: sub });
                totalQueued++;
                ctx.logger.info(`Queued deletion for ${email}`, { userId: sub });
              } catch (err) {
                ctx.logger.warn(`Failed to queue deletion for ${email}`, { error: err });
              }
            }

            // Step 3: Delete the identity-provider user immediately
            // (the delete-account worker also tries, but it may process the
            // message after a delay)
            try {
              await ctx.directory.deleteUserByUsername(user.username);
              ctx.logger.info(`Deleted Cognito user ${email}`);
            } catch (err) {
              ctx.logger.warn(`Cognito delete failed for ${email}`, { error: err });
            }
          }

          paginationToken = res.paginationToken;
          pages++;
        } while (paginationToken && pages < E2E_MAX_PAGES);
      } catch (err) {
        ctx.logger.error("Failed to list Cognito users", { error: err });
      }

      // Step 4: Emit metric
      try {
        ctx.metrics.emitCounts({ Stage: ctx.stage }, [
          { name: "E2eLeakedRecords", value: totalQueued },
        ]);
      } catch (err) {
        ctx.logger.error("Failed to emit metric", { error: err });
      }

      ctx.logger.info("E2E sweeper complete", { totalQueued });
    },
  );
  if (!result.acquired) {
    ctx.logger.info("E2E sweeper already running, skipping");
  }
  return result;
}
