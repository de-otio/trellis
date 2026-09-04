/**
 * ClaimsCache behavior-comparison suite (WS-1 §3.6, §6.1.4).
 *
 * The pre-port ClaimsCache asserted DynamoDB command SHAPES. Post-port, the
 * write path changed from a conditional PutItem to `putIfFresher` and the reads
 * to `KvStore.get` — so this suite asserts OUTCOME EQUIVALENCE (best-practice
 * split), not command identity: every observable result the DynamoDB-backed
 * cache produced (fresh hit / stale miss / missing-ttl miss / empty-field fill /
 * tenant-preference-past-ttl / monotonic-freshness swallow / transient rethrow)
 * is reproduced against a `MemoryKvStore`. The frozen clock drives both the
 * cache's `Date.now` (via fake timers) and the store's injected clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore, type KvStore } from "@de-otio/saas-foundation/kv";
import {
  ClaimsCache,
  DEFAULT_CACHE_TTL_SECONDS,
  type CachedClaims,
} from "../../src/lib/auth/claims-cache.js";

const sampleClaims: CachedClaims = {
  userId: "u_clxxx",
  globalRole: "B2B_PARTNER",
  activeTenantId: "t_clyyy",
  tenantSlug: "acme",
  tenantRole: "ADMIN",
  handle: "alice",
};

function makeCache(): { cache: ClaimsCache; store: MemoryKvStore } {
  const store = new MemoryKvStore({ now: () => Date.now() });
  return { cache: new ClaimsCache(store), store };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaimsCache.get", () => {
  it("returns null on a cache miss", async () => {
    const { cache } = makeCache();
    expect(await cache.get("sub-1")).toBeNull();
  });

  it("returns cached claims when the entry is fresh (ttl in the future)", async () => {
    const { cache } = makeCache();
    await cache.put("sub-1", sampleClaims, 1800);
    expect(await cache.get("sub-1")).toEqual(sampleClaims);
  });

  it("returns null once the entry's ttl is in the past (stale entry)", async () => {
    const { cache } = makeCache();
    await cache.put("sub-1", sampleClaims, 100);
    vi.advanceTimersByTime(101_000);
    expect(await cache.get("sub-1")).toBeNull();
  });

  it("fills missing string fields with empty strings", async () => {
    const { cache, store } = makeCache();
    // A partial record written directly (drift sentinel shape).
    await store.putIfFresher(
      "sub-1",
      { userId: "u_clxxx", globalRole: "END_USER" },
      { expiresAt: Math.floor(Date.now() / 1000) + 1800 },
    );
    expect(await cache.get("sub-1")).toEqual({
      userId: "u_clxxx",
      globalRole: "END_USER",
      activeTenantId: "",
      tenantSlug: "",
      tenantRole: "",
      handle: "",
    });
  });
});

describe("ClaimsCache.put", () => {
  it("writes with the default TTL when none specified (fresh for ~3600s)", async () => {
    const { cache } = makeCache();
    await cache.put("sub-1", sampleClaims);
    expect(await cache.get("sub-1")).toEqual(sampleClaims);
    // Just before the default TTL elapses it is still a hit...
    vi.advanceTimersByTime((DEFAULT_CACHE_TTL_SECONDS - 1) * 1000);
    expect(await cache.get("sub-1")).toEqual(sampleClaims);
    // ...and just after, a miss.
    vi.advanceTimersByTime(2_000);
    expect(await cache.get("sub-1")).toBeNull();
  });

  it("uses the provided TTL when given", async () => {
    const { cache } = makeCache();
    await cache.put("sub-1", sampleClaims, 60);
    vi.advanceTimersByTime(61_000);
    expect(await cache.get("sub-1")).toBeNull();
  });

  it("round-trips: put then get returns the same claims", async () => {
    const { cache } = makeCache();
    await cache.put("sub-1", sampleClaims, 600);
    expect(await cache.get("sub-1")).toEqual(sampleClaims);
  });

  it("swallows a not-fresher (stale) write without throwing — monotonic freshness (F2)", async () => {
    const { cache } = makeCache();
    // Fresh write with a long TTL.
    await cache.put("sub-1", sampleClaims, 3600);
    // A concurrent write that resolves to an OLDER expiry must not overwrite,
    // and must not throw (best-effort cache).
    const stale: CachedClaims = { ...sampleClaims, tenantRole: "MEMBER" };
    await expect(cache.put("sub-1", stale, 60)).resolves.toBeUndefined();
    // The fresher entry survives.
    expect((await cache.get("sub-1"))?.tenantRole).toBe("ADMIN");
  });

  it("tenant-removal regression: a stale higher-privilege write cannot win after a fresher invalidating write (F2)", async () => {
    const { cache } = makeCache();
    // The invalidating write already landed with a NEWER expiry (viewer claim).
    await cache.put("sub-1", { ...sampleClaims, tenantRole: "MEMBER" }, 3600);
    // A stale higher-privilege claim the caller is mid-writing, shorter expiry.
    await cache.put("sub-1", { ...sampleClaims, tenantRole: "OWNER" }, 60);
    expect((await cache.get("sub-1"))?.tenantRole).toBe("MEMBER");
  });

  it("propagates transient backend errors (matches the pre-port non-conditional rethrow)", async () => {
    const throwingStore: KvStore = {
      ...new MemoryKvStore({ now: () => Date.now() }),
      putIfFresher: () => Promise.reject(new Error("network down")),
    } as unknown as KvStore;
    const cache = new ClaimsCache(throwingStore);
    await expect(cache.put("sub-1", sampleClaims)).rejects.toThrow("network down");
  });
});

describe("ClaimsCache.getActiveTenantPreference", () => {
  it("returns null on a cache miss", async () => {
    const { cache } = makeCache();
    expect(await cache.getActiveTenantPreference("sub-1")).toBeNull();
  });

  it("returns null when activeTenantId is empty/missing", async () => {
    const { cache } = makeCache();
    await cache.put("sub-1", { ...sampleClaims, activeTenantId: "" }, 1800);
    expect(await cache.getActiveTenantPreference("sub-1")).toBeNull();
  });

  it("returns the activeTenantId even when the ttl is in the past (includeExpired read)", async () => {
    const { cache } = makeCache();
    await cache.put("sub-1", { ...sampleClaims, activeTenantId: "t_chosen" }, 100);
    vi.advanceTimersByTime(101_000);
    // get() is now a miss, but the preference survives past TTL.
    expect(await cache.get("sub-1")).toBeNull();
    expect(await cache.getActiveTenantPreference("sub-1")).toBe("t_chosen");
  });

  it("returns the activeTenantId for a fresh entry", async () => {
    const { cache } = makeCache();
    await cache.put("sub-1", { ...sampleClaims, activeTenantId: "t_chosen" }, 1800);
    expect(await cache.getActiveTenantPreference("sub-1")).toBe("t_chosen");
  });
});

describe("ClaimsCache.invalidate", () => {
  it("removes the entry so the next get is a miss", async () => {
    const { cache } = makeCache();
    await cache.put("sub-1", sampleClaims, 1800);
    await cache.invalidate("sub-1");
    expect(await cache.get("sub-1")).toBeNull();
    // And the preference is gone too (row deleted, not just expired).
    expect(await cache.getActiveTenantPreference("sub-1")).toBeNull();
  });
});
