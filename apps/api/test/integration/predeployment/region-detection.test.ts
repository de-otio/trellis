/**
 * Integration Tests: Region Detection
 *
 * Tests region detection with different request scenarios.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createRequestContext,
  createRequestContextSync,
} from "../../../src/lib/request-context.js";
import type { TrellisRequestContextEnv } from "../../../src/lib/request-context.js";

describe("Region Detection Integration", () => {
  let mockEnv: TrellisRequestContextEnv;

  beforeEach(() => {
    mockEnv = {
      DEFAULT_REGION: "EU", // Default region changed from US to EU
    };
  });

  describe("createRequestContextSync", () => {
    it("should detect US region from CF-IPCountry header", () => {
      const request = new Request("https://api.example.com", {
        headers: {
          "CF-IPCountry": "US",
        },
      });

      const context = createRequestContextSync(request, mockEnv);

      expect(context.region).toBe("US");
      expect(context.config.region).toBe("US");
      expect(context.config.features.authentication.emailPassword).toBe(false); // Regular users use magic link
    });

    it("should detect CN region from CF-IPCountry header", () => {
      const request = new Request("https://api.example.com", {
        headers: {
          "CF-IPCountry": "CN",
        },
      });

      const context = createRequestContextSync(request, mockEnv);

      expect(context.region).toBe("CN");
      expect(context.config.region).toBe("CN");
      expect(context.config.features.authentication.phoneAuth).toBe(true);
    });

    it("should default to EU if no region detected", () => {
      const request = new Request("https://api.example.com");

      const context = createRequestContextSync(request, mockEnv);

      expect(context.region).toBe("EU");
      expect(context.config.region).toBe("EU");
    });

    it("should load region-specific configuration", () => {
      const request = new Request("https://api.example.com", {
        headers: {
          "CF-IPCountry": "CN",
        },
      });

      const context = createRequestContextSync(request, mockEnv);

      // CN region should have extended timeouts
      expect(context.config.timeouts.api).toBeGreaterThan(10000);
      expect(context.config.features.authentication.weChatAuth).toBe(true);
    });
  });

  describe("createRequestContext", () => {
    it("should detect region asynchronously", async () => {
      // Use actual EU country code (DE = Germany) instead of 'EU'
      // Cloudflare CF-IPCountry returns ISO 3166-1 alpha-2 country codes
      const request = new Request("https://api.example.com", {
        headers: {
          "CF-IPCountry": "DE", // Germany -> maps to EU region
        },
      });

      const context = await createRequestContext(request, mockEnv);

      expect(context.region).toBe("EU");
      expect(context.config.region).toBe("EU");
    });
  });
});
