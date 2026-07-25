/**
 * T7b — scheduler + lock tests (§3.4). Deterministic under fake timers with
 * WS-1's injectable-clock MemoryKvStore; single-fire across two "replicas"
 * uses the REAL cron core (runCleanupCron) over one shared store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import {
  CronScheduler,
  nextFireDelayMs,
} from "../../../../worker/src/scheduler.js";
import {
  buildCronJobs,
  type CronJobsInput,
} from "../../../../worker/src/cron-jobs.js";
import { makeKvCronLock, withCronLock } from "../../../src/lib/workers/cron-lock.js";
import { runCleanupCron } from "../../../src/lib/workers/cleanup-cron.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

describe("nextFireDelayMs (pure)", () => {
  it("rate: fires every interval", () => {
    expect(nextFireDelayMs({ kind: "rate", everyMs: 300_000 }, 1_700_000_000_000)).toBe(300_000);
  });

  it("dailyUtc: before today's slot → today; after → tomorrow", () => {
    const t0100 = Date.UTC(2026, 6, 19, 1, 0, 0);
    const t0230 = Date.UTC(2026, 6, 19, 2, 30, 0);
    expect(nextFireDelayMs({ kind: "dailyUtc", hour: 2 }, t0100)).toBe(60 * 60 * 1000);
    expect(nextFireDelayMs({ kind: "dailyUtc", hour: 2 }, t0230)).toBe(23.5 * 60 * 60 * 1000);
  });

  it("dailyUtc: exactly at the slot → tomorrow (never zero-delay loop)", () => {
    const t0200 = Date.UTC(2026, 6, 19, 2, 0, 0);
    expect(nextFireDelayMs({ kind: "dailyUtc", hour: 2 }, t0200)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("CronScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a rate job at each interval and never stacks runs", async () => {
    let running = 0;
    let maxRunning = 0;
    let fires = 0;
    const scheduler = new CronScheduler(
      [
        {
          name: "j",
          schedule: { kind: "rate", everyMs: 1000 },
          run: async () => {
            fires++;
            running++;
            maxRunning = Math.max(maxRunning, running);
            await new Promise((r) => setTimeout(r, 1500)); // body slower than the rate
            running--;
          },
        },
      ],
      { logger: makeLogger() },
    );
    scheduler.start();

    await vi.advanceTimersByTimeAsync(6000);
    // Let any body still sleeping on its fake timer finish before draining.
    await vi.advanceTimersByTimeAsync(1500);
    await scheduler.stop();

    expect(fires).toBeGreaterThanOrEqual(2);
    expect(maxRunning).toBe(1); // slow body delays its own next fire
  });

  it("REPLICA single-fire: two schedulers over one shared KvStore — exactly one core body runs per cadence", async () => {
    let now = 1_700_000_000_000;
    const clock = (): number => now;
    const kv = new MemoryKvStore({ now: clock });
    const results: boolean[] = [];

    const replica = (owner: string): CronScheduler =>
      new CronScheduler(
        [
          {
            name: "cleanup",
            schedule: { kind: "rate", everyMs: 5 * 60 * 1000 },
            run: async () => {
              const r = await runCleanupCron({
                logger: makeLogger(),
                cronLock: makeKvCronLock(kv, { owner, clock }),
              });
              results.push(r.acquired);
              return r;
            },
          },
        ],
        { logger: makeLogger(), clock },
      );

    const a = replica("A");
    const b = replica("B");
    a.start();
    b.start();

    // First cadence: both fire ~simultaneously; the lock admits exactly one.
    now += 5 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results).toHaveLength(2);

    // Next cadence (lock TTL 300s expired by then): again exactly one winner.
    now += 5 * 60 * 1000 + 1000;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(results).toHaveLength(4);

    await a.stop();
    await b.stop();
  });

  it("stop() prevents further fires and drains an in-flight body", async () => {
    let fires = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const scheduler = new CronScheduler(
      [
        {
          name: "j",
          schedule: { kind: "rate", everyMs: 100 },
          run: async () => {
            fires++;
            await gate;
          },
        },
      ],
      { logger: makeLogger() },
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(fires).toBe(1);
    expect(scheduler.inFlightCount).toBe(1);

    const stopping = scheduler.stop();
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fires).toBe(1); // no fires after stop
  });
});

describe("buildCronJobs (X5 profile gating)", () => {
  function baseInput(profile: "aws" | "scaleway"): CronJobsInput {
    const logger = makeLogger();
    const kv = new MemoryKvStore();
    const cronLock = makeKvCronLock(kv);
    return {
      profile,
      logger,
      cleanup: { logger, cronLock },
      hourly: {} as never,
      nightly: {} as never,
      maintenance: {} as never,
      kvSweep:
        profile === "scaleway"
          ? {
              executor: { query: vi.fn(async () => ({ rows: [] })) },
              cronLock,
              clock: Date.now,
            }
          : undefined,
    };
  }

  it("aws profile: five standard cadences at most, NO kv-entries-cleanup", () => {
    const names = buildCronJobs(baseInput("aws")).map((j) => j.name);
    expect(names).toEqual(["cleanup", "hourly", "nightly", "maintenance"]);
    expect(names).not.toContain("kv-entries-cleanup");
  });

  it("scaleway profile: registers kv-entries-cleanup (rate 15m)", () => {
    const jobs = buildCronJobs(baseInput("scaleway"));
    const sweep = jobs.find((j) => j.name === "kv-entries-cleanup");
    expect(sweep).toBeDefined();
    expect(sweep!.schedule).toEqual({ kind: "rate", everyMs: 15 * 60 * 1000 });
  });

  it("scaleway profile WITHOUT kvSweep wiring is a hard construction error", () => {
    const input = { ...baseInput("scaleway"), kvSweep: undefined };
    expect(() => buildCronJobs(input)).toThrow(/kv-entries-cleanup/);
  });

  it("kv-entries-cleanup runs the WS-1 sweep under its own single-fire lock", async () => {
    const input = baseInput("scaleway");
    const executor = input.kvSweep!.executor as { query: ReturnType<typeof vi.fn> };
    const jobs = buildCronJobs(input);
    const sweep = jobs.find((j) => j.name === "kv-entries-cleanup")!;

    await sweep.run();
    expect(executor.query).toHaveBeenCalledTimes(1);
    expect(String(executor.query.mock.calls[0][0])).toContain("DELETE FROM kv_entries");

    // A second run inside the lock TTL window skips (single-fire): the lock
    // from the first run persists.
    await sweep.run();
    expect(executor.query).toHaveBeenCalledTimes(1);
  });
});

describe("withCronLock is what the sweep job uses (owner-fenced heartbeat already covered in cron-lock.test.ts)", () => {
  it("sanity: a held lock skips the sweep body", async () => {
    const kv = new MemoryKvStore();
    await makeKvCronLock(kv, { owner: "other" }).acquire("kv-entries-cleanup", 300);
    const body = vi.fn();
    const result = await withCronLock(
      makeKvCronLock(kv),
      "kv-entries-cleanup",
      300,
      makeLogger(),
      body,
    );
    expect(result.acquired).toBe(false);
    expect(body).not.toHaveBeenCalled();
  });
});
