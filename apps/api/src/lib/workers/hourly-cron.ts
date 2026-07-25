/**
 * hourly cron core (WS-2 T3a), extracted from `lambda/hourly-cron.ts`.
 *
 * Fires hourly. Steps (each fail-open with its own try/catch, exactly as the
 * Lambda handler was):
 *  1. Reap genuinely-abandoned PENDING/FAILED media records (AR4 scope —
 *     see lib/media/stale-media-reap.ts for the invariant).
 *  2. Soft-delete orphaned media past the 24h grace period.
 *  3. Prune expired SecurityEvent rows (batched + circuit breaker).
 *  3b. Prune expired EmailSubscription rows (same helper).
 *  4. Prune expired InteractionEvent rows (P2 — silent retention failure is
 *     the surveillance-asset failure mode, so prune failures/tripped breakers
 *     emit metrics to alarm on).
 *
 * Metrics go through `ctx.metrics` (MetricsPort, §5.2): the AWS entrypoint
 * injects the EMF adapter so the `Trellis/Retention` `PruneFailed` /
 * `PruneCircuitBreakerTripped` alarms keep firing byte-identically.
 *
 * Operational thresholds resolve from `ctx.configSource` (an env-shaped
 * record the ENTRYPOINT supplies — the core itself never touches
 * `process.env`; both helpers are already parameterized for this).
 *
 * Single-fire via `ctx.cronLock` (WS-1 KvStore, `cron` namespace).
 */

import {
  batchedPruneExpired,
  resolveInteractionEventConfig,
} from "../graph/postgres/interaction-events.js";
import {
  staleMediaReapCutoff,
  staleMediaReapWhere,
  staleMediaReapWindowMs,
} from "../media/stale-media-reap.js";
import type { WorkerContext } from "./context.js";
import { withCronLock, type WithCronLockResult } from "./cron-lock.js";
import type { MetricsPort } from "./metrics-port.js";
import type { Logger } from "../logger.js";

export const HOURLY_CRON_LOCK_NAME = "hourly";
/** 1 h — matches the old inline `ttl: now + 3600`. */
export const HOURLY_CRON_LOCK_TTL_SECONDS = 3600;

export type HourlyCronContext = Pick<
  WorkerContext,
  "logger" | "metrics" | "cronLock" | "clock"
> &
  Required<Pick<WorkerContext, "getDb">> & {
  /** Env-shaped config source for the retention thresholds (entrypoint:
   *  `process.env`; container: its own env contract). Never secrets. */
  readonly configSource: Record<string, string | undefined>;
};

