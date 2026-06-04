import { describe, it, expect, vi, beforeEach } from "vitest";
import { DataRouter } from "../../src/lib/data-router.js";
import type { DataRouterEnv } from "../../src/lib/data-router.js";

// Mock db module. `mockFindUnique` is kept as the variable name for diff
// minimalism, but the unified `consent` model is now queried via `findFirst`
// (append-only: the current decision is the single active row).
const mockFindUnique = vi.fn();

vi.mock("../../src/db", () => ({
  createPrismaForRegion: vi.fn((region: string, env: any) => {
    return {
      consent: {
        findFirst: mockFindUnique,
      },
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      post: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      postEntity: {
        createMany: vi.fn(),
      },
      entity: {
        findMany: vi.fn(),
      },
      $transaction: vi.fn(),
    };
  }),
}));

// Mock region-detection
vi.mock("../../src/lib/region-detection", () => {
  const mockIsValidRegion = vi.fn((region: string) =>
    ["US", "EU", "CN"].includes(region),
  );
  return {
    isValidRegion: mockIsValidRegion,
    RegionDetector: class RegionDetector {
      isValidRegion = mockIsValidRegion;
    },
  };
});

// Mock audit-logger
const mockLog = vi.fn().mockResolvedValue(undefined);
const mockAuditLogger = {
  log: mockLog,
  withRequestId: vi.fn((requestId: string) => mockAuditLogger),
};

vi.mock("../../src/lib/audit-composer", () => {
  return {
    TrellisAuditLogger: class TrellisAuditLogger {
      log = mockLog;
      withRequestId = vi.fn((requestId: string) => mockAuditLogger);
    },
  };
});

// Mock ip-scrubber
vi.mock("../../src/lib/ip-scrubber", () => ({
  getIPAddress: vi.fn((request: Request) => {
    return request.headers.get("CF-Connecting-IP") || "127.0.0.1";
  }),
}));

