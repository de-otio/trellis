/**
 * Integration Tests: Authentication with Feature Flags
 *
 * Tests authentication flows with region-specific feature flags.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequestContextSync } from "../../../src/lib/request-context.js";
import type { TrellisRequestContextEnv } from "../../../src/lib/request-context.js";

describe("Authentication Integration with Feature Flags", () => {
  let mockEnv: TrellisRequestContextEnv;

  beforeEach(() => {
    mockEnv = {
      DEFAULT_REGION: "EU", // Default region changed from US to EU
    };
  });

  describe("Magic Link Authentication", () => {
    it("should be enabled for US region", () => {
      const request = new Request("https://api.example.com", {
        headers: { "CF-IPCountry": "US" },
      });

      const context = createRequestContextSync(request, mockEnv);

      expect(context.region).toBe("US");
      expect(context.config.features.authentication.magicLink).toBe(true);
    });

    it("should be disabled for CN region", () => {
      const request = new Request("https://api.example.com", {
        headers: { "CF-IPCountry": "CN" },
      });

      const context = createRequestContextSync(request, mockEnv);

      expect(context.region).toBe("CN");
      expect(context.config.features.authentication.magicLink).toBe(false);
    });
  });

  describe("Microsoft SSO Authentication", () => {
    it("should be enabled for US region", () => {
      const request = new Request("https://api.example.com", {
        headers: { "CF-IPCountry": "US" },
      });

      const context = createRequestContextSync(request, mockEnv);

      expect(context.region).toBe("US");
      expect(context.config.features.authentication.microsoftSSO).toBe(true);
    });

    it("should be disabled for CN region", () => {
      const request = new Request("https://api.example.com", {
        headers: { "CF-IPCountry": "CN" },
      });

      const context = createRequestContextSync(request, mockEnv);

      expect(context.region).toBe("CN");
      expect(context.config.features.authentication.microsoftSSO).toBe(false);
    });
  });

  describe("Phone Authentication", () => {
    it("should be disabled for US region", () => {
      const request = new Request("https://api.example.com", {
        headers: { "CF-IPCountry": "US" },
      });

      const context = createRequestContextSync(request, mockEnv);

      expect(context.region).toBe("US");
      expect(context.config.features.authentication.phoneAuth).toBe(false);
    });

    it("should be enabled for CN region", () => {
      const request = new Request("https://api.example.com", {
        headers: { "CF-IPCountry": "CN" },
      });

      const context = createRequestContextSync(request, mockEnv);

      expect(context.region).toBe("CN");
      expect(context.config.features.authentication.phoneAuth).toBe(true);
    });
  });

  describe("WeChat Authentication", () => {
    it("should be disabled for US region", () => {
      const request = new Request("https://api.example.com", {
        headers: { "CF-IPCountry": "US" },
      });

      const context = createRequestContextSync(request, mockEnv);

      expect(context.region).toBe("US");
      expect(context.config.features.authentication.weChatAuth).toBe(false);
    });

    it("should be enabled for CN region", () => {
      const request = new Request("https://api.example.com", {
        headers: { "CF-IPCountry": "CN" },
      });

      const context = createRequestContextSync(request, mockEnv);

      expect(context.region).toBe("CN");
      expect(context.config.features.authentication.weChatAuth).toBe(true);
    });
  });
});
