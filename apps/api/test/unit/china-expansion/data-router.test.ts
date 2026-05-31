/**
 * Unit tests for China expansion - DataRouter
 *
 * Tests data residency enforcement and region validation
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DataRouter } from "../../../src/lib/data-router.js";
import type { DataRouterEnv } from "../../../src/lib/data-router.js";
import type { Region } from "../../../src/lib/region-detection.js";

// Mock dependencies - create mockLog outside so it's accessible in tests
const mockLogFn = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/lib/audit-composer", () => {
  return {
    TrellisAuditLogger: class TrellisAuditLogger {
      log = mockLogFn;
      logDataAccess = vi.fn();
      logUserAction = vi.fn();
      logAuthentication = vi.fn();
      logAuthorization = vi.fn();
      withRequestId() {
        return this;
      }
    },
  };
});
vi.mock("../../../src/db", () => ({
  createPrismaForRegion: vi.fn(),
}));

describe("DataRouter - China Expansion", () => {
  let mockEnv: DataRouterEnv;
  let mockRequest: Request;

  beforeEach(async () => {
    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
      trellis_dev_session_secret: "test-secret",
      DEFAULT_REGION: "US",
    } as DataRouterEnv;

    mockRequest = {
      headers: new Headers({
        "CF-IPCountry": "US",
        "User-Agent": "test-agent",
      }),
    } as Request;

    vi.clearAllMocks();
    if (mockLogFn) {
      mockLogFn.mockClear();
    }
  });

  describe("validateRegionAccess", () => {
    it("should throw error if dataRegion is null", () => {
      expect(() => {
        DataRouter.validateRegionAccess(
          null,
          "US" as Region,
          "user-123",
          mockEnv,
          mockRequest,
          "req-123",
        );
      }).toThrow("Data residency violation: dataRegion not set");
    });

    it("should throw error if dataRegion is undefined", () => {
      expect(() => {
        DataRouter.validateRegionAccess(
          undefined,
          "US" as Region,
          "user-123",
          mockEnv,
          mockRequest,
          "req-123",
        );
      }).toThrow("Data residency violation: dataRegion not set");
    });

    it("should throw error if dataRegion does not match requested region", () => {
      expect(() => {
        DataRouter.validateRegionAccess(
          "CN",
          "US" as Region,
          "user-123",
          mockEnv,
          mockRequest,
          "req-123",
        );
      }).toThrow(
        "CROSS_REGION_ACCESS_REQUIRES_CONSENT: Cannot access CN data from US region",
      );
    });

    it("should not throw if dataRegion matches requested region", () => {
      expect(() => {
        DataRouter.validateRegionAccess(
          "US",
          "US" as Region,
          "user-123",
          mockEnv,
          mockRequest,
          "req-123",
        );
      }).not.toThrow();
    });

    it("should log audit event for missing dataRegion", async () => {
      if (mockLogFn) {
        mockLogFn.mockClear();
      }

      try {
        DataRouter.validateRegionAccess(
          null,
          "US" as Region,
          "user-123",
          mockEnv,
          mockRequest,
          "req-123",
        );
      } catch (e) {
        // Expected to throw
      }

      expect(mockLogFn).toHaveBeenCalled();
    });

    it("should log audit event for cross-region access attempt", async () => {
      if (mockLogFn) {
        mockLogFn.mockClear();
      }

      try {
        DataRouter.validateRegionAccess(
          "CN",
          "US" as Region,
          "user-123",
          mockEnv,
          mockRequest,
          "req-123",
        );
      } catch (e) {
        // Expected to throw
      }

      expect(mockLogFn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "authorization",
          action: "CROSS_REGION_DATA_ACCESS_BLOCKED",
          severity: "high",
          success: false,
        }),
        expect.any(Object),
      );
    });
  });
});
