/**
 * WORKER_ENABLED_QUEUES — queue selection at the composition root.
 *
 * Mounts main() with the boundary modules mocked (same shape as
 * main-boot-ordering.test.ts) and asserts which queues get a poller. A
 * rejection from main() is what the entrypoint turns into a non-zero exit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  resolveDbConnectionString: vi.fn().mockResolvedValue("postgresql://u:p@h:5432/db"),
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
vi.mock("../../../../worker/src/health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../worker/src/health.js")>()),
  startHealthServer: mocks.startHealthServer,
}));
vi.mock("../../../../worker/src/shutdown.js", () => ({
  installShutdownHandlers: mocks.installShutdownHandlers,
  closeDefaultResources: mocks.closeDefaultResources,
}));

import { main } from "../../../../worker/src/main.js";
import { QueueSelectionError } from "../../../../worker/src/queue-selection.js";
import {
  __resetMediaProcessingDeps,
  setMediaProcessingDeps,
  type MediaProcessingDeps,
} from "../../../src/lib/workers/media-processing.js";

const ENV_KEYS = ["WORKER_ENABLED_QUEUES", "WORKER_DISABLED_CRONS", "ACTIVITYPUB_ENABLED"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Park the nightly cron (needs an identity port; unrelated to queue selection).
  process.env.WORKER_DISABLED_CRONS = "nightly";
  delete process.env.WORKER_ENABLED_QUEUES;
  delete process.env.ACTIVITYPUB_ENABLED;
  mocks.getLambdaPrisma.mockResolvedValue({ $queryRaw: vi.fn().mockResolvedValue([1]) });
  mocks.resolvePseudonymSecret.mockResolvedValue("valid-tombstone-key");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetMediaProcessingDeps();
  vi.clearAllMocks();
  mocks.pollerInstances.length = 0;
});

/** Queue names the composition handed to a QueuePoller (3rd ctor arg). */
function polledQueues(): string[] {
  return (mocks.pollerInstances as Array<[unknown, unknown, { queueName: string }]>)
    .map((args) => args[2].queueName)
    .sort();
}

function expectNothingStarted(): void {
  expect(mocks.getLambdaPrisma).not.toHaveBeenCalled();
  expect(mocks.makeDefaultSqsClient).not.toHaveBeenCalled();
  expect(mocks.pollerInstances).toHaveLength(0);
  expect(mocks.pollerStart).not.toHaveBeenCalled();
  expect(mocks.schedulerStart).not.toHaveBeenCalled();
}

describe("main() WORKER_ENABLED_QUEUES", () => {
  it("unset, no media deps ⇒ boots and the media queues are not consumed", async () => {
    await expect(main()).resolves.toBeUndefined();

    const queues = polledQueues();
    expect(queues).not.toContain("media-processing");
    expect(queues).not.toContain("media-completion");
    // Everything else an existing deployment runs is unchanged (federation is
    // off by default and stays skipped).
    expect(queues).toEqual(
      ["delete-account", "followers-events", "link-check", "user-export"].sort(),
    );
  });

  it("unset, processing deps injected ⇒ media-processing is consumed, media-completion still is not", async () => {
    setMediaProcessingDeps({} as MediaProcessingDeps);
    await expect(main()).resolves.toBeUndefined();
    expect(polledQueues()).toContain("media-processing");
    expect(polledQueues()).not.toContain("media-completion");
  });

  it("set to a media queue with no deps ⇒ rejects with a clear message, nothing started", async () => {
    process.env.WORKER_ENABLED_QUEUES = "media-completion";
    const err = await main().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(QueueSelectionError);
    expect((err as Error).message).toMatch(/media-completion/);
    expect((err as Error).message).toMatch(/dependencies are not wired/);
    expectNothingStarted();
  });

  it("set to an unknown name ⇒ rejects naming it, nothing started", async () => {
    process.env.WORKER_ENABLED_QUEUES = "link-check, no-such-queue";
    const err = await main().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(QueueSelectionError);
    expect((err as Error).message).toMatch(/no-such-queue/);
    expectNothingStarted();
  });

  it("set to a subset ⇒ only those queues are polled", async () => {
    process.env.WORKER_ENABLED_QUEUES = "link-check,followers-events";
    await expect(main()).resolves.toBeUndefined();
    expect(polledQueues()).toEqual(["followers-events", "link-check"]);
    expect(mocks.pollerStart).toHaveBeenCalledTimes(2);
  });

  it("set to a media queue whose deps ARE wired ⇒ consumed", async () => {
    setMediaProcessingDeps({} as MediaProcessingDeps);
    process.env.WORKER_ENABLED_QUEUES = "media-processing";
    await expect(main()).resolves.toBeUndefined();
    expect(polledQueues()).toEqual(["media-processing"]);
  });
});
