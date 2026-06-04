/**
 * Integration Tests: Feature Flags
 *
 * Tests feature flag loading and validation across different regions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getFeatureFlags,
  getRegionConfig,
} from "../../../src/lib/region-config.js";
import type { Env } from "../../../src/lib/region-config.js";

describe("Feature Flags Integration", () => {
  let mockEnv: Env;

  beforeEach(() => {
    mockEnv = {
      DEFAULT_REGION: "US",
    };
  });

  describe("getRegionConfig", () => {
    it("should return US feature flags", () => {
      const config = getRegionConfig("US", mockEnv);

      expect(config.features.authentication.emailPassword).toBe(false); // Regular users use magic link
      expect(config.features.authentication.magicLink).toBe(true);
      expect(config.features.authentication.microsoftSSO).toBe(true);
      expect(config.features.authentication.phoneAuth).toBe(false);
      expect(config.features.authentication.weChatAuth).toBe(false);
    });

    it("should return CN feature flags", () => {
      const config = getRegionConfig("CN", mockEnv);

      expect(config.features.authentication.emailPassword).toBe(false); // Regular users use phone/WeChat/QQ
      expect(config.features.authentication.magicLink).toBe(false);
      expect(config.features.authentication.microsoftSSO).toBe(false);
      expect(config.features.authentication.phoneAuth).toBe(true);
      expect(config.features.authentication.weChatAuth).toBe(true);
    });

    it("should always enable security flags", () => {
      const usConfig = getRegionConfig("US", mockEnv);
      const cnConfig = getRegionConfig("CN", mockEnv);

      expect(usConfig.features.security.encryption).toBe(true);
      expect(usConfig.features.security.rateLimiting).toBe(true);
      expect(usConfig.features.security.auditLogging).toBe(true);
      expect(usConfig.features.security.regionValidation).toBe(true);

      expect(cnConfig.features.security.encryption).toBe(true);
      expect(cnConfig.features.security.rateLimiting).toBe(true);
      expect(cnConfig.features.security.auditLogging).toBe(true);
      expect(cnConfig.features.security.regionValidation).toBe(true);
    });
  });

  describe("Performance Flags", () => {
    it("should enable extended timeouts for CN region", () => {
      const config = getRegionConfig("CN", mockEnv);

      expect(config.features.performance.extendedTimeouts).toBe(true);
      expect(config.timeouts.api).toBeGreaterThan(10000);
    });

    it("should enable aggressive caching for CN region", () => {
      const config = getRegionConfig("CN", mockEnv);

      expect(config.features.performance.aggressiveCaching).toBe(true);
    });

    it("should disable extended timeouts for US region", () => {
      const config = getRegionConfig("US", mockEnv);

      expect(config.features.performance.extendedTimeouts).toBe(false);
      expect(config.timeouts.api).toBe(10000);
    });
  });

  describe("Application Features", () => {
    it("should enable offline mode for CN region", () => {
      const config = getRegionConfig("CN", mockEnv);

      expect(config.features.features.offlineMode).toBe(true);
      expect(config.features.features.realTimeUpdates).toBe(false);
    });

    it("should enable real-time updates for US region", () => {
      const config = getRegionConfig("US", mockEnv);

      expect(config.features.features.offlineMode).toBe(false);
      expect(config.features.features.realTimeUpdates).toBe(true);
    });
  });
});
