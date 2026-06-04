/**
 * Unit tests for CN region - Region Config
 *
 * Tests region-specific configuration and feature flags
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getRegionConfig,
  getDefaultCNConfig,
} from "../../../src/lib/region-config.js";
import type { Env } from "../../../src/env.js";

describe("Region Config - CN Region", () => {
  let mockEnv: Env;

  beforeEach(() => {
    mockEnv = {
      DEFAULT_REGION: "US",
    } as Env;
  });

  describe("getDefaultCNConfig", () => {
    it("should return China-specific configuration", () => {
      const config = getDefaultCNConfig(mockEnv);

      expect(config.region).toBe("CN");
      expect(config.features.authentication.phoneAuth).toBe(true);
      expect(config.features.authentication.weChatAuth).toBe(true);
      expect(config.features.authentication.microsoftSSO).toBe(false);
      expect(config.features.features.offlineMode).toBe(true);
      expect(config.features.performance.extendedTimeouts).toBe(true);
    });

    it("should have correct endpoint configuration", () => {
      const config = getDefaultCNConfig(mockEnv);

      expect(config.endpoints.api).toContain("cn");
      expect(config.endpoints.frontend).toBeDefined();
      expect(config.endpoints.cdn).toBeDefined();
    });

    it("should have extended timeouts for China", () => {
      const config = getDefaultCNConfig(mockEnv);

      expect(config.timeouts.api).toBeGreaterThan(30000);
      expect(config.timeouts.database).toBeGreaterThan(20000);
    });
  });

  describe("getRegionConfig", () => {
    it("should return US config for US region", () => {
      const config = getRegionConfig("US", mockEnv);

      expect(config.region).toBe("US");
      expect(config.features.authentication.microsoftSSO).toBe(true);
      expect(config.features.authentication.phoneAuth).toBe(false);
    });

    it("should return CN config for CN region", () => {
      const config = getRegionConfig("CN", mockEnv);

      expect(config.region).toBe("CN");
      expect(config.features.authentication.phoneAuth).toBe(true);
      expect(config.features.authentication.microsoftSSO).toBe(false);
    });

    it("should return EU config for EU region", () => {
      const config = getRegionConfig("EU", mockEnv);

      expect(config.region).toBe("EU");
    });
  });
});
