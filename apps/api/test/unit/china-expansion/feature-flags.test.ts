/**
 * Unit tests for China expansion - Feature Flags
 *
 * Tests feature flags API endpoint
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { featureFlagsRoutes } from "../../../src/lib/routes/feature-flags.js";

// Mock dependencies
let getRegionConfig: any;
const mockGetRegionConfig = vi.fn().mockReturnValue({
  region: "US",
  features: {
    authentication: { emailPassword: true },
    features: { offlineMode: false },
    performance: { extendedTimeouts: false },
    security: {
      encryption: true,
      rateLimiting: true,
      auditLogging: true,
      regionValidation: true,
    },
  },
  endpoints: {
    api: "https://api.example.com",
    frontend: "https://www.example.com",
    cdn: "https://cdn.example.com",
  },
  timeouts: { api: 10000, database: 5000, storage: 5000 },
});
vi.mock("../../../src/lib/region-config", async () => {
  const actual = await vi.importActual("../../../src/lib/region-config");
  return {
    ...actual,
    getRegionConfig: (...args: any[]) => mockGetRegionConfig(...args),
    RegionConfigManager: class RegionConfigManager {
      constructor(env: any) {}
      getRegionConfig = (...args: any[]) => mockGetRegionConfig(...args);
    },
  };
});
vi.mock("../../../src/lib/region-detection", () => {
  const mockDetectRegionSync = vi.fn(() => "US");
  const mockIsValidRegion = vi.fn((region: string) =>
    ["US", "EU", "CN"].includes(region),
  );
  return {
    detectRegionSync: mockDetectRegionSync,
    isValidRegion: mockIsValidRegion,
    RegionDetector: class RegionDetector {
      detectRegionSync = mockDetectRegionSync;
      isValidRegion = mockIsValidRegion;
    },
  };
});

describe("Feature Flags Routes - China Expansion", () => {
  let mockEnv: Env;
  let mockRequest: Request;

  beforeEach(async () => {
    mockEnv = {
      DEFAULT_REGION: "US",
    } as Env;

    mockRequest = {
      url: "https://api.example.com/api/feature-flags?region=CN",
      headers: new Headers({}),
    } as Request;

    vi.clearAllMocks();
    // Import getRegionConfig from mocked module
    const regionConfigModule = await import("../../../src/lib/region-config.js");
    getRegionConfig = regionConfigModule.getRegionConfig;
    // Reset mock to default return value
    mockGetRegionConfig.mockReturnValue({
      region: "US",
      features: {
        authentication: { emailPassword: true },
        features: { offlineMode: false },
        performance: { extendedTimeouts: false },
        security: {
          encryption: true,
          rateLimiting: true,
          auditLogging: true,
          regionValidation: true,
        },
      },
      endpoints: {
        api: "https://api.example.com",
        frontend: "https://www.example.com",
        cdn: "https://cdn.example.com",
      },
      timeouts: { api: 10000, database: 5000, storage: 5000 },
    });
  });

  describe("GET /api/feature-flags", () => {
    it("should have correct route path", () => {
      const route = featureFlagsRoutes.find(
        (r) => r.path === "/api/feature-flags",
      );
      expect(route).toBeDefined();
      expect(route?.method).toBe("GET");
    });

    it("should return feature flags for specified region", async () => {
      const route = featureFlagsRoutes.find(
        (r) => r.path === "/api/feature-flags",
      );
      if (!route) throw new Error("Route not found");

      // Mock region config
      mockGetRegionConfig.mockReturnValueOnce({
        region: "CN",
        features: {
          authentication: {
            phoneAuth: true,
            weChatAuth: true,
            microsoftSSO: false,
          },
          features: {
            offlineMode: true,
            realTimeUpdates: false,
          },
          performance: {
            extendedTimeouts: true,
            aggressiveCaching: true,
          },
          security: {
            encryption: true,
            rateLimiting: true,
          },
        },
        endpoints: {
          api: "https://api-cn.example.com",
          supabase: "https://supabase-cn.example.com",
        },
        timeouts: {
          apiTimeout: 30000,
          dbTimeout: 20000,
        },
      } as any);

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.region).toBe("CN");
      expect(body.features.authentication.phoneAuth).toBe(true);
      expect(body.features.authentication.microsoftSSO).toBe(false);
    });

    it("should detect region from request if not specified", async () => {
      const route = featureFlagsRoutes.find(
        (r) => r.path === "/api/feature-flags",
      );
      if (!route) throw new Error("Route not found");

      const requestWithoutRegion = {
        url: "https://api.example.com/api/feature-flags",
        headers: new Headers({
          "CF-IPCountry": "CN",
        }),
      } as Request;

      mockGetRegionConfig.mockReturnValue({
        region: "CN",
        features: {} as any,
        endpoints: {} as any,
        timeouts: {} as any,
      } as any);

      const response = await route.handler(requestWithoutRegion, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.region).toBe("CN");
    });

    it("should return different flags for different regions", async () => {
      const route = featureFlagsRoutes.find(
        (r) => r.path === "/api/feature-flags",
      );
      if (!route) throw new Error("Route not found");

      // US region
      mockGetRegionConfig.mockReturnValueOnce({
        region: "US",
        features: {
          authentication: { microsoftSSO: true, phoneAuth: false },
        } as any,
        endpoints: {} as any,
        timeouts: {} as any,
      } as any);

      const usRequest = {
        url: "https://api.example.com/api/feature-flags?region=US",
        headers: new Headers({}),
      } as Request;

      const usResponse = await route.handler(usRequest, mockEnv);
      const usBody = await usResponse.json();

      // CN region
      mockGetRegionConfig.mockReturnValueOnce({
        region: "CN",
        features: {
          authentication: { microsoftSSO: false, phoneAuth: true },
        } as any,
        endpoints: {} as any,
        timeouts: {} as any,
      } as any);

      const cnRequest = {
        url: "https://api.example.com/api/feature-flags?region=CN",
        headers: new Headers({}),
      } as Request;

      const cnResponse = await route.handler(cnRequest, mockEnv);
      const cnBody = await cnResponse.json();

      expect(usBody.features.authentication.microsoftSSO).toBe(true);
      expect(cnBody.features.authentication.microsoftSSO).toBe(false);
      expect(cnBody.features.authentication.phoneAuth).toBe(true);
    });
  });
});
