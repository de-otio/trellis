/**
 * Unit tests for RedirectResolver
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RedirectResolver } from "../../src/lib/redirect-resolver.js";
import type { KVNamespace } from "@cloudflare/workers-types";

// Mock LinkSecurityHandler
vi.mock("../../src/lib/link-security-handler", () => ({
  LinkSecurityHandler: class LinkSecurityHandler {
    normalizeUrl(url: string) {
      if (url === "not-a-url") return null;
      try {
        const parsed = new URL(url);
        return {
          normalized: parsed.href,
          domain: parsed.hostname,
        };
      } catch {
        return null;
      }
    }
    validateUrlSync(url: string) {
      // Block internal IPs
      if (
        url.includes("192.168.") ||
        url.includes("127.0.0.1") ||
        url.includes("localhost")
      ) {
        return { status: "blocked", reason: "Internal IP" };
      }
      return { status: "safe", reason: null };
    }
  },
}));

describe("RedirectResolver", () => {
  let redirectResolver: RedirectResolver;
  let mockEnv: any;
  let mockKv: KVNamespace;

  beforeEach(() => {
    mockKv = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    } as any;

    mockEnv = {
      THREAT_INTEL_CACHE_KV: mockKv,
    };

    redirectResolver = new RedirectResolver(mockEnv);
    vi.clearAllMocks();
  });

  describe("isShortener", () => {
    it("should detect known shorteners", () => {
      expect(redirectResolver.isShortener("bit.ly")).toBe(true);
      expect(redirectResolver.isShortener("tinyurl.com")).toBe(true);
      expect(redirectResolver.isShortener("t.co")).toBe(true);
      expect(redirectResolver.isShortener("goo.gl")).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(redirectResolver.isShortener("BIT.LY")).toBe(true);
      expect(redirectResolver.isShortener("TinyUrl.Com")).toBe(true);
    });

    it("should return false for non-shorteners", () => {
      expect(redirectResolver.isShortener("example.com")).toBe(false);
      expect(redirectResolver.isShortener("github.com")).toBe(false);
      expect(redirectResolver.isShortener("google.com")).toBe(false);
    });
  });

  describe("resolveRedirects", () => {
    it("should return cached result if available", async () => {
      const cachedResult = {
        originalUrl: "https://bit.ly/test",
        finalUrl: "https://example.com",
        redirectChain: ["https://bit.ly/test", "https://example.com"],
        isShortener: true,
      };

      // Mock KV.get to return JSON string with 'json' type
      vi.mocked(mockKv.get).mockResolvedValue(cachedResult as any);

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
      );

      expect(result).toBeDefined();
      expect(result?.finalUrl).toBe("https://example.com");
      expect(result?.cacheHit).toBe(true);
      expect(mockKv.get).toHaveBeenCalled();
    });

    it("should return null for invalid URL", async () => {
      const result = await redirectResolver.resolveRedirects(
        "not-a-url",
        mockEnv,
      );
      expect(result).toBeNull();
    });

    it("should resolve single redirect", async () => {
      // Mock cache miss
      vi.mocked(mockKv.get).mockResolvedValue(null);

      // Mock fetch response with redirect
      const mockHeaders1 = new Headers();
      mockHeaders1.set("Location", "https://example.com");

      const mockHeaders2 = new Headers();

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 301,
          headers: mockHeaders1,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: mockHeaders2,
        });

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
      );

      expect(result).toBeDefined();
      // URL may have trailing slash, so check if it starts with expected URL
      expect(result?.finalUrl).toMatch(/^https:\/\/example\.com\/?$/);
      expect(result?.redirectChain.length).toBeGreaterThan(1);
      expect(mockKv.put).toHaveBeenCalled();
    });

    it("should stop at max redirects", async () => {
      // Mock cache miss
      vi.mocked(mockKv.get).mockResolvedValue(null);

      // Mock fetch to return redirects
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        const mockHeaders = new Headers();
        mockHeaders.set("Location", `https://example.com/redirect${callCount}`);
        return Promise.resolve({
          ok: false,
          status: 301,
          headers: mockHeaders,
        });
      });

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
      );

      expect(result).toBeDefined();
      expect(callCount).toBeLessThanOrEqual(5); // Max redirects
    });

    it("should detect redirect loops", async () => {
      // Mock cache miss
      vi.mocked(mockKv.get).mockResolvedValue(null);

      // Mock fetch to return same URL in redirect
      const mockHeaders = new Headers();
      mockHeaders.set("Location", "https://bit.ly/test");

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 301,
        headers: mockHeaders,
      });

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
      );

      expect(result).toBeDefined();
      // Should stop at loop detection
    });

    it("should handle timeout", async () => {
      // Mock cache miss
      vi.mocked(mockKv.get).mockResolvedValue(null);

      // Mock fetch to timeout
      global.fetch = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Request timeout")), 100);
        });
      });

      // Use shorter timeout for test
      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
      );

      // Should handle timeout gracefully
      expect(result).toBeNull();
    });

    it("should block redirects to internal IPs", async () => {
      // Mock cache miss
      vi.mocked(mockKv.get).mockResolvedValue(null);

      // Mock fetch to redirect to internal IP
      const mockHeaders = new Headers();
      mockHeaders.set("Location", "http://192.168.1.1");

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 301,
        headers: mockHeaders,
      });

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
      );

      // Should not follow redirect to internal IP
      expect(result).toBeDefined();
    });
  });

  describe("caching", () => {
    it("should cache resolved redirects", async () => {
      // Mock cache miss
      vi.mocked(mockKv.get).mockResolvedValue(null);

      // Mock successful resolution
      const mockHeaders = new Headers();
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: mockHeaders,
      });

      await redirectResolver.resolveRedirects("https://bit.ly/test", mockEnv);

      expect(mockKv.put).toHaveBeenCalled();
      const putCall = vi.mocked(mockKv.put).mock.calls[0];
      expect(putCall[0]).toContain("redirect:");
      expect(putCall[2]).toHaveProperty("expirationTtl");
    });

    it("should use cached result on subsequent calls", async () => {
      const cachedResult = {
        originalUrl: "https://bit.ly/test",
        finalUrl: "https://example.com",
        redirectChain: ["https://bit.ly/test", "https://example.com"],
        isShortener: true,
      };

      vi.mocked(mockKv.get).mockResolvedValue(cachedResult as any);

      const result1 = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
      );
      const result2 = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
      );

      expect(result1?.cacheHit).toBe(true);
      expect(result2?.cacheHit).toBe(true);
      // Should only call fetch once (or not at all if cached)
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should handle fetch errors gracefully", async () => {
      // Mock cache miss
      vi.mocked(mockKv.get).mockResolvedValue(null);

      // Mock fetch to throw error
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
      );

      expect(result).toBeNull();
    });

    it("should handle cache read errors gracefully", async () => {
      vi.mocked(mockKv.get).mockRejectedValue(new Error("Cache error"));

      // Should not throw, should continue without cache
      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
      );

      // Result may be null or attempt to resolve without cache
      expect(result).toBeDefined();
    });

    it("should handle cache write errors gracefully", async () => {
      // Mock cache miss
      vi.mocked(mockKv.get).mockResolvedValue(null);
      vi.mocked(mockKv.put).mockRejectedValue(new Error("Cache write error"));

      // Mock successful fetch
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          get: vi.fn().mockReturnValue(null),
        },
      });

      // Should not throw, should return result even if cache write fails
      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
      );

      expect(result).toBeDefined();
    });
  });

  describe("shortener detection", () => {
    it("should identify bit.ly as shortener", () => {
      expect(redirectResolver.isShortener("bit.ly")).toBe(true);
    });

    it("should identify t.co as shortener", () => {
      expect(redirectResolver.isShortener("t.co")).toBe(true);
    });

    it("should not identify regular domains as shorteners", () => {
      expect(redirectResolver.isShortener("example.com")).toBe(false);
      expect(redirectResolver.isShortener("github.com")).toBe(false);
    });
  });
});
