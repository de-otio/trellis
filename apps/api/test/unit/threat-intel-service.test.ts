/**
 * Unit Tests: Threat Intelligence Service
 *
 * Tests Google Safe Browsing API integration, caching, and error handling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreatIntelService } from "../../src/lib/threat-intel-service.js";
import type { ThreatIntelEnv } from "../../src/lib/threat-intel-service.js";

// Mock fetch
global.fetch = vi.fn();

describe("ThreatIntelService", () => {
  let service: ThreatIntelService;
  let mockEnv: ThreatIntelEnv;
  let mockKv: any;

  beforeEach(() => {
    service = new ThreatIntelService();
    mockKv = {
      get: vi.fn(),
      put: vi.fn(),
    };
    mockEnv = {
      GOOGLE_SAFE_BROWSING_API_KEY: "test-api-key",
      THREAT_INTEL_CACHE_KV: mockKv,
    };

    vi.clearAllMocks();
    (global.fetch as any).mockClear();
  });

  describe("checkSafeBrowsing", () => {
    it("should return safe result when API key is not configured", async () => {
      const envWithoutKey = {
        ...mockEnv,
        GOOGLE_SAFE_BROWSING_API_KEY: undefined,
      };
      const result = await service.checkSafeBrowsing(
        "https://example.com",
        envWithoutKey,
      );

      expect(result.safe).toBe(true);
      expect(result.cacheHit).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return safe result for URLs with no threats", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({}), // No matches = safe
      });

      const result = await service.checkSafeBrowsing(
        "https://example.com",
        mockEnv,
      );

      expect(result.safe).toBe(true);
      expect(result.threats).toBeUndefined();
      expect(result.cacheHit).toBe(false);
      expect(global.fetch).toHaveBeenCalled();
      expect(mockKv.put).toHaveBeenCalled();
    });

    it("should return unsafe result for URLs with threats", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          matches: [
            {
              threatType: "MALWARE",
              platformType: "ANY_PLATFORM",
              threat: { url: "https://example.com" },
            },
          ],
        }),
      });

      const result = await service.checkSafeBrowsing(
        "https://example.com",
        mockEnv,
      );

      expect(result.safe).toBe(false);
      expect(result.threats).toEqual(["MALWARE"]);
      expect(result.cacheHit).toBe(false);
      expect(global.fetch).toHaveBeenCalled();
      expect(mockKv.put).toHaveBeenCalled();
    });

    it("should use cached result when available", async () => {
      const cachedResult = {
        safe: true,
        threats: undefined,
        cachedAt: new Date().toISOString(),
      };
      mockKv.get.mockResolvedValue(cachedResult);

      const result = await service.checkSafeBrowsing(
        "https://example.com",
        mockEnv,
      );

      expect(result.safe).toBe(true);
      expect(result.cacheHit).toBe(true);
      expect(result.cachedAt).toBeInstanceOf(Date);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockKv.get).toHaveBeenCalled();
    });

    it("should handle API errors gracefully (fail open)", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "API Error",
      });

      const result = await service.checkSafeBrowsing(
        "https://example.com",
        mockEnv,
      );

      expect(result.safe).toBe(true); // Fail open
      expect(result.cacheHit).toBe(false);
    });

    it("should handle network errors gracefully (fail open)", async () => {
      (global.fetch as any).mockRejectedValue(new Error("Network error"));

      const result = await service.checkSafeBrowsing(
        "https://example.com",
        mockEnv,
      );

      expect(result.safe).toBe(true); // Fail open
      expect(result.cacheHit).toBe(false);
    });

    it("should handle multiple threat types", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          matches: [
            {
              threatType: "MALWARE",
              platformType: "ANY_PLATFORM",
              threat: { url: "https://example.com" },
            },
            {
              threatType: "SOCIAL_ENGINEERING",
              platformType: "ANY_PLATFORM",
              threat: { url: "https://example.com" },
            },
          ],
        }),
      });

      const result = await service.checkSafeBrowsing(
        "https://example.com",
        mockEnv,
      );

      expect(result.safe).toBe(false);
      expect(result.threats).toEqual(["MALWARE", "SOCIAL_ENGINEERING"]);
    });
  });

  describe("getCachedResult", () => {
    it("should return cached result when found", async () => {
      const cached = {
        safe: true,
        threats: undefined,
        cachedAt: new Date().toISOString(),
      };
      mockKv.get.mockResolvedValue(cached);

      const result = await service.getCachedResult(
        "https://example.com",
        mockEnv,
      );

      expect(result).not.toBeNull();
      expect(result?.safe).toBe(true);
      expect(mockKv.get).toHaveBeenCalled();
    });

    it("should return null when cache miss", async () => {
      mockKv.get.mockResolvedValue(null);

      const result = await service.getCachedResult(
        "https://example.com",
        mockEnv,
      );

      expect(result).toBeNull();
    });

    it("should return null when KV is not configured", async () => {
      const envWithoutKv = { ...mockEnv, THREAT_INTEL_CACHE_KV: undefined };
      const result = await service.getCachedResult(
        "https://example.com",
        envWithoutKv,
      );

      expect(result).toBeNull();
    });

    it("should handle cache read errors gracefully", async () => {
      mockKv.get.mockRejectedValue(new Error("Cache error"));

      const result = await service.getCachedResult(
        "https://example.com",
        mockEnv,
      );

      expect(result).toBeNull();
    });
  });

  describe("cacheResult", () => {
    it("should cache result with TTL", async () => {
      const result = {
        safe: true,
        threats: undefined,
        cacheHit: false,
      };

      await service.cacheResult("https://example.com", result, mockEnv);

      expect(mockKv.put).toHaveBeenCalledWith(
        expect.stringContaining("threat-intel:"),
        expect.stringContaining('"safe":true'),
        { expirationTtl: 24 * 60 * 60 },
      );
    });

    it("should not cache when KV is not configured", async () => {
      const envWithoutKv = { ...mockEnv, THREAT_INTEL_CACHE_KV: undefined };
      const result = {
        safe: true,
        threats: undefined,
        cacheHit: false,
      };

      await service.cacheResult("https://example.com", result, envWithoutKv);

      expect(mockKv.put).not.toHaveBeenCalled();
    });

    it("should handle cache write errors gracefully", async () => {
      mockKv.put.mockRejectedValue(new Error("Cache write error"));

      const result = {
        safe: true,
        threats: undefined,
        cacheHit: false,
      };

      // Should not throw
      await expect(
        service.cacheResult("https://example.com", result, mockEnv),
      ).resolves.not.toThrow();
    });
  });
});
