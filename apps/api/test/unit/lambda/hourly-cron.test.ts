/**
 * hourly-cron tests — focused on the stale-media reaper step (AR4).
 *
 * The reaper tests are BEHAVIORAL: the mocked Prisma client evaluates the
 * reaper's where clauses against seeded in-memory rows (test/unit/helpers/
 * fake-media-db.ts), so the assertions are on which rows SURVIVE the cron —
 * not on the shape of the query it issued.
 *
 * Bug being reproduced (architecture-review/02-architecture-traps.md §6.1):
 * async video uploads are born `lifecycle: "UPLOADED"` and nothing advanced
 * it, so this cron hard-deleted in-flight video rows (cascading their
 * MediaModerationJob records) one hour after upload — approved videos 404'd.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeFakeMediaDb,
  mediaRow,
  type FakeMediaRow,
} from "../helpers/fake-media-db.js";

// ---------------------------------------------------------------------------
// Mocks — hoisted seams for the cron's module-level clients
// ---------------------------------------------------------------------------

const { kvState, mockGetPrisma, mockBatchedPrune, mockOpsPrune, mockSingleMetric } =
  vi.hoisted(() => ({
    // WS-2 T3a: the lock now goes through the kv-provider seam (CronLock over
    // KvStore). A MemoryKvStore instance is swapped in per test.
    kvState: { kv: undefined as unknown },
    mockGetPrisma: vi.fn(),
    mockBatchedPrune: vi.fn(),
    mockOpsPrune: vi.fn(),
    mockSingleMetric: vi.fn(),
  }));

vi.mock("@aws-lambda-powertools/metrics", () => ({
  Metrics: class {
    singleMetric = mockSingleMetric;
  },
  MetricUnit: { Count: "Count" },
}));

vi.mock("../../../src/lib/kv/kv-provider.js", () => ({
  getKvStore: vi.fn(() => kvState.kv),
}));

vi.mock("../../../src/lib/lambda-prisma.js", () => ({
  getLambdaPrisma: mockGetPrisma,
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

// The generated Prisma client is not needed — the cron only uses the client
// instance returned by getLambdaPrisma — but the module imports the package,
// so keep the real import resolvable and cheap.

import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import { handler } from "../../../src/lambda/hourly-cron.js";

const HOUR = 3600000;

/** A Prisma-ish client: behavioral mediaFile + one expired security event. */
function makeDb(rows: FakeMediaRow[]) {
  return {
    ...makeFakeMediaDb(rows),
    securityEvent: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([{ id: "sec-1" }])
        .mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    // Open Social Web: the hourly cron also prunes expired EmailSubscription rows.
    emailSubscription: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe("hourly-cron handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvState.kv = new MemoryKvStore(); // fresh lock namespace → lock acquired
    mockSingleMetric.mockReturnValue({
      addDimension: vi.fn(),
      addMetric: vi.fn(),
    });
    // Non-zero so the cron's "pruned" logging branch is exercised.
    mockOpsPrune.mockResolvedValue({ deleted: 3, circuitBreakerTripped: false });
    // Drive the injected callbacks like the real batched helper (one batch):
    // the cron's findExpiredIds/deleteByIds closures are part of its surface.
    mockBatchedPrune.mockImplementation(
      async (opts: {
        findExpiredIds: (take: number) => Promise<string[]>;
        deleteByIds: (ids: string[]) => Promise<number>;
        batchSize: number;
      }) => {
        const ids = await opts.findExpiredIds(opts.batchSize);
        const deleted = ids.length > 0 ? await opts.deleteByIds(ids) : 0;
        return { deleted, circuitBreakerTripped: false };
      },
    );
  });

  it("skips the run entirely when the cron lock is held", async () => {
    await (kvState.kv as MemoryKvStore).putIfAbsent(
      "hourly",
      { lockedAt: Math.floor(Date.now() / 1000), owner: "other" },
      { ttlSeconds: 3600 },
    );

    await handler();

    // Lock-first, DB-second: a skipped fire opens NO DB connection.
    expect(mockGetPrisma).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // AR4 — reproduce-then-fix
  // -------------------------------------------------------------------------
  describe("AR4: stale-media reaper never deletes rows still inside the moderation pipeline", () => {
    it("a PENDING video row with an OPEN moderation job survives the cron at T+1h (and beyond)", async () => {
      const rows = [
        // In-flight: moderation started (open job), older than the legacy 1h
        // cutoff. Pre-fix the cron deleted this row; it MUST survive.
        mediaRow({
          id: "in-flight-open-job",
          lifecycle: "UPLOADED",
          createdAt: new Date(Date.now() - 2 * HOUR),
          moderationJobs: [{ decision: null }],
        }),
        // The open-job guard must hold independent of ANY age window.
        mediaRow({
          id: "in-flight-open-job-old",
          lifecycle: "UPLOADED",
          createdAt: new Date(Date.now() - 48 * HOUR),
          moderationJobs: [{ decision: null }],
        }),
        // All jobs resolved but uploadStatus not yet advanced (completion
        // worker mid-flight/crashed): deleting would destroy an approved
        // video + its moderation records — protected too.
        mediaRow({
          id: "resolved-jobs-not-yet-complete",
          lifecycle: "UPLOADED",
          createdAt: new Date(Date.now() - 48 * HOUR),
          moderationJobs: [{ decision: "approved" }, { decision: "approved" }],
        }),
      ];
      mockGetPrisma.mockResolvedValue(makeDb(rows));

      await handler();

      expect(rows.map((r) => r.id)).toEqual([
        "in-flight-open-job",
        "in-flight-open-job-old",
        "resolved-jobs-not-yet-complete",
      ]);
    });

    it("a jobless PENDING row younger than the reap window survives (queue-delayed processing is not abandonment)", async () => {
      const rows = [
        mediaRow({
          id: "young-jobless",
          lifecycle: "UPLOADED",
          createdAt: new Date(Date.now() - 2 * HOUR),
          moderationJobs: [],
        }),
      ];
      mockGetPrisma.mockResolvedValue(makeDb(rows));

      await handler();

      expect(rows.map((r) => r.id)).toEqual(["young-jobless"]);
    });

    it("still reaps genuinely abandoned uploads (jobless, older than the reap window) and leaves terminal rows alone", async () => {
      const rows = [
        mediaRow({
          id: "abandoned-pending",
          lifecycle: "UPLOADED",
          createdAt: new Date(Date.now() - 25 * HOUR),
          moderationJobs: [],
        }),
        mediaRow({
          id: "abandoned-failed",
          lifecycle: "UPLOAD_FAILED",
          createdAt: new Date(Date.now() - 25 * HOUR),
          moderationJobs: [],
        }),
        mediaRow({
          id: "complete-untouched",
          lifecycle: "APPROVED",
          createdAt: new Date(Date.now() - 25 * HOUR),
          moderationJobs: [{ decision: "approved" }],
        }),
      ];
      mockGetPrisma.mockResolvedValue(makeDb(rows));

      await handler();

      expect(rows.map((r) => r.id)).toEqual(["complete-untouched"]);
    });
  });

  it("soft-deletes orphaned media past the 24h grace period", async () => {
    const rows = [
      mediaRow({
        id: "orphaned-old",
        lifecycle: "APPROVED",
        createdAt: new Date(Date.now() - 30 * HOUR),
        attachedToPost: false,
        orphanedAt: new Date(Date.now() - 25 * HOUR),
        moderationJobs: [{ decision: "approved" }],
      }),
    ];
    mockGetPrisma.mockResolvedValue(makeDb(rows));

    await handler();

    expect(rows[0].deletedAt).not.toBeNull();
  });

  it("continues past a failing stale-media step (fail-open per-step error handling)", async () => {
    const db = makeDb([]);
    db.mediaFile.findMany = vi.fn().mockRejectedValue(new Error("db down"));
    mockGetPrisma.mockResolvedValue(db);

    await expect(handler()).resolves.toBeUndefined();
    // Later steps still ran.
    expect(mockBatchedPrune).toHaveBeenCalled();
  });

  it("survives a failing retention-prune step (emits the failure metric path)", async () => {
    mockBatchedPrune.mockRejectedValue(new Error("prune exploded"));
    mockGetPrisma.mockResolvedValue(makeDb([]));

    await expect(handler()).resolves.toBeUndefined();
  });

  it("survives a failing orphaned-media step", async () => {
    const db = makeDb([]);
    db.mediaFile.updateMany = vi.fn().mockRejectedValue(new Error("update failed"));
    mockGetPrisma.mockResolvedValue(db);

    await expect(handler()).resolves.toBeUndefined();
    expect(mockBatchedPrune).toHaveBeenCalled(); // later steps still ran
  });

  it("survives a failing interaction-event prune (fails the metric, not the cron)", async () => {
    mockOpsPrune.mockRejectedValue(new Error("ops prune exploded"));
    mockGetPrisma.mockResolvedValue(makeDb([]));

    await expect(handler()).resolves.toBeUndefined();
  });

  it("logs and flags a tripped retention circuit breaker (deleted=0, tripped=true)", async () => {
    mockBatchedPrune.mockResolvedValue({ deleted: 0, circuitBreakerTripped: true });
    mockOpsPrune.mockResolvedValue({ deleted: 0, circuitBreakerTripped: true });
    mockGetPrisma.mockResolvedValue(makeDb([]));

    await expect(handler()).resolves.toBeUndefined();
  });

  it("stays quiet when nothing was pruned (deleted=0, tripped=false)", async () => {
    mockBatchedPrune.mockResolvedValue({ deleted: 0, circuitBreakerTripped: false });
    mockOpsPrune.mockResolvedValue({ deleted: 0, circuitBreakerTripped: false });
    mockGetPrisma.mockResolvedValue(makeDb([]));

    await expect(handler()).resolves.toBeUndefined();
  });

  it("survives a metrics-emit failure (metrics are fail-open)", async () => {
    mockSingleMetric.mockImplementation(() => {
      throw new Error("EMF emit failed");
    });
    mockGetPrisma.mockResolvedValue(makeDb([]));

    await expect(handler()).resolves.toBeUndefined();
  });
});
