/**
 * Unit Tests: Security Event Cleaner
 *
 * Comprehensive tests for SecurityEventCleaner including:
 * - Stub method behavior
 * - Return value verification
 */

import { beforeEach, describe, expect, it } from "vitest";
import { SecurityEventCleaner } from "../../src/lib/security-event-cleaner.js";

describe("SecurityEventCleaner", () => {
  let securityEventCleaner: SecurityEventCleaner;

  beforeEach(() => {
    securityEventCleaner = new SecurityEventCleaner();
  });

  describe("cleanupExpiredEvents", () => {
    it("should return 0 (stub implementation)", async () => {
      const result = await securityEventCleaner.cleanupExpiredEvents();

      expect(result).toBe(0);
    });

    it("should return 0 consistently", async () => {
      const result1 = await securityEventCleaner.cleanupExpiredEvents();
      const result2 = await securityEventCleaner.cleanupExpiredEvents();
      const result3 = await securityEventCleaner.cleanupExpiredEvents();

      expect(result1).toBe(0);
      expect(result2).toBe(0);
      expect(result3).toBe(0);
    });

    it("should return a number", async () => {
      const result = await securityEventCleaner.cleanupExpiredEvents();

      expect(typeof result).toBe("number");
    });

    it("should complete without errors", async () => {
      await expect(securityEventCleaner.cleanupExpiredEvents()).resolves.toBe(
        0,
      );
    });
  });
});
