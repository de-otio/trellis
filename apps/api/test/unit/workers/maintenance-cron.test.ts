/**
 * Unit tests — `lib/workers/maintenance-cron.ts` core (WS-2 T2).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import { makeKvCronLock } from "../../../src/lib/workers/cron-lock.js";
import { runMaintenanceCron } from "../../../src/lib/workers/maintenance-cron.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

function makeDb() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  };
}

describe("runMaintenanceCron", () => {
  let now: number;
  let kv: MemoryKvStore;
  const clock = () => now;

  beforeEach(() => {
    now = 1_700_000_000_000;
    kv = new MemoryKvStore({ now: clock });
  });

  function ctxWith(overrides: Record<string, unknown> = {}) {
    return {
      db: makeDb() as never,
      logger: makeLogger(),
      cronLock: makeKvCronLock(kv, { owner: "A", clock }),
      cronKv: kv,
      clock,
      ...overrides,
    };
  }

  it("acquires the lock, ANALYZEs critical tables under the advisory lock", async () => {
    const db = makeDb();
    const ctx = ctxWith({ db: db as never });
    const result = await runMaintenanceCron(ctx as never);

    expect(result.acquired).toBe(true);
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith("ANALYZE users");
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith("ANALYZE posts");
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith("ANALYZE media_files");
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith("ANALYZE follows");
    // Advisory lock taken and released around the ANALYZEs.
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("skips when the lock is held", async () => {
    await makeKvCronLock(kv, { owner: "other", clock }).acquire("maintenance", 3600);
    const db = makeDb();
    const logger = makeLogger();
    const result = await runMaintenanceCron(ctxWith({ db: db as never, logger }) as never);

    expect(result.acquired).toBe(false);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("Maintenance cron already running, skipping");
  });

  it("ANALYZE failure is swallowed (logged), never thrown — old handler parity", async () => {
    const db = makeDb();
    db.$executeRaw.mockRejectedValueOnce(new Error("pg down"));
    const logger = makeLogger();

    const result = await runMaintenanceCron(ctxWith({ db: db as never, logger }) as never);
    expect(result.acquired).toBe(true);
    expect(logger.error).toHaveBeenCalledWith("ANALYZE failed", expect.anything());
  });

  it("releases the advisory lock even when an ANALYZE fails", async () => {
    const db = makeDb();
    db.$executeRawUnsafe.mockRejectedValueOnce(new Error("ANALYZE users failed"));
    await runMaintenanceCron(ctxWith({ db: db as never }) as never);
    // pg_advisory_lock + pg_advisory_unlock both ran.
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
  });

  describe("stale-lock sweep (defense-in-depth, §3.4)", () => {
    it("removes locks older than 2h (even TTL-expired-but-unswept ones) and keeps fresh locks", async () => {
      const nowSec = Math.floor(now / 1000);
      // Stale: locked 3h ago, TTL long expired (visible only via includeExpired).
      await kv.put("hourly", { lockedAt: nowSec - 10_800, owner: "dead" }, {
        expiresAt: nowSec - 7200,
      });
      // Fresh: locked 10 min ago, live TTL.
      await kv.put("nightly", { lockedAt: nowSec - 600, owner: "alive" }, {
        expiresAt: nowSec + 3000,
      });

      const logger = makeLogger();
      await runMaintenanceCron(ctxWith({ logger }) as never);

      expect(await kv.get("hourly", { includeExpired: true })).toBeNull();
      expect(await kv.get("nightly")).not.toBeNull();
      expect(logger.info).toHaveBeenCalledWith("Stale cron lock removed", {
        lock: "cron:hourly",
      });
    });

    it("does not remove its own freshly-acquired maintenance lock", async () => {
      await runMaintenanceCron(ctxWith() as never);
      expect(await kv.get("maintenance")).not.toBeNull();
    });

    it("sweep failure is swallowed (logged) and the run continues", async () => {
      const failingKv = {
        get: vi.fn().mockRejectedValue(new Error("kv down")),
        delete: vi.fn(),
      };
      const db = makeDb();
      const logger = makeLogger();
      const result = await runMaintenanceCron(
        ctxWith({ cronKv: failingKv, db: db as never, logger }) as never,
      );
      expect(result.acquired).toBe(true);
      expect(logger.error).toHaveBeenCalledWith("Stale lock cleanup failed", expect.anything());
      // ANALYZE still ran.
      expect(db.$executeRawUnsafe).toHaveBeenCalled();
    });
  });
});
