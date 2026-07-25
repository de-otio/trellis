/**
 * Unit tests — `lib/workers/cleanup-cron.ts` core (WS-2 T2).
 * Runs against WS-1's MemoryKvStore (injectable clock) via makeKvCronLock.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import { makeKvCronLock } from "../../../src/lib/workers/cron-lock.js";
import { runCleanupCron } from "../../../src/lib/workers/cleanup-cron.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

describe("runCleanupCron", () => {
  let now: number;
  let kv: MemoryKvStore;
  const clock = () => now;

  beforeEach(() => {
    now = 1_700_000_000_000;
    kv = new MemoryKvStore({ now: clock });
  });

  it("acquires the lock and runs (first fire)", async () => {
    const logger = makeLogger();
    const result = await runCleanupCron({
      logger,
      cronLock: makeKvCronLock(kv, { owner: "A", clock }),
    });

    expect(result.acquired).toBe(true);
    expect(logger.info).toHaveBeenCalledWith("Cleanup cron started");
    expect(logger.info).toHaveBeenCalledWith("Cleanup cron complete");
    // Lock persists (5-min TTL) — matches the old inline item.
    const rec = await kv.get("cleanup");
    expect(rec).not.toBeNull();
    expect(rec?.expiresAt).toBe(Math.floor(now / 1000) + 300);
  });

  it("skips when another holder has the lock (identical to today's skip)", async () => {
    await makeKvCronLock(kv, { owner: "other", clock }).acquire("cleanup", 300);

    const logger = makeLogger();
    const result = await runCleanupCron({
      logger,
      cronLock: makeKvCronLock(kv, { owner: "A", clock }),
    });

    expect(result.acquired).toBe(false);
    expect(logger.info).toHaveBeenCalledWith("Cleanup cron already running, skipping");
    expect(logger.info).not.toHaveBeenCalledWith("Cleanup cron started");
  });

  it("re-acquires after the 5-minute TTL expires (every rate(5m) fire runs)", async () => {
    await runCleanupCron({ logger: makeLogger(), cronLock: makeKvCronLock(kv, { owner: "A", clock }) });
    now += 301_000;
    const result = await runCleanupCron({
      logger: makeLogger(),
      cronLock: makeKvCronLock(kv, { owner: "B", clock }),
    });
    expect(result.acquired).toBe(true);
  });
});
