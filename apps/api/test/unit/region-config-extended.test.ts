/**
 * Extended Unit Tests: Region Configuration
 *
 * Tests edge cases and additional scenarios for region configuration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getRegionConfig,
  getFeatureFlags,
  getEndpoints,
  getTimeouts,
} from "../../src/lib/region-config.js";
import type { Env } from "../../src/lib/region-config.js";

describe("Region Configuration Extended", () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      DEFAULT_REGION: "US",
    };
  });

  describe("getRegionConfig - Edge Cases", () => {
    it("should handle invalid region by defaulting to EU", () => {
      const config = getRegionConfig("INVALID", mockEnv);
      expect(config.region).toBe("EU");
    });

    it("should use custom US endpoints from env", () => {
      const env: Env = {
        ...mockEnv,
        US_API_ENDPOINT: "https://custom-api.example.com",
        US_FRONTEND_ENDPOINT: "https://custom-frontend.example.com",
        US_CDN_ENDPOINT: "https://custom-cdn.example.com",
      };
      const config = getRegionConfig("US", env);
      expect(config.endpoints.api).toBe("https://custom-api.example.com");
      expect(config.endpoints.frontend).toBe(
        "https://custom-frontend.example.com",
      );
      expect(config.endpoints.cdn).toBe("https://custom-cdn.example.com");
    });

    it("should use custom EU endpoints from env", () => {
      const env: Env = {
        ...mockEnv,
        EU_API_ENDPOINT: "https://custom-api-eu.example.com",
        EU_FRONTEND_ENDPOINT: "https://custom-frontend-eu.example.com",
        EU_CDN_ENDPOINT: "https://custom-cdn-eu.example.com",
      };
      const config = getRegionConfig("EU", env);
      expect(config.endpoints.api).toBe("https://custom-api-eu.example.com");
      expect(config.endpoints.frontend).toBe(
        "https://custom-frontend-eu.example.com",
      );
      expect(config.endpoints.cdn).toBe("https://custom-cdn-eu.example.com");
    });

    it("should use custom CN endpoints from env", () => {
      const env: Env = {
        ...mockEnv,
        CN_API_ENDPOINT: "https://custom-api-cn.example.com",
        CN_FRONTEND_ENDPOINT: "https://custom-frontend-cn.example.com",
        CN_CDN_ENDPOINT: "https://custom-cdn-cn.example.com",
      };
      const config = getRegionConfig("CN", env);
      expect(config.endpoints.api).toBe("https://custom-api-cn.example.com");
      expect(config.endpoints.frontend).toBe(
        "https://custom-frontend-cn.example.com",
      );
      expect(config.endpoints.cdn).toBe("https://custom-cdn-cn.example.com");
    });

    it("should cache configurations for performance", () => {
      const config1 = getRegionConfig("US", mockEnv);
      const config2 = getRegionConfig("US", mockEnv);
      expect(config1).toBe(config2); // Same object reference (cached)
    });

    it("should invalidate cache when env changes", () => {
      const config1 = getRegionConfig("US", mockEnv);
      const env2: Env = {
        ...mockEnv,
        US_API_ENDPOINT: "https://new-api.example.com",
      };
      const config2 = getRegionConfig("US", env2);
      expect(config1.endpoints.api).not.toBe(config2.endpoints.api);
    });
  });

  describe("getFeatureFlags", () => {
    it("should return feature flags for US region", () => {
      const flags = getFeatureFlags("US", mockEnv);
      expect(flags.authentication.magicLink).toBe(true);
      expect(flags.authentication.microsoftSSO).toBe(true);
      expect(flags.authentication.phoneAuth).toBe(false);
    });

    it("should return feature flags for CN region", () => {
      const flags = getFeatureFlags("CN", mockEnv);
      expect(flags.authentication.magicLink).toBe(false);
      expect(flags.authentication.microsoftSSO).toBe(false);
      expect(flags.authentication.phoneAuth).toBe(true);
      expect(flags.authentication.weChatAuth).toBe(true);
    });

    it("should always enable security flags", () => {
      const usFlags = getFeatureFlags("US", mockEnv);
      const cnFlags = getFeatureFlags("CN", mockEnv);
      expect(usFlags.security.encryption).toBe(true);
      expect(usFlags.security.rateLimiting).toBe(true);
      expect(cnFlags.security.encryption).toBe(true);
      expect(cnFlags.security.rateLimiting).toBe(true);
    });
  });

  describe("getEndpoints", () => {
    it("should return endpoints for US region", () => {
      const endpoints = getEndpoints("US", mockEnv);
      expect(endpoints.api).toBeDefined();
      expect(endpoints.frontend).toBeDefined();
      expect(endpoints.cdn).toBeDefined();
    });

    it("should return endpoints for CN region", () => {
      const endpoints = getEndpoints("CN", mockEnv);
      expect(endpoints.api).toBeDefined();
      expect(endpoints.frontend).toBeDefined();
      expect(endpoints.cdn).toBeDefined();
    });
  });

  describe("getTimeouts", () => {
    it("should return timeouts for US region", () => {
      const timeouts = getTimeouts("US", mockEnv);
      expect(timeouts.api).toBe(10000);
      expect(timeouts.database).toBe(5000);
      expect(timeouts.storage).toBe(5000);
    });

    it("should return extended timeouts for CN region", () => {
      const timeouts = getTimeouts("CN", mockEnv);
      expect(timeouts.api).toBe(60000);
      expect(timeouts.database).toBe(30000); // Extended for China
      expect(timeouts.storage).toBe(30000); // Extended for China
    });
  });
});
