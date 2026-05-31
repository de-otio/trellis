/**
 * Unit Tests: Database Monitor
 *
 * Tests database connection monitoring, failure tracking, and alerting.
 *
 * Logger note (1.B.3 Track C): for most of the `DatabaseMonitor` surface
 * the observable behaviour is captured by outcome assertions (failure
 * counts via `getFailureStats()` and security-event emission via the
 * injected `SecurityMonitor`). Two cases genuinely require log capture:
 *
 *   - `logQuery` whose only side-effect is a `debug` log gated on
 *     `LOG_LEVEL` — there's no DB row, no security event, no return
 *     value to assert on.
 *   - the "security logging failed" graceful-degradation branch in
 *     `logSecurityEvent` whose contract is "swallow the error and warn".
 *
 * For those, we use `createTestLogCapture` from
 * `@de-otio/saas-foundation/logger` (0.2.3+). For the rest, outcome
 * assertions are sufficient.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createTestLogCapture,
  type LogRecord,
} from "@de-otio/saas-foundation/logger";
import {
  DatabaseMonitor,
  type DatabaseMonitorEnv,
  type DatabaseConnectionFailure,
  type DatabaseQueryLog,
} from "../../src/lib/database-monitor.js";

// Mock SecurityMonitor — this is a real outcome surface we assert on.
const mockLogSecurityEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/lib/security-monitor", () => ({
  SecurityMonitor: class {
    logSecurityEvent = mockLogSecurityEvent;
  },
}));

describe("DatabaseMonitor", () => {
  let monitor: DatabaseMonitor;
  let mockEnv: DatabaseMonitorEnv;
  let capture: ReturnType<typeof createTestLogCapture>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogSecurityEvent.mockResolvedValue(undefined);
    capture = createTestLogCapture();
    capture.installAsRoot();
    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      LOG_LEVEL: "INFO",
    };
    monitor = new DatabaseMonitor(mockEnv);
  });

  afterEach(() => {
    capture.restore();
  });

  describe("logConnectionFailure", () => {
    it("should record failure in stats", async () => {
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Connection timeout",
        timestamp: new Date(),
        operation: "findUnique",
        userId: "user-123",
      };

      await monitor.logConnectionFailure(failure, mockEnv);

      // Outcome: failure is tracked in the per-key counter.
      const stats = monitor.getFailureStats();
      expect(stats["US:findUnique"]?.count).toBe(1);
      expect(stats["US:findUnique"]?.lastFailure).toBeInstanceOf(Date);
    });

    it("should track failure counts per region and operation", async () => {
      const failure1: DatabaseConnectionFailure = {
        region: "US",
        error: "Connection timeout",
        timestamp: new Date(),
        operation: "findUnique",
      };

      const failure2: DatabaseConnectionFailure = {
        region: "US",
        error: "Connection timeout",
        timestamp: new Date(),
        operation: "findUnique",
      };

      await monitor.logConnectionFailure(failure1, mockEnv);
      await monitor.logConnectionFailure(failure2, mockEnv);

      // Outcome: the same (region, operation) key accumulates the count.
      const stats = monitor.getFailureStats();
      expect(stats["US:findUnique"]?.count).toBe(2);
    });

    it("should track separate counts for different regions", async () => {
      const failureUS: DatabaseConnectionFailure = {
        region: "US",
        error: "Connection timeout",
        timestamp: new Date(),
      };

      const failureEU: DatabaseConnectionFailure = {
        region: "EU",
        error: "Connection timeout",
        timestamp: new Date(),
      };

      await monitor.logConnectionFailure(failureUS, mockEnv);
      await monitor.logConnectionFailure(failureEU, mockEnv);

      const stats = monitor.getFailureStats();
      expect(stats["US:unknown"]?.count).toBe(1);
      expect(stats["EU:unknown"]?.count).toBe(1);
    });

    it("should trigger alert when threshold exceeded", async () => {
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Connection timeout",
        timestamp: new Date(),
        operation: "findUnique",
      };

      // Trigger 5 failures (threshold is 5)
      for (let i = 0; i < 5; i++) {
        await monitor.logConnectionFailure(failure, mockEnv);
      }

      // Outcome: the threshold trigger produces a security event whose
      // metadata reflects the alert payload.
      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "database_connection_failure",
          severity: "medium",
          provider: "database",
        }),
        mockEnv,
      );
    });

    it("should log security event for critical failures", async () => {
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Authentication failed",
        timestamp: new Date(),
        operation: "findUnique",
      };

      await monitor.logConnectionFailure(failure, mockEnv);

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "database_connection_failure",
          severity: "high", // Critical failures are high severity
          provider: "database",
          metadata: expect.objectContaining({
            region: "US",
            operation: "findUnique",
            error: "Authentication failed",
          }),
        }),
        mockEnv,
      );
    });

    it("should respect alert cooldown period", async () => {
      // Use a non-critical error so the only path that fires a security
      // event is the alert path. (Critical errors like "timeout" or
      // "connection refused" would fire on EVERY failure via the
      // isCriticalFailure branch, masking the cooldown signal.)
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Slow query result",
        timestamp: new Date(),
        operation: "findUnique",
      };

      // Trigger 5 failures to exceed threshold → fires exactly one alert.
      for (let i = 0; i < 5; i++) {
        await monitor.logConnectionFailure(failure, mockEnv);
      }

      const callsAfterAlert = mockLogSecurityEvent.mock.calls.length;
      expect(callsAfterAlert).toBe(1);

      // Trigger another failure within cooldown period.
      await monitor.logConnectionFailure(failure, mockEnv);

      // Outcome: the alert path is suppressed during cooldown, so the
      // call count is unchanged.
      expect(mockLogSecurityEvent.mock.calls.length).toBe(callsAfterAlert);
    });
  });

  describe("logQuery", () => {
    // logQuery's only side-effect is a debug log. The observable
    // behaviour IS the log emission, so we use the capture buffer.

    it("should not log when LOG_LEVEL is INFO", () => {
      const env: DatabaseMonitorEnv = {
        ...mockEnv,
        LOG_LEVEL: "INFO",
      };

      const log: DatabaseQueryLog = {
        operation: "user.findUnique",
        region: "US",
        duration: 10,
        success: true,
        timestamp: new Date(),
      };

      capture.clear();
      monitor.logQuery(log, env);

      expect(
        capture
          .entries()
          .filter((e: LogRecord) => e.level === "debug" && /Query executed/.test(e.msg)),
      ).toHaveLength(0);
    });

    it("should not log when LOG_LEVEL is WARN", () => {
      const env: DatabaseMonitorEnv = {
        ...mockEnv,
        LOG_LEVEL: "WARN",
      };

      const log: DatabaseQueryLog = {
        operation: "user.findUnique",
        region: "US",
        duration: 10,
        success: true,
        timestamp: new Date(),
      };

      capture.clear();
      monitor.logQuery(log, env);

      expect(
        capture
          .entries()
          .filter((e: LogRecord) => e.level === "debug" && /Query executed/.test(e.msg)),
      ).toHaveLength(0);
    });

    it("should log when LOG_LEVEL is TRACE", () => {
      const env: DatabaseMonitorEnv = {
        ...mockEnv,
        LOG_LEVEL: "TRACE",
      };

      const log: DatabaseQueryLog = {
        operation: "user.findUnique",
        region: "US",
        duration: 10,
        success: true,
        userId: "user-123",
        timestamp: new Date(),
      };

      capture.clear();
      monitor.logQuery(log, env);

      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "debug",
          msg: expect.stringMatching(/Query executed/),
          operation: "user.findUnique",
          region: "US",
          duration: 10,
          success: true,
          userId: "user-123",
        }),
      );
    });

    it("should log when LOG_LEVEL is DEBUG", () => {
      const env: DatabaseMonitorEnv = {
        ...mockEnv,
        LOG_LEVEL: "DEBUG",
      };

      const log: DatabaseQueryLog = {
        operation: "user.findUnique",
        region: "US",
        duration: 10,
        success: true,
        timestamp: new Date(),
      };

      capture.clear();
      monitor.logQuery(log, env);

      expect(
        capture
          .entries()
          .filter((e: LogRecord) => e.level === "debug" && /Query executed/.test(e.msg))
          .length,
      ).toBeGreaterThan(0);
    });

    it("should sanitize error messages in query logs", () => {
      const env: DatabaseMonitorEnv = {
        ...mockEnv,
        LOG_LEVEL: "TRACE",
      };

      const log: DatabaseQueryLog = {
        operation: "user.findUnique",
        region: "US",
        duration: 10,
        success: false,
        error: "ConnectionError: Failed to connect to database",
        timestamp: new Date(),
      };

      capture.clear();
      monitor.logQuery(log, env);

      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "debug",
          msg: expect.stringMatching(/Query executed/),
          errorType: "ConnectionError", // Only error type, not full message
        }),
      );
    });

    it("should extract error type from error message", () => {
      const env: DatabaseMonitorEnv = {
        ...mockEnv,
        LOG_LEVEL: "TRACE",
      };

      const log: DatabaseQueryLog = {
        operation: "user.findUnique",
        region: "US",
        success: false,
        error: "Timeout: Request timed out after 30s",
        timestamp: new Date(),
      };

      capture.clear();
      monitor.logQuery(log, env);

      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "debug",
          msg: expect.stringMatching(/Query executed/),
          errorType: "Timeout",
        }),
      );
    });

    it("should handle unknown error types", () => {
      const env: DatabaseMonitorEnv = {
        ...mockEnv,
        LOG_LEVEL: "TRACE",
      };

      const log: DatabaseQueryLog = {
        operation: "user.findUnique",
        region: "US",
        success: false,
        error: "Some random error message",
        timestamp: new Date(),
      };

      capture.clear();
      monitor.logQuery(log, env);

      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "debug",
          msg: expect.stringMatching(/Query executed/),
          errorType: "UnknownError",
        }),
      );
    });
  });

  describe("isCriticalFailure", () => {
    it("should detect authentication failures as critical", async () => {
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Authentication failed: invalid credentials",
        timestamp: new Date(),
      };

      await monitor.logConnectionFailure(failure, mockEnv);

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: "high",
        }),
        mockEnv,
      );
    });

    it("should detect connection refused as critical", async () => {
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Connection refused: unable to connect",
        timestamp: new Date(),
      };

      await monitor.logConnectionFailure(failure, mockEnv);

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: "high",
        }),
        mockEnv,
      );
    });

    it("should detect timeout errors as critical", async () => {
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Request timeout after 30 seconds",
        timestamp: new Date(),
      };

      await monitor.logConnectionFailure(failure, mockEnv);

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: "high",
        }),
        mockEnv,
      );
    });

    it("should detect network errors as critical", async () => {
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Network error: unable to reach database",
        timestamp: new Date(),
      };

      await monitor.logConnectionFailure(failure, mockEnv);

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: "high",
        }),
        mockEnv,
      );
    });

    it("should detect SSL errors as critical", async () => {
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "SSL error: certificate validation failed",
        timestamp: new Date(),
      };

      await monitor.logConnectionFailure(failure, mockEnv);

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: "high",
        }),
        mockEnv,
      );
    });

    it("should treat non-critical errors as medium severity", async () => {
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Query syntax error",
        timestamp: new Date(),
      };

      await monitor.logConnectionFailure(failure, mockEnv);

      // Non-critical errors don't trigger security events unless threshold exceeded
      expect(mockLogSecurityEvent).not.toHaveBeenCalled();
    });
  });

  describe("getFailureStats", () => {
    it("should return empty stats when no failures", () => {
      const stats = monitor.getFailureStats();
      expect(stats).toEqual({});
    });

    it("should return failure statistics", async () => {
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Connection timeout",
        timestamp: new Date(),
        operation: "findUnique",
      };

      await monitor.logConnectionFailure(failure, mockEnv);

      const stats = monitor.getFailureStats();
      expect(stats["US:findUnique"]).toBeDefined();
      expect(stats["US:findUnique"]?.count).toBe(1);
      expect(stats["US:findUnique"]?.lastFailure).toBeInstanceOf(Date);
    });

    it("should not include alert entries in stats", async () => {
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Connection timeout",
        timestamp: new Date(),
        operation: "findUnique",
      };

      // Trigger threshold to create alert entry
      for (let i = 0; i < 5; i++) {
        await monitor.logConnectionFailure(failure, mockEnv);
      }

      const stats = monitor.getFailureStats();
      // Should not include 'US:findUnique:alert' in stats
      expect(stats["US:findUnique:alert"]).toBeUndefined();
    });
  });

  describe("resetStats", () => {
    it("should clear all failure statistics", async () => {
      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Connection timeout",
        timestamp: new Date(),
        operation: "findUnique",
      };

      await monitor.logConnectionFailure(failure, mockEnv);

      let stats = monitor.getFailureStats();
      expect(stats["US:findUnique"]?.count).toBe(1);

      monitor.resetStats();

      stats = monitor.getFailureStats();
      expect(stats).toEqual({});
    });
  });

  describe("error handling", () => {
    it("should handle security event logging failures gracefully", async () => {
      mockLogSecurityEvent.mockRejectedValueOnce(
        new Error("Security logging failed"),
      );

      const failure: DatabaseConnectionFailure = {
        region: "US",
        error: "Authentication failed",
        timestamp: new Date(),
      };

      // Outcome 1: the call does not throw — the catch clause must
      // swallow the security-monitor failure so DB monitoring keeps
      // running.
      await expect(
        monitor.logConnectionFailure(failure, mockEnv),
      ).resolves.not.toThrow();

      // Outcome 2: the swallowed error is surfaced as a warn-level log
      // record so an operator can still see it. This *is* the
      // observable behaviour — there's no DB row or other side effect.
      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "warn",
          msg: expect.stringMatching(/Failed to log security event/),
        }),
      );
    });
  });

  describe("default LOG_LEVEL behavior", () => {
    it("should default to INFO when LOG_LEVEL is not set", () => {
      const env: DatabaseMonitorEnv = {
        DATABASE_URL: "postgresql://test:test@localhost:5432/test",
        // LOG_LEVEL not set
      };

      const log: DatabaseQueryLog = {
        operation: "user.findUnique",
        region: "US",
        success: true,
        timestamp: new Date(),
      };

      capture.clear();
      monitor.logQuery(log, env);

      // Outcome: at default INFO level, no debug Query-executed record
      // is emitted.
      expect(
        capture
          .entries()
          .filter((e: LogRecord) => e.level === "debug" && /Query executed/.test(e.msg)),
      ).toHaveLength(0);
    });
  });
});
