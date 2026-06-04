/**
 * Extended Unit Tests: Request Context
 *
 * Tests edge cases and additional scenarios for request context.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createRequestContext,
  createRequestContextSync,
  addRegionHeaders,
  addRegionHeadersAsync,
} from "../../src/lib/request-context.js";
import type { TrellisRequestContextEnv } from "../../src/lib/request-context.js";

// Mock region detection
vi.mock("../../src/lib/region-detection", () => {
  const mockDetectRegion = vi.fn().mockResolvedValue("US");
  const mockDetectRegionSync = vi.fn().mockReturnValue("US");
  const mockIsValidRegion = vi.fn().mockReturnValue(true);

  return {
    detectRegion: mockDetectRegion,
    detectRegionSync: mockDetectRegionSync,
    isValidRegion: mockIsValidRegion,
    RegionDetector: class RegionDetector {
      constructor(env: any) {}
      detectRegion = mockDetectRegion;
      detectRegionSync = mockDetectRegionSync;
      isValidRegion = mockIsValidRegion;
    },
  };
});

// Mock region config
vi.mock("../../src/lib/region-config", () => {
  const mockGetRegionConfig = vi.fn().mockReturnValue({
    region: "US",
    features: {
      authentication: {
        emailPassword: true,
        magicLink: true,
        phoneAuth: false,
        weChatAuth: false,
        qqAuth: false,
        microsoftSSO: true,
      },
      features: {
        offlineMode: false,
        realTimeUpdates: true,
        pushNotifications: true,
      },
      performance: {
        extendedTimeouts: false,
        aggressiveCaching: false,
        requestBatching: false,
      },
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
    timeouts: {
      api: 10000,
      database: 5000,
      storage: 5000,
    },
  });

  return {
    getRegionConfig: mockGetRegionConfig,
    RegionConfigManager: class RegionConfigManager {
      constructor(env: any) {}
      getRegionConfig = mockGetRegionConfig;
    },
  };
});

describe("Request Context Extended", () => {
  let mockEnv: TrellisRequestContextEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      DEFAULT_REGION: "US",
    };
  });

  describe("createRequestContextSync", () => {
    it("should create context with default region", () => {
      const request = new Request("https://api.example.com");
      const context = createRequestContextSync(request, mockEnv);
      expect(context.region).toBe("US");
      expect(context.config.region).toBe("US");
    });

    it("should include feature flags in config", () => {
      const request = new Request("https://api.example.com");
      const context = createRequestContextSync(request, mockEnv);
      expect(context.config.features.authentication.magicLink).toBe(true);
      expect(context.config.features.authentication.microsoftSSO).toBe(true);
    });

    it("should include endpoints in config", () => {
      const request = new Request("https://api.example.com");
      const context = createRequestContextSync(request, mockEnv);
      expect(context.config.endpoints.api).toBeDefined();
      expect(context.config.endpoints.frontend).toBeDefined();
      expect(context.config.endpoints.cdn).toBeDefined();
    });

    it("should include timeouts in config", () => {
      const request = new Request("https://api.example.com");
      const context = createRequestContextSync(request, mockEnv);
      expect(context.config.timeouts.api).toBeDefined();
      expect(context.config.timeouts.database).toBeDefined();
      expect(context.config.timeouts.storage).toBeDefined();
    });
  });

  describe("createRequestContext", () => {
    it("should create context asynchronously", async () => {
      const request = new Request("https://api.example.com");
      const context = await createRequestContext(request, mockEnv);
      expect(context.region).toBe("US");
      expect(context.config.region).toBe("US");
    });

    it("should handle different regions", async () => {
      const { detectRegion } = await import("../../src/lib/region-detection.js");
      vi.mocked(detectRegion).mockResolvedValueOnce("CN");

      // Need to configure IP geolocation to use async path
      const envWithIPGeo = {
        ...mockEnv,
        IP_GEOLOCATION_API_KEY: "test-key",
        IP_GEOLOCATION_SERVICE: "ipapi",
      };

      const request = new Request("https://api.example.com");
      const context = await createRequestContext(request, envWithIPGeo);
      expect(context.region).toBe("CN");
    });
  });

  describe("addRegionHeadersAsync", () => {
    it("should add region headers to response", async () => {
      const request = new Request("https://api.example.com");
      const context = createRequestContextSync(request, mockEnv);
      const response = new Response("OK", { status: 200 });

      const newResponse = await addRegionHeadersAsync(response, context);
      expect(newResponse.headers.get("X-Region")).toBe("US");
    });

    it("should preserve existing headers", async () => {
      const request = new Request("https://api.example.com");
      const context = createRequestContextSync(request, mockEnv);
      const response = new Response("OK", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

      const newResponse = await addRegionHeadersAsync(response, context);
      expect(newResponse.headers.get("Content-Type")).toBe("application/json");
      expect(newResponse.headers.get("X-Region")).toBe("US");
    });

    it("should handle already consumed response body", async () => {
      const request = new Request("https://api.example.com");
      const context = createRequestContextSync(request, mockEnv);
      const response = new Response("OK", { status: 200 });

      // Consume the body
      await response.text();

      // Should still add headers (body will be null)
      const newResponse = await addRegionHeadersAsync(response, context);
      expect(newResponse.headers.get("X-Region")).toBe("US");
      // Body should be null since it was already consumed
      expect(newResponse.body).toBeNull();
    });
  });
});
