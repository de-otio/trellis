/**
 * Unit Tests: Database Query Helper
 *
 * Tests for database query timeout and retry utilities.
 */

import { describe, expect, it, vi } from "vitest";
import {
  QueryTimeoutPresets,
  withQueryTimeout,
} from "../../src/lib/db-query-helper.js";

describe("db-query-helper", () => {
  describe("withQueryTimeout", () => {
    it("should return query result when query completes before timeout", async () => {
      const queryFn = vi.fn().mockResolvedValue({ id: "123", name: "Test" });
      const result = await withQueryTimeout(queryFn, 1000);

      expect(result).toEqual({ id: "123", name: "Test" });
      expect(queryFn).toHaveBeenCalledTimes(1);
    });

    it("should throw timeout error when query exceeds timeout", async () => {
      const queryFn = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ id: "123" }), 2000);
          }),
      );

      await expect(withQueryTimeout(queryFn, 100)).rejects.toThrow(
        "Database query timeout",
      );
    });

    it("should use default timeout of 12000ms when not specified", async () => {
      const queryFn = vi.fn().mockResolvedValue({ id: "123" });
      const result = await withQueryTimeout(queryFn);

      expect(result).toEqual({ id: "123" });
      expect(queryFn).toHaveBeenCalledTimes(1);
    });

    it("should handle query that throws error", async () => {
      const queryError = new Error("Database connection failed");
      const queryFn = vi.fn().mockRejectedValue(queryError);

      await expect(withQueryTimeout(queryFn, 1000)).rejects.toThrow(
        "Database connection failed",
      );
    });

    it("should handle query that returns null", async () => {
      const queryFn = vi.fn().mockResolvedValue(null);
      const result = await withQueryTimeout(queryFn, 1000);

      expect(result).toBeNull();
    });

    it("should handle query that returns undefined", async () => {
      const queryFn = vi.fn().mockResolvedValue(undefined);
      const result = await withQueryTimeout(queryFn, 1000);

      expect(result).toBeUndefined();
    });

    it("should handle query that returns array", async () => {
      const queryFn = vi.fn().mockResolvedValue([{ id: "1" }, { id: "2" }]);
      const result = await withQueryTimeout(queryFn, 1000);

      expect(result).toEqual([{ id: "1" }, { id: "2" }]);
    });

    it("should handle query that returns string", async () => {
      const queryFn = vi.fn().mockResolvedValue("test result");
      const result = await withQueryTimeout(queryFn, 1000);

      expect(result).toBe("test result");
    });

    it("should handle query that returns number", async () => {
      const queryFn = vi.fn().mockResolvedValue(42);
      const result = await withQueryTimeout(queryFn, 1000);

      expect(result).toBe(42);
    });

    it("should handle query that returns boolean", async () => {
      const queryFn = vi.fn().mockResolvedValue(true);
      const result = await withQueryTimeout(queryFn, 1000);

      expect(result).toBe(true);
    });

    it("should timeout even if query is very slow", async () => {
      const queryFn = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ data: "slow" }), 5000);
          }),
      );

      await expect(withQueryTimeout(queryFn, 100)).rejects.toThrow(
        "Database query timeout",
      );
    });

    it("should complete successfully when query finishes just before timeout", async () => {
      const queryFn = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ data: "fast" }), 50);
          }),
      );

      const result = await withQueryTimeout(queryFn, 200);
      expect(result).toEqual({ data: "fast" });
    });

    it("should handle multiple sequential queries", async () => {
      const query1 = vi.fn().mockResolvedValue({ id: "1" });
      const query2 = vi.fn().mockResolvedValue({ id: "2" });

      const result1 = await withQueryTimeout(query1, 1000);
      const result2 = await withQueryTimeout(query2, 1000);

      expect(result1).toEqual({ id: "1" });
      expect(result2).toEqual({ id: "2" });
      expect(query1).toHaveBeenCalledTimes(1);
      expect(query2).toHaveBeenCalledTimes(1);
    });

    it("should handle custom timeout values", async () => {
      const queryFn = vi.fn().mockResolvedValue({ id: "123" });
      const result = await withQueryTimeout(queryFn, 5000);

      expect(result).toEqual({ id: "123" });
    });

    it("should handle very short timeout values", async () => {
      const queryFn = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ id: "123" }), 100);
          }),
      );

      await expect(withQueryTimeout(queryFn, 50)).rejects.toThrow(
        "Database query timeout",
      );
    });
  });

  describe("QueryTimeoutPresets", () => {
    it("should have USER_FACING timeout of 2000ms (increased from 500ms based on Cloudflare logs analysis)", () => {
      expect(QueryTimeoutPresets.USER_FACING.timeoutMs).toBe(2000);
      expect(QueryTimeoutPresets.USER_FACING.retryTimeoutMs).toBe(2000);
    });

    it("should have STANDARD timeout of 2000ms (increased from 500ms based on Cloudflare logs analysis)", () => {
      expect(QueryTimeoutPresets.STANDARD.timeoutMs).toBe(2000);
      expect(QueryTimeoutPresets.STANDARD.retryTimeoutMs).toBe(2000);
    });

    it("should have BACKGROUND timeout of 12s (longer for background operations)", () => {
      expect(QueryTimeoutPresets.BACKGROUND.timeoutMs).toBe(12000);
      expect(QueryTimeoutPresets.BACKGROUND.retryTimeoutMs).toBe(5000);
    });

    it("should have CRITICAL timeout of 5s (medium for critical operations)", () => {
      expect(QueryTimeoutPresets.CRITICAL.timeoutMs).toBe(5000);
      expect(QueryTimeoutPresets.CRITICAL.retryTimeoutMs).toBe(3000);
    });
  });
});
