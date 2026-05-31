/**
 * Unit Tests: Domain Reputation Service
 *
 * Tests for domain reputation scoring, blocklists, and allowlists.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DomainReputationService } from "../../src/lib/domain-reputation-service.js";
import { DataRouter } from "../../src/lib/data-router.js";

// Mock DataRouter
vi.mock("../../src/lib/data-router", () => {
  const mockDb = {
    domainReputation: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    linkReport: {
      count: vi.fn(),
    },
  };

  return {
    DataRouter: {
      getDatabaseForRegion: vi.fn(() => mockDb),
    },
  };
});

describe("DomainReputationService", () => {
  let service: DomainReputationService;
  let mockDb: any;
  const mockEnv = {} as any;
  const region = "US";

  beforeEach(() => {
    service = new DomainReputationService(mockEnv);
    mockDb = (DataRouter.getDatabaseForRegion as any)(region, mockEnv);
    vi.clearAllMocks();
  });

  describe("getReputation", () => {
    it("should return default reputation for new domain", async () => {
      // Arrange
      mockDb.domainReputation.findUnique.mockResolvedValue(null);
      mockDb.domainReputation.create.mockResolvedValue({
        id: "1",
        domain: "example.com",
        reputation: 0,
        status: "unknown",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Act
      const result = await service.getReputation(
        "example.com",
        region,
        mockEnv,
      );

      // Assert
      expect(result.domain).toBe("example.com");
      expect(result.reputation).toBe(0);
      expect(result.status).toBe("unknown");
      expect(mockDb.domainReputation.create).toHaveBeenCalled();
    });

    it("should return existing reputation", async () => {
      // Arrange
      const existingReputation = {
        id: "1",
        domain: "example.com",
        reputation: 50,
        status: "safe",
        lastChecked: new Date("2024-01-01"),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDb.domainReputation.findUnique.mockResolvedValue(existingReputation);

      // Act
      const result = await service.getReputation(
        "example.com",
        region,
        mockEnv,
      );

      // Assert
      expect(result.domain).toBe("example.com");
      expect(result.reputation).toBe(50);
      expect(result.status).toBe("safe");
      expect(mockDb.domainReputation.create).not.toHaveBeenCalled();
    });

    it("should normalize domain name", async () => {
      // Arrange
      mockDb.domainReputation.findUnique.mockResolvedValue(null);
      mockDb.domainReputation.create.mockResolvedValue({
        id: "1",
        domain: "example.com",
        reputation: 0,
        status: "unknown",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Act
      await service.getReputation(
        "HTTPS://WWW.EXAMPLE.COM/path?query=1",
        region,
        mockEnv,
      );

      // Assert
      expect(mockDb.domainReputation.create).toHaveBeenCalledWith({
        data: {
          domain: "example.com",
          reputation: 0,
          status: "unknown",
          lastChecked: expect.any(Date),
        },
      });
    });

    it("should return default on error", async () => {
      // Arrange
      mockDb.domainReputation.findUnique.mockRejectedValue(
        new Error("DB error"),
      );

      // Act
      const result = await service.getReputation(
        "example.com",
        region,
        mockEnv,
      );

      // Assert
      expect(result.domain).toBe("example.com");
      expect(result.reputation).toBe(0);
      expect(result.status).toBe("unknown");
    });
  });

  describe("updateReputation", () => {
    it("should update reputation with positive signal", async () => {
      // Arrange
      const existingReputation = {
        id: "1",
        domain: "example.com",
        reputation: 0,
        status: "unknown",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDb.domainReputation.findUnique.mockResolvedValue(existingReputation);
      mockDb.domainReputation.update.mockResolvedValue({
        ...existingReputation,
        reputation: 30,
        status: "safe",
      });

      // Act
      await service.updateReputation(
        "example.com",
        "threat_intel_positive",
        region,
        mockEnv,
      );

      // Assert
      expect(mockDb.domainReputation.update).toHaveBeenCalledWith({
        where: { domain: "example.com" },
        data: {
          reputation: 30,
          status: "safe",
          lastChecked: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      });
    });

    it("should update reputation with negative signal", async () => {
      // Arrange
      const existingReputation = {
        id: "1",
        domain: "example.com",
        reputation: 0,
        status: "unknown",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDb.domainReputation.findUnique.mockResolvedValue(existingReputation);
      mockDb.domainReputation.update.mockResolvedValue({
        ...existingReputation,
        reputation: -50,
        status: "blocked",
      });

      // Act
      await service.updateReputation(
        "example.com",
        "threat_intel_negative",
        region,
        mockEnv,
      );

      // Assert
      expect(mockDb.domainReputation.update).toHaveBeenCalledWith({
        where: { domain: "example.com" },
        data: {
          reputation: -50,
          status: "blocked",
          lastChecked: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      });
    });

    it("should create reputation if not exists", async () => {
      // Arrange
      mockDb.domainReputation.findUnique.mockResolvedValue(null);
      mockDb.domainReputation.create.mockResolvedValue({
        id: "1",
        domain: "example.com",
        reputation: 0,
        status: "unknown",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDb.domainReputation.update.mockResolvedValue({
        id: "1",
        domain: "example.com",
        reputation: 30,
        status: "safe",
        lastChecked: new Date(),
        updatedAt: new Date(),
      });

      // Act
      await service.updateReputation(
        "example.com",
        "threat_intel_positive",
        region,
        mockEnv,
      );

      // Assert
      expect(mockDb.domainReputation.create).toHaveBeenCalled();
      expect(mockDb.domainReputation.update).toHaveBeenCalled();
    });

    it("should set status to blocked for admin_block signal", async () => {
      // Arrange
      const existingReputation = {
        id: "1",
        domain: "example.com",
        reputation: 50,
        status: "safe",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDb.domainReputation.findUnique.mockResolvedValue(existingReputation);
      mockDb.domainReputation.update.mockResolvedValue({
        ...existingReputation,
        reputation: -50,
        status: "blocked",
      });

      // Act
      await service.updateReputation(
        "example.com",
        "admin_block",
        region,
        mockEnv,
      );

      // Assert
      expect(mockDb.domainReputation.update).toHaveBeenCalledWith({
        where: { domain: "example.com" },
        data: {
          reputation: -50,
          status: "blocked",
          lastChecked: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      });
    });

    it("should clamp reputation to valid range", async () => {
      // Arrange
      const existingReputation = {
        id: "1",
        domain: "example.com",
        reputation: 90,
        status: "safe",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDb.domainReputation.findUnique.mockResolvedValue(existingReputation);
      mockDb.domainReputation.update.mockResolvedValue({
        ...existingReputation,
        reputation: 100, // Clamped to max
        status: "safe",
      });

      // Act
      await service.updateReputation(
        "example.com",
        "threat_intel_positive",
        region,
        mockEnv,
      );

      // Assert
      expect(mockDb.domainReputation.update).toHaveBeenCalledWith({
        where: { domain: "example.com" },
        data: {
          reputation: 100, // Should be clamped to MAX_REPUTATION
          status: "safe",
          lastChecked: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      });
    });
  });

  describe("blockDomain", () => {
    it("should block domain", async () => {
      // Arrange
      const existingReputation = {
        id: "1",
        domain: "example.com",
        reputation: 0,
        status: "unknown",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDb.domainReputation.findUnique.mockResolvedValue(existingReputation);
      mockDb.domainReputation.update.mockResolvedValue({
        ...existingReputation,
        reputation: -100,
        status: "blocked",
      });

      // Act
      await service.blockDomain("example.com", region, mockEnv);

      // Assert
      expect(mockDb.domainReputation.update).toHaveBeenCalled();
    });
  });

  describe("unblockDomain", () => {
    it("should unblock domain and reset reputation", async () => {
      // Arrange
      const existingReputation = {
        id: "1",
        domain: "example.com",
        reputation: -100,
        status: "blocked",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDb.domainReputation.findUnique.mockResolvedValue(existingReputation);
      mockDb.domainReputation.update.mockResolvedValue({
        ...existingReputation,
        reputation: 0,
        status: "unknown",
      });

      // Act
      await service.unblockDomain("example.com", region, mockEnv);

      // Assert
      expect(mockDb.domainReputation.update).toHaveBeenCalledWith({
        where: { domain: "example.com" },
        data: {
          reputation: 0,
          status: "unknown",
          lastChecked: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      });
    });
  });

  describe("addToAllowlist", () => {
    it("should add domain to allowlist", async () => {
      // Arrange
      const existingReputation = {
        id: "1",
        domain: "example.com",
        reputation: 0,
        status: "unknown",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDb.domainReputation.findUnique.mockResolvedValue(existingReputation);
      mockDb.domainReputation.update.mockResolvedValue({
        ...existingReputation,
        reputation: 50,
        status: "safe",
      });

      // Act
      await service.addToAllowlist("example.com", region, mockEnv);

      // Assert
      expect(mockDb.domainReputation.update).toHaveBeenCalled();
    });
  });

  describe("shouldAutoBlock", () => {
    it("should return true when report threshold exceeded", async () => {
      // Arrange
      mockDb.linkReport.count.mockResolvedValue(5); // Threshold is 5
      mockDb.domainReputation.findUnique.mockResolvedValue({
        id: "1",
        domain: "example.com",
        reputation: -10,
        status: "warning",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Act
      const result = await service.shouldAutoBlock(
        "example.com",
        region,
        mockEnv,
      );

      // Assert
      expect(result).toBe(true);
    });

    it("should return false when report threshold not exceeded", async () => {
      // Arrange
      mockDb.linkReport.count.mockResolvedValue(3); // Below threshold

      // Act
      const result = await service.shouldAutoBlock(
        "example.com",
        region,
        mockEnv,
      );

      // Assert
      expect(result).toBe(false);
    });

    it("should return false when domain already blocked", async () => {
      // Arrange
      mockDb.linkReport.count.mockResolvedValue(10);
      mockDb.domainReputation.findUnique.mockResolvedValue({
        id: "1",
        domain: "example.com",
        reputation: -100,
        status: "blocked",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Act
      const result = await service.shouldAutoBlock(
        "example.com",
        region,
        mockEnv,
      );

      // Assert
      expect(result).toBe(false);
    });
  });

  describe("applyReputationDecay", () => {
    it("should decay stale domain reputations", async () => {
      // Arrange
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const staleDomain = {
        id: "1",
        domain: "example.com",
        reputation: 50,
        status: "safe",
        lastChecked: thirtyDaysAgo,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockDb.domainReputation.findMany.mockResolvedValue([staleDomain]);
      mockDb.domainReputation.update.mockResolvedValue({
        ...staleDomain,
        reputation: 20, // Decayed by 30 days * 1 point/day = 30, so 50 - 30 = 20
        status: "safe",
      });

      // Act
      await service.applyReputationDecay(region, mockEnv, 1);

      // Assert
      expect(mockDb.domainReputation.findMany).toHaveBeenCalled();
      expect(mockDb.domainReputation.update).toHaveBeenCalled();
    });

    it("should not decay blocked domains", async () => {
      // Arrange
      mockDb.domainReputation.findMany.mockResolvedValue([]); // No stale domains (blocked ones are filtered)

      // Act
      await service.applyReputationDecay(region, mockEnv, 1);

      // Assert
      expect(mockDb.domainReputation.update).not.toHaveBeenCalled();
    });
  });
});
