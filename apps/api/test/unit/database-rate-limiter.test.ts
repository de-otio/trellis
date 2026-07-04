/**
 * Unit tests for DatabaseRateLimiter
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseRateLimiter } from "../../src/lib/database-rate-limiter.js";

// Create mock function that will be shared - must be hoisted
const mockCheckRateLimit = vi.hoisted(() => vi.fn());

// Mock RateLimiter class - factory function can access hoisted variables
vi.mock("../../src/lib/rate-limit", () => {
  // Access the hoisted mock function from the outer scope
  // This works because vi.hoisted runs before the mock factory
  return {
    RateLimiter: class {
      checkRateLimit = mockCheckRateLimit;
    },
  };
});

describe("DatabaseRateLimiter", () => {
  let mockEnv: any;
  let rateLimiter: DatabaseRateLimiter;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      RATE_LIMIT_KV: {},
    };

    rateLimiter = new DatabaseRateLimiter(mockEnv);
  });

  describe("constructor", () => {
    it("should use default config when none provided", () => {
      const limiter = new DatabaseRateLimiter(mockEnv);

      expect(limiter).toBeInstanceOf(DatabaseRateLimiter);
    });

    it("should use custom config when provided", () => {
      const customConfig = {
        userLimit: 200,
        userWindowMs: 120000,
        operationLimit: 100,
        operationWindowMs: 120000,
        globalLimit: 2000,
        globalWindowMs: 120000,
      };

      const limiter = new DatabaseRateLimiter(mockEnv, customConfig);

      expect(limiter).toBeInstanceOf(DatabaseRateLimiter);
    });
  });

  describe("checkLimit", () => {
    let mockRequest: Request;

    beforeEach(() => {
      mockRequest = new Request("https://example.com/api");
    });

    it("should allow operation when all limits pass", async () => {
      mockCheckRateLimit.mockReturnValue({
        allowed: true,
        resetAt: Date.now() + 60000,
      });

      const result = await rateLimiter.checkLimit(
        mockRequest,
        "user-123",
        "findMany",
      );

      expect(result).toEqual({ allowed: true });
      expect(mockCheckRateLimit).toHaveBeenCalledTimes(3);
    });

    it("should reject when global limit is exceeded", async () => {
      const resetAt = Date.now() + 30000;
      mockCheckRateLimit.mockReturnValueOnce({
        allowed: false,
        resetAt,
      });

      const result = await rateLimiter.checkLimit(
        mockRequest,
        "user-123",
        "findMany",
      );

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeDefined();
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    });

    it("should reject when user limit is exceeded", async () => {
      const resetAt = Date.now() + 30000;
      mockCheckRateLimit
        .mockReturnValueOnce({
          allowed: true,
          resetAt: Date.now() + 60000,
        })
        .mockReturnValueOnce({
          allowed: false,
          resetAt,
        });

      const result = await rateLimiter.checkLimit(
        mockRequest,
        "user-123",
        "findMany",
      );

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeDefined();
      expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
    });

    it("should reject when operation limit is exceeded", async () => {
      const resetAt = Date.now() + 30000;
      mockCheckRateLimit
        .mockReturnValueOnce({
          allowed: true,
          resetAt: Date.now() + 60000,
        })
        .mockReturnValueOnce({
          allowed: true,
          resetAt: Date.now() + 60000,
        })
        .mockReturnValueOnce({
          allowed: false,
          resetAt,
        });

      const result = await rateLimiter.checkLimit(
        mockRequest,
        "user-123",
        "findMany",
      );

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeDefined();
      expect(mockCheckRateLimit).toHaveBeenCalledTimes(3);
    });

    it("should skip user limit check when userId is not provided", async () => {
      mockCheckRateLimit
        .mockReturnValueOnce({
          allowed: true,
          resetAt: Date.now() + 60000,
        })
        .mockReturnValueOnce({
          allowed: true,
          resetAt: Date.now() + 60000,
        });

      const result = await rateLimiter.checkLimit(
        mockRequest,
        undefined,
        "findMany",
      );

      expect(result.allowed).toBe(true);
      expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
    });

    it("should skip operation limit check when operation is not provided", async () => {
      mockCheckRateLimit
        .mockReturnValueOnce({
          allowed: true,
          resetAt: Date.now() + 60000,
        })
        .mockReturnValueOnce({
          allowed: true,
          resetAt: Date.now() + 60000,
        });

      const result = await rateLimiter.checkLimit(mockRequest, "user-123");

      expect(result.allowed).toBe(true);
      expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
    });

    it("should use correct rate limit keys", async () => {
      mockCheckRateLimit.mockReturnValue({
        allowed: true,
        resetAt: Date.now() + 60000,
      });

      await rateLimiter.checkLimit(mockRequest, "user-123", "create");

      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        mockRequest,
        "db:global",
        1000,
        60,
        undefined,
        undefined,
        "user-123",
      );

      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        mockRequest,
        "db:user:user-123",
        100,
        60,
        undefined,
        undefined,
        "user-123",
      );

      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        mockRequest,
        "db:op:create",
        50,
        60,
        undefined,
        undefined,
        "user-123",
      );
    });

    it("should calculate retryAfter correctly", async () => {
      const resetAt = Date.now() + 45000; // 45 seconds from now
      mockCheckRateLimit.mockReturnValueOnce({
        allowed: false,
        resetAt,
      });

      const result = await rateLimiter.checkLimit(
        mockRequest,
        "user-123",
        "findMany",
      );

      expect(result.retryAfter).toBeGreaterThanOrEqual(40000);
      expect(result.retryAfter).toBeLessThanOrEqual(50000);
    });
  });
});
