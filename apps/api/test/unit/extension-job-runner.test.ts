/**
 * Unit tests for the in-process extension job runner (O-1 §5.2/§12.4 item 2).
 *
 * Nondeterminism is pinned: the clock and uuid are injected, DynamoDB is a fake
 * that honors the two ConditionExpressions the runner uses (acquire:
 * `attribute_not_exists(pk) OR #ttl < :now`; release: `lockToken = :myToken`),
 * and the timeout test drives vitest fake timers. No wall-clock, no real AWS.
 */

import {
  DeleteItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  ExtensionJobDecl,
  ScopedDb,
  TenantId as ExtensionTenantId,
  TrellisExtension,
} from "@de-otio/trellis-extension-api";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type InternalJobContext,
  type JobLockDynamo,
  type JobRunnerDeps,
  JobTimeoutError,
  UndeclaredJobModelError,
  acquireJobLock,
  buildJobContext,
  jobLockPk,
  releaseJobLock,
  runJobOnce,
  scheduleIntervalMs,
  startExtensionJobRunners,
} from "../../src/lib/extension-job-runner.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** DynamoDB's conditional-check error — matched by `name`. */
class ConditionalCheckFailedException extends Error {
  constructor() {
    super("The conditional request failed");
    this.name = "ConditionalCheckFailedException";
  }
}

interface LockItem {
  pk: string;
  sk: string;
  ttl: number;
  lockedAt: number;
  lockToken: string;
}

/**
 * A fake DynamoDB honoring the exact ConditionExpressions the runner issues, so
 * lock semantics (single-flight, TTL expiry, token-guarded release) are really
 * exercised rather than stubbed.
 */
function makeFakeDynamo() {
  const store = new Map<string, LockItem>();
  const calls = { put: 0, delete: 0 };

  const dynamo = {
    async send(
      command: PutItemCommand | DeleteItemCommand,
    ): Promise<{ $metadata: Record<string, never> }> {
      if (command instanceof PutItemCommand) {
        calls.put++;
        const input = command.input;
        const item = unmarshall(input.Item ?? {}) as LockItem;
        const values = unmarshall(input.ExpressionAttributeValues ?? {});
        const nowVal = values[":now"] as number;
        const key = `${item.pk}|${item.sk}`;
        const existing = store.get(key);
        // attribute_not_exists(pk) OR #ttl < :now
        const passes = existing === undefined || existing.ttl < nowVal;
        if (!passes) throw new ConditionalCheckFailedException();
        store.set(key, item);
        return { $metadata: {} };
      }
      if (command instanceof DeleteItemCommand) {
        calls.delete++;
        const input = command.input;
        const dkey = unmarshall(input.Key ?? {}) as { pk: string; sk: string };
        const values = unmarshall(input.ExpressionAttributeValues ?? {});
        const myToken = values[":myToken"] as string;
        const key = `${dkey.pk}|${dkey.sk}`;
        const existing = store.get(key);
        // lockToken = :myToken
        if (existing === undefined || existing.lockToken !== myToken) {
          throw new ConditionalCheckFailedException();
        }
        store.delete(key);
        return { $metadata: {} };
      }
      throw new Error("unexpected command");
    },
  } as unknown as JobLockDynamo;

  return { dynamo, store, calls };
}

function silentLogger(): Pick<JobRunnerDeps["logger"], "info" | "error"> {
  return { info: () => {}, error: () => {} };
}

/** Monotonic uuid generator so each acquire gets a distinct lock token. */
function seqUuid(): () => string {
  let n = 0;
  return () => `token-${++n}`;
}

interface DepsOverrides {
  nowMs?: () => number;
  uuid?: () => string;
  timeoutSeconds?: number;
  marginSeconds?: number;
  readDelegateSource?: JobRunnerDeps["readDelegateSource"];
  scopedDbFactory?: JobRunnerDeps["scopedDbFactory"];
}

function makeDeps(
  dynamo: JobLockDynamo,
  overrides: DepsOverrides = {},
): JobRunnerDeps {
  return {
    dynamo,
    tableName: "test-trellis",
    now: overrides.nowMs ?? (() => 1_000_000),
    uuid: overrides.uuid ?? seqUuid(),
    readDelegateSource: overrides.readDelegateSource ?? (() => undefined),
    scopedDbFactory: overrides.scopedDbFactory,
    stage: "dev",
    logger: silentLogger(),
    timeoutSeconds: overrides.timeoutSeconds,
    marginSeconds: overrides.marginSeconds,
  };
}

