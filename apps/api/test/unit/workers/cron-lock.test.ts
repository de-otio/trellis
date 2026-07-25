/**
 * Unit tests — `lib/workers/cron-lock.ts` (WS-2 T2, X1 + finding 5).
 *
 * Uses WS-1's MemoryKvStore with an injected frozen clock, exactly as the
 * frozen-interface note in store-types.ts promises for WS-2's tests.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import {
  makeKvCronLock,
  withCronLock,
  type CronLockValue,
} from "../../../src/lib/workers/cron-lock.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

describe("makeKvCronLock", () => {
  let now: number;
  let kv: MemoryKvStore;
  const clock = () => now;

  beforeEach(() => {
    now = 1_700_000_000_000;
    kv = new MemoryKvStore({ now: clock });
  });

  it("acquire wins on a fresh key and refuses a concurrent second acquire", async () => {
    const a = makeKvCronLock(kv, { owner: "A", clock });
    const b = makeKvCronLock(kv, { owner: "B", clock });

    await expect(a.acquire("nightly", 3600)).resolves.toBe(true);
    await expect(b.acquire("nightly", 3600)).resolves.toBe(false);
    // Identical to today's "already running, skip".
  });

  it("acquire takes over an EXPIRED lock (overwriteExpired — the old `OR #ttl < :now` clause)", async () => {
    const a = makeKvCronLock(kv, { owner: "A", clock });
    const b = makeKvCronLock(kv, { owner: "B", clock });

    await a.acquire("cleanup", 300);
    now += 301_000; // past the TTL
    await expect(b.acquire("cleanup", 300)).resolves.toBe(true);
  });

  it("stores { lockedAt, owner } as the typed lock value", async () => {
    const a = makeKvCronLock(kv, { owner: "A", clock });
    await a.acquire("hourly", 3600);
    const rec = await kv.get<CronLockValue>("hourly");
    expect(rec?.value).toEqual({ lockedAt: Math.floor(now / 1000), owner: "A" });
    expect(rec?.expiresAt).toBe(Math.floor(now / 1000) + 3600);
  });

  it("refresh extends the holder's TTL (owner-fenced)", async () => {
    const a = makeKvCronLock(kv, { owner: "A", clock });
    await a.acquire("nightly", 30);
    now += 20_000;
    await expect(a.refresh("nightly", 30)).resolves.toBe(true);
    // After the refresh the lock survives past the ORIGINAL expiry.
    now += 20_000; // t=40s from acquire; original TTL 30s, refreshed at 20s → expires t=50s
    const b = makeKvCronLock(kv, { owner: "B", clock });
    await expect(b.acquire("nightly", 30)).resolves.toBe(false);
  });

  it("refresh returns FALSE after another owner took the expired lock (finding 5 fence)", async () => {
    const a = makeKvCronLock(kv, { owner: "A", clock });
    const b = makeKvCronLock(kv, { owner: "B", clock });
    await a.acquire("nightly", 30);
    now += 31_000; // A's lock expired
    await expect(b.acquire("nightly", 30)).resolves.toBe(true); // takeover
    await expect(a.refresh("nightly", 30)).resolves.toBe(false);
  });

  it("refresh returns FALSE when the lock vanished", async () => {
    const a = makeKvCronLock(kv, { owner: "A", clock });
    await expect(a.refresh("nightly", 30)).resolves.toBe(false);
  });

  it("refresh returns FALSE when the owner still matches but the version CAS loses (critic F6)", async () => {
    // The untested `result.applied === false` branch: between refresh's read
    // and its compareAndSet, a concurrent write bumps the version WITHOUT
    // changing the owner (e.g. another refresh heartbeat from a twin process
    // holding the same owner token, or any interleaved store write). The
    // owner fence passes but the version-guarded CAS must lose — refresh
    // returns false and the caller aborts.
    const a = makeKvCronLock(interceptedKv(), { owner: "A", clock });
    await expect(a.acquire("nightly", 30)).resolves.toBe(true);
    await expect(a.refresh("nightly", 30)).resolves.toBe(false);

    function interceptedKv(): typeof kv {
      // Delegate everything to the real MemoryKvStore, but bump the version
      // out-of-band (same value, same owner) right before the caller's CAS —
      // the classic read-modify-write race, made deterministic.
      return {
        get: (k: string, o?: unknown) => kv.get(k, o as never),
        putIfAbsent: (k: string, v: unknown, o?: unknown) =>
          kv.putIfAbsent(k, v, o as never),
        delete: (k: string, ver?: number) => kv.delete(k, ver as never),
        compareAndSet: async (k: string, expectedVersion: number, v: unknown, o?: unknown) => {
          const current = await kv.get<CronLockValue>(k, { consistent: true });
          if (current !== null) {
            // Out-of-band writer: same owner, same value — only the version moves.
            await kv.compareAndSet(k, current.version, current.value, { ttlSeconds: 999 });
          }
          return kv.compareAndSet(k, expectedVersion, v, o as never);
        },
      } as unknown as typeof kv;
    }
  });

  it("release deletes only the caller's own live lock", async () => {
    const a = makeKvCronLock(kv, { owner: "A", clock });
    const b = makeKvCronLock(kv, { owner: "B", clock });
    await a.acquire("e2e-sweeper", 300);
    await b.release("e2e-sweeper"); // not the owner — no-op
    expect(await kv.get("e2e-sweeper")).not.toBeNull();
    await a.release("e2e-sweeper");
    expect(await kv.get("e2e-sweeper")).toBeNull();
  });
});

describe("withCronLock", () => {
  let now: number;
  let kv: MemoryKvStore;
  const clock = () => now;

  beforeEach(() => {
    now = 1_700_000_000_000;
    kv = new MemoryKvStore({ now: clock });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips the body when the lock is held (single-fire)", async () => {
    const a = makeKvCronLock(kv, { owner: "A", clock });
    const b = makeKvCronLock(kv, { owner: "B", clock });
    await a.acquire("cleanup", 300);

    const body = vi.fn();
    const result = await withCronLock(b, "cleanup", 300, makeLogger(), body);
    expect(result.acquired).toBe(false);
    expect(body).not.toHaveBeenCalled();
  });

  it("treats an acquire ERROR as skip (old handlers' bare-catch semantics; fail-safe)", async () => {
    const broken = {
      acquire: vi.fn().mockRejectedValue(new Error("dynamo down")),
      refresh: vi.fn(),
      release: vi.fn(),
    };
    const body = vi.fn();
    const logger = makeLogger();
    const result = await withCronLock(broken, "cleanup", 300, logger, body);
    expect(result.acquired).toBe(false);
    expect(body).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("does NOT release on completion — a duplicate fire inside the TTL window still skips", async () => {
    const a = makeKvCronLock(kv, { owner: "A", clock });
    const r1 = await withCronLock(a, "hourly", 3600, makeLogger(), async () => {});
    expect(r1.acquired).toBe(true);
    // Second fire 1 minute later (duplicate EventBridge delivery): must skip.
    now += 60_000;
    const b = makeKvCronLock(kv, { owner: "B", clock });
    const body2 = vi.fn();
    const r2 = await withCronLock(b, "hourly", 3600, makeLogger(), body2);
    expect(r2.acquired).toBe(false);
    expect(body2).not.toHaveBeenCalled();
  });

  it("HEARTBEAT holds the lock across a body that runs longer than the initial TTL (finding 5a)", async () => {
    const a = makeKvCronLock(kv, { owner: "A", clock });
    const b = makeKvCronLock(kv, { owner: "B", clock });

    let finishBody!: () => void;
    const bodyDone = new Promise<void>((resolve) => (finishBody = resolve));
    const run = withCronLock(a, "nightly", 30, makeLogger(), async () => bodyDone);

    // Advance 60s (2× the initial TTL) in heartbeat-interval steps, advancing
    // the KV clock in lockstep with the timer wheel.
    for (let i = 0; i < 6; i++) {
      now += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);
      // A concurrent fire is refused THE WHOLE TIME.
      await expect(b.acquire("nightly", 30)).resolves.toBe(false);
    }

    finishBody();
    const result = await run;
    expect(result.acquired).toBe(true);
  });

  it("a FORCE-EXPIRED lock makes refresh return false and ABORTS the running body (finding 5)", async () => {
    const a = makeKvCronLock(kv, { owner: "A", clock });
    const b = makeKvCronLock(kv, { owner: "B", clock });

    const run = withCronLock(a, "nightly", 30, makeLogger(), async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    // Attach a handler immediately so the eventual rejection is never unhandled.
    const settled = run.then(
      () => ({ rejected: false as const }),
      (err: unknown) => ({ rejected: true as const, err }),
    );

    // Force-expire A's lock and let B take it over BEFORE A's next heartbeat.
    now += 31_000;
    await expect(b.acquire("nightly", 30)).resolves.toBe(true);

    // A's heartbeat fires → owner fence fails → body aborted.
    await vi.advanceTimersByTimeAsync(10_000);

    const outcome = await settled;
    expect(outcome.rejected).toBe(true);
    expect(String((outcome as { err?: unknown }).err)).toMatch(/lost mid-run/);
  });
});