export async function runHourlyCron(
  ctx: HourlyCronContext,
): Promise<WithCronLockResult> {
  const result = await withCronLock(
    ctx.cronLock,
    HOURLY_CRON_LOCK_NAME,
    HOURLY_CRON_LOCK_TTL_SECONDS,
    ctx.logger,
    async (signal) => {
      ctx.logger.info("Hourly cron started");
      // Lazy: only a fire that HOLDS the lock opens a DB connection.
      const db = await ctx.getDb();

      // 1. Reap genuinely-abandoned PENDING/FAILED media records (AR4-scoped:
      //    never a row the moderation pipeline has engaged with, never younger
      //    than the reap window ≫ the moderation SLA).
      try {
        const cutoff = staleMediaReapCutoff(
          new Date(ctx.clock()),
          staleMediaReapWindowMs(ctx.configSource),
        );
        const staleMedia = await db.mediaFile.findMany({
          where: staleMediaReapWhere(cutoff),
          take: 100,
          select: { id: true },
        });

        if (staleMedia.length > 0) {
          const result = await db.mediaFile.deleteMany({
            // Re-assert the full reap scope (not id-only): a row that acquired
            // a moderation job between the findMany and this delete is
            // re-excluded atomically at delete time (no reap race).
            where: {
              id: { in: staleMedia.map((m) => m.id) },
              ...staleMediaReapWhere(cutoff),
            },
          });
          ctx.logger.info("Stale media cleaned", { deleted: result.count });
        }
      } catch (err) {
        ctx.logger.error("Stale media cleanup failed", { error: err });
      }

      signal.throwIfAborted();

      // 2. Soft-delete orphaned media past 24h grace period
      try {
        const gracePeriodCutoff = new Date(ctx.clock() - 24 * 3600000);
        const result = await db.mediaFile.updateMany({
          where: {
            attachedToPost: false,
            orphanedAt: { lte: gracePeriodCutoff },
            deletedAt: null,
          },
          data: { deletedAt: new Date(ctx.clock()) },
        });
        if (result.count > 0) {
          ctx.logger.info("Orphaned media soft-deleted", { count: result.count });
        }
      } catch (err) {
        ctx.logger.error("Orphaned media cleanup failed", { error: err });
      }

      signal.throwIfAborted();

      const eventConfig = resolveInteractionEventConfig(ctx.configSource);

      // 3. Clean up expired security events (retentionUntil < now), batched.
      try {
        const cutoff = new Date(ctx.clock());
        const result = await batchedPruneExpired({
          findExpiredIds: async (take) => {
            const rows = await db.securityEvent.findMany({
              where: { retentionUntil: { lt: cutoff } },
              select: { id: true },
              take,
            });
            return rows.map((r) => r.id);
          },
          deleteByIds: async (ids) => {
            const res = await db.securityEvent.deleteMany({ where: { id: { in: ids } } });
            return res.count;
          },
          batchSize: eventConfig.pruneBatchSize,
          maxIterations: eventConfig.pruneMaxIterations,
        });
        if (result.deleted > 0 || result.circuitBreakerTripped) {
          ctx.logger.info("Expired security events cleaned", {
            deleted: result.deleted,
            circuitBreakerTripped: result.circuitBreakerTripped,
          });
        }
        emitPruneMetrics(ctx.metrics, ctx.logger, "SecurityEvent", result, false);
      } catch (err) {
        ctx.logger.error("Security event cleanup failed", { error: err });
        emitPruneMetrics(
          ctx.metrics,
          ctx.logger,
          "SecurityEvent",
          { deleted: 0, circuitBreakerTripped: false },
          true,
        );
      }

      signal.throwIfAborted();

      // 3b. Prune expired EmailSubscription rows (email-bomb defense tombstones
      //     etc.), same batched helper + circuit breaker as SecurityEvent.
      try {
        const cutoff = new Date(ctx.clock());
        const result = await batchedPruneExpired({
          findExpiredIds: async (take) => {
            const rows = await db.emailSubscription.findMany({
              where: { retentionUntil: { lt: cutoff } },
              select: { id: true },
              take,
            });
            return rows.map((r) => r.id);
          },
          deleteByIds: async (ids) => {
            const res = await db.emailSubscription.deleteMany({ where: { id: { in: ids } } });
            return res.count;
          },
          batchSize: eventConfig.pruneBatchSize,
          maxIterations: eventConfig.pruneMaxIterations,
        });
        if (result.deleted > 0 || result.circuitBreakerTripped) {
          ctx.logger.info("Expired email subscriptions pruned", {
            deleted: result.deleted,
            circuitBreakerTripped: result.circuitBreakerTripped,
          });
        }
        emitPruneMetrics(ctx.metrics, ctx.logger, "EmailSubscription", result, false);
      } catch (err) {
        ctx.logger.error("Email subscription cleanup failed", { error: err });
        emitPruneMetrics(
          ctx.metrics,
          ctx.logger,
          "EmailSubscription",
          { deleted: 0, circuitBreakerTripped: false },
          true,
        );
      }

      signal.throwIfAborted();

      // 4. Prune expired InteractionEvent rows (expiresAt < now), batched with
      //    a circuit breaker (P2). Prune failure / tripped breaker raises a
      //    metric to alarm on — retention must never silently stop.
      try {
        const { InteractionEventOps } = await import(
          "../graph/postgres/interaction-events.js"
        );
        const ops = new InteractionEventOps(db, eventConfig);
        const result = await ops.prune(new Date(ctx.clock()));
        if (result.deleted > 0 || result.circuitBreakerTripped) {
          ctx.logger.info("Expired interaction events pruned", {
            deleted: result.deleted,
            circuitBreakerTripped: result.circuitBreakerTripped,
          });
        }
        emitPruneMetrics(ctx.metrics, ctx.logger, "InteractionEvent", result, false);
      } catch (err) {
        ctx.logger.error("Interaction event pruning failed", { error: err });
        emitPruneMetrics(
          ctx.metrics,
          ctx.logger,
          "InteractionEvent",
          { deleted: 0, circuitBreakerTripped: false },
          true,
        );
      }

      ctx.logger.info("Hourly cron complete");
    },
  );
  if (!result.acquired) {
    ctx.logger.info("Hourly cron already running, skipping");
  }
  return result;
}

/**
 * Emit retention-pruning metrics (Trellis/Retention namespace) through the
 * MetricsPort, fail-open. `Pruned` counts deleted rows; `PruneFailed` flags an
 * exception; `PruneCircuitBreakerTripped` flags a drained-iteration-cap
 * backlog — alarm on the latter two. One grouped emit per table isolates the
 * `Table` dimension (maps to one powertools `singleMetric` on AWS).
 */
function emitPruneMetrics(
  metrics: MetricsPort,
  logger: Logger,
  table: "SecurityEvent" | "InteractionEvent" | "EmailSubscription",
  result: { deleted: number; circuitBreakerTripped: boolean },
  failed: boolean,
): void {
  try {
    metrics.emitCounts({ Table: table }, [
      { name: "Pruned", value: result.deleted },
      { name: "PruneFailed", value: failed ? 1 : 0 },
      { name: "PruneCircuitBreakerTripped", value: result.circuitBreakerTripped ? 1 : 0 },
    ]);
  } catch (err) {
    logger.error("Retention metrics emit failed", { table, error: err });
  }
}