function makeJob(overrides: Partial<ExtensionJobDecl> = {}): ExtensionJobDecl {
  return {
    id: "reminder-sweep",
    schedule: "daily",
    crossTenantRead: [],
    run: overrides.run ?? (async () => {}),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  it("jobLockPk namespaces by extension + job", () => {
    expect(jobLockPk("dogs", "reminder-sweep")).toBe("job:dogs:reminder-sweep");
  });

  it("scheduleIntervalMs: hourly < daily, both positive", () => {
    expect(scheduleIntervalMs("hourly")).toBe(3_600_000);
    expect(scheduleIntervalMs("daily")).toBe(86_400_000);
    expect(scheduleIntervalMs("hourly")).toBeLessThan(scheduleIntervalMs("daily"));
  });
});

// ---------------------------------------------------------------------------
// Single-flight
// ---------------------------------------------------------------------------

describe("single-flight under concurrent ticks", () => {
  it("only one of two concurrent ticks runs the body; the other skips", async () => {
    const { dynamo, calls } = makeFakeDynamo();
    const deps = makeDeps(dynamo, { uuid: seqUuid() });
    let bodyRuns = 0;
    const job = makeJob({ run: async () => { bodyRuns++; } });

    const outcomes = await Promise.all([
      runJobOnce(deps, "dogs", job),
      runJobOnce(deps, "dogs", job),
    ]);

    expect(bodyRuns).toBe(1);
    expect(outcomes.filter((o) => o === "ran")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "skipped")).toHaveLength(1);
    // Two acquire attempts, exactly one release (from the holder).
    expect(calls.put).toBe(2);
    expect(calls.delete).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lock lifecycle: TTL steal, crashed-holder recovery, skip-when-held
// ---------------------------------------------------------------------------

describe("lock lifecycle", () => {
  it("conditional release is a no-op after a TTL steal (anti lock-stealing)", async () => {
    const { dynamo, store, calls } = makeFakeDynamo();
    // Holder A acquires at t=1000s with a 300s timeout + 60s margin (ttl=1360s).
    const clockA = { ms: 1_000_000 };
    const depsA = makeDeps(dynamo, {
      nowMs: () => clockA.ms,
      uuid: () => "token-A",
      timeoutSeconds: 300,
      marginSeconds: 60,
    });
    const tokenA = await acquireJobLock(depsA, "dogs", "sweep");
    expect(tokenA).toBe("token-A");

    // Time jumps past A's ttl (1361s). Holder B legitimately re-acquires.
    const depsB = makeDeps(dynamo, {
      nowMs: () => 1_361_000,
      uuid: () => "token-B",
      timeoutSeconds: 300,
      marginSeconds: 60,
    });
    const tokenB = await acquireJobLock(depsB, "dogs", "sweep");
    expect(tokenB).toBe("token-B");

    // A finally tries to release its (long-dead) lock — must NOT delete B's.
    const released = await releaseJobLock(depsA, "dogs", "sweep", "token-A");
    expect(released).toBe(false);
    const held = store.get(`${jobLockPk("dogs", "sweep")}|lock`);
    expect(held?.lockToken).toBe("token-B");
    expect(calls.delete).toBe(1); // A's release attempt reached Dynamo (and no-op'd)
  });

  it("recovers a crashed holder's lock only after its TTL expires", async () => {
    const { dynamo } = makeFakeDynamo();
    // Holder A acquires and crashes (never releases). ttl = 1000 + 300 + 60.
    const depsA = makeDeps(dynamo, {
      nowMs: () => 1_000_000,
      uuid: () => "token-A",
      timeoutSeconds: 300,
      marginSeconds: 60,
    });
    expect(await acquireJobLock(depsA, "dogs", "sweep")).toBe("token-A");

    // Before expiry: another task cannot acquire.
    const depsEarly = makeDeps(dynamo, {
      nowMs: () => 1_359_000, // < ttl (1_360_000)
      uuid: () => "token-early",
    });
    expect(await acquireJobLock(depsEarly, "dogs", "sweep")).toBeNull();

    // After expiry: recovery succeeds.
    const depsLate = makeDeps(dynamo, {
      nowMs: () => 1_361_000, // > ttl
      uuid: () => "token-late",
    });
    expect(await acquireJobLock(depsLate, "dogs", "sweep")).toBe("token-late");
  });

  it("skips (and does not release) when the lock is already held", async () => {
    const { dynamo, calls } = makeFakeDynamo();
    const holder = makeDeps(dynamo, { uuid: () => "token-holder" });
    // Pre-acquire and hold (no release).
    expect(await acquireJobLock(holder, "dogs", "sweep")).toBe("token-holder");

    let bodyRuns = 0;
    const deps = makeDeps(dynamo, { uuid: () => "token-other" });
    const outcome = await runJobOnce(deps, "dogs", makeJob({
      id: "sweep",
      run: async () => { bodyRuns++; },
    }));

    expect(outcome).toBe("skipped");
    expect(bodyRuns).toBe(0);
    // Held lock: one prior put, the failed acquire, and NO delete (never held it).
    expect(calls.put).toBe(2);
    expect(calls.delete).toBe(0);
  });

  it("propagates a non-conditional acquire error as a skip (never crashes the tick)", async () => {
    const dynamo = {
      send: async () => { throw new Error("network down"); },
    } as unknown as JobLockDynamo;
    const deps = makeDeps(dynamo);
    let bodyRuns = 0;
    const outcome = await runJobOnce(deps, "dogs", makeJob({
      run: async () => { bodyRuns++; },
    }));
    expect(outcome).toBe("skipped");
    expect(bodyRuns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Timeout / abort
// ---------------------------------------------------------------------------

describe("timeout aborts the body", () => {
  it("aborts a hung body at the timeout and conditionally releases", async () => {
    vi.useFakeTimers();
    const { dynamo, calls } = makeFakeDynamo();
    const deps = makeDeps(dynamo, { timeoutSeconds: 2 });

    let observedAbort = false;
    const job = makeJob({
      // A body that never settles on its own — only the abort is observable.
      run: (ctx) =>
        new Promise<void>(() => {
          (ctx as InternalJobContext).signal.addEventListener("abort", () => {
            observedAbort = true;
          });
        }),
    });

    const p = runJobOnce(deps, "dogs", job);
    await vi.advanceTimersByTimeAsync(2000); // fire the 2s timeout
    const outcome = await p;

    expect(outcome).toBe("failed");
    expect(observedAbort).toBe(true);
    expect(calls.delete).toBe(1); // lock released despite the timeout
  });

  it("reports a thrown body as failed and still releases the lock", async () => {
    const { dynamo, calls } = makeFakeDynamo();
    const deps = makeDeps(dynamo);
    const outcome = await runJobOnce(deps, "dogs", makeJob({
      run: async () => { throw new Error("boom"); },
    }));
    expect(outcome).toBe("failed");
    expect(calls.delete).toBe(1);
  });

  it("JobTimeoutError carries the timeout budget", () => {
    const err = new JobTimeoutError(2000);
    expect(err).toBeInstanceOf(Error);
    expect(err.timeoutMs).toBe(2000);
    expect(err.name).toBe("JobTimeoutError");
  });
});

// ---------------------------------------------------------------------------
// Job context — built by construction
// ---------------------------------------------------------------------------

describe("job context (by construction)", () => {
  it("exposes ONLY the declared crossTenantRead models; undeclared are undefined", () => {
    const readDelegate = { findMany: async () => [], findFirst: async () => null, count: async () => 0, aggregate: async () => ({}), groupBy: async () => [] };
    const deps = makeDeps(makeFakeDynamo().dynamo, {
      readDelegateSource: (model) => (model === "dogReminder" ? readDelegate : undefined),
    });
    const job = makeJob({ crossTenantRead: ["dogReminder"] });
    const ctx = buildJobContext(deps, job, new AbortController().signal);

    expect(ctx.read.dogReminder).toBe(readDelegate);
    // Undeclared model is absent (null-prototype object → undefined, not a throw-on-read proxy).
    expect(ctx.read.dogDocument).toBeUndefined();
    expect(Object.keys(ctx.read)).toEqual(["dogReminder"]);
  });

  it("throws UndeclaredJobModelError when a declared model has no delegate", () => {
    const deps = makeDeps(makeFakeDynamo().dynamo, { readDelegateSource: () => undefined });
    const job = makeJob({ crossTenantRead: ["ghostModel"] });
    expect(() => buildJobContext(deps, job, new AbortController().signal)).toThrow(
      UndeclaredJobModelError,
    );
  });

  it("a job declaring an unavailable model fails the tick (and releases the lock)", async () => {
    const { dynamo, calls } = makeFakeDynamo();
    const deps = makeDeps(dynamo, { readDelegateSource: () => undefined });
    const outcome = await runJobOnce(deps, "dogs", makeJob({ crossTenantRead: ["ghostModel"] }));
    expect(outcome).toBe("failed");
    expect(calls.delete).toBe(1);
  });

  it("tenant() mints with 'job' provenance and delegates to the scoped-DB factory", () => {
    const scopedDb = { entity: {} } as unknown as ScopedDb;
    const factory = vi.fn((_tid: string) => scopedDb) as unknown as JobRunnerDeps["scopedDbFactory"];
    const deps = makeDeps(makeFakeDynamo().dynamo, { scopedDbFactory: factory });
    const ctx = buildJobContext(deps, makeJob(), new AbortController().signal);

    const result = ctx.tenant("tenant-abc" as unknown as ExtensionTenantId);
    expect(result).toBe(scopedDb);
    expect(factory).toHaveBeenCalledWith("tenant-abc");
  });

  it("tenant() rejects an invalid raw tenant id at the mint site", () => {
    const deps = makeDeps(makeFakeDynamo().dynamo, { scopedDbFactory: () => ({} as ScopedDb) });
    const ctx = buildJobContext(deps, makeJob(), new AbortController().signal);
    expect(() => ctx.tenant("bad id with spaces" as unknown as ExtensionTenantId)).toThrow();
  });

  it("tenant() throws when no scoped-DB factory is wired", () => {
    const deps = makeDeps(makeFakeDynamo().dynamo); // no scopedDbFactory
    const ctx = buildJobContext(deps, makeJob(), new AbortController().signal);
    expect(() => ctx.tenant("tenant-abc" as unknown as ExtensionTenantId)).toThrow(
      /scoped-DB factory not wired/,
    );
  });

  it("property: ctx.read keys equal exactly the declared model set", () => {
    const delegate = { findMany: async () => [], findFirst: async () => null, count: async () => 0, aggregate: async () => ({}), groupBy: async () => [] };
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }).filter((s) => s !== "__proto__"), { maxLength: 6 }),
        (models) => {
          const deps = makeDeps(makeFakeDynamo().dynamo, { readDelegateSource: () => delegate });
          const ctx = buildJobContext(deps, makeJob({ crossTenantRead: models }), new AbortController().signal);
          expect(new Set(Object.keys(ctx.read))).toEqual(new Set(models));
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Startup registration
// ---------------------------------------------------------------------------

describe("startExtensionJobRunners", () => {
  it("no-ops when no extension declares a job", () => {
    const deps = makeDeps(makeFakeDynamo().dynamo);
    const ext: TrellisExtension = { id: "dogs" } as TrellisExtension;
    const handle = startExtensionJobRunners(deps, [ext]);
    expect(handle.jobCount).toBe(0);
    handle.stop();
  });

  it("registers one recurring timer per declared job and stop() clears them", () => {
    vi.useFakeTimers();
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const deps = makeDeps(makeFakeDynamo().dynamo);
    const ext = {
      id: "dogs",
      jobs: [makeJob({ id: "a", schedule: "hourly" }), makeJob({ id: "b", schedule: "daily" })],
    } as unknown as TrellisExtension;

    const handle = startExtensionJobRunners(deps, [ext]);
    expect(handle.jobCount).toBe(2);
    expect(setInterval).toHaveBeenCalledTimes(2);
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 3_600_000);
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 86_400_000);

    handle.stop();
    expect(clearInterval).toHaveBeenCalledTimes(2);
  });

  it("a ticked job runs single-flight via the lock (fake-timer driven)", async () => {
    vi.useFakeTimers();
    const { dynamo, calls } = makeFakeDynamo();
    const deps = makeDeps(dynamo, { uuid: seqUuid() });
    let bodyRuns = 0;
    const ext = {
      id: "dogs",
      jobs: [makeJob({ id: "sweep", schedule: "hourly", run: async () => { bodyRuns++; } })],
    } as unknown as TrellisExtension;

    const handle = startExtensionJobRunners(deps, [ext]);
    await vi.advanceTimersByTimeAsync(3_600_000); // exactly one hourly tick
    handle.stop(); // clear the interval before it can fire again

    expect(bodyRuns).toBe(1);
    expect(calls.put).toBeGreaterThanOrEqual(1);
  });
});
