/**
 * Unit tests for the in-process extension job runner (O-1 §5.2/§12.4 item 2).
 *
 * Nondeterminism is pinned: the clock and uuid are injected, DynamoDB is a fake
 * that honors the two ConditionExpressions the runner uses (acquire:
 * `attribute_not_exists(pk) OR #ttl < :now`; release: `lockToken = :myToken`),
 * and the timeout test drives vitest fake timers. No wall-clock, no real AWS.
 */

import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
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

/** The MemoryKvStore key for a lock (the segment after the `job` prefix). */
function lockKey(extId: string, jobId: string): string {
  return `${extId}:${jobId}`;
}

/**
 * A real `MemoryKvStore` bound to a shared clock, so lock semantics
 * (single-flight, TTL expiry via `putIfAbsent`/`overwriteExpired`, version-
 * guarded release) are actually exercised rather than stubbed. The clock is
 * shared with the runner's injected `now` so frozen-clock takeover is
 * deterministic.
 */
function makeStore(now: () => number = () => 1_000_000): MemoryKvStore {
  return new MemoryKvStore({ now });
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
  kvStore: MemoryKvStore,
  overrides: DepsOverrides = {},
): JobRunnerDeps {
  return {
    kvStore,
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
    const store = makeStore();
    const deps = makeDeps(store);
    let bodyRuns = 0;
    const job = makeJob({ run: async () => { bodyRuns++; } });

    const outcomes = await Promise.all([
      runJobOnce(deps, "dogs", job),
      runJobOnce(deps, "dogs", job),
    ]);

    expect(bodyRuns).toBe(1);
    expect(outcomes.filter((o) => o === "ran")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "skipped")).toHaveLength(1);
    // The holder released its lock; nothing is held afterwards.
    expect(await store.get(lockKey("dogs", job.id))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lock lifecycle: TTL steal, crashed-holder recovery, skip-when-held
// ---------------------------------------------------------------------------

describe("lock lifecycle", () => {
  it("conditional release is a no-op after a TTL steal (anti lock-stealing)", async () => {
    // Holder A acquires at t=1000s with a 300s timeout + 60s margin (ttl=1360s).
    const clock = { ms: 1_000_000 };
    const store = makeStore(() => clock.ms);
    const deps = makeDeps(store, {
      nowMs: () => clock.ms,
      timeoutSeconds: 300,
      marginSeconds: 60,
    });
    const tokenA = await acquireJobLock(deps, "dogs", "sweep");
    expect(tokenA).not.toBeNull();

    // Time jumps past A's ttl (1361s). The lock is now expired → legitimate
    // re-acquire (expired-takeover bumps the version → a new token).
    clock.ms = 1_361_000;
    const tokenB = await acquireJobLock(deps, "dogs", "sweep");
    expect(tokenB).not.toBeNull();
    expect(tokenB).not.toBe(tokenA);

    // A finally tries to release its (long-dead) lock — version mismatch → no-op.
    const released = await releaseJobLock(deps, "dogs", "sweep", tokenA!);
    expect(released).toBe(false);
    const held = await store.get(lockKey("dogs", "sweep"));
    expect(held).not.toBeNull();
    expect(String(held!.version)).toBe(tokenB);
  });

  it("recovers a crashed holder's lock only after its TTL expires", async () => {
    const clock = { ms: 1_000_000 };
    const store = makeStore(() => clock.ms);
    // Holder A acquires and crashes (never releases). ttl = 1000 + 300 + 60.
    const deps = makeDeps(store, {
      nowMs: () => clock.ms,
      timeoutSeconds: 300,
      marginSeconds: 60,
    });
    expect(await acquireJobLock(deps, "dogs", "sweep")).not.toBeNull();

    // Before expiry: another task cannot acquire.
    clock.ms = 1_359_000; // < ttl (1_360_000)
    expect(await acquireJobLock(deps, "dogs", "sweep")).toBeNull();

    // After expiry: recovery succeeds.
    clock.ms = 1_361_000; // > ttl
    expect(await acquireJobLock(deps, "dogs", "sweep")).not.toBeNull();
  });

  it("skips (and does not release) when the lock is already held", async () => {
    const store = makeStore();
    const holder = makeDeps(store);
    // Pre-acquire and hold (no release).
    expect(await acquireJobLock(holder, "dogs", "sweep")).not.toBeNull();

    let bodyRuns = 0;
    const deps = makeDeps(store);
    const outcome = await runJobOnce(deps, "dogs", makeJob({
      id: "sweep",
      run: async () => { bodyRuns++; },
    }));

    expect(outcome).toBe("skipped");
    expect(bodyRuns).toBe(0);
    // The held lock is still present — the skipper never held it, so never released it.
    expect(await store.get(lockKey("dogs", "sweep"))).not.toBeNull();
  });

  it("propagates a non-conditional acquire error as a skip (never crashes the tick)", async () => {
    const store = makeStore();
    const throwing = {
      ...store,
      putIfAbsent: () => Promise.reject(new Error("network down")),
    } as unknown as MemoryKvStore;
    const deps = makeDeps(throwing);
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
    const store = makeStore();
    const deps = makeDeps(store, { timeoutSeconds: 2 });

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
    // Lock released despite the timeout.
    expect(await store.get(lockKey("dogs", "reminder-sweep"))).toBeNull();
  });

  it("reports a thrown body as failed and still releases the lock", async () => {
    const store = makeStore();
    const deps = makeDeps(store);
    const outcome = await runJobOnce(deps, "dogs", makeJob({
      run: async () => { throw new Error("boom"); },
    }));
    expect(outcome).toBe("failed");
    expect(await store.get(lockKey("dogs", "reminder-sweep"))).toBeNull();
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
    const deps = makeDeps(makeStore(), {
      readDelegateSource: (model) => (model === "dogReminder" ? readDelegate : undefined),
    });
    const job = makeJob({ crossTenantRead: ["dogReminder"] });
    const ctx = buildJobContext(deps, job, new AbortController().signal);

    // A read-only facade (not the raw delegate) whose read methods delegate through.
    expect(typeof ctx.read.dogReminder.findMany).toBe("function");
    // Undeclared model is absent (null-prototype object → undefined, not a throw-on-read proxy).
    expect(ctx.read.dogDocument).toBeUndefined();
    expect(Object.keys(ctx.read)).toEqual(["dogReminder"]);
  });

  it("SECURITY (Finding 1): write methods on the raw delegate are NOT reachable via ctx.read", () => {
    // A raw Prisma delegate carries write methods; the facade must strip them so a
    // job body cannot perform an unscoped cross-tenant write.
    let wrote = false;
    const rawDelegate = {
      findMany: async () => [{ id: "row" }],
      findFirst: async () => null,
      count: async () => 0,
      aggregate: async () => ({}),
      groupBy: async () => [],
      deleteMany: async () => { wrote = true; return { count: 999 }; },
      create: async () => { wrote = true; return {}; },
      update: async () => { wrote = true; return {}; },
    };
    const deps = makeDeps(makeStore(), {
      readDelegateSource: (model) => (model === "dogReminder" ? rawDelegate : undefined),
    });
    const ctx = buildJobContext(deps, makeJob({ crossTenantRead: ["dogReminder"] }), new AbortController().signal);

    const surface = ctx.read.dogReminder as unknown as Record<string, unknown>;
    expect(surface.deleteMany).toBeUndefined();
    expect(surface.create).toBeUndefined();
    expect(surface.update).toBeUndefined();
    // The read path still works and delegates to the raw object.
    expect(typeof surface.findMany).toBe("function");
    expect(wrote).toBe(false);
  });

  it("throws UndeclaredJobModelError when a declared model has no delegate", () => {
    const deps = makeDeps(makeStore(), { readDelegateSource: () => undefined });
    const job = makeJob({ crossTenantRead: ["ghostModel"] });
    expect(() => buildJobContext(deps, job, new AbortController().signal)).toThrow(
      UndeclaredJobModelError,
    );
  });

  it("a job declaring an unavailable model fails the tick (and releases the lock)", async () => {
    const store = makeStore();
    const deps = makeDeps(store, { readDelegateSource: () => undefined });
    const outcome = await runJobOnce(deps, "dogs", makeJob({ id: "ghost", crossTenantRead: ["ghostModel"] }));
    expect(outcome).toBe("failed");
    // Lock acquired then released even though the context build failed.
    expect(await store.get(lockKey("dogs", "ghost"))).toBeNull();
  });

  it("tenant() mints with 'job' provenance and delegates to the scoped-DB factory", () => {
    const scopedDb = { entity: {} } as unknown as ScopedDb;
    const factory = vi.fn((_tid: string) => scopedDb) as unknown as JobRunnerDeps["scopedDbFactory"];
    const deps = makeDeps(makeStore(), { scopedDbFactory: factory });
    const ctx = buildJobContext(deps, makeJob(), new AbortController().signal);

    const result = ctx.tenant("tenant-abc" as unknown as ExtensionTenantId);
    expect(result).toBe(scopedDb);
    expect(factory).toHaveBeenCalledWith("tenant-abc");
  });

  it("tenant() rejects an invalid raw tenant id at the mint site", () => {
    const deps = makeDeps(makeStore(), { scopedDbFactory: () => ({} as ScopedDb) });
    const ctx = buildJobContext(deps, makeJob(), new AbortController().signal);
    expect(() => ctx.tenant("bad id with spaces" as unknown as ExtensionTenantId)).toThrow();
  });

  it("tenant() throws when no scoped-DB factory is wired", () => {
    const deps = makeDeps(makeStore()); // no scopedDbFactory
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
          const deps = makeDeps(makeStore(), { readDelegateSource: () => delegate });
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
    const deps = makeDeps(makeStore());
    const ext: TrellisExtension = { id: "dogs" } as TrellisExtension;
    const handle = startExtensionJobRunners(deps, [ext]);
    expect(handle.jobCount).toBe(0);
    handle.stop();
  });

  it("registers one recurring timer per declared job and stop() clears them", () => {
    vi.useFakeTimers();
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const deps = makeDeps(makeStore());
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
    const store = makeStore();
    const deps = makeDeps(store);
    let bodyRuns = 0;
    const ext = {
      id: "dogs",
      jobs: [makeJob({ id: "sweep", schedule: "hourly", run: async () => { bodyRuns++; } })],
    } as unknown as TrellisExtension;

    const handle = startExtensionJobRunners(deps, [ext]);
    await vi.advanceTimersByTimeAsync(3_600_000); // exactly one hourly tick
    handle.stop(); // clear the interval before it can fire again

    expect(bodyRuns).toBe(1);
    // The single tick acquired and released the lock.
    expect(await store.get(lockKey("dogs", "sweep"))).toBeNull();
  });
});
