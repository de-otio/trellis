/**
 * The nightly scheduled-deletion batch (nightly-cron.ts step 4) takes at most
 * 50 due accounts per run. Without an ORDER BY, WHICH 50 is up to the query
 * plan — so the same set can come back every night while newer due accounts
 * wait indefinitely. Oldest-due first (id as the tie-break) makes the batch a
 * queue: every due account is reached as long as fewer than 50 older ones are
 * failing every night.
 */

import { describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import { runNightlyCron } from "../../../src/lib/workers/nightly-cron.js";
import { makeKvCronLock } from "../../../src/lib/workers/cron-lock.js";
import { noopMetrics } from "../../../src/lib/workers/metrics-port.js";

const NOW = new Date("2026-03-01T02:00:00.000Z").getTime();

describe("nightly scheduled deletions — batch order", () => {
  it("takes the oldest-due accounts first, with a stable tie-break", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = {
      mediaFile: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
      invitation: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      user: { findMany, count: vi.fn().mockResolvedValue(0) },
    };
    await runNightlyCron({
      getDb: async () => db as never,
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
      metrics: noopMetrics,
      cronLock: makeKvCronLock(new MemoryKvStore()),
      clock: () => NOW,
      resolvePseudonymSecret: async () => "a-non-empty-pseudonym-secret",
      deleteStagingObjects: async () => ({ requested: 0, failedBatches: 0, truncated: false }),
      objectStore: { deleteObjects: async () => {} },
      getAppEnv: async () => {
        throw new Error("not in this test");
      },
    } as never);

    const dueQuery = findMany.mock.calls
      .map((c) => c[0])
      .find((args) => args?.where?.deletionScheduledAt);
    expect(dueQuery).toBeDefined();
    expect(dueQuery.orderBy).toEqual([{ deletionScheduledAt: "asc" }, { id: "asc" }]);
    expect(dueQuery.take).toBe(50);
  });
});
