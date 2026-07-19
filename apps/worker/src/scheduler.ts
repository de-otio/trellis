/**
 * scheduler.ts — in-process cron scheduler (WS-2 T7b, §3.4).
 *
 * A small hand-rolled timer wheel (next-fire computation is pure and
 * frozen-clock-testable via the injected `clock`). Six cadences on the
 * Scaleway profile: rate(5m) cleanup, rate(1h) hourly, daily 02:00 nightly,
 * daily 03:00 maintenance, rate(1h) e2e-sweeper, rate(15m)
 * kv-entries-cleanup (X5, Scaleway only).
 *
 * SINGLE-FIRE is NOT this module's job: the extracted cron cores take the
 * `CronLock` themselves (`withCronLock` → WS-1
 * `KvStore.putIfAbsent({ overwriteExpired: true })` in the `cron`
 * namespace, with the finding-5 owner-fenced heartbeat). Under replication,
 * every replica's scheduler fires; exactly one core body runs — identical
 * to today's "already running, skip".
 *
 * Per-job runs never overlap locally either: the next fire is computed only
 * after the previous run settles (a slow body delays its own next fire, it
 * never stacks).
 */

import type { Logger } from "../../api/src/lib/logger.js";

export type CronSchedule =
  | { readonly kind: "rate"; readonly everyMs: number }
  | { readonly kind: "dailyUtc"; readonly hour: number; readonly minute?: number };

export interface ScheduledJob {
  readonly name: string;
  readonly schedule: CronSchedule;
  /** The full core invocation (locking happens INSIDE the core). */
  readonly run: () => Promise<unknown>;
}

/** Pure next-fire computation (exported for the frozen-clock tests). */
export function nextFireDelayMs(schedule: CronSchedule, nowMs: number): number {
  if (schedule.kind === "rate") {
    return schedule.everyMs;
  }
  const now = new Date(nowMs);
  const next = new Date(nowMs);
  next.setUTCHours(schedule.hour, schedule.minute ?? 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - nowMs;
}

export interface CronSchedulerOptions {
  readonly clock?: () => number;
  readonly logger: Logger;
}

export class CronScheduler {
  private running = false;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly clock: () => number;

  constructor(
    private readonly jobs: readonly ScheduledJob[],
    private readonly options: CronSchedulerOptions,
  ) {
    this.clock = options.clock ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const job of this.jobs) {
      this.armTimer(job);
    }
    this.options.logger.info("cron scheduler started", {
      jobs: this.jobs.map((j) => j.name),
    });
  }

  /** Stop future fires; wait for in-flight bodies (callers bound the wait). */
  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.inFlight]);
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  private armTimer(job: ScheduledJob): void {
    if (!this.running) return;
    const delay = nextFireDelayMs(job.schedule, this.clock());
    const timer = setTimeout(() => {
      this.timers.delete(job.name);
      const started = Date.now();
      const run = job
        .run()
        .then((result) => {
          this.options.logger.info("cron fire complete", {
            name: job.name,
            durationMs: Date.now() - started,
            // Cores return { acquired } — surface it when present.
            ...(typeof result === "object" &&
              result !== null &&
              "acquired" in result && { acquired: (result as { acquired: boolean }).acquired }),
          });
        })
        .catch((err) => {
          this.options.logger.error("cron fire failed", { name: job.name, error: err });
        })
        .finally(() => {
          this.inFlight.delete(run);
          // Re-arm only after the run settles: fires never stack locally.
          this.armTimer(job);
        });
      this.inFlight.add(run);
    }, delay);
    timer.unref?.();
    this.timers.set(job.name, timer);
  }
}
