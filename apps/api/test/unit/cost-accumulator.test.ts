/**
 * Unit Tests: Cost Accumulator — behavior-comparison suite (WS-1 §3.1).
 *
 * The pre-port suite mocked `@aws-sdk/client-dynamodb` and asserted the raw
 * `ADD` UpdateItem shape. Post-port the flush uses `KvStore.increment`, so this
 * suite injects a `MemoryKvStore` and asserts OUTCOME equivalence: buffering,
 * atomic flush (counters summed), re-buffer on error, daily-summary reads, and
 * over-budget classification.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore, type KvStore } from "@de-otio/saas-foundation/kv";
import {
  CostAccumulator,
  type CostLimitsConfig,
  __setCostStoreForTest,
} from "../../src/lib/cost-accumulator.js";

let store: MemoryKvStore;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe("CostAccumulator", () => {
  let accumulator: CostAccumulator;
  let config: CostLimitsConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
    CostAccumulator.resetInstance();
    store = new MemoryKvStore({ now: () => Date.now() });
    __setCostStoreForTest(store);
    config = { dailyTotal: 10, dailyPerService: { openai: 5, ses: 2 } };
    accumulator = new CostAccumulator(config);
  });

  afterEach(() => {
    vi.useRealTimers();
    CostAccumulator.resetInstance();
    __setCostStoreForTest(null);
  });

  describe("record", () => {
    it("buffers events without writing to the store", async () => {
      accumulator.record({ service: "openai", operation: "moderation", units: 1 });
      accumulator.record({ service: "sqs", operation: "send-message", units: 3 });
      expect(await store.get(`${today()}:openai`)).toBeNull();
    });

    it("never throws", () => {
      expect(() => {
        accumulator.record({ service: "openai", operation: "moderation", units: 1 });
      }).not.toThrow();
    });
  });

  describe("forceFlush", () => {
    it("writes buffered events to the store (atomic add)", async () => {
      accumulator.record({ service: "openai", operation: "moderation", units: 5 });
      accumulator.record({ service: "sqs", operation: "send-message", units: 3 });
      await accumulator.forceFlush();
      const openai = await store.get<{ units: number }>(`${today()}:openai`);
      const sqs = await store.get<{ units: number }>(`${today()}:sqs`);
      expect(openai?.value.units).toBe(5);
      expect(sqs?.value.units).toBe(3);
    });

    it("aggregates repeated events for one service:operation before flushing", async () => {
      accumulator.record({ service: "openai", operation: "moderation", units: 1 });
      accumulator.record({ service: "openai", operation: "moderation", units: 1 });
      accumulator.record({ service: "openai", operation: "moderation", units: 1 });
      await accumulator.forceFlush();
      const rec = await store.get<{ units: number }>(`${today()}:openai`);
      expect(rec?.value.units).toBe(3);
    });

    it("clears the buffer after a successful flush", async () => {
      accumulator.record({ service: "openai", operation: "moderation", units: 5 });
      await accumulator.forceFlush();
      await accumulator.forceFlush(); // no-op
      const rec = await store.get<{ units: number }>(`${today()}:openai`);
      expect(rec?.value.units).toBe(5); // not double-counted
    });

    it("re-buffers events on a store failure and retries on the next flush", async () => {
      let fail = true;
      const flaky: KvStore = {
        ...store,
        increment: (k: string, f: string, d: number, o?: unknown) => {
          if (fail) {
            fail = false;
            return Promise.reject(new Error("DynamoDB error"));
          }
          return store.increment(k, f, d, o as never);
        },
      } as unknown as KvStore;
      __setCostStoreForTest(flaky);

      accumulator.record({ service: "openai", operation: "moderation", units: 5 });
      await accumulator.forceFlush(); // first flush fails, re-buffers
      await accumulator.forceFlush(); // retry succeeds
      const rec = await store.get<{ units: number }>(`${today()}:openai`);
      expect(rec?.value.units).toBe(5);
    });

    it("is a no-op when the buffer is empty", async () => {
      await accumulator.forceFlush();
      expect(await store.get(`${today()}:s3`)).toBeNull();
    });

    it("performs a set-once TTL add (counter grows, value persists)", async () => {
      accumulator.record({ service: "s3", operation: "put-object", units: 10 });
      await accumulator.forceFlush();
      const rec = await store.get<{ units: number }>(`${today()}:s3`);
      expect(rec?.value.units).toBe(10);
      expect(rec?.expiresAt).toBeDefined();
    });
  });

  describe("getDailySummary", () => {
    async function seed(service: string, units: number): Promise<void> {
      await store.increment(`${today()}:${service}`, "units", units, { ttlSeconds: 172800 });
    }

    it("returns estimated costs by service", async () => {
      await seed("openai", 100);
      await seed("ses", 1000);
      await seed("sqs", 5000);
      await seed("s3", 200);
      await seed("dynamodb", 10000);

      const summary = await accumulator.getDailySummary();
      expect(summary.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(summary.limit).toBe(10);
      expect(summary.estimatedTotal).toBeGreaterThan(0);
      expect(summary.services.openai).toBeGreaterThan(0);
    });

    it("returns zeros when no data exists", async () => {
      const summary = await accumulator.getDailySummary();
      expect(summary.estimatedTotal).toBe(0);
      for (const cost of Object.values(summary.services)) {
        expect(cost).toBe(0);
      }
    });

    it("handles store errors gracefully (returns zeros, does not throw)", async () => {
      const failing: KvStore = {
        ...store,
        get: () => Promise.reject(new Error("DynamoDB error")),
      } as unknown as KvStore;
      __setCostStoreForTest(failing);
      const summary = await accumulator.getDailySummary();
      expect(summary.estimatedTotal).toBe(0);
    });
  });

  describe("isOverBudget", () => {
    async function seed(service: string, units: number): Promise<void> {
      await store.increment(`${today()}:${service}`, "units", units, { ttlSeconds: 172800 });
    }

    it("returns exceeded when total exceeds the limit", async () => {
      await seed("openai", 50000); // $50 > $10 total
      const result = await accumulator.isOverBudget();
      expect(result.exceeded).toBe(true);
      expect(result.services).toContain("total");
    });

    it("returns exceeded for a specific service over its limit", async () => {
      await seed("openai", 6000); // $6 > $5 openai limit, < $10 total
      const result = await accumulator.isOverBudget();
      expect(result.exceeded).toBe(true);
      expect(result.services).toContain("openai");
    });

    it("returns not exceeded when under limits", async () => {
      await seed("openai", 1);
      const result = await accumulator.isOverBudget();
      expect(result.exceeded).toBe(false);
      expect(result.services).toHaveLength(0);
    });
  });

  describe("singleton", () => {
    it("returns the same instance", () => {
      const a = CostAccumulator.getInstance(config);
      const b = CostAccumulator.getInstance();
      expect(a).toBe(b);
    });

    it("creates a new instance after reset", () => {
      const a = CostAccumulator.getInstance(config);
      CostAccumulator.resetInstance();
      const b = CostAccumulator.getInstance(config);
      expect(a).not.toBe(b);
    });

    it("clears a pending flush timer on reset without error", () => {
      const inst = CostAccumulator.getInstance(config);
      inst.record({ service: "openai", operation: "moderation", units: 1 });
      CostAccumulator.resetInstance();
    });
  });
});
