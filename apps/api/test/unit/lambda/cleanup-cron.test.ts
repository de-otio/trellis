/**
 * Unit Tests: Cleanup Cron Lambda (thin AWS entrypoint, WS-2 T2)
 *
 * The lock now goes through the kv-provider (`getKvStore("cron")` →
 * DynamoKvStore on AWS) + the CronLock wrapper. This suite substitutes a
 * MemoryKvStore at the provider seam and asserts the entrypoint's outcomes
 * are unchanged: run on acquire, silent skip on held lock, void return.
 * (DynamoDB-conditional-put outcome equivalence is proven separately in
 * test/unit/workers/cron-dynamo-behavior.test.ts.)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";

const state = vi.hoisted(() => ({
  kv: undefined as unknown,
}));

vi.mock("../../../src/lib/kv/kv-provider.js", () => ({
  getKvStore: vi.fn(() => state.kv),
}));

describe("CleanupCron Lambda", () => {
  let kv: MemoryKvStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    kv = new MemoryKvStore();
    state.kv = kv;
  });

  async function loadHandler() {
    const mod = await import("../../../src/lambda/cleanup-cron.js");
    return mod.handler;
  }

  it("should acquire lock and run cleanup successfully", async () => {
    const handler = await loadHandler();

    await expect(handler()).resolves.toBeUndefined();
    // The lock item was written to the cron namespace.
    expect(await kv.get("cleanup")).not.toBeNull();
  });

  it("should skip execution when lock is already held (another execution running)", async () => {
    // Another holder owns a live lock.
    await kv.putIfAbsent("cleanup", { lockedAt: Math.floor(Date.now() / 1000), owner: "other" }, {
      ttlSeconds: 300,
    });

    const handler = await loadHandler();

    // Should not throw — just skip.
    await expect(handler()).resolves.toBeUndefined();
    // The other holder's lock is untouched.
    const rec = await kv.get<{ owner: string }>("cleanup");
    expect(rec?.value.owner).toBe("other");
  });

  it("should be idempotent — multiple invocations are safe", async () => {
    const handler = await loadHandler();

    await handler();
    await handler(); // second call inside the TTL window: skips silently

    expect(await kv.get("cleanup")).not.toBeNull();
  });

  it("should return void (no return value)", async () => {
    const handler = await loadHandler();
    const result = await handler();

    expect(result).toBeUndefined();
  });
});
