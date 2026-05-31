import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must use vi.hoisted so the variable is available in the vi.mock factory
const { mockExtensions } = vi.hoisted(() => ({
  mockExtensions: [] as any[],
}));

vi.mock("../../src/extensions", () => ({
  getExtensions: () => mockExtensions,
}));

// Mock extension-context
vi.mock("../../src/lib/extension-context", () => ({
  createExtensionContext: vi.fn((_ext, _env, _prisma) => ({
    db: {},
    appDomain: "test.com",
    appUrl: "https://test.com",
    stage: "test",
    config: {},
  })),
}));

import { dispatchHook, resetHookCircuitBreakers } from "../../src/lib/hook-dispatcher.js";

const mockEnv = { SESSION_SECRET: "secret" } as any;
const mockPrisma = {} as any;

describe("dispatchHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHookCircuitBreakers();
    mockExtensions.length = 0;
  });

  it("calls the hook with correct arguments", async () => {
    const onPostCreated = vi.fn();
    mockExtensions.push({
      id: "dog",
      hooks: { onPostCreated },
    });

    const post = { id: "post-1", title: "Hello" };
    await dispatchHook("onPostCreated", mockEnv, mockPrisma, post);

    expect(onPostCreated).toHaveBeenCalledTimes(1);
    expect(onPostCreated).toHaveBeenCalledWith(
      post,
      expect.objectContaining({ appDomain: "test.com" }),
    );
  });

  it("does nothing when no extensions are registered", async () => {
    await expect(
      dispatchHook("onPostCreated", mockEnv, mockPrisma, {}),
    ).resolves.not.toThrow();
  });

  it("does nothing when extension has no hooks", async () => {
    mockExtensions.push({ id: "dog" });
    await expect(
      dispatchHook("onPostCreated", mockEnv, mockPrisma, {}),
    ).resolves.not.toThrow();
  });

  it("does not fail the core operation when hook throws", async () => {
    const onPostCreated = vi.fn().mockRejectedValue(new Error("hook error"));
    mockExtensions.push({ id: "dog", hooks: { onPostCreated } });

    await expect(
      dispatchHook("onPostCreated", mockEnv, mockPrisma, {}),
    ).resolves.not.toThrow();
  });

  it("terminates hooks that exceed the timeout", async () => {
    const slowHook = vi.fn(
      () => new Promise((resolve) => setTimeout(resolve, 10_000)),
    );
    mockExtensions.push({ id: "dog", hooks: { onPostCreated: slowHook } });

    const start = Date.now();
    await dispatchHook("onPostCreated", mockEnv, mockPrisma, {});
    const elapsed = Date.now() - start;

    // Should complete in ~5s (timeout), not 10s
    expect(elapsed).toBeLessThan(7_000);
  }, 10_000);

  it("disables hook after consecutive failures (circuit breaker)", async () => {
    const failingHook = vi.fn().mockRejectedValue(new Error("fail"));
    mockExtensions.push({ id: "dog", hooks: { onPostCreated: failingHook } });

    // Fire 5 times to trigger circuit breaker
    for (let i = 0; i < 5; i++) {
      await dispatchHook("onPostCreated", mockEnv, mockPrisma, {});
    }
    expect(failingHook).toHaveBeenCalledTimes(5);

    // 6th call should be skipped (circuit breaker open)
    await dispatchHook("onPostCreated", mockEnv, mockPrisma, {});
    expect(failingHook).toHaveBeenCalledTimes(5); // still 5
  });

  it("resets circuit breaker on success", async () => {
    let callCount = 0;
    const sometimesFails = vi.fn(async () => {
      callCount++;
      if (callCount <= 3) throw new Error("fail");
    });
    mockExtensions.push({
      id: "dog",
      hooks: { onPostCreated: sometimesFails },
    });

    // Fail 3 times
    for (let i = 0; i < 3; i++) {
      await dispatchHook("onPostCreated", mockEnv, mockPrisma, {});
    }

    // 4th succeeds — resets counter
    await dispatchHook("onPostCreated", mockEnv, mockPrisma, {});

    // Should still be callable (circuit breaker was reset)
    await dispatchHook("onPostCreated", mockEnv, mockPrisma, {});
    expect(sometimesFails).toHaveBeenCalledTimes(5);
  });

  it("calls hooks from multiple extensions", async () => {
    const hook1 = vi.fn();
    const hook2 = vi.fn();
    mockExtensions.push(
      { id: "dog", hooks: { onPostCreated: hook1 } },
      { id: "plant", hooks: { onPostCreated: hook2 } },
    );

    await dispatchHook("onPostCreated", mockEnv, mockPrisma, {});

    expect(hook1).toHaveBeenCalledTimes(1);
    expect(hook2).toHaveBeenCalledTimes(1);
  });

  it("hook receives ExtensionContext, not raw Env", async () => {
    const onPostCreated = vi.fn();
    mockExtensions.push({ id: "dog", hooks: { onPostCreated } });

    await dispatchHook("onPostCreated", mockEnv, mockPrisma, {});

    const ctx = onPostCreated.mock.calls[0][1];
    expect(ctx).toHaveProperty("appDomain");
    expect(ctx).toHaveProperty("db");
    expect(ctx).toHaveProperty("config");
    expect(ctx).not.toHaveProperty("SESSION_SECRET");
    expect(ctx).not.toHaveProperty("DATABASE_URL");
  });
});
