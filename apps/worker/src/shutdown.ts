/**
 * shutdown.ts — graceful drain (WS-2 T7c, §3.5), mirroring the API's proven
 * `server.ts` sequence:
 *
 *   SIGTERM/SIGINT → stop the scheduler timers (no new cron fires) → stop
 *   pulling new messages → bounded drain of in-flight work → close the
 *   Prisma pools + graph service → exit(0); a force-exit(1) backstop timer
 *   sits BELOW the orchestrator's terminationGracePeriodSeconds.
 *
 * In-flight messages that do not finish inside the drain window are simply
 * NOT acked → they redeliver (at-least-once holds; nothing is lost).
 */

import type { Logger } from "../../api/src/lib/logger.js";

export interface Drainable {
  stop(): Promise<unknown>;
}

export interface ShutdownOptions {
  readonly scheduler: Drainable;
  readonly pollers: readonly Drainable[];
  /** Bounded drain window (ms). Keep below the orchestrator grace period and
   *  above the longest ack. Default 25s (§3.5). */
  readonly drainTimeoutMs?: number;
  /** Force-exit backstop (ms) — total wall clock before exit(1). */
  readonly forceExitAfterMs?: number;
  readonly logger: Logger;
  /** Close DB pools etc. Injected so tests don't touch real pools. */
  readonly closeResources?: () => Promise<void>;
  /** Injected for tests. Defaults to process.exit. */
  readonly exit?: (code: number) => void;
}

/** Default resource closer: Prisma pools + graph service (server.ts parity). */
export async function closeDefaultResources(logger: Logger): Promise<void> {
  try {
    const { sharedDatabaseConnectionManager } = await import(
      "../../api/src/lib/database-connection-manager.js"
    );
    await sharedDatabaseConnectionManager.shutdown();
    const { closeSharedGraphService } = await import("../../api/src/lib/graph/index.js");
    await closeSharedGraphService();
    logger.info("worker: database pools closed");
  } catch (err) {
    logger.error("worker: error closing database pools", { error: err });
  }
}

export function installShutdownHandlers(options: ShutdownOptions): {
  shutdown: (signal: string) => Promise<void>;
} {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const drainTimeoutMs = options.drainTimeoutMs ?? 25_000;
  const forceExitAfterMs = options.forceExitAfterMs ?? drainTimeoutMs + 5_000;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.logger.info("worker: shutdown requested", { signal });

    // Backstop: force-exit(1) if the drain wedges (below the orchestrator's
    // grace period so the kill is ours, not SIGKILL's).
    const backstop = setTimeout(() => {
      options.logger.error("worker: forced shutdown after backstop timeout");
      exit(1);
    }, forceExitAfterMs);
    backstop.unref?.();

    // 1. No new cron fires.
    await options.scheduler.stop();

    // 2+3. Stop pulling new messages; bounded drain of in-flight work.
    const drain = Promise.allSettled(options.pollers.map((p) => p.stop()));
    const timedOut = await Promise.race([
      drain.then(() => false),
      new Promise<true>((resolve) => {
        const t = setTimeout(() => resolve(true), drainTimeoutMs);
        t.unref?.();
      }),
    ]);
    if (timedOut) {
      // Un-acked in-flight messages will redeliver — at-least-once holds.
      options.logger.warn("worker: drain window elapsed with work in flight — proceeding", {
        drainTimeoutMs,
      });
    }

    // 4. Close pools.
    if (options.closeResources) {
      await options.closeResources();
    }

    clearTimeout(backstop);
    options.logger.info("worker: shutdown complete");
    exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  return { shutdown };
}
