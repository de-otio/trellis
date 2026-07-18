/**
 * Unit Tests: OpenAI Budget — behavior-comparison suite (WS-1 §3.2).
 *
 * The pre-port suite mocked `@aws-sdk/client-dynamodb`. Post-port the counters
 * use `KvStore.increment` (return-new) + `KvStore.get`, so this suite injects a
 * `MemoryKvStore` and asserts OUTCOME equivalence: allow/block on the hourly and
 * daily limits, fail-open on store error, set-once TTL, and status reads.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore, type KvStore } from "@de-otio/saas-foundation/kv";
import {
  OpenAiBudget,
  type OpenAiBudgetConfig,
  __setOpenAiBudgetStoreForTest,
} from "../../src/lib/openai-budget.js";

let store: MemoryKvStore;

function hourlyKey(): string {
  return `openai:hourly:${new Date().toISOString().slice(0, 13)}`;
}
function dailyKey(): string {
  return `openai:daily:${new Date().toISOString().slice(0, 10)}`;
}

describe("OpenAiBudget", () => {
  let config: OpenAiBudgetConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
    store = new MemoryKvStore({ now: () => Date.now() });
    __setOpenAiBudgetStoreForTest(store);
    config = { enabled: true, maxRequestsPerHour: 100, maxRequestsPerDay: 500 };
  });

  afterEach(() => {
    vi.useRealTimers();
    __setOpenAiBudgetStoreForTest(null);
  });

  describe("tryConsume", () => {
    it("allows calls when under budget and increments both counters", async () => {
      const budget = new OpenAiBudget(config);
      expect(await budget.tryConsume()).toBe(true);
      expect((await store.get<{ count: number }>(hourlyKey()))?.value.count).toBe(1);
      expect((await store.get<{ count: number }>(dailyKey()))?.value.count).toBe(1);
    });

    it("blocks when the hourly limit is exceeded and does not touch the daily counter", async () => {
      await store.increment(hourlyKey(), "count", 100, { ttlSeconds: 7200 });
      const budget = new OpenAiBudget(config);
      expect(await budget.tryConsume()).toBe(false);
      // The daily counter was never incremented.
      expect(await store.get(dailyKey())).toBeNull();
    });

    it("blocks when the daily limit is exceeded", async () => {
      await store.increment(hourlyKey(), "count", 49, { ttlSeconds: 7200 });
      await store.increment(dailyKey(), "count", 500, { ttlSeconds: 172800 });
      const budget = new OpenAiBudget(config);
      expect(await budget.tryConsume()).toBe(false);
    });

    it("allows a call at exactly the limit", async () => {
      await store.increment(hourlyKey(), "count", 99, { ttlSeconds: 7200 });
      await store.increment(dailyKey(), "count", 99, { ttlSeconds: 172800 });
      const budget = new OpenAiBudget(config);
      expect(await budget.tryConsume()).toBe(true); // 100 and 100, neither > limit
    });

    it("fails open when the store errors", async () => {
      const failing: KvStore = {
        ...store,
        increment: () => Promise.reject(new Error("DynamoDB unavailable")),
      } as unknown as KvStore;
      __setOpenAiBudgetStoreForTest(failing);
      const budget = new OpenAiBudget(config);
      expect(await budget.tryConsume()).toBe(true);
    });

    it("bypasses all checks when disabled", async () => {
      config.enabled = false;
      const budget = new OpenAiBudget(config);
      expect(await budget.tryConsume()).toBe(true);
      expect(await store.get(hourlyKey())).toBeNull();
    });

    it("sets a ~2h set-once TTL on the hourly counter", async () => {
      const budget = new OpenAiBudget(config);
      await budget.tryConsume();
      const rec = await store.get<{ count: number }>(hourlyKey());
      const nowEpoch = Math.floor(Date.now() / 1000);
      expect(rec?.expiresAt).toBeGreaterThan(nowEpoch + 7195);
      expect(rec?.expiresAt).toBeLessThan(nowEpoch + 7205);
    });
  });

  describe("getStatus", () => {
    it("returns the current counters", async () => {
      await store.increment(hourlyKey(), "count", 42, { ttlSeconds: 7200 });
      await store.increment(dailyKey(), "count", 350, { ttlSeconds: 172800 });
      const budget = new OpenAiBudget(config);
      const status = await budget.getStatus();
      expect(status.hourlyUsed).toBe(42);
      expect(status.dailyUsed).toBe(350);
      expect(status.hourlyLimit).toBe(100);
      expect(status.dailyLimit).toBe(500);
      expect(status.exceeded).toBe(false);
    });

    it("reports exceeded when the hourly limit is reached", async () => {
      await store.increment(hourlyKey(), "count", 100, { ttlSeconds: 7200 });
      const budget = new OpenAiBudget(config);
      expect((await budget.getStatus()).exceeded).toBe(true);
    });

    it("reports exceeded when the daily limit is reached", async () => {
      await store.increment(dailyKey(), "count", 500, { ttlSeconds: 172800 });
      const budget = new OpenAiBudget(config);
      expect((await budget.getStatus()).exceeded).toBe(true);
    });

    it("returns zeros when disabled", async () => {
      config.enabled = false;
      const budget = new OpenAiBudget(config);
      const status = await budget.getStatus();
      expect(status.hourlyUsed).toBe(0);
      expect(status.dailyUsed).toBe(0);
      expect(status.exceeded).toBe(false);
    });

    it("returns zeros on a store error", async () => {
      const failing: KvStore = {
        ...store,
        get: () => Promise.reject(new Error("DynamoDB error")),
      } as unknown as KvStore;
      __setOpenAiBudgetStoreForTest(failing);
      const budget = new OpenAiBudget(config);
      const status = await budget.getStatus();
      expect(status.hourlyUsed).toBe(0);
      expect(status.exceeded).toBe(false);
    });

    it("handles missing counter items as zero", async () => {
      const budget = new OpenAiBudget(config);
      const status = await budget.getStatus();
      expect(status.hourlyUsed).toBe(0);
      expect(status.dailyUsed).toBe(0);
    });
  });
});
