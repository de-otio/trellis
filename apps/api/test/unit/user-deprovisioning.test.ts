/**
 * Unit Tests: User Deprovisioning
 *
 * Tests for user suspension, restoration, and access blocking.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { UserDeprovisioning } from "../../src/lib/user-deprovisioning.js";
import { createMockEnv } from "../utils/mock-env.js";

// Mock Prisma client
vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(),
}));

// Mock DatabaseConnectionManager
vi.mock("../../src/lib/database-connection-manager", () => {
  const mockExecuteWithRetry = vi.fn();
  const mockSharedInstance = {
    createClient: vi.fn(),
    clearPools: vi.fn(),
    getPoolStatus: vi.fn().mockReturnValue([]),
    executeWithRetry: mockExecuteWithRetry,
  };
  return {
    DatabaseConnectionManager: class {
      createClient = mockSharedInstance.createClient;
      clearPools = mockSharedInstance.clearPools;
      getPoolStatus = mockSharedInstance.getPoolStatus;
      executeWithRetry = mockSharedInstance.executeWithRetry;
    },
    sharedDatabaseConnectionManager: mockSharedInstance,
  };
});

// Mock Security Monitor
vi.mock("../../src/lib/security-monitor", () => {
  return {
    SecurityMonitor: class {
      logSecurityEvent = vi.fn().mockResolvedValue(undefined);
    },
  };
});

describe("UserDeprovisioning", () => {
  let deprovisioning: UserDeprovisioning;
  let mockEnv: any;
  let mockPrisma: any;

  beforeEach(async () => {
    deprovisioning = new UserDeprovisioning();

    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SECURITY_WEBHOOK_URL: "https://webhook.example.com/security",
    };

    mockPrisma = {
      user: {
        // @ts-ignore - Vitest mock types
        update: vi.fn().mockResolvedValue({
          id: "user-123",
          suspended: true,
          suspendedAt: new Date(),
          suspendedReason: "idp_removal: User removed from IdP",
        }),
        // @ts-ignore - Vitest mock types
        findUnique: vi.fn().mockResolvedValue({
          id: "user-123",
          suspended: false,
        }),
      },
    };

    const dbModule = await import("../../src/db.js");
    vi.mocked(dbModule.createPrisma).mockReturnValue(mockPrisma as any);
  });

  describe("suspendUser", () => {
    it("should suspend user account", async () => {
      await deprovisioning.suspendUser(
        "user-123",
        {
          type: "idp_removal",
          description: "User removed from IdP",
          initiatedBy: "system",
        },
        mockEnv,
      );

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-123" },
        data: {
          suspended: true,
          suspendedAt: expect.any(Date),
          suspendedReason: "idp_removal: User removed from IdP",
        },
      });
    });

    it("should log security event when suspending user", async () => {
      const deprovisioningWithSecurity = new UserDeprovisioning();
      const logSecurityEventSpy = (deprovisioningWithSecurity as any)
        .securityMonitor.logSecurityEvent;
      await deprovisioningWithSecurity.suspendUser(
        "user-123",
        {
          type: "idp_removal",
          description: "User removed from IdP",
          initiatedBy: "admin-456",
        },
        mockEnv,
      );

      expect(logSecurityEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "suspicious_activity",
          severity: "high",
          userId: "user-123",
          metadata: expect.objectContaining({
            action: "user_suspended",
            reason: "idp_removal",
            initiatedBy: "admin-456",
          }),
        }),
        mockEnv,
      );
    });

    it("should handle suspension errors", async () => {
      mockPrisma.user.update.mockRejectedValue(new Error("Database error"));

      await expect(
        deprovisioning.suspendUser(
          "user-123",
          {
            type: "idp_removal",
            description: "User removed from IdP",
          },
          mockEnv,
        ),
      ).rejects.toThrow("Database error");
    });
  });

  describe("isUserSuspended", () => {
    it("should return true for suspended user", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user-123",
        suspended: true,
      });

      // Mock executeWithRetry to call the query function with mockPrisma
      const { sharedDatabaseConnectionManager } = await import(
        "../../src/lib/database-connection-manager.js"
      );
      (
        sharedDatabaseConnectionManager.executeWithRetry as any
      ).mockImplementation(
        async (region: string, env: any, queryFn: any, options: any) => {
          return await queryFn(mockPrisma);
        },
      );

      const isSuspended = await deprovisioning.isUserSuspended(
        "user-123",
        mockEnv,
        "US",
      );

      expect(isSuspended).toBe(true);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user-123" },
        select: { suspended: true },
      });
    });

    it("should return false for non-suspended user", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user-123",
        suspended: false,
      });

      // Mock executeWithRetry to call the query function with mockPrisma
      const { sharedDatabaseConnectionManager } = await import(
        "../../src/lib/database-connection-manager.js"
      );
      (
        sharedDatabaseConnectionManager.executeWithRetry as any
      ).mockImplementation(
        async (region: string, env: any, queryFn: any, options: any) => {
          return await queryFn(mockPrisma);
        },
      );

      const isSuspended = await deprovisioning.isUserSuspended(
        "user-123",
        mockEnv,
        "US",
      );

      expect(isSuspended).toBe(false);
    });

    it("should return false if user not found (fail open)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const isSuspended = await deprovisioning.isUserSuspended(
        "non-existent",
        mockEnv,
      );

      expect(isSuspended).toBe(false);
    });

    it("should return false on database error (fail open)", async () => {
      mockPrisma.user.findUnique.mockRejectedValue(new Error("Database error"));

      const isSuspended = await deprovisioning.isUserSuspended(
        "user-123",
        mockEnv,
      );

      expect(isSuspended).toBe(false);
    });
  });

  describe("restoreUser", () => {
    it("should restore suspended user account", async () => {
      await deprovisioning.restoreUser(
        "user-123",
        "User account restored by admin",
        "admin-456",
        mockEnv,
      );

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-123" },
        data: {
          suspended: false,
          suspendedAt: null,
          suspendedReason: null,
        },
      });
    });

    it("should log security event when restoring user", async () => {
      const deprovisioningWithSecurity = new UserDeprovisioning();
      const logSecurityEventSpy = (deprovisioningWithSecurity as any)
        .securityMonitor.logSecurityEvent;
      await deprovisioningWithSecurity.restoreUser(
        "user-123",
        "User account restored",
        "admin-456",
        mockEnv,
      );

      expect(logSecurityEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "suspicious_activity",
          severity: "medium",
          userId: "user-123",
          success: true,
          metadata: expect.objectContaining({
            action: "user_restored",
            initiatedBy: "admin-456",
          }),
        }),
        mockEnv,
      );
    });

    it("should handle restoration errors", async () => {
      mockPrisma.user.update.mockRejectedValue(new Error("Database error"));

      await expect(
        deprovisioning.restoreUser(
          "user-123",
          "User account restored",
          "admin-456",
          mockEnv,
        ),
      ).rejects.toThrow("Database error");
    });
  });

  describe("verifyUserStillInIdP", () => {
    it("should return true (placeholder implementation)", async () => {
      const isValid = await deprovisioning.verifyUserStillInIdP(
        "user-123",
        "microsoft",
        mockEnv,
      );

      expect(isValid).toBe(true);
    });
  });
});
