/**
 * Unit Tests for Feature Toggle Rate Limiting Middleware
 *
 * Tests rate limiting functionality for feature toggle API endpoints.
 *
 * Note: These tests verify the middleware logic and headers.
 * Integration tests should verify actual rate limiting behavior with KV.
 */

import { describe, it, expect } from "vitest";
import { createRateLimitErrorResponse } from "../../src/lib/middleware/feature-toggle-rate-limit.js";

describe("createRateLimitErrorResponse", () => {
  it("should create 429 response with rate limit headers", () => {
    const rateLimitResult = {
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30000,
      headers: {
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": new Date(Date.now() + 30000).toISOString(),
        "Retry-After": "30",
      },
    };

    const response = createRateLimitErrorResponse(rateLimitResult);

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("Retry-After")).toBe("30");

    return response.json().then((body) => {
      expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
      expect(body.error.message).toContain("Rate limit exceeded");
      expect(body.error.retryAfter).toBeGreaterThan(0);
    });
  });

  it("should include retryAfter in response body", async () => {
    const resetAt = Date.now() + 45000; // 45 seconds
    const rateLimitResult = {
      allowed: false,
      remaining: 0,
      resetAt,
      headers: {
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": new Date(resetAt).toISOString(),
        "Retry-After": "45",
      },
    };

    const response = createRateLimitErrorResponse(rateLimitResult);
    const body = await response.json();

    expect(body.error.retryAfter).toBeGreaterThanOrEqual(44);
    expect(body.error.retryAfter).toBeLessThanOrEqual(45);
  });
});

// Note: Integration tests for rateLimitFeatureToggleAPI and rateLimitAdminFeatureToggleAPI
// should be added to verify actual rate limiting behavior with KV storage.
// These functions depend on the RateLimiter class which is tested separately.
