/**
 * cleanup cron core (WS-2 T2), extracted from `lambda/cleanup-cron.ts`.
 *
 * Fires every 5 minutes. The backing store's TTL handles most cleanup
 * automatically; this cron exists for cleanup TTL alone can't do (currently
 * none — the body is a placeholder, exactly as the Lambda handler was).
 *
 * Single-fire across replicas via `ctx.cronLock` → WS-1
 * `KvStore.putIfAbsent(key, value, { ttlSeconds, overwriteExpired: true })`
 * in the `cron` namespace (X1).
 */

import type { WorkerContext } from "./context.js";
import { withCronLock, type WithCronLockResult } from "./cron-lock.js";

export const CLEANUP_CRON_LOCK_NAME = "cleanup";
/** 5 min — matches the old inline `ttl: now + 300`. */
export const CLEANUP_CRON_LOCK_TTL_SECONDS = 300;

export type CleanupCronContext = Pick<WorkerContext, "logger" | "cronLock">;

export async function runCleanupCron(
  ctx: CleanupCronContext,
): Promise<WithCronLockResult> {
  const result = await withCronLock(
    ctx.cronLock,
    CLEANUP_CRON_LOCK_NAME,
    CLEANUP_CRON_LOCK_TTL_SECONDS,
    ctx.logger,
    async () => {
      ctx.logger.info("Cleanup cron started");
      // Additional cleanup logic goes here
      ctx.logger.info("Cleanup cron complete");
    },
  );
  if (!result.acquired) {
    ctx.logger.info("Cleanup cron already running, skipping");
  }
  return result;
}
