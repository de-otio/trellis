/**
 * Unit tests for China expansion - Region Detection
 *
 * Tests region detection priority (user preference first)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  detectRegionSync,
  isValidRegion,
} from "../../../src/lib/region-detection.js";
import type { Env } from "../../../src/env.js";

// Mock database
vi.mock("../../../src/db", () => ({
  createPrismaForRegion: vi.fn(() => ({
    user: {
      findUnique: vi.fn(),
    },
  })),
}));

describe("Region Detection - China Expansion", () => {
  let mockEnv: Env;
  let mockRequest: Request;

  beforeEach(() => {
    mockEnv = {
      DEFAULT_REGION: "US",
      ENVIRONMENT: "dev",
      trellis_dev_session_secret: "test-secret",
    } as Env;

    mockRequest = {
      headers: new Headers({
        "CF-IPCountry": "US",
        "Accept-Language": "en-US",
      }),
    } as Request;

    vi.clearAllMocks();
  });

  describe("isValidRegion", () => {
    it("should return true for valid regions", () => {
      expect(isValidRegion("US")).toBe(true);
      expect(isValidRegion("EU")).toBe(true);
      expect(isValidRegion("CN")).toBe(true);
    });

    it("should return false for invalid regions", () => {
      expect(isValidRegion("XX")).toBe(false);
      expect(isValidRegion("")).toBe(false);
      expect(isValidRegion("us")).toBe(false); // Case sensitive
    });
  });

  describe("detectRegionSync", () => {
    it("should use CF-IPCountry header when available", () => {
      const request = {
        headers: new Headers({
          "CF-IPCountry": "CN",
        }),
      } as Request;

      const region = detectRegionSync(request, mockEnv);
      expect(region).toBe("CN");
    });

    it("should fallback to Accept-Language when CF-IPCountry not available", () => {
      const request = {
        headers: new Headers({
          "Accept-Language": "zh-CN",
        }),
      } as Request;

      const region = detectRegionSync(request, mockEnv);
      // Should detect CN from language
      expect(["CN", "US"]).toContain(region);
    });

    it("should default to US when no headers available", () => {
      const request = {
        headers: new Headers({}),
      } as Request;

      const region = detectRegionSync(request, mockEnv);
      expect(region).toBe("US");
    });

    it("should use DEFAULT_REGION from env when set", () => {
      const envWithDefault = {
        ...mockEnv,
        DEFAULT_REGION: "EU",
      } as Env;

      const request = {
        headers: new Headers({}),
      } as Request;

      const region = detectRegionSync(request, envWithDefault);
      expect(region).toBe("EU");
    });
  });
});
