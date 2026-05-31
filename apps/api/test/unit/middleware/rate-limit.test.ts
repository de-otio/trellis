/**
 * Unit Tests: Rate Limiting Middleware
 *
 * After the limiter consolidation, `rateLimitMiddleware` is backed by the
 * foundation **token-bucket** limiter (the same one the auth path uses) rather
 * than a fixed-window counter over KV. These tests exercise the real
 * in-memory limiter (no `RATE_LIMIT_TABLE` configured → `MemoryTokenBucketLimiter`)
 * through the public middleware. Module-level limiter state is reset between
 * tests via `__resetRateLimiterForTests`.
 *
 * The S4.2 fail-closed/open posture on limiter failure is covered in
 * `s4-runtime-hardening.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { MiddlewareContext } from "../../../src/lib/middleware.js";
import { rateLimitMiddleware } from "../../../src/lib/middleware.js";
import { __resetRateLimiterForTests } from "../../../src/lib/rate-limit.js";

// Mock SessionManager — controls the caller identity used for bucket keying.
const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

function makeContext(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  return {
    request: new Request("https://example.com/api/test", {
      method: "POST",
      headers: { "CF-Connecting-IP": "192.168.1.1" },
    }),
    env: { DATABASE_URL: "postgresql://test", SESSION_SECRET: "s" } as unknown as Env,
    url: new URL("https://example.com/api/test"),
    pathname: "/api/test",
    method: "POST",
    ...overrides,
  };
}

describe("Rate Limiting Middleware (token-bucket)", () => {
  let mockNext: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the module-level (memory) limiter so buckets don't leak between tests.
    __resetRateLimiterForTests();
    mockNext = vi.fn(async () => new Response("OK", { status: 200 }));
    mockGetSession.mockResolvedValue({
      userId: "user-123",
      expiresAt: Date.now() + 3_600_000,
    });
  });

  describe("Basic limiting", () => {
    it("allows requests under the limit and calls next()", async () => {
      const middleware = rateLimitMiddleware({ maxRequests: 5, windowMs: 60_000 });
      const res = await middleware(makeContext(), mockNext);

      expect(res.status).toBe(200);
      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it("blocks the request once the bucket is exhausted (429)", async () => {
      const middleware = rateLimitMiddleware({ maxRequests: 2, windowMs: 60_000 });

      // capacity = 2: first two allowed, the third denied (refill over ms is ~0).
      expect((await middleware(makeContext(), mockNext)).status).toBe(200);
      expect((await middleware(makeContext(), mockNext)).status).toBe(200);

      const denied = await middleware(makeContext(), mockNext);
      expect(denied.status).toBe(429);
      expect(mockNext).toHaveBeenCalledTimes(2); // not called for the denied request

      const body = (await denied.json()) as { error: string; retryAfter: number };
      expect(body.error).toBe("Rate limit exceeded");
      expect(typeof body.retryAfter).toBe("number");
    });
  });

  describe("Rate limit headers", () => {
    it("adds X-RateLimit-* headers to successful responses", async () => {
      const middleware = rateLimitMiddleware({ maxRequests: 10, windowMs: 60_000 });
      const res = await middleware(makeContext(), mockNext);

      expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
      // One token consumed → 9 remaining.
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("9");
      expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
    });

    it("sets Retry-After and remaining=0 on the 429", async () => {
      const middleware = rateLimitMiddleware({ maxRequests: 1, windowMs: 60_000 });
      await middleware(makeContext(), mockNext); // consume the only token
      const denied = await middleware(makeContext(), mockNext);

      expect(denied.status).toBe(429);
      expect(denied.headers.get("Retry-After")).toBeTruthy();
      expect(denied.headers.get("X-RateLimit-Limit")).toBe("1");
      expect(denied.headers.get("X-RateLimit-Remaining")).toBe("0");
    });
  });

  describe("Caller identity / bucket keying", () => {
    it("keys by userId — different users get independent buckets", async () => {
      const middleware = rateLimitMiddleware({ maxRequests: 1, windowMs: 60_000 });

      mockGetSession.mockResolvedValue({ userId: "alice" });
      expect((await middleware(makeContext(), mockNext)).status).toBe(200);
      expect((await middleware(makeContext(), mockNext)).status).toBe(429); // alice exhausted

      mockGetSession.mockResolvedValue({ userId: "bob" });
      expect((await middleware(makeContext(), mockNext)).status).toBe(200); // bob unaffected
    });

    it("falls back to IP when there is no session", async () => {
      mockGetSession.mockResolvedValue(null);
      const middleware = rateLimitMiddleware({ maxRequests: 1, windowMs: 60_000 });

      expect((await middleware(makeContext(), mockNext)).status).toBe(200);
      // Same IP, bucket now empty.
      expect((await middleware(makeContext(), mockNext)).status).toBe(429);
    });

    it("still limits when session retrieval throws (IP fallback)", async () => {
      mockGetSession.mockRejectedValue(new Error("session error"));
      const middleware = rateLimitMiddleware({ maxRequests: 1, windowMs: 60_000 });

      expect((await middleware(makeContext(), mockNext)).status).toBe(200);
      expect((await middleware(makeContext(), mockNext)).status).toBe(429);
    });
  });

  describe("Configuration", () => {
    it("defaults to maxRequests=20", async () => {
      const middleware = rateLimitMiddleware();
      const res = await middleware(makeContext(), mockNext);
      expect(res.headers.get("X-RateLimit-Limit")).toBe("20");
    });
  });
});
