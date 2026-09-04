/**
 * Unit Tests: Discovery Exposure Counters — behavior-comparison suite (WS-1 §3.3).
 *
 * The pre-port suite asserted the raw DynamoDB `ADD` command shape. Post-port
 * the counter uses `KvStore.increment` (no TTL — durable), so this suite injects
 * a `MemoryKvStore` and asserts OUTCOME equivalence: correct composite key,
 * per-entity increments, NO ttl (durable, sweep-safe — F10), the privacy key
 * shape, and the fire-and-forget failure path. Handler wiring is unchanged.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore, type KvStore } from "@de-otio/saas-foundation/kv";
import type { Env } from "../../src/env.js";

const { mockGraphService } = vi.hoisted(() => ({
  mockGraphService: { getRecommendations: vi.fn() },
}));

vi.mock("../../src/lib/graph", () => ({
  createGraphServiceFromEnv: vi.fn().mockResolvedValue(mockGraphService),
}));

import {
  recordServedRecommendations,
  currentMonthBucket,
  __setDiscoveryExposureStoreForTest,
} from "../../src/lib/discovery-exposure.js";
import { DiscoveryHandler } from "../../src/lib/discovery-handler.js";

let store: MemoryKvStore;

describe("recordServedRecommendations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store = new MemoryKvStore();
    __setDiscoveryExposureStoreForTest(store);
  });

  afterEach(() => {
    __setDiscoveryExposureStoreForTest(null);
  });

  describe("success path", () => {
    it("increments the composite (month, entity) counter with NO ttl (durable — F10)", async () => {
      await recordServedRecommendations(["entity-abc"]);
      const bucket = currentMonthBucket();
      const rec = await store.get<{ count: number }>(`${bucket}:entity-abc`);
      expect(rec?.value.count).toBe(1);
      // Durable: no expiry, so the KV sweep (expires_at IS NOT NULL) never deletes it.
      expect(rec?.expiresAt).toBeUndefined();
    });

    it("issues one increment per entity in the list", async () => {
      await recordServedRecommendations(["entity-1", "entity-2", "entity-3"]);
      const bucket = currentMonthBucket();
      expect((await store.get<{ count: number }>(`${bucket}:entity-1`))?.value.count).toBe(1);
      expect((await store.get<{ count: number }>(`${bucket}:entity-2`))?.value.count).toBe(1);
      expect((await store.get<{ count: number }>(`${bucket}:entity-3`))?.value.count).toBe(1);
    });

    it("accumulates repeated exposures for the same entity", async () => {
      await recordServedRecommendations(["entity-x"]);
      await recordServedRecommendations(["entity-x"]);
      const bucket = currentMonthBucket();
      expect((await store.get<{ count: number }>(`${bucket}:entity-x`))?.value.count).toBe(2);
    });

    it("privacy invariant: the key encodes ONLY the month bucket + entityId", async () => {
      await recordServedRecommendations(["entity-priv"]);
      const now = new Date();
      const expectedBucket = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      // The only live key for this entity is `${bucket}:entity-priv` — no viewer/tenant.
      const rec = await store.get<{ count: number }>(`${expectedBucket}:entity-priv`);
      expect(rec?.value.count).toBe(1);
    });

    it("resolves immediately with no writes for an empty list", async () => {
      await recordServedRecommendations([]);
      const bucket = currentMonthBucket();
      expect(await store.get(`${bucket}:anything`)).toBeNull();
    });
  });

  describe("failure handling", () => {
    function failingStore(): KvStore {
      return { ...store, increment: () => Promise.reject(new Error("DynamoDB unavailable")) } as unknown as KvStore;
    }

    it("resolves (does not throw) when the store rejects", async () => {
      __setDiscoveryExposureStoreForTest(failingStore());
      await expect(recordServedRecommendations(["entity-fail"])).resolves.toBeUndefined();
    });

    it("logs a structured stderr line on failure (exposure.record.failure metric)", async () => {
      __setDiscoveryExposureStoreForTest(failingStore());
      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await recordServedRecommendations(["entity-metric"]);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(stderrSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(parsed.exposureRecordFailure).toBe(true);
      expect(parsed.metric).toBe("exposure.record.failure");
      expect(typeof parsed.error).toBe("string");
      stderrSpy.mockRestore();
    });

    it("resolves even when all entities fail", async () => {
      __setDiscoveryExposureStoreForTest(failingStore());
      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(recordServedRecommendations(["e1", "e2", "e3"])).resolves.toBeUndefined();
      stderrSpy.mockRestore();
    });
  });
});

describe("currentMonthBucket", () => {
  it("returns yyyy-mm format", () => {
    expect(currentMonthBucket(new Date("2026-06-15T12:00:00Z"))).toBe("2026-06");
  });
  it("zero-pads single-digit months", () => {
    expect(currentMonthBucket(new Date("2026-03-01T00:00:00Z"))).toBe("2026-03");
  });
  it("uses UTC month, not local time", () => {
    expect(currentMonthBucket(new Date("2026-01-31T23:59:59Z"))).toBe("2026-01");
  });
});

describe("DiscoveryHandler.handleGetRecommendations — exposure wiring", () => {
  let handler: DiscoveryHandler;
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new MemoryKvStore();
    __setDiscoveryExposureStoreForTest(store);
    handler = new DiscoveryHandler();
    mockEnv = { DATABASE_URL: "postgresql://test:test@localhost/test" } as unknown as Env;
  });

  afterEach(() => {
    __setDiscoveryExposureStoreForTest(null);
  });

  function makeSession(userId = "wiring-user-1") {
    return {
      userId,
      email: "u@example.com",
      role: "END_USER" as const,
      expiresAt: Date.now() + 3_600_000,
      sessionType: "user" as const,
      lastActivityAt: Date.now(),
    };
  }

  it("returns 200 with recommendations; an exposure-recording failure does not affect the response", async () => {
    const fakeRecs = [
      { entityId: "dog-1", confidence: 0.9, reason: "shared_connections" as const, sharedCount: 3 },
      { entityId: "dog-2", confidence: 0.7, reason: "same_breed" as const, sharedCount: 0 },
    ];
    mockGraphService.getRecommendations.mockResolvedValue(fakeRecs);
    __setDiscoveryExposureStoreForTest({
      ...store,
      increment: () => Promise.reject(new Error("DynamoDB throttled")),
    } as unknown as KvStore);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const request = new Request("https://api.example.com/api/discover/recommendations", { method: "GET" });
    const response = await handler.handleGetRecommendations(request, makeSession(), mockEnv, {} as any);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { recommendations: typeof fakeRecs };
    expect(body.recommendations).toEqual(fakeRecs);
    stderrSpy.mockRestore();
  });

  it("returns 200 with empty recommendations and no counter writes when graph returns []", async () => {
    mockGraphService.getRecommendations.mockResolvedValue([]);
    const request = new Request("https://api.example.com/api/discover/recommendations", { method: "GET" });
    const response = await handler.handleGetRecommendations(request, makeSession("wiring-user-2"), mockEnv, {} as any);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { recommendations: unknown[] };
    expect(body.recommendations).toEqual([]);
    // Empty list → no counter rows written.
    expect(await store.queryByIndex("any")).toEqual([]);
  });
});
