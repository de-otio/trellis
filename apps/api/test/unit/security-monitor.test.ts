/**
 * Unit Tests: Security Monitor
 *
 * Tests for security event logging, pattern detection, and alerting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SecurityMonitor,
  type SecurityEventSeverity,
  type SecurityEventType,
} from "../../src/lib/security-monitor.js";

// Mock Prisma client
const mockCreatePrisma = vi.fn();
vi.mock("../../src/db", () => ({
  createPrisma: (...args: any[]) => mockCreatePrisma(...args),
}));

// Mock fetch for webhook calls - will be reset in beforeEach
let originalFetch: typeof global.fetch;

describe("SecurityMonitor", () => {
  let monitor: SecurityMonitor;
  let mockEnv: any;
  let mockPrisma: any;

  beforeEach(() => {
    monitor = new SecurityMonitor();

    // Save original fetch
    originalFetch = global.fetch;

    // Mock fetch
    (global.fetch as any) = vi.fn().mockResolvedValue({ ok: true });

    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SECURITY_WEBHOOK_URL: "https://webhook.example.com/security",
      ANALYTICS: {
        writeDataPoint: vi.fn().mockResolvedValue(undefined),
      },
    };

    mockPrisma = {
      securityEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-123" }),
      },
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ count: BigInt(0) }]),
    };

    mockCreatePrisma.mockReturnValue(mockPrisma);
  });

  afterEach(() => {
    // Restore original fetch after each test
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  describe("logSSOEvent", () => {
    it("should log successful SSO login with low severity", async () => {
      await monitor.logSSOEvent(
        {
          type: "sso_login",
          userId: "user-123",
          provider: "microsoft",
          ipAddress: "192.168.1.1",
          userAgent: "test-agent",
          success: true,
          metadata: { role: "INTERNAL" },
        },
        mockEnv,
      );

      expect(mockPrisma.securityEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "sso_login",
            severity: "low",
            userId: "user-123",
          }),
        }),
      );
      expect(mockEnv.ANALYTICS.writeDataPoint).toHaveBeenCalled();
    });

    it("should log failed SSO attempt with high severity", async () => {
      await monitor.logSSOEvent(
        {
          type: "sso_failed",
          provider: "microsoft",
          ipAddress: "192.168.1.1",
          userAgent: "test-agent",
          success: false,
          metadata: { reason: "invalid_code" },
        },
        mockEnv,
      );

      expect(mockPrisma.securityEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "sso_failed",
            severity: "high",
          }),
        }),
      );
      expect(mockEnv.ANALYTICS.writeDataPoint).toHaveBeenCalled();
    });

    it("should send alert for high severity events", async () => {
      await monitor.logSSOEvent(
        {
          type: "sso_failed",
          provider: "microsoft",
          ipAddress: "192.168.1.1",
          userAgent: "test-agent",
          success: false,
        },
        mockEnv,
      );

      expect(global.fetch).toHaveBeenCalledWith(
        mockEnv.SECURITY_WEBHOOK_URL,
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    it("should not send alert for low severity events", async () => {
      await monitor.logSSOEvent(
        {
          type: "sso_login",
          userId: "user-123",
          provider: "microsoft",
          ipAddress: "192.168.1.1",
          userAgent: "test-agent",
          success: true,
        },
        mockEnv,
      );

      // Low severity events should not trigger alerts
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("logSecurityEvent", () => {
    it("[T7] should store security event in database", async () => {
      await monitor.logSecurityEvent(
        {
          type: "sso_config_error",
          severity: "medium",
          ipAddress: "192.168.1.1",
          userAgent: "test-agent",
          success: false,
          metadata: { reason: "tokens_in_url" },
        },
        mockEnv,
      );

      // Updated to expect Prisma create method instead of raw SQL
      expect(mockPrisma.securityEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "sso_config_error",
            severity: "medium",
            userId: null,
            // T1 (v0.7): the column is `tenantId`; the input event shape keeps
            // the legacy `partnerId` key, but nothing persists under that name.
            tenantId: null,
            ipAddress: "192.168.1.1",
            userAgent: "test-agent",
            details: expect.stringContaining("tokens_in_url"),
            retentionUntil: expect.any(Date), // Retention date calculated from severity
          }),
        }),
      );
    });

    it("should send to analytics engine", async () => {
      await monitor.logSecurityEvent(
        {
          type: "rate_limit_exceeded",
          severity: "medium",
          ipAddress: "192.168.1.1",
          success: false,
        },
        mockEnv,
      );

      expect(mockEnv.ANALYTICS.writeDataPoint).toHaveBeenCalledWith(
        expect.objectContaining({
          blobs: expect.arrayContaining([
            "security_event",
            "rate_limit_exceeded",
            "medium",
          ]),
        }),
      );
    });

    it("should send alert for critical events", async () => {
      await monitor.logSecurityEvent(
        {
          type: "unauthorized_access",
          severity: "critical",
          userId: "user-123",
          ipAddress: "192.168.1.1",
          success: false,
        },
        mockEnv,
      );

      expect(global.fetch).toHaveBeenCalledWith(
        mockEnv.SECURITY_WEBHOOK_URL,
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("Security Alert"),
        }),
      );
    });

    it("should handle database errors gracefully", async () => {
      mockPrisma.securityEvent.create.mockRejectedValue(
        new Error("Database error"),
      );

      // Should not throw
      await expect(
        monitor.logSecurityEvent(
          {
            type: "sso_login",
            severity: "low",
            success: true,
          },
          mockEnv,
        ),
      ).resolves.not.toThrow();
    });
  });

  describe("detectFailedAuthPattern", () => {
    it("should detect multiple failed attempts from same IP", async () => {
      // Mock 5 failed attempts
      mockPrisma.$queryRawUnsafe.mockResolvedValue([{ count: BigInt(5) }]);

      await monitor.logSSOEvent(
        {
          type: "sso_failed",
          provider: "microsoft",
          ipAddress: "192.168.1.1",
          userAgent: "test-agent",
          success: false,
        },
        mockEnv,
      );

      // Wait for pattern detection (it's called synchronously, but wait to ensure it completes)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should log suspicious activity (check the second call - first is the sso_failed event)
      const calls = mockPrisma.securityEvent.create.mock.calls;
      const suspiciousActivityCall = calls.find(
        (call: any) => call[0]?.data?.type === "suspicious_activity",
      );

      expect(suspiciousActivityCall).toBeDefined();
      expect(suspiciousActivityCall[0].data.type).toBe("suspicious_activity");
      expect(suspiciousActivityCall[0].data.severity).toBe("high");
      expect(suspiciousActivityCall[0].data.ipAddress).toBe("192.168.1.1");
      expect(suspiciousActivityCall[0].data.userAgent).toBe("test-agent");
      expect(suspiciousActivityCall[0].data.details).toContain(
        "multiple_failed_attempts",
      );
    });

    it("should not trigger alert for single failed attempt", async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([{ count: BigInt(1) }]);

      await monitor.logSSOEvent(
        {
          type: "sso_failed",
          provider: "microsoft",
          ipAddress: "192.168.1.1",
          userAgent: "test-agent",
          success: false,
        },
        mockEnv,
      );

      // Wait for pattern detection
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not log suspicious activity for single failure
      const calls = mockPrisma.securityEvent.create.mock.calls;
      const suspiciousActivityCalls = calls.filter(
        (call: any) => call[0]?.data?.type === "suspicious_activity",
      );
      expect(suspiciousActivityCalls.length).toBe(0);
    });

    it("should handle missing IP address gracefully", async () => {
      await monitor.logSSOEvent(
        {
          type: "sso_failed",
          provider: "microsoft",
          ipAddress: "192.168.1.1",
          userAgent: "test-agent",
          success: false,
        },
        mockEnv,
      );

      // Should not throw
      await expect(
        monitor.logSSOEvent(
          {
            type: "sso_failed",
            provider: "microsoft",
            ipAddress: "192.168.1.1",
            userAgent: "test-agent",
            success: false,
          },
          mockEnv,
        ),
      ).resolves.not.toThrow();
    });
  });

  describe("Error Handling", () => {
    it("should handle webhook failures gracefully", async () => {
      // Mock fetch to reject
      const originalFetch = global.fetch;
      (global.fetch as any) = vi
        .fn()
        .mockRejectedValue(new Error("Webhook error"));

      await expect(
        monitor.logSecurityEvent(
          {
            type: "unauthorized_access",
            severity: "critical",
            success: false,
          },
          mockEnv,
        ),
      ).resolves.not.toThrow();

      // Restore original fetch
      global.fetch = originalFetch;
    });

    it("should handle analytics failures gracefully", async () => {
      // Reset the mock to throw an error
      const originalWriteDataPoint = mockEnv.ANALYTICS.writeDataPoint;
      (mockEnv.ANALYTICS.writeDataPoint as any) = vi
        .fn()
        .mockRejectedValue(new Error("Analytics error"));

      await expect(
        monitor.logSecurityEvent(
          {
            type: "sso_login",
            severity: "low",
            success: true,
          },
          mockEnv,
        ),
      ).resolves.not.toThrow();

      // Restore original mock
      mockEnv.ANALYTICS.writeDataPoint = originalWriteDataPoint;
    });

    it("should handle missing ANALYTICS gracefully", async () => {
      delete mockEnv.ANALYTICS;

      await expect(
        monitor.logSecurityEvent(
          {
            type: "sso_login",
            severity: "low",
            success: true,
          },
          mockEnv,
        ),
      ).resolves.not.toThrow();
    });

    it("should calculate retention date based on severity", async () => {
      const criticalEvent = {
        type: "unauthorized_access" as const,
        severity: "critical" as const,
        success: false,
      };

      await monitor.logSecurityEvent(criticalEvent, mockEnv);

      const createCall = mockPrisma.securityEvent.create.mock.calls[0];
      const retentionUntil = createCall[0].data.retentionUntil;
      expect(retentionUntil).toBeInstanceOf(Date);

      // Critical events should have 365 days retention
      const daysFromNow = Math.floor(
        (retentionUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      expect(daysFromNow).toBeGreaterThanOrEqual(364);
      expect(daysFromNow).toBeLessThanOrEqual(366);
    });

    it("should calculate retention for high severity events (90 days)", async () => {
      const highEvent = {
        type: "sso_failed" as const,
        severity: "high" as const,
        success: false,
      };

      await monitor.logSecurityEvent(highEvent, mockEnv);

      const createCall = mockPrisma.securityEvent.create.mock.calls[0];
      const retentionUntil = createCall[0].data.retentionUntil;
      const daysFromNow = Math.floor(
        (retentionUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      expect(daysFromNow).toBeGreaterThanOrEqual(89);
      expect(daysFromNow).toBeLessThanOrEqual(91);
    });

    it("should calculate retention for medium severity events (30 days)", async () => {
      const mediumEvent = {
        type: "sso_config_error" as const,
        severity: "medium" as const,
        success: false,
      };

      await monitor.logSecurityEvent(mediumEvent, mockEnv);

      const createCall = mockPrisma.securityEvent.create.mock.calls[0];
      const retentionUntil = createCall[0].data.retentionUntil;
      const daysFromNow = Math.floor(
        (retentionUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      expect(daysFromNow).toBeGreaterThanOrEqual(29);
      expect(daysFromNow).toBeLessThanOrEqual(31);
    });

    it("should calculate retention for low severity events (7 days)", async () => {
      const lowEvent = {
        type: "sso_login" as const,
        severity: "low" as const,
        success: true,
      };

      await monitor.logSecurityEvent(lowEvent, mockEnv);

      const createCall = mockPrisma.securityEvent.create.mock.calls[0];
      const retentionUntil = createCall[0].data.retentionUntil;
      const daysFromNow = Math.floor(
        (retentionUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      expect(daysFromNow).toBeGreaterThanOrEqual(6);
      expect(daysFromNow).toBeLessThanOrEqual(8);
    });

    it("should handle all event types in determineSeverity", async () => {
      const eventTypes: Array<{
        type: SecurityEventType;
        success: boolean;
        expectedSeverity: SecurityEventSeverity;
      }> = [
        { type: "sso_login", success: true, expectedSeverity: "low" },
        { type: "sso_failed", success: false, expectedSeverity: "high" },
        {
          type: "sso_config_error",
          success: false,
          expectedSeverity: "medium",
        },
        {
          type: "rate_limit_exceeded",
          success: false,
          expectedSeverity: "medium",
        },
        {
          type: "suspicious_activity",
          success: false,
          expectedSeverity: "high",
        },
        {
          type: "unauthorized_access",
          success: false,
          expectedSeverity: "critical",
        },
        {
          type: "database_connection_failure",
          success: false,
          expectedSeverity: "low",
        },
      ];

      for (const { type, success, expectedSeverity } of eventTypes) {
        vi.clearAllMocks();
        await monitor.logSecurityEvent(
          {
            type,
            severity: expectedSeverity,
            success,
          },
          mockEnv,
        );

        const createCall = mockPrisma.securityEvent.create.mock.calls[0];
        expect(createCall[0].data.severity).toBe(expectedSeverity);
      }
    });

    it("should not send alert when webhook URL is not configured", async () => {
      delete mockEnv.SECURITY_WEBHOOK_URL;

      await monitor.logSecurityEvent(
        {
          type: "unauthorized_access",
          severity: "critical",
          success: false,
        },
        mockEnv,
      );

      expect(global.fetch).not.toHaveBeenCalled();
    });

    // The event payload still carries `partnerId` (the pre-v0.7 spelling of the
    // caller-facing field); the row it produces must be keyed on `tenantId`.
    it("[T7] should persist the event's partnerId as tenantId", async () => {
      await monitor.logSecurityEvent(
        {
          type: "sso_login",
          severity: "low",
          partnerId: "partner-123",
          success: true,
        },
        mockEnv,
      );

      expect(mockPrisma.securityEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: "partner-123",
          }),
        }),
      );
    });

    it("should handle detectFailedAuthPattern query errors gracefully", async () => {
      mockPrisma.$queryRawUnsafe.mockRejectedValue(
        new Error("Table does not exist"),
      );

      await expect(
        monitor.logSSOEvent(
          {
            type: "sso_failed",
            provider: "microsoft",
            ipAddress: "192.168.1.1",
            userAgent: "test-agent",
            success: false,
          },
          mockEnv,
        ),
      ).resolves.not.toThrow();
    });

    it("should not detect pattern when IP address is missing", async () => {
      await monitor.logSSOEvent(
        {
          type: "sso_failed",
          provider: "microsoft",
          ipAddress: "", // Empty IP
          userAgent: "test-agent",
          success: false,
        },
        mockEnv,
      );

      // Should not query for pattern detection
      expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it("should send analytics when ANALYTICS_OPT_OUT_ENABLED is not set", async () => {
      await monitor.logSecurityEvent(
        {
          type: "sso_login",
          severity: "low",
          userId: "user-123",
          success: true,
        },
        mockEnv,
      );

      expect(mockEnv.ANALYTICS.writeDataPoint).toHaveBeenCalled();
    });

    it("should send analytics when ANALYTICS_OPT_OUT_ENABLED is false", async () => {
      mockEnv.ANALYTICS_OPT_OUT_ENABLED = "false";

      await monitor.logSecurityEvent(
        {
          type: "sso_login",
          severity: "low",
          userId: "user-123",
          success: true,
        },
        mockEnv,
      );

      expect(mockEnv.ANALYTICS.writeDataPoint).toHaveBeenCalled();
    });

    it("should send analytics for anonymous users", async () => {
      await monitor.logSecurityEvent(
        {
          type: "sso_login",
          severity: "low",
          // No userId
          success: true,
        },
        mockEnv,
      );

      expect(mockEnv.ANALYTICS.writeDataPoint).toHaveBeenCalled();
    });

    it("should send analytics when ANALYTICS_OPT_OUT_ENABLED is true (preparatory feature)", async () => {
      // Even when the feature is enabled, it currently always returns true (preparatory)
      mockEnv.ANALYTICS_OPT_OUT_ENABLED = "true";

      await monitor.logSecurityEvent(
        {
          type: "sso_login",
          severity: "low",
          userId: "user-123",
          success: true,
        },
        mockEnv,
      );

      // Currently always sends analytics (preparatory feature, not yet implemented)
      expect(mockEnv.ANALYTICS.writeDataPoint).toHaveBeenCalled();
    });

    it("should handle detectFailedAuthPattern when IP is undefined", async () => {
      await monitor.logSecurityEvent(
        {
          type: "sso_failed",
          severity: "high",
          // No ipAddress
          success: false,
        },
        mockEnv,
      );

      // Should not query for pattern detection when IP is missing
      expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it("should handle detectFailedAuthPattern when IP is null", async () => {
      await monitor.logSecurityEvent(
        {
          type: "sso_failed",
          severity: "high",
          ipAddress: null as any,
          success: false,
        },
        mockEnv,
      );

      // Should not query for pattern detection when IP is null
      expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it("should handle provider field in analytics correctly", async () => {
      await monitor.logSecurityEvent(
        {
          type: "sso_login",
          severity: "low",
          provider: "google",
          success: true,
        },
        mockEnv,
      );

      expect(mockEnv.ANALYTICS.writeDataPoint).toHaveBeenCalledWith(
        expect.objectContaining({
          blobs: expect.arrayContaining(["google"]),
          indexes: expect.arrayContaining(["provider:google"]),
        }),
      );
    });

    it("should handle missing provider in analytics", async () => {
      await monitor.logSecurityEvent(
        {
          type: "sso_login",
          severity: "low",
          success: true,
        },
        mockEnv,
      );

      expect(mockEnv.ANALYTICS.writeDataPoint).toHaveBeenCalledWith(
        expect.objectContaining({
          blobs: expect.arrayContaining([""]), // Empty provider string
        }),
      );
    });
  });
});