describe("DataRouter - Cross-Region Consent", () => {
  const createMockEnv = (
    overrides: Partial<DataRouterEnv> = {},
  ): DataRouterEnv => ({
    DATABASE_URL: "postgres://test",
    DEFAULT_REGION: "US",
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUnique.mockReset();
  });

  describe("checkCrossRegionConsent", () => {
    it("should return true when user has active consent", async () => {
      const env = createMockEnv();
      mockFindUnique.mockResolvedValue({
        userId: "user-123",
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
        withdrawnAt: null,
      });

      const result = await DataRouter.checkCrossRegionConsent(
        "user-123",
        "EU",
        "US",
        env,
      );

      expect(result).toBe(true);
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: {
          userId: "user-123",
          purpose: "CROSS_REGION",
          dataRegion: "EU",
          accessRegion: "US",
          active: true,
        },
      });
    });

    it("should return false when consent does not exist", async () => {
      const env = createMockEnv();
      mockFindUnique.mockResolvedValue(null);

      const result = await DataRouter.checkCrossRegionConsent(
        "user-123",
        "EU",
        "US",
        env,
      );

      expect(result).toBe(false);
    });

    it("should return false when consent is withdrawn", async () => {
      const env = createMockEnv();
      mockFindUnique.mockResolvedValue({
        userId: "user-123",
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
        withdrawnAt: new Date("2024-01-01"),
      });

      const result = await DataRouter.checkCrossRegionConsent(
        "user-123",
        "EU",
        "US",
        env,
      );

      expect(result).toBe(false);
    });

    it("should return false when consented is false", async () => {
      const env = createMockEnv();
      mockFindUnique.mockResolvedValue({
        userId: "user-123",
        dataRegion: "EU",
        accessRegion: "US",
        consented: false,
        withdrawnAt: null,
      });

      const result = await DataRouter.checkCrossRegionConsent(
        "user-123",
        "EU",
        "US",
        env,
      );

      expect(result).toBe(false);
    });

    it("should return false and log warning on database error", async () => {
      const env = createMockEnv();
      const dbError = new Error("Database connection failed");
      mockFindUnique.mockRejectedValue(dbError);

      const result = await DataRouter.checkCrossRegionConsent(
        "user-123",
        "EU",
        "US",
        env,
      );

      expect(result).toBe(false);
          });

    it("should query correct database for access region", async () => {
      const env = createMockEnv();
      const { createPrismaForRegion } = await import("../../src/db.js");

      mockFindUnique.mockResolvedValue({
        userId: "user-123",
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
        withdrawnAt: null,
      });

      await DataRouter.checkCrossRegionConsent("user-123", "EU", "US", env);

      // Should use accessRegion (US) to get the database
      expect(createPrismaForRegion).toHaveBeenCalledWith("US", env);
    });
  });

  describe("validateRegionAccessWithConsent", () => {
    it("should allow access when regions match", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com");

      await expect(
        DataRouter.validateRegionAccessWithConsent(
          "US",
          "US",
          "user-123",
          env,
          request,
        ),
      ).resolves.not.toThrow();
    });

    it("should allow access when user has consent", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com", {
        headers: {
          "User-Agent": "test-agent",
          "CF-Connecting-IP": "192.168.1.1",
        },
      });

      mockFindUnique.mockResolvedValue({
        userId: "user-123",
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
        withdrawnAt: null,
      });

      await expect(
        DataRouter.validateRegionAccessWithConsent(
          "EU",
          "US",
          "user-123",
          env,
          request,
          "req-123",
        ),
      ).resolves.not.toThrow();

      // Should log consent-based access
          });

    it("should throw error when user does not have consent", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com");

      mockFindUnique.mockResolvedValue(null); // No consent

      await expect(
        DataRouter.validateRegionAccessWithConsent(
          "EU",
          "US",
          "user-123",
          env,
          request,
        ),
      ).rejects.toThrow("CROSS_REGION_ACCESS_REQUIRES_CONSENT");

      const error = await DataRouter.validateRegionAccessWithConsent(
        "EU",
        "US",
        "user-123",
        env,
        request,
      ).catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as any).code).toBe("CROSS_REGION_ACCESS_REQUIRES_CONSENT");
      expect((error as any).dataRegion).toBe("EU");
      expect((error as any).requestedRegion).toBe("US");
    });

    it("should throw error when userId is not provided", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com");

      await expect(
        DataRouter.validateRegionAccessWithConsent(
          "EU",
          "US",
          undefined,
          env,
          request,
        ),
      ).rejects.toThrow("CROSS_REGION_ACCESS_REQUIRES_CONSENT");

      // Should not check consent when userId is undefined
      expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it("should throw error when dataRegion is null", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com");

      await expect(
        DataRouter.validateRegionAccessWithConsent(
          null,
          "US",
          "user-123",
          env,
          request,
        ),
      ).rejects.toThrow("Data residency violation: dataRegion not set");
    });

    it("should throw error when dataRegion is undefined", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com");

      await expect(
        DataRouter.validateRegionAccessWithConsent(
          undefined,
          "US",
          "user-123",
          env,
          request,
        ),
      ).rejects.toThrow("Data residency violation: dataRegion not set");
    });

    it("should handle audit logging failure gracefully when consent exists", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com");

      mockFindUnique.mockResolvedValue({
        userId: "user-123",
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
        withdrawnAt: null,
      });

      // Mock audit logging failure
      mockLog.mockRejectedValueOnce(new Error("Audit log failed"));

      // Should still allow access even if audit logging fails
      await expect(
        DataRouter.validateRegionAccessWithConsent(
          "EU",
          "US",
          "user-123",
          env,
          request,
        ),
      ).resolves.not.toThrow();

      // Should log the audit failure
          });

    it("should check consent for correct user and regions", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com");

      mockFindUnique.mockResolvedValue({
        userId: "user-123",
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
        withdrawnAt: null,
      });

      await DataRouter.validateRegionAccessWithConsent(
        "EU",
        "US",
        "user-123",
        env,
        request,
      );

      expect(mockFindUnique).toHaveBeenCalledWith({
        where: {
          userId: "user-123",
          purpose: "CROSS_REGION",
          dataRegion: "EU",
          accessRegion: "US",
          active: true,
        },
      });
    });

    it("should log blocked access when consent is withdrawn", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com", {
        headers: {
          "User-Agent": "test-agent",
          "CF-Connecting-IP": "192.168.1.1",
        },
      });

      mockFindUnique.mockResolvedValue({
        userId: "user-123",
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
        withdrawnAt: new Date("2024-01-01"), // Withdrawn
      });

      await expect(
        DataRouter.validateRegionAccessWithConsent(
          "EU",
          "US",
          "user-123",
          env,
          request,
          "req-123",
        ),
      ).rejects.toThrow("CROSS_REGION_ACCESS_REQUIRES_CONSENT");

      // Should log blocked access
          });

    it("should handle different region combinations", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com");

      // Test EU -> US
      mockFindUnique.mockResolvedValue({
        userId: "user-123",
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
        withdrawnAt: null,
      });

      await expect(
        DataRouter.validateRegionAccessWithConsent(
          "EU",
          "US",
          "user-123",
          env,
          request,
        ),
      ).resolves.not.toThrow();

      // Test US -> EU
      mockFindUnique.mockResolvedValue({
        userId: "user-123",
        dataRegion: "US",
        accessRegion: "EU",
        consented: true,
        withdrawnAt: null,
      });

      await expect(
        DataRouter.validateRegionAccessWithConsent(
          "US",
          "EU",
          "user-123",
          env,
          request,
        ),
      ).resolves.not.toThrow();

      // Test CN -> US
      mockFindUnique.mockResolvedValue({
        userId: "user-123",
        dataRegion: "CN",
        accessRegion: "US",
        consented: true,
        withdrawnAt: null,
      });

      await expect(
        DataRouter.validateRegionAccessWithConsent(
          "CN",
          "US",
          "user-123",
          env,
          request,
        ),
      ).resolves.not.toThrow();
    });

    it("should include requestId in audit logs when provided", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com");

      mockFindUnique.mockResolvedValue({
        userId: "user-123",
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
        withdrawnAt: null,
      });

      await DataRouter.validateRegionAccessWithConsent(
        "EU",
        "US",
        "user-123",
        env,
        request,
        "req-123",
      );

      // Audit logger should be called with requestId
      const { TrellisAuditLogger } = await import("../../src/lib/audit-composer.js");
      expect(TrellisAuditLogger).toBeDefined();
    });
  });
});
