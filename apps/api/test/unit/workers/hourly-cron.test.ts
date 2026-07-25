/**
 * Unit tests — `lib/workers/hourly-cron.ts` core (WS-2 T3a).
 *
 * Focus: the MetricsPort emission contract (one grouped emit per table with
 * the Table dimension — what keeps the AWS EMF byte-identical) and the
 * lock/skip + fail-open step behavior. The full behavioral reaper coverage
 * lives in test/unit/lambda/hourly-cron.test.ts (through the entrypoint).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import { makeKvCronLock } from "../../../src/lib/workers/cron-lock.js";
import { runHourlyCron } from "../../../src/lib/workers/hourly-cron.js";
import { CapturingMetrics } from "../../../src/lib/workers/metrics-port.js";
import type { Logger } from "../../../src/lib/logger.js";

const { mockBatchedPrune, mockOpsPrune } = vi.hoisted(() => ({
  mockBatchedPrune: vi.fn(),
  mockOpsPrune: vi.fn(),
}));

vi.mock("../../../src/lib/graph/postgres/interaction-events.js", () => ({
  batchedPruneExpired: mockBatchedPrune,
  resolveInteractionEventConfig: vi.fn(() => ({
    pruneBatchSize: 10,
    pruneMaxIterations: 2,
  })),
  InteractionEventOps: class {
    prune = mockOpsPrune;
  },
}));

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

function makeDb() {
  return {
    mediaFile: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    securityEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    emailSubscription: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe("runHourlyCron", () => {
  let now: number;
  let kv: MemoryKvStore;
  const clock = () => now;

  beforeEach(() => {
    vi.clearAllMocks();
    now = 1_700_000_000_000;
    kv = new MemoryKvStore({ now: clock });
    mockBatchedPrune.mockResolvedValue({ deleted: 2, circuitBreakerTripped: false });
    mockOpsPrune.mockResolvedValue({ deleted: 3, circuitBreakerTripped: false });
  });

  function ctx(overrides: Record<string, unknown> = {}) {
    return {
      getDb: async () => makeDb() as never,
      logger: makeLogger(),
      metrics: new CapturingMetrics(),
      cronLock: makeKvCronLock(kv, { owner: "A", clock }),
      clock,
      configSource: {},
      ...overrides,
    };
  }

  it("emits ONE grouped metric blob per table with the Table dimension (EMF parity)", async () => {
    const metrics = new CapturingMetrics();
    const result = await runHourlyCron(ctx({ metrics }) as never);

    expect(result.acquired).toBe(true);
    expect(metrics.emitted).toHaveLength(3);
    const tables = metrics.emitted.map((e) => e.dimensions.Table);
    expect(tables).toEqual(["SecurityEvent", "EmailSubscription", "InteractionEvent"]);
    for (const e of metrics.emitted) {
      expect(e.metrics.map((m) => m.name)).toEqual([
        "Pruned",
        "PruneFailed",
        "PruneCircuitBreakerTripped",
      ]);
    }
    // Happy path: PruneFailed = 0 everywhere, Pruned carries the counts.
    expect(metrics.emitted[0].metrics[0].value).toBe(2);
    expect(metrics.emitted[2].metrics[0].value).toBe(3);
    expect(metrics.emitted.every((e) => e.metrics[1].value === 0)).toBe(true);
  });

  it("a failing prune step emits PruneFailed=1 for THAT table and the cron continues", async () => {
    mockBatchedPrune
      .mockRejectedValueOnce(new Error("security prune down")) // SecurityEvent
      .mockResolvedValueOnce({ deleted: 0, circuitBreakerTripped: false }); // EmailSubscription
    const metrics = new CapturingMetrics();

    const result = await runHourlyCron(ctx({ metrics }) as never);
    expect(result.acquired).toBe(true);

    const security = metrics.emitted.find((e) => e.dimensions.Table === "SecurityEvent")!;
    expect(security.metrics.find((m) => m.name === "PruneFailed")?.value).toBe(1);
    const interaction = metrics.emitted.find((e) => e.dimensions.Table === "InteractionEvent")!;
    expect(interaction.metrics.find((m) => m.name === "PruneFailed")?.value).toBe(0);
  });

  it("a tripped circuit breaker is flagged on the metric", async () => {
    mockOpsPrune.mockResolvedValue({ deleted: 0, circuitBreakerTripped: true });
    const metrics = new CapturingMetrics();

    await runHourlyCron(ctx({ metrics }) as never);

    const interaction = metrics.emitted.find((e) => e.dimensions.Table === "InteractionEvent")!;
    expect(
      interaction.metrics.find((m) => m.name === "PruneCircuitBreakerTripped")?.value,
    ).toBe(1);
  });

  it("skips (no DB connection) when the lock is held", async () => {
    await makeKvCronLock(kv, { owner: "other", clock }).acquire("hourly", 3600);
    const getDb = vi.fn();
    const logger = makeLogger();

    const result = await runHourlyCron(ctx({ getDb, logger }) as never);

    expect(result.acquired).toBe(false);
    expect(getDb).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("Hourly cron already running, skipping");
  });

  it("a metrics-port throw is swallowed (fail-open)", async () => {
    const throwing = {
      emitCounts: vi.fn(() => {
        throw new Error("metrics down");
      }),
    };
    await expect(runHourlyCron(ctx({ metrics: throwing }) as never)).resolves.toEqual({
      acquired: true,
    });
  });
});
