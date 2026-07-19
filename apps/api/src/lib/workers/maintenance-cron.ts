/**
 * maintenance cron core (WS-2 T2), extracted from `lambda/maintenance-cron.ts`.
 *
 * Fires daily (3:00). Steps:
 *  1. Defense-in-depth stale cron-lock sweep (locks whose `lockedAt` is older
 *     than 2h). Mostly redundant now that `putIfAbsent({overwriteExpired})`
 *     self-heals expired locks on the next acquire (§3.4), but kept
 *     deliberately as a safety net. Reads with `includeExpired: true` so an
 *     expired-but-unswept lock row is still visible to the sweep (matching
 *     the old raw GetItem, which had no TTL filter).
 *  2. ANALYZE on critical tables under a Postgres advisory lock.
 *
 * Single-fire via `ctx.cronLock` (WS-1 KvStore, `cron` namespace).
 */

import type { CronLockValue } from "./cron-lock.js";
import type { WorkerContext } from "./context.js";
import { withCronLock, type WithCronLockResult } from "./cron-lock.js";

export const MAINTENANCE_CRON_LOCK_NAME = "maintenance";
/** 1 h — matches the old inline `ttl: now + 3600`; ≫ observed runtime (5b). */
export const MAINTENANCE_CRON_LOCK_TTL_SECONDS = 3600;

/** Locks the stale sweep covers — the old handler's exact list. */
const SWEEP_LOCK_NAMES = ["hourly", "nightly", "maintenance", "cleanup"] as const;
/** A lock is stale when locked more than 2 hours ago (old handler's rule). */
const STALE_AFTER_SECONDS = 7200;

export type MaintenanceCronContext = Pick<
  WorkerContext,
  "db" | "logger" | "cronLock" | "clock"
> &
  Pick<WorkerContext, "cronKv">;

export async function runMaintenanceCron(
  ctx: MaintenanceCronContext,
): Promise<WithCronLockResult> {
  const result = await withCronLock(
    ctx.cronLock,
    MAINTENANCE_CRON_LOCK_NAME,
    MAINTENANCE_CRON_LOCK_TTL_SECONDS,
    ctx.logger,
    async (signal) => {
      ctx.logger.info("Maintenance cron started");

      // 1. Follow counts removed — relationships now live in graph DB
      // TODO: Add graph-side consistency check when reconciliation service is wired up

      // 2. Clean up stale cron locks (safety net; see module doc).
      if (ctx.cronKv) {
        try {
          const nowSec = Math.floor(ctx.clock() / 1000);
          for (const name of SWEEP_LOCK_NAMES) {
            const rec = await ctx.cronKv.get<CronLockValue>(name, {
              includeExpired: true,
            });
            if (
              rec !== null &&
              typeof rec.value.lockedAt === "number" &&
              rec.value.lockedAt < nowSec - STALE_AFTER_SECONDS
            ) {
              await ctx.cronKv.delete(name);
              ctx.logger.info("Stale cron lock removed", { lock: `cron:${name}` });
            }
          }
        } catch (err) {
          ctx.logger.error("Stale lock cleanup failed", { error: err });
        }
      }

      signal.throwIfAborted();

      // 3. Vacuum analyze critical tables (via advisory lock to prevent
      //    concurrent runs)
      try {
        await ctx.db.$executeRaw`SELECT pg_advisory_lock(42)`;
        try {
          await ctx.db.$executeRawUnsafe("ANALYZE users");
          await ctx.db.$executeRawUnsafe("ANALYZE posts");
          await ctx.db.$executeRawUnsafe("ANALYZE media_files");
          await ctx.db.$executeRawUnsafe("ANALYZE follows");
          ctx.logger.info("ANALYZE completed on critical tables");
        } finally {
          await ctx.db.$executeRaw`SELECT pg_advisory_unlock(42)`;
        }
      } catch (err) {
        ctx.logger.error("ANALYZE failed", { error: err });
      }

      ctx.logger.info("Maintenance cron complete");
    },
  );
  if (!result.acquired) {
    ctx.logger.info("Maintenance cron already running, skipping");
  }
  return result;
}
