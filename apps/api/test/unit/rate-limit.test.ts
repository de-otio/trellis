/**
 * Unit Tests: Rate Limiter (token-bucket)
 *
 * Exercises the token-bucket RateLimiter ported onto
 * `@de-otio/saas-foundation/rate-limit`.
 *
 *  - The synchronous `checkRateLimit` / `applyRateLimit` path uses an
 *    in-memory token bucket (capacity = limit, refillRate = limit/window).
 *  - The async `checkRateLimitKV` / `applyRateLimitKV` path uses a
 *    foundation limiter selected from env: a `MemoryTokenBucketLimiter`
 *    when `RATE_LIMIT_TABLE` is absent (the case under test).
 *
 * The foundation memory limiter reads `Date.now()` internally and exposes
 * no clock injection, so wall-clock refill is asserted via burst-then-deny
 * plus per-instance fresh-bucket behavior rather than sleeping for refills.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RateLimiter,
  __resetRateLimiterForTests,
} from "../../src/lib/rate-limit.js";

function makeRequest(ip = "192.168.1.1"): Request {
  return new Request("https://api.example.com/test", {
    headers: { "CF-Connecting-IP": ip },
  });
}

describe("RateLimiter (token-bucket)", () => {
  let rateLimiter: RateLimiter;
  let request: Request;

  beforeEach(() => {
    __resetRateLimiterForTests();
    rateLimiter = new RateLimiter();
    request = makeRequest();
  });

  afterEach(() => {
    __resetRateLimiterForTests();
  });

  describe("checkRateLimit (sync in-memory)", () => {
    it("allows a request within capacity and reports remaining", () => {
      const result = rateLimiter.checkRateLimit(request, "/test", 10, 60);
      expect(result.allowed).toBe(true);
      // capacity 10, consume 1 → 9 tokens remain.
      expect(result.remaining).toBe(9);
    });

    it("decrements remaining on each consume", () => {
      const r1 = rateLimiter.checkRateLimit(request, "/test", 10, 60);
      expect(r1.remaining).toBe(9);
      const r2 = rateLimiter.checkRateLimit(request, "/test", 10, 60);
      expect(r2.remaining).toBe(8);
    });

    it("denies once the bucket is drained past capacity", () => {
      for (let i = 0; i < 10; i++) {
        const r = rateLimiter.checkRateLimit(request, "/test", 10, 60);
        expect(r.allowed).toBe(true);
      }
      // 11th request: bucket empty (refill over a few ms is < 1 token).
      const denied = rateLimiter.checkRateLimit(request, "/test", 10, 60);
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      // Token-bucket retryAfter is positive (seconds until the next token).
      expect(denied.retryAfter).toBeGreaterThan(0);
    });

    it("tolerates a burst up to capacity", () => {
      // capacity 5: five immediate requests all allowed, sixth denied.
      for (let i = 0; i < 5; i++) {
        expect(rateLimiter.checkRateLimit(request, "/burst", 5, 60).allowed).toBe(
          true,
        );
      }
      expect(rateLimiter.checkRateLimit(request, "/burst", 5, 60).allowed).toBe(
        false,
      );
    });

    it("keys separate buckets per user (isolation)", () => {
      const a = rateLimiter.checkRateLimit(
        request,
        "/test",
        10,
        60,
        undefined,
        undefined,
        "user-a",
      );
      const b = rateLimiter.checkRateLimit(
        request,
        "/test",
        10,
        60,
        undefined,
        undefined,
        "user-b",
      );
      expect(a.remaining).toBe(9);
      expect(b.remaining).toBe(9); // fresh, independent bucket
    });

    it("normalizes email and shares a bucket case-insensitively", () => {
      const r1 = rateLimiter.checkRateLimit(
        request,
        "/test",
        10,
        60,
        undefined,
        "Test@Example.com",
      );
      const r2 = rateLimiter.checkRateLimit(
        request,
        "/test",
        10,
        60,
        undefined,
        "test@example.com",
      );
      expect(r1.remaining).toBe(9);
      expect(r2.remaining).toBe(8); // same normalized key
    });

    it("prioritizes userId over session and email", () => {
      const r1 = rateLimiter.checkRateLimit(
        request,
        "/test",
        10,
        60,
        "session-1",
        "a@example.com",
        "user-x",
      );
      const r2 = rateLimiter.checkRateLimit(
        request,
        "/test",
        10,
        60,
        "session-2",
        "b@example.com",
        "user-x",
      );
      // Same userId → same bucket regardless of session/email.
      expect(r1.remaining).toBe(9);
      expect(r2.remaining).toBe(8);
    });

    it("keys separate buckets per endpoint (isolation)", () => {
      // Drain /a fully.
      for (let i = 0; i < 10; i++) {
        rateLimiter.checkRateLimit(request, "/a", 10, 60, undefined, undefined, "u");
      }
      expect(
        rateLimiter
          .checkRateLimit(request, "/a", 10, 60, undefined, undefined, "u")
          .allowed,
      ).toBe(false);
      // /b is untouched for the same user.
      expect(
        rateLimiter
          .checkRateLimit(request, "/b", 10, 60, undefined, undefined, "u")
          .allowed,
      ).toBe(true);
    });

    it("keys separate IP buckets when no identity is supplied", () => {
      const r1 = rateLimiter.checkRateLimit(makeRequest("10.0.0.1"), "/test", 10, 60);
      const r2 = rateLimiter.checkRateLimit(makeRequest("10.0.0.2"), "/test", 10, 60);
      expect(r1.remaining).toBe(9);
      expect(r2.remaining).toBe(9);
    });
  });

  describe("applyRateLimit (sync 429 shape)", () => {
    it("returns null when within capacity", () => {
      expect(rateLimiter.applyRateLimit(request, "/test", 10, 60)).toBeNull();
    });

    it("returns a 429 with the canonical body and headers when drained", async () => {
      for (let i = 0; i < 10; i++) {
        rateLimiter.checkRateLimit(request, "/test", 10, 60);
      }
      const response = rateLimiter.applyRateLimit(request, "/test", 10, 60);
      expect(response).not.toBeNull();
      expect(response!.status).toBe(429);
      expect(response!.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(response!.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(response!.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(response!.headers.get("X-RateLimit-Reset")).toBeTruthy();

      const retryAfterHeader = response!.headers.get("Retry-After");
      expect(retryAfterHeader).toBeTruthy();
      // refillRate = 10/60 ≈ 0.1667/s → ~6s to earn one token.
      const retryAfter = parseInt(retryAfterHeader!, 10);
      expect(retryAfter).toBeGreaterThanOrEqual(1);

      const body = (await response!.json()) as {
        error: string;
        retryAfter: number;
      };
      expect(body.error).toBe("Rate limit exceeded");
      expect(body.retryAfter).toBe(retryAfter);
    });
  });

  describe("checkRateLimitKV (async, memory-backed via env)", () => {
    const env = {}; // no RATE_LIMIT_TABLE → MemoryTokenBucketLimiter

    it("allows within capacity and reports remaining", async () => {
      const result = await rateLimiter.checkRateLimitKV(
        env,
        request,
        "/kv",
        10,
        60,
        undefined,
        undefined,
        "kv-user-1",
      );
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });

    it("denies past capacity with a positive retryAfter", async () => {
      for (let i = 0; i < 3; i++) {
        await rateLimiter.checkRateLimitKV(
          env,
          request,
          "/kv",
          3,
          60,
          undefined,
          undefined,
          "kv-user-deny",
        );
      }
      const result = await rateLimiter.checkRateLimitKV(
        env,
        request,
        "/kv",
        3,
        60,
        undefined,
        undefined,
        "kv-user-deny",
      );
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it("isolates buckets per user via the foundation limiter", async () => {
      // Drain user A.
      for (let i = 0; i < 3; i++) {
        await rateLimiter.checkRateLimitKV(
          env, request, "/kv", 3, 60, undefined, undefined, "kv-iso-a",
        );
      }
      const aDenied = await rateLimiter.checkRateLimitKV(
        env, request, "/kv", 3, 60, undefined, undefined, "kv-iso-a",
      );
      expect(aDenied.allowed).toBe(false);

      // User B is independent.
      const bAllowed = await rateLimiter.checkRateLimitKV(
        env, request, "/kv", 3, 60, undefined, undefined, "kv-iso-b",
      );
      expect(bAllowed.allowed).toBe(true);
      expect(bAllowed.remaining).toBe(2);
    });

    it("shares a single bucket for ':unknown' keys (shared-bucket strategy)", async () => {
      // No identity headers → key ends in ':ip:unknown'. Two distinct
      // requests with no IP collapse to one shared bucket.
      const noIp = () => new Request("https://api.example.com/test");
      for (let i = 0; i < 2; i++) {
        await rateLimiter.checkRateLimitKV(env, noIp(), "/shared", 2, 60);
      }
      const denied = await rateLimiter.checkRateLimitKV(
        env,
        noIp(),
        "/shared",
        2,
        60,
      );
      expect(denied.allowed).toBe(false);
    });
  });

  describe("applyRateLimitKV (async 429 shape)", () => {
    const env = { LOG_LEVEL: "error" };

    it("returns null when within capacity", async () => {
      const response = await rateLimiter.applyRateLimitKV(
        env,
        request,
        "/kv-apply",
        10,
        60,
        undefined,
        undefined,
        "kv-apply-ok",
      );
      expect(response).toBeNull();
    });

    it("returns a 429 with canonical body/headers when drained", async () => {
      for (let i = 0; i < 3; i++) {
        await rateLimiter.applyRateLimitKV(
          env, request, "/kv-apply", 3, 60, undefined, undefined, "kv-apply-deny",
        );
      }
      const response = await rateLimiter.applyRateLimitKV(
        env, request, "/kv-apply", 3, 60, undefined, undefined, "kv-apply-deny",
      );
      expect(response).not.toBeNull();
      expect(response!.status).toBe(429);
      expect(response!.headers.get("X-RateLimit-Limit")).toBe("3");
      expect(response!.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(response!.headers.get("Retry-After")).toBeTruthy();

      const body = (await response!.json()) as { error: string; retryAfter: number };
      expect(body.error).toBe("Rate limit exceeded");
      expect(typeof body.retryAfter).toBe("number");
      expect(body.retryAfter).toBeGreaterThan(0);
    });
  });

  describe("reset semantics via fresh limiter", () => {
    it("a reset limiter starts each bucket full again", async () => {
      const env = {};
      for (let i = 0; i < 3; i++) {
        await rateLimiter.checkRateLimitKV(
          env, request, "/reset", 3, 60, undefined, undefined, "reset-user",
        );
      }
      const denied = await rateLimiter.checkRateLimitKV(
        env, request, "/reset", 3, 60, undefined, undefined, "reset-user",
      );
      expect(denied.allowed).toBe(false);

      // Resetting the module limiter drops all bucket state.
      __resetRateLimiterForTests();

      const afterReset = await rateLimiter.checkRateLimitKV(
        env, request, "/reset", 3, 60, undefined, undefined, "reset-user",
      );
      expect(afterReset.allowed).toBe(true);
      expect(afterReset.remaining).toBe(2);
    });
  });
});
