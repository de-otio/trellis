/**
 * Unit tests — `lib/workers/e2e-sweeper.ts` core (WS-2 T4).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import { makeKvCronLock } from "../../../src/lib/workers/cron-lock.js";
import {
  runE2eSweeper,
  type E2eDirectoryUser,
} from "../../../src/lib/workers/e2e-sweeper.js";
import { CapturingMetrics } from "../../../src/lib/workers/metrics-port.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

const NOW = 1_700_000_000_000;
const HOURS = 60 * 60 * 1000;

function staleUser(n: number): E2eDirectoryUser {
  return {
    username: `__e2e_user${n}@test.com`,
    email: `__e2e_user${n}@test.com`,
    sub: `sub-${n}`,
    createdAt: new Date(NOW - 3 * HOURS),
  };
}

describe("runE2eSweeper", () => {
  let now: number;
  let kv: MemoryKvStore;
  const clock = () => now;

  beforeEach(() => {
    now = NOW;
    kv = new MemoryKvStore({ now: clock });
  });

  function ctx(overrides: Record<string, unknown> = {}) {
    return {
      logger: makeLogger(),
      metrics: new CapturingMetrics(),
      cronLock: makeKvCronLock(kv, { owner: "A", clock }),
      clock,
      stage: "dev",
      directory: {
        listUsersByEmailPrefix: vi.fn().mockResolvedValue({ users: [] }),
        deleteUserByUsername: vi.fn().mockResolvedValue(undefined),
      },
      deleteAccountQueue: { send: vi.fn().mockResolvedValue(undefined) },
      ...overrides,
    };
  }

  it("queues deletion + deletes the directory user for stale __e2e_ users", async () => {
    const c = ctx();
    (c.directory.listUsersByEmailPrefix as ReturnType<typeof vi.fn>).mockResolvedValue({
      users: [staleUser(1)],
    });

    const result = await runE2eSweeper(c as never);

    expect(result.acquired).toBe(true);
    expect(c.deleteAccountQueue.send).toHaveBeenCalledWith({ userId: "sub-1" });
    expect(c.directory.deleteUserByUsername).toHaveBeenCalledWith(
      "__e2e_user1@test.com",
    );
    // Metric: one Stage-dimensioned count.
    const metrics = c.metrics as CapturingMetrics;
    expect(metrics.emitted).toEqual([
      {
        dimensions: { Stage: "dev" },
        metrics: [{ name: "E2eLeakedRecords", value: 1 }],
      },
    ]);
  });

  it("skips users younger than the 2h threshold and users without username/createdAt", async () => {
    const c = ctx();
    (c.directory.listUsersByEmailPrefix as ReturnType<typeof vi.fn>).mockResolvedValue({
      users: [
        { ...staleUser(1), createdAt: new Date(NOW - 1 * HOURS) }, // too young
        { ...staleUser(2), createdAt: undefined }, // no createdAt
        { ...staleUser(3), username: undefined }, // no username
      ],
    });

    await runE2eSweeper(c as never);

    expect(c.deleteAccountQueue.send).not.toHaveBeenCalled();
    expect(c.directory.deleteUserByUsername).not.toHaveBeenCalled();
  });

  it("still deletes the directory user when the sub is missing (no queueing possible)", async () => {
    const c = ctx();
    (c.directory.listUsersByEmailPrefix as ReturnType<typeof vi.fn>).mockResolvedValue({
      users: [{ ...staleUser(1), sub: undefined }],
    });

    await runE2eSweeper(c as never);

    expect(c.deleteAccountQueue.send).not.toHaveBeenCalled();
    expect(c.directory.deleteUserByUsername).toHaveBeenCalled();
  });

  it("a queue-send failure is logged and the directory delete still happens", async () => {
    const c = ctx();
    (c.directory.listUsersByEmailPrefix as ReturnType<typeof vi.fn>).mockResolvedValue({
      users: [staleUser(1)],
    });
    (c.deleteAccountQueue.send as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("sqs down"),
    );

    await runE2eSweeper(c as never);

    expect(c.directory.deleteUserByUsername).toHaveBeenCalled();
    // Not counted as queued.
    expect((c.metrics as CapturingMetrics).emitted[0].metrics[0].value).toBe(0);
  });

  it("follows pagination but stops at the 20-page circuit breaker", async () => {
    const c = ctx();
    (c.directory.listUsersByEmailPrefix as ReturnType<typeof vi.fn>).mockResolvedValue({
      users: [],
      paginationToken: "more", // never exhausts
    });

    await runE2eSweeper(c as never);

    expect(c.directory.listUsersByEmailPrefix).toHaveBeenCalledTimes(20);
  });

  it("a listing failure is swallowed (logged) and the metric still emits", async () => {
    const c = ctx();
    (c.directory.listUsersByEmailPrefix as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("cognito down"),
    );

    const result = await runE2eSweeper(c as never);

    expect(result.acquired).toBe(true);
    expect((c.metrics as CapturingMetrics).emitted).toHaveLength(1);
    expect((c.logger.error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "Failed to list Cognito users",
    );
  });

  it("skips when the lock is held (single-fire, 300s TTL)", async () => {
    await makeKvCronLock(kv, { owner: "other", clock }).acquire("e2e-sweeper", 300);
    const c = ctx();

    const result = await runE2eSweeper(c as never);

    expect(result.acquired).toBe(false);
    expect(c.directory.listUsersByEmailPrefix).not.toHaveBeenCalled();
  });
});
