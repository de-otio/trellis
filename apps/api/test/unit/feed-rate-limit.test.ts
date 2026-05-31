/**
 * Unit Tests: Feed Route Rate Limiting
 *
 * Tests that the RateLimiter class enforces per-user rate limits correctly
 * for the /api/feeds/home and /api/feeds/dog routes.
 *
 * Rate limit configuration (matching feeds.ts):
 *   - 30 requests per 60 seconds
 *   - Keyed by userId (sessionId is omitted; userId takes priority)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RateLimiter,
  __resetRateLimiterForTests,
} from "../../src/lib/rate-limit.js";

// The async (KV) path now uses a module-level foundation token-bucket
// limiter selected from env. With no RATE_LIMIT_TABLE configured it is an
// in-memory MemoryTokenBucketLimiter whose bucket state is shared across
// RateLimiter instances; reset it between tests for isolation.
beforeEach(() => {
  __resetRateLimiterForTests();
});
afterEach(() => {
  __resetRateLimiterForTests();
});

// Minimal Request factory. The RateLimiter only reads headers when falling
// back to IP-based keying; since we always supply a userId in these tests
// the URL and method are irrelevant.
function makeRequest(ip = "127.0.0.1"): Request {
  return new Request("https://api.example.com/api/feeds/home", {
    headers: { "CF-Connecting-IP": ip },
  });
}

// Helper that mirrors exactly the applyRateLimit call made in feeds.ts for
// a given endpoint so that tests stay in sync with production code.
function applyFeedRateLimit(
  rateLimiter: RateLimiter,
  request: Request,
  endpoint: string,
  userId: string,
): Response | null {
  return rateLimiter.applyRateLimit(
    request,
    endpoint,
    30,   // 30 requests
    60,   // per 60 seconds
    undefined, // no sessionId (Session type does not expose one)
    undefined, // no email
    userId,
  );
}

describe("Feed route rate limiting", () => {
  describe("/api/feeds/home", () => {
    it("allows requests that are under the limit", () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const userId = "user-home-under-limit";

      // Make 30 requests — all should be allowed (limit is 30 per 60 s).
      for (let i = 0; i < 30; i++) {
        const result = applyFeedRateLimit(
          rateLimiter,
          request,
          "/api/feeds/home",
          userId,
        );
        expect(result).toBeNull();
      }
    });

    it("returns a 429 response when the limit is exceeded", async () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const userId = "user-home-over-limit";

      // Exhaust the 30-request allowance.
      for (let i = 0; i < 30; i++) {
        applyFeedRateLimit(rateLimiter, request, "/api/feeds/home", userId);
      }

      // The 31st request must be rejected.
      const result = applyFeedRateLimit(
        rateLimiter,
        request,
        "/api/feeds/home",
        userId,
      );

      expect(result).not.toBeNull();
      expect(result!.status).toBe(429);
      expect(result!.headers.get("content-type")).toContain("application/json");
      expect(result!.headers.get("Retry-After")).not.toBeNull();
      expect(result!.headers.get("X-RateLimit-Limit")).toBe("30");
      expect(result!.headers.get("X-RateLimit-Remaining")).toBe("0");

      const body = await result!.json() as { error: string; retryAfter: number };
      expect(body.error).toBe("Rate limit exceeded");
      expect(typeof body.retryAfter).toBe("number");
    });

    it("counts requests independently for different users", () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const userA = "user-home-independent-a";
      const userB = "user-home-independent-b";

      // Exhaust userA's allowance completely.
      for (let i = 0; i < 30; i++) {
        applyFeedRateLimit(rateLimiter, request, "/api/feeds/home", userA);
      }

      // userA should now be rate limited.
      const userAResult = applyFeedRateLimit(
        rateLimiter,
        request,
        "/api/feeds/home",
        userA,
      );
      expect(userAResult).not.toBeNull();
      expect(userAResult!.status).toBe(429);

      // userB has made no requests, so they must still be allowed.
      const userBResult = applyFeedRateLimit(
        rateLimiter,
        request,
        "/api/feeds/home",
        userB,
      );
      expect(userBResult).toBeNull();
    });
  });

  describe("/api/feeds/dog", () => {
    it("allows requests that are under the limit", () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const userId = "user-dog-under-limit";

      for (let i = 0; i < 30; i++) {
        const result = applyFeedRateLimit(
          rateLimiter,
          request,
          "/api/feeds/dog",
          userId,
        );
        expect(result).toBeNull();
      }
    });

    it("returns a 429 response when the limit is exceeded", () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const userId = "user-dog-over-limit";

      for (let i = 0; i < 30; i++) {
        applyFeedRateLimit(rateLimiter, request, "/api/feeds/dog", userId);
      }

      const result = applyFeedRateLimit(
        rateLimiter,
        request,
        "/api/feeds/dog",
        userId,
      );

      expect(result).not.toBeNull();
      expect(result!.status).toBe(429);
      expect(result!.headers.get("X-RateLimit-Limit")).toBe("30");
      expect(result!.headers.get("X-RateLimit-Remaining")).toBe("0");
    });

    it("counts requests independently for different users", () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const userA = "user-dog-independent-a";
      const userB = "user-dog-independent-b";

      // Exhaust userA's allowance.
      for (let i = 0; i < 30; i++) {
        applyFeedRateLimit(rateLimiter, request, "/api/feeds/dog", userA);
      }

      const userAResult = applyFeedRateLimit(
        rateLimiter,
        request,
        "/api/feeds/dog",
        userA,
      );
      expect(userAResult).not.toBeNull();
      expect(userAResult!.status).toBe(429);

      // userB is completely independent and must still be allowed.
      const userBResult = applyFeedRateLimit(
        rateLimiter,
        request,
        "/api/feeds/dog",
        userB,
      );
      expect(userBResult).toBeNull();
    });
  });

  describe("rate limit key generation", () => {
    it("uses userId-based key when userId is provided", () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();

      // Two requests with same userId should share a counter
      applyFeedRateLimit(rateLimiter, request, "/api/feeds/home", "user-123");
      const result = rateLimiter.checkRateLimit(
        request,
        "/api/feeds/home",
        30,
        60,
        undefined,
        undefined,
        "user-123",
      );
      // Should have 1 remaining less than a fresh counter (28 = 30 - 2)
      expect(result.remaining).toBe(28);
    });

    it("falls back to session-based key when no userId", () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();

      // Use sessionId instead of userId
      const result1 = rateLimiter.checkRateLimit(
        request,
        "/api/feeds/home",
        30,
        60,
        "session-abc",
      );
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBe(29);

      // Different sessionId should have independent counter
      const result2 = rateLimiter.checkRateLimit(
        request,
        "/api/feeds/home",
        30,
        60,
        "session-xyz",
      );
      expect(result2.remaining).toBe(29);
    });

    it("falls back to email-based key when no userId or sessionId", () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();

      const result = rateLimiter.checkRateLimit(
        request,
        "/api/feeds/home",
        30,
        60,
        undefined,
        "User@Example.COM",
      );
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(29);
    });

    it("falls back to IP-based key when no userId, sessionId, or email", () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest("10.0.0.1");

      const result = rateLimiter.checkRateLimit(
        request,
        "/api/feeds/home",
        30,
        60,
      );
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(29);

      // Different IP should have independent counter
      const request2 = makeRequest("10.0.0.2");
      const result2 = rateLimiter.checkRateLimit(
        request2,
        "/api/feeds/home",
        30,
        60,
      );
      expect(result2.remaining).toBe(29);
    });

    it("uses X-Forwarded-For when CF-Connecting-IP is absent", () => {
      const rateLimiter = new RateLimiter();
      const request = new Request("https://api.example.com/api/feeds/home", {
        headers: { "X-Forwarded-For": "192.168.1.1, 10.0.0.1" },
      });

      const result = rateLimiter.checkRateLimit(
        request,
        "/api/feeds/home",
        30,
        60,
      );
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(29);
    });
  });

  describe("expired entries cleanup", () => {
    it("resets counter after window expires", async () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();

      // Use a 1-second window for faster testing
      for (let i = 0; i < 3; i++) {
        rateLimiter.checkRateLimit(
          request,
          "/api/feeds/test",
          3,
          1, // 1-second window
          undefined,
          undefined,
          "user-expire",
        );
      }

      // Should be at limit
      const atLimit = rateLimiter.checkRateLimit(
        request,
        "/api/feeds/test",
        3,
        1,
        undefined,
        undefined,
        "user-expire",
      );
      expect(atLimit.allowed).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be allowed again
      const afterExpiry = rateLimiter.checkRateLimit(
        request,
        "/api/feeds/test",
        3,
        1,
        undefined,
        undefined,
        "user-expire",
      );
      expect(afterExpiry.allowed).toBe(true);
      expect(afterExpiry.remaining).toBe(2);
    });
  });

  describe("token-bucket distributed path (checkRateLimitKV / applyRateLimitKV)", () => {
    // No RATE_LIMIT_TABLE in env → the limiter is an in-memory
    // MemoryTokenBucketLimiter (dev/test backing).
    function makeMockEnv() {
      return { LOG_LEVEL: "error" } as any;
    }

    it("uses the in-memory token bucket when no table is configured", async () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const env = makeMockEnv();

      const result = await rateLimiter.checkRateLimitKV(
        env,
        request,
        "/api/feeds/home",
        30,
        60,
        undefined,
        undefined,
        "user-kv-fallback",
      );
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(29);
    });

    it("allows the first request from a full bucket", async () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const env = makeMockEnv();

      const result = await rateLimiter.checkRateLimitKV(
        env,
        request,
        "/api/feeds/home",
        30,
        60,
        undefined,
        undefined,
        "user-kv-first",
      );
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(29);
    });

    it("decrements remaining on subsequent requests", async () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const env = makeMockEnv();

      await rateLimiter.checkRateLimitKV(
        env, request, "/api/feeds/home", 30, 60,
        undefined, undefined, "user-kv-inc",
      );

      const result = await rateLimiter.checkRateLimitKV(
        env, request, "/api/feeds/home", 30, 60,
        undefined, undefined, "user-kv-inc",
      );
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(28);
    });

    it("rejects once the bucket is drained past capacity", async () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const env = makeMockEnv();

      for (let i = 0; i < 3; i++) {
        await rateLimiter.checkRateLimitKV(
          env, request, "/api/feeds/home", 3, 60,
          undefined, undefined, "user-kv-exceed",
        );
      }

      const result = await rateLimiter.checkRateLimitKV(
        env, request, "/api/feeds/home", 3, 60,
        undefined, undefined, "user-kv-exceed",
      );
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it("applyRateLimitKV returns 429 when limit exceeded", async () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const env = makeMockEnv();

      for (let i = 0; i < 3; i++) {
        await rateLimiter.applyRateLimitKV(
          env, request, "/api/feeds/home", 3, 60,
          undefined, undefined, "user-apply-kv",
        );
      }

      const result = await rateLimiter.applyRateLimitKV(
        env, request, "/api/feeds/home", 3, 60,
        undefined, undefined, "user-apply-kv",
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(429);

      const body = await result!.json() as { error: string };
      expect(body.error).toBe("Rate limit exceeded");
    });

    it("applyRateLimitKV returns null when under limit", async () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const env = makeMockEnv();

      const result = await rateLimiter.applyRateLimitKV(
        env, request, "/api/feeds/home", 30, 60,
        undefined, undefined, "user-apply-kv-ok",
      );
      expect(result).toBeNull();
    });
  });

  describe("rate limit isolation across endpoints", () => {
    it("exhausting /api/feeds/dog does not affect /api/feeds/home for the same user", () => {
      const rateLimiter = new RateLimiter();
      const request = makeRequest();
      const userId = "user-cross-endpoint";

      // Exhaust the dog feed limit.
      for (let i = 0; i < 30; i++) {
        applyFeedRateLimit(rateLimiter, request, "/api/feeds/dog", userId);
      }

      // dog feed must be rate limited.
      const dogResult = applyFeedRateLimit(
        rateLimiter,
        request,
        "/api/feeds/dog",
        userId,
      );
      expect(dogResult).not.toBeNull();
      expect(dogResult!.status).toBe(429);

      // home feed must still be allowed — its counter is separate.
      const homeResult = applyFeedRateLimit(
        rateLimiter,
        request,
        "/api/feeds/home",
        userId,
      );
      expect(homeResult).toBeNull();
    });
  });
});
