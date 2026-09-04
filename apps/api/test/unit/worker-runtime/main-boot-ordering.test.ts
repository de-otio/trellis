/**
 * WS-2 test-critique finding 5 — main.ts boot ORDERING.
 *
 * startup-validation.test.ts proves the validator fails closed, but nothing
 * proved main() runs it BEFORE constructing/starting the pollers. A refactor
 * that started pollers first (or in parallel with validation) would pass
 * every existing suite while letting an unkeyed container consume GDPR
 * deletion messages until the crash.
 *
 * This suite mounts main()'s real composition with the boundary modules
 * mocked (secret resolvers, transports, health/shutdown side-effects) and
 * proves: a throwing validator ⇒ main() rejects with the startup error and
 * ZERO queue clients are built, ZERO pollers are constructed/started, ZERO
 * `queue.receive` calls happen — plus the green-path sanity that with valid
 * secrets the pollers DO start (so the failure case isn't vacuous).
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLambdaPrisma: vi.fn(),
  resolvePseudonymSecret: vi.fn(),
  deleteUserData: vi.fn(),
  deleteStagingObjects: vi.fn(),
  makeDefaultSqsClient: vi.fn(() => ({ __sqs: true })),
  makeSqsQueueClient: vi.fn(() => ({
    receive: vi.fn().mockResolvedValue([]),
    deleteMessage: vi.fn(),
  })),
  pollerStart: vi.fn(),
  pollerStop: vi.fn().mockResolvedValue(undefined),
  pollerInstances: [] as unknown[],
  schedulerStart: vi.fn(),
  schedulerStop: vi.fn(),
  startHealthServer: vi.fn(),
  installShutdownHandlers: vi.fn(),
  closeDefaultResources: vi.fn(),
  getKvStore: vi.fn(() => ({ __kv: true })),
  resolveKvProvider: vi.fn(() => "dynamo"),
  getKvSqlExecutor: vi.fn(() => undefined),
}));

vi.mock("../../../src/lib/logger.js", () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));
vi.mock("../../../src/lib/lambda-prisma.js", () => ({
  getLambdaPrisma: mocks.getLambdaPrisma,
  // KV url falls back to the resolved app-DB connection string when no explicit
  // KV_DATABASE_URL/DATABASE_URL is set (same source as getLambdaPrisma).
  resolveDbConnectionString: vi
    .fn()
    .mockResolvedValue("postgresql://u:p@h:5432/db"),
}));
vi.mock("../../../src/lib/services/user-data-deletion.js", () => ({
  resolvePseudonymSecret: mocks.resolvePseudonymSecret,
  deleteUserData: mocks.deleteUserData,
}));
vi.mock("../../../src/lib/media/staging-object-cleanup.js", () => ({
  deleteStagingObjects: mocks.deleteStagingObjects,
}));
vi.mock("../../../src/lib/kv/kv-provider.js", () => ({
  getKvStore: mocks.getKvStore,
  resolveKvProvider: mocks.resolveKvProvider,
  getKvSqlExecutor: mocks.getKvSqlExecutor,
  setKvSqlExecutor: vi.fn(),
  makeKvSqlExecutor: vi.fn(),
}));
vi.mock("../../../../worker/src/consumer.js", () => ({
  QueuePoller: class {
    constructor(...args: unknown[]) {
      mocks.pollerInstances.push(args);
    }
    start = mocks.pollerStart;
    stop = mocks.pollerStop;
    get inFlightCount(): number {
      return 0;
    }
  },
}));
vi.mock("../../../../worker/src/sqs-queue-client.js", () => ({
  makeDefaultSqsClient: mocks.makeDefaultSqsClient,
  makeSqsQueueClient: mocks.makeSqsQueueClient,
}));
vi.mock("../../../../worker/src/scheduler.js", () => ({
  CronScheduler: class {
    start = mocks.schedulerStart;
    stop = mocks.schedulerStop;
  },
}));
vi.mock("../../../../worker/src/health.js", () => ({
  startHealthServer: mocks.startHealthServer,
}));
vi.mock("../../../../worker/src/shutdown.js", () => ({
  installShutdownHandlers: mocks.installShutdownHandlers,
  closeDefaultResources: mocks.closeDefaultResources,
}));

import { main } from "../../../../worker/src/main.js";
import { StartupValidationError } from "../../../../worker/src/startup-validation.js";

// Park the nightly cron: this suite proves boot ORDERING (validation before
// pollers), not port wiring. With nightly enabled, assertNightlyPortsWired
// correctly refuses to boot without an identity-admin port (plan 015 WS-B),
// which would fail the green-path sanity for reasons unrelated to ordering.
// The guard itself is covered by nightly-ports-guard.test.ts.
const PRIOR_DISABLED_CRONS = process.env.WORKER_DISABLED_CRONS;
process.env.WORKER_DISABLED_CRONS = "nightly";

afterEach(() => {
  vi.clearAllMocks();
  mocks.pollerInstances.length = 0;
});

afterAll(() => {
  if (PRIOR_DISABLED_CRONS === undefined) {
    delete process.env.WORKER_DISABLED_CRONS;
  } else {
    process.env.WORKER_DISABLED_CRONS = PRIOR_DISABLED_CRONS;
  }
});

describe("main() boot ordering (critic F5)", () => {
  it("GATE: a failing secret validation ⇒ pollers are NEVER built or started, zero receive calls", async () => {
    mocks.getLambdaPrisma.mockRejectedValue(new Error("db secret unresolvable"));
    mocks.resolvePseudonymSecret.mockResolvedValue(""); // empty ⇒ validation failure

    await expect(main()).rejects.toThrow(StartupValidationError);

    // Validation failed BEFORE any consumption machinery existed:
    expect(mocks.makeDefaultSqsClient).not.toHaveBeenCalled();
    expect(mocks.makeSqsQueueClient).not.toHaveBeenCalled();
    expect(mocks.pollerInstances).toHaveLength(0);
    expect(mocks.pollerStart).not.toHaveBeenCalled();
    // No queue client was ever constructed ⇒ zero queue.receive calls.
    for (const result of mocks.makeSqsQueueClient.mock.results) {
      expect((result.value as { receive: ReturnType<typeof vi.fn> }).receive)
        .not.toHaveBeenCalled();
    }
    // And none of the later composition ran either:
    expect(mocks.schedulerStart).not.toHaveBeenCalled();
    expect(mocks.startHealthServer).not.toHaveBeenCalled();
  });

  it("sanity (non-vacuous): with valid secrets the SAME composition builds and starts the pollers", async () => {
    mocks.getLambdaPrisma.mockResolvedValue({
      $queryRaw: vi.fn().mockResolvedValue([1]),
    });
    mocks.resolvePseudonymSecret.mockResolvedValue("valid-tombstone-key");

    await expect(main()).resolves.toBeUndefined();

    expect(mocks.makeSqsQueueClient).toHaveBeenCalled();
    expect(mocks.pollerInstances.length).toBeGreaterThan(0);
    expect(mocks.pollerStart).toHaveBeenCalledTimes(mocks.pollerInstances.length);
    expect(mocks.schedulerStart).toHaveBeenCalled();
  });
});
