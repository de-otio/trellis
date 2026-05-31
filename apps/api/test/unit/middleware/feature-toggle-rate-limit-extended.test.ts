/**
 * Extended Unit Tests: Feature Toggle Rate Limit Middleware
 *
 * Tests for the feature toggle rate limiting functions:
 * - rateLimitFeatureToggleAPI (public API, per-IP)
 * - rateLimitAdminFeatureToggleAPI (admin API, per-user)
 * - createRateLimitErrorResponse (429 response generation)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";

// Mock RateLimiter
const mockCheckRateLimitKV = vi.fn();
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    checkRateLimitKV = mockCheckRateLimitKV;
  },
}));

import {
  rateLimitFeatureToggleAPI,
  rateLimitAdminFeatureToggleAPI,
  createRateLimitErrorResponse,
} from "../../../src/lib/middleware/feature-toggle-rate-limit.js";

describe("Feature Toggle Rate Limit Middleware", () => {
  let mockEnv: Env;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      FEED_CACHE_KV: {} as any,
    } as any;

    mockRequest = new Request("https://example.com/api/feature-toggles", {
      method: "GET",
      headers: {
        "CF-Connecting-IP": "192.168.1.1",
      },
    });
  });

  describe("rateLimitFeatureToggleAPI (public)", () => {
    it("should allow requests under the rate limit", async () => {
      mockCheckRateLimitKV.mockResolvedValue({
        allowed: true,
        remaining: 99,
        resetAt: Date.now() + 60000,
      });

      const result = await rateLimitFeatureToggleAPI(mockRequest, mockEnv);

      expect(result).not.toBeNull();
      expect(result!.allowed).toBe(true);
      expect(result!.remaining).toBe(99);
    });

    it("should reject requests over the rate limit", async () => {
      const resetAt = Date.now() + 30000;
      mockCheckRateLimitKV.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt,
      });

      const result = await rateLimitFeatureToggleAPI(mockRequest, mockEnv);

      expect(result).not.toBeNull();
      expect(result!.allowed).toBe(false);
      expect(result!.remaining).toBe(0);
    });

    it("should include rate limit headers when allowed", async () => {
      mockCheckRateLimitKV.mockResolvedValue({
        allowed: true,
        remaining: 50,
        resetAt: Date.now() + 60000,
      });

      const result = await rateLimitFeatureToggleAPI(mockRequest, mockEnv);

      expect(result!.headers["X-RateLimit-Limit"]).toBe("100");
      expect(result!.headers["X-RateLimit-Remaining"]).toBe("50");
      expect(result!.headers["X-RateLimit-Reset"]).toBeDefined();
    });

    it("should include Retry-After header when rate limited", async () => {
      const resetAt = Date.now() + 30000;
      mockCheckRateLimitKV.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt,
      });

      const result = await rateLimitFeatureToggleAPI(mockRequest, mockEnv);

      expect(result!.headers["Retry-After"]).toBeDefined();
      const retryAfter = parseInt(result!.headers["Retry-After"], 10);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(30);
    });

    it("should use the public rate limit config (100 requests/minute)", async () => {
      mockCheckRateLimitKV.mockResolvedValue({
        allowed: true,
        remaining: 99,
        resetAt: Date.now() + 60000,
      });

      await rateLimitFeatureToggleAPI(mockRequest, mockEnv);

      expect(mockCheckRateLimitKV).toHaveBeenCalledWith(
        mockEnv,
        mockRequest,
        "/api/feature-toggles",
        100, // limit
        60, // windowSeconds
        undefined, // sessionId
        undefined, // email
        undefined, // userId (public uses IP internally)
      );
    });

    it("should use X-Forwarded-For when CF-Connecting-IP is absent", async () => {
      const request = new Request(
        "https://example.com/api/feature-toggles",
        {
          method: "GET",
          headers: {
            "X-Forwarded-For": "10.0.0.1, 10.0.0.2",
          },
        },
      );

      mockCheckRateLimitKV.mockResolvedValue({
        allowed: true,
        remaining: 99,
        resetAt: Date.now() + 60000,
      });

      const result = await rateLimitFeatureToggleAPI(request, mockEnv);
      expect(result!.allowed).toBe(true);
    });
  });

  describe("rateLimitAdminFeatureToggleAPI (admin)", () => {
    it("should allow requests under the admin rate limit", async () => {
      mockCheckRateLimitKV.mockResolvedValue({
        allowed: true,
        remaining: 999,
        resetAt: Date.now() + 60000,
      });

      const result = await rateLimitAdminFeatureToggleAPI(
        mockRequest,
        mockEnv,
        "user-123",
      );

      expect(result).not.toBeNull();
      expect(result!.allowed).toBe(true);
      expect(result!.remaining).toBe(999);
    });

    it("should reject requests over the admin rate limit", async () => {
      const resetAt = Date.now() + 30000;
      mockCheckRateLimitKV.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt,
      });

      const result = await rateLimitAdminFeatureToggleAPI(
        mockRequest,
        mockEnv,
        "user-123",
      );

      expect(result!.allowed).toBe(false);
      expect(result!.remaining).toBe(0);
      expect(result!.headers["Retry-After"]).toBeDefined();
    });

    it("should use user ID for rate limit key", async () => {
      mockCheckRateLimitKV.mockResolvedValue({
        allowed: true,
        remaining: 999,
        resetAt: Date.now() + 60000,
      });

      await rateLimitAdminFeatureToggleAPI(mockRequest, mockEnv, "user-456");

      expect(mockCheckRateLimitKV).toHaveBeenCalledWith(
        mockEnv,
        mockRequest,
        "/api/admin/feature-toggles",
        1000, // admin limit
        60, // windowSeconds
        undefined, // sessionId
        undefined, // email
        "user-456", // userId
      );
    });

    it("should return null for invalid userId (graceful degradation)", async () => {
      const result = await rateLimitAdminFeatureToggleAPI(
        mockRequest,
        mockEnv,
        "",
      );

      expect(result).toBeNull();
      expect(mockCheckRateLimitKV).not.toHaveBeenCalled();
          });

    it("should return null for undefined userId", async () => {
      const result = await rateLimitAdminFeatureToggleAPI(
        mockRequest,
        mockEnv,
        undefined as any,
      );

      expect(result).toBeNull();
      expect(mockCheckRateLimitKV).not.toHaveBeenCalled();
    });

    it("should include admin rate limit headers when allowed", async () => {
      mockCheckRateLimitKV.mockResolvedValue({
        allowed: true,
        remaining: 500,
        resetAt: Date.now() + 60000,
      });

      const result = await rateLimitAdminFeatureToggleAPI(
        mockRequest,
        mockEnv,
        "user-123",
      );

      expect(result!.headers["X-RateLimit-Limit"]).toBe("1000");
      expect(result!.headers["X-RateLimit-Remaining"]).toBe("500");
    });

    it("should handle null result from checkRateLimitKV with graceful degradation", async () => {
      mockCheckRateLimitKV.mockResolvedValue(null);

      const result = await rateLimitAdminFeatureToggleAPI(
        mockRequest,
        mockEnv,
        "user-123",
      );

      expect(result).not.toBeNull();
      expect(result!.allowed).toBe(true);
      expect(result!.remaining).toBe(1000);
      expect(result!.headers["X-RateLimit-Limit"]).toBe("1000");
    });

    it("should handle undefined result from checkRateLimitKV with graceful degradation", async () => {
      mockCheckRateLimitKV.mockResolvedValue(undefined);

      const result = await rateLimitAdminFeatureToggleAPI(
        mockRequest,
        mockEnv,
        "user-123",
      );

      expect(result).not.toBeNull();
      expect(result!.allowed).toBe(true);
    });
  });

  describe("createRateLimitErrorResponse", () => {
    it("should return 429 status code", () => {
      const resetAt = Date.now() + 30000;
      const response = createRateLimitErrorResponse({
        allowed: false,
        remaining: 0,
        resetAt,
        headers: {
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": new Date(resetAt).toISOString(),
          "Retry-After": "30",
        },
      });

      expect(response.status).toBe(429);
    });

    it("should include rate limit error body with RATE_LIMIT_EXCEEDED code", async () => {
      const resetAt = Date.now() + 30000;
      const response = createRateLimitErrorResponse({
        allowed: false,
        remaining: 0,
        resetAt,
        headers: {
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": new Date(resetAt).toISOString(),
          "Retry-After": "30",
        },
      });

      const body = await response.json() as any;
      expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
      expect(body.error.message).toContain("Rate limit exceeded");
      expect(body.error.retryAfter).toBeGreaterThan(0);
    });

    it("should include rate limit headers in response", () => {
      const resetAt = Date.now() + 60000;
      const response = createRateLimitErrorResponse({
        allowed: false,
        remaining: 0,
        resetAt,
        headers: {
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": new Date(resetAt).toISOString(),
          "Retry-After": "60",
        },
      });

      expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(response.headers.get("content-type")).toBe("application/json");
    });
  });
});
