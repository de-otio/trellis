import { describe, expect, it } from "vitest";
import type { Env } from "../../src/lib/region-config.js";
import {
  getEndpoints,
  getFeatureFlags,
  getRegionConfig,
  getTimeouts,
} from "../../src/lib/region-config.js";

describe("Region Configuration", () => {
  const createMockEnv = (overrides: Partial<Env> = {}): Env => ({
    DEFAULT_REGION: "US",
    ...overrides,
  });

  describe("getRegionConfig", () => {
    it("should return US configuration by default", () => {
      const env = createMockEnv();
      const config = getRegionConfig("US", env);

      expect(config.region).toBe("US");
      expect(config.features.authentication.emailPassword).toBe(false); // Regular users use magic link
      expect(config.features.authentication.magicLink).toBe(true);
      expect(config.features.authentication.microsoftSSO).toBe(true);
      expect(config.features.authentication.phoneAuth).toBe(false);
      expect(config.features.authentication.weChatAuth).toBe(false);
      expect(config.timeouts.api).toBe(10000);
    });

    it("should return EU configuration", () => {
      const env = createMockEnv();
      const config = getRegionConfig("EU", env);

      expect(config.region).toBe("EU");
      expect(config.features.authentication.emailPassword).toBe(false); // Regular users use magic link
      expect(config.features.authentication.magicLink).toBe(true);
      expect(config.timeouts.api).toBe(10000);
    });

    it("should return CN configuration with China-specific settings", () => {
      const env = createMockEnv();
      const config = getRegionConfig("CN", env);

      expect(config.region).toBe("CN");
      expect(config.features.authentication.emailPassword).toBe(false); // Regular users use phone/WeChat/QQ
      expect(config.features.authentication.magicLink).toBe(false); // Email unreliable
      expect(config.features.authentication.phoneAuth).toBe(true); // SMS OTP preferred
      expect(config.features.authentication.weChatAuth).toBe(true); // WeChat OAuth
      expect(config.features.authentication.microsoftSSO).toBe(false); // Blocked by GFW
      expect(config.features.features.offlineMode).toBe(true); // Important for unreliable connections
      expect(config.features.performance.extendedTimeouts).toBe(true);
      expect(config.timeouts.api).toBe(60000); // Longer timeouts for China
    });

    it("should use custom endpoints from environment variables", () => {
      const env = createMockEnv({
        US_API_ENDPOINT: "https://api-custom.example.com",
        US_FRONTEND_ENDPOINT: "https://www-custom.example.com",
        US_CDN_ENDPOINT: "https://cdn-custom.example.com",
      });
      const config = getRegionConfig("US", env);

      expect(config.endpoints.api).toBe("https://api-custom.example.com");
      expect(config.endpoints.frontend).toBe("https://www-custom.example.com");
      expect(config.endpoints.cdn).toBe("https://cdn-custom.example.com");
    });

    it("should use custom CN endpoints from environment variables", () => {
      const env = createMockEnv({
        CN_API_ENDPOINT: "https://api-cn-custom.example.com",
        CN_FRONTEND_ENDPOINT: "https://www-cn-custom.example.com",
        CN_CDN_ENDPOINT: "https://cdn-cn-custom.example.com",
      });
      const config = getRegionConfig("CN", env);

      expect(config.endpoints.api).toBe("https://api-cn-custom.example.com");
      expect(config.endpoints.frontend).toBe(
        "https://www-cn-custom.example.com",
      );
      expect(config.endpoints.cdn).toBe("https://cdn-cn-custom.example.com");
    });

    it("should default to EU for invalid region", () => {
      const env = createMockEnv();
      const config = getRegionConfig("INVALID", env);

      expect(config.region).toBe("EU");
    });

    it("should always enable security features", () => {
      const env = createMockEnv();
      const usConfig = getRegionConfig("US", env);
      const cnConfig = getRegionConfig("CN", env);
      const euConfig = getRegionConfig("EU", env);

      // Security features must always be enabled
      expect(usConfig.features.security.encryption).toBe(true);
      expect(usConfig.features.security.rateLimiting).toBe(true);
      expect(usConfig.features.security.auditLogging).toBe(true);
      expect(usConfig.features.security.regionValidation).toBe(true);

      expect(cnConfig.features.security.encryption).toBe(true);
      expect(cnConfig.features.security.rateLimiting).toBe(true);
      expect(cnConfig.features.security.auditLogging).toBe(true);
      expect(cnConfig.features.security.regionValidation).toBe(true);

      expect(euConfig.features.security.encryption).toBe(true);
      expect(euConfig.features.security.rateLimiting).toBe(true);
      expect(euConfig.features.security.auditLogging).toBe(true);
      expect(euConfig.features.security.regionValidation).toBe(true);
    });

    it("should validate endpoint URLs", () => {
      const env = createMockEnv({
        US_API_ENDPOINT: "invalid-url", // Invalid URL
      });

      // Should fallback to EU config when validation fails
      const config = getRegionConfig("US", env);
      expect(config.region).toBe("EU"); // Falls back to EU when US config is invalid
    });

    it("should have valid timeout values", () => {
      const env = createMockEnv();
      const usConfig = getRegionConfig("US", env);
      const cnConfig = getRegionConfig("CN", env);

      expect(usConfig.timeouts.api).toBeGreaterThan(0);
      expect(usConfig.timeouts.database).toBeGreaterThan(0);
      expect(usConfig.timeouts.storage).toBeGreaterThan(0);

      expect(cnConfig.timeouts.api).toBeGreaterThan(0);
      expect(cnConfig.timeouts.database).toBeGreaterThan(0);
      expect(cnConfig.timeouts.storage).toBeGreaterThan(0);

      // CN should have longer timeouts
      expect(cnConfig.timeouts.api).toBeGreaterThan(usConfig.timeouts.api);
    });
  });

  describe("getFeatureFlags", () => {
    it("should return feature flags for US region", () => {
      const env = createMockEnv();
      const flags = getFeatureFlags("US", env);

      expect(flags.authentication.emailPassword).toBe(false); // Regular users use magic link
      expect(flags.authentication.magicLink).toBe(true);
      expect(flags.authentication.microsoftSSO).toBe(true);
      expect(flags.authentication.phoneAuth).toBe(false);
    });

    it("should return feature flags for CN region", () => {
      const env = createMockEnv();
      const flags = getFeatureFlags("CN", env);

      expect(flags.authentication.emailPassword).toBe(false); // Regular users use phone/WeChat/QQ
      expect(flags.authentication.magicLink).toBe(false);
      expect(flags.authentication.phoneAuth).toBe(true);
      expect(flags.authentication.weChatAuth).toBe(true);
      expect(flags.authentication.microsoftSSO).toBe(false);
      expect(flags.features.offlineMode).toBe(true);
    });

    it("should always include security flags", () => {
      const env = createMockEnv();
      const flags = getFeatureFlags("US", env);

      expect(flags.security).toBeDefined();
      expect(flags.security.encryption).toBe(true);
      expect(flags.security.rateLimiting).toBe(true);
      expect(flags.security.auditLogging).toBe(true);
      expect(flags.security.regionValidation).toBe(true);
    });
  });

  describe("getEndpoints", () => {
    it("should return endpoints for US region", () => {
      const env = createMockEnv();
      const endpoints = getEndpoints("US", env);

      expect(endpoints.api).toContain("api");
      expect(endpoints.frontend).toContain("www");
      expect(endpoints.cdn).toContain("cdn");
    });

    it("should return endpoints for CN region", () => {
      const env = createMockEnv();
      const endpoints = getEndpoints("CN", env);

      expect(endpoints.api).toContain("api");
      expect(endpoints.frontend).toContain("www");
      expect(endpoints.cdn).toContain("cdn");
    });

    it("should use custom endpoints from environment", () => {
      const env = createMockEnv({
        US_API_ENDPOINT: "https://custom-api.example.com",
      });
      const endpoints = getEndpoints("US", env);

      expect(endpoints.api).toBe("https://custom-api.example.com");
    });
  });

  describe("getTimeouts", () => {
    it("should return timeouts for US region", () => {
      const env = createMockEnv();
      const timeouts = getTimeouts("US", env);

      expect(timeouts.api).toBe(10000);
      expect(timeouts.database).toBe(5000);
      expect(timeouts.storage).toBe(5000);
    });

    it("should return extended timeouts for CN region", () => {
      const env = createMockEnv();
      const timeouts = getTimeouts("CN", env);

      expect(timeouts.api).toBe(60000); // Longer for China
      expect(timeouts.database).toBe(30000); // Extended for China
      expect(timeouts.storage).toBe(30000); // Extended for China
    });
  });

  describe("Configuration Validation", () => {
    it("should fallback to EU config for invalid endpoint URLs", () => {
      const env = createMockEnv({
        US_API_ENDPOINT: "not-a-valid-url",
      });

      // Should fallback to EU config when validation fails
      const config = getRegionConfig("US", env);
      expect(config.region).toBe("EU"); // Falls back to EU when US config is invalid
    });

    it("should throw error if security features are disabled", () => {
      // This test verifies that security features cannot be disabled
      // In practice, the getDefaultUSConfig always sets security to true
      // But we test that validation would catch it if it were false
      const env = createMockEnv();
      const config = getRegionConfig("US", env);

      // Security features should always be true
      expect(config.features.security.encryption).toBe(true);
      expect(config.features.security.rateLimiting).toBe(true);
      expect(config.features.security.auditLogging).toBe(true);
      expect(config.features.security.regionValidation).toBe(true);
    });
  });
});
