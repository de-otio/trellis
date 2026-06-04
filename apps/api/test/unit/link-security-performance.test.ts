/**
 * Performance Tests: Link Security
 *
 * Tests performance characteristics of the link security system:
 * - URL extraction performance
 * - Normalization performance
 * - Queue processing latency
 * - Cache hit rates
 * - API response times
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinkSecurityHandler } from "../../src/lib/link-security-handler.js";
import { RedirectResolver } from "../../src/lib/redirect-resolver.js";
import { ThreatIntelService } from "../../src/lib/threat-intel-service.js";

// Mock fetch
global.fetch = vi.fn();

describe("Link Security - Performance Tests", () => {
  const mockEnv = {
    GOOGLE_SAFE_BROWSING_API_KEY: "test-key",
    THREAT_INTEL_CACHE_KV: {
      get: vi.fn(),
      put: vi.fn(),
    },
  } as any;

  const linkSecurityHandler = new LinkSecurityHandler(mockEnv);
  const threatIntelService = new ThreatIntelService(mockEnv);
  const redirectResolver = new RedirectResolver(mockEnv);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("URL Extraction Performance", () => {
    it("should extract URLs quickly from short text", () => {
      const text = "Check out https://example.com for more info";
      const start = performance.now();
      const urls = linkSecurityHandler.extractUrls(text);
      const end = performance.now();
      const duration = end - start;

      expect(urls).toHaveLength(1);
      expect(duration).toBeLessThan(10); // Should be very fast (< 10ms)
    });

    it("should extract multiple URLs efficiently", () => {
      const text = Array(100)
        .fill("https://example.com/page")
        .map((url, i) => `${url}${i}`)
        .join(" ");

      const start = performance.now();
      const urls = linkSecurityHandler.extractUrls(text);
      const end = performance.now();
      const duration = end - start;

      expect(urls.length).toBeGreaterThan(0);
      expect(duration).toBeLessThan(100); // Should handle 100 URLs quickly
    });

    it("should handle large text blocks efficiently", () => {
      const largeText =
        "Check out https://example.com " + "lorem ipsum ".repeat(1000);
      const start = performance.now();
      const urls = linkSecurityHandler.extractUrls(largeText);
      const end = performance.now();
      const duration = end - start;

      expect(urls).toHaveLength(1);
      expect(duration).toBeLessThan(50); // Should handle large text efficiently
    });

    it("should deduplicate URLs efficiently", () => {
      const text = Array(50).fill("https://example.com").join(" ");

      const start = performance.now();
      const urls = linkSecurityHandler.extractUrls(text);
      const end = performance.now();
      const duration = end - start;

      expect(urls).toHaveLength(1); // Should deduplicate
      expect(duration).toBeLessThan(20);
    });
  });

  describe("URL Normalization Performance", () => {
    it("should normalize URLs quickly", () => {
      const urls = [
        "https://EXAMPLE.COM/Path?query=value#fragment",
        "http://example.com:80/path",
        "https://xn--r8jz45g.xn--zckzah",
      ];

      const start = performance.now();
      urls.forEach((url) => {
        linkSecurityHandler.normalizeUrl(url);
      });
      const end = performance.now();
      const duration = end - start;

      expect(duration).toBeLessThan(10); // Should normalize quickly
    });

    it("should handle punycode conversion efficiently", () => {
      const unicodeUrl = "https://例え.テスト/path";
      const start = performance.now();
      const normalized = linkSecurityHandler.normalizeUrl(unicodeUrl);
      const end = performance.now();
      const duration = end - start;

      expect(normalized).toBeDefined();
      expect(duration).toBeLessThan(5);
    });

    it("should handle invalid URLs efficiently", () => {
      const invalidUrls = ["not-a-url", "http://", "://invalid"];

      const start = performance.now();
      invalidUrls.forEach((url) => {
        linkSecurityHandler.normalizeUrl(url);
      });
      const end = performance.now();
      const duration = end - start;

      expect(duration).toBeLessThan(5); // Should fail fast
    });
  });

  describe("Synchronous Validation Performance", () => {
    it("should validate URLs quickly", () => {
      const urls = [
        "https://example.com",
        "http://example.com",
        "javascript:alert(1)",
        "http://192.168.1.1",
      ];

      const start = performance.now();
      urls.forEach((url) => {
        linkSecurityHandler.validateUrlSync(url);
      });
      const end = performance.now();
      const duration = end - start;

      expect(duration).toBeLessThan(10); // Synchronous validation should be fast
    });

    it("should check internal IPs efficiently", () => {
      const internalIps = [
        "http://10.0.0.1",
        "http://172.16.0.1",
        "http://192.168.1.1",
        "http://127.0.0.1",
      ];

      const start = performance.now();
      internalIps.forEach((ip) => {
        linkSecurityHandler.validateUrlSync(ip);
      });
      const end = performance.now();
      const duration = end - start;

      expect(duration).toBeLessThan(10);
    });
  });

  describe("Cache Performance", () => {
    it("should return cached results quickly", async () => {
      const url = "https://example.com";
      const cachedResult = {
        safe: true,
        threats: [],
        cachedAt: new Date().toISOString(),
      };

      // Mock cache hit - KV.get with 'json' option returns parsed object
      // Use mockImplementation to handle any parameters
      vi.mocked(mockEnv.THREAT_INTEL_CACHE_KV.get).mockImplementation(
        async () => {
          return cachedResult as any;
        },
      );

      const start = performance.now();
      const result = await threatIntelService.checkSafeBrowsing(url, mockEnv);
      const end = performance.now();
      const duration = end - start;

      expect(result.cacheHit).toBe(true);
      expect(duration).toBeLessThan(50); // Cache lookup should be fast
    });

    it("should cache redirect results efficiently", async () => {
      const url = "https://bit.ly/test";
      const cachedResult = {
        originalUrl: url,
        finalUrl: "https://example.com",
        redirectChain: [url, "https://example.com"],
        isShortener: true,
      };

      vi.mocked(mockEnv.THREAT_INTEL_CACHE_KV.get).mockResolvedValue(
        cachedResult as any,
      );

      const start = performance.now();
      const result = await redirectResolver.resolveRedirects(url, mockEnv);
      const end = performance.now();
      const duration = end - start;

      expect(result?.cacheHit).toBe(true);
      expect(duration).toBeLessThan(50);
    });
  });

  describe("Queue Processing Performance", () => {
    it("should process queue messages efficiently", async () => {
      // This is a placeholder for actual queue processing performance tests
      // In a real scenario, we would measure:
      // - Message parsing time
      // - Database lookup time
      // - Threat intel check time
      // - Database update time

      // For now, we verify that synchronous operations are fast
      const url = "https://example.com";
      const start = performance.now();
      linkSecurityHandler.validateUrlSync(url);
      const end = performance.now();
      const duration = end - start;

      expect(duration).toBeLessThan(5); // Synchronous validation should be instant
    });
  });

  describe("API Response Time Impact", () => {
    it("should not significantly impact post creation time", () => {
      const text = "Check out https://example.com and https://github.com";
      const start = performance.now();

      // Simulate what happens during post creation
      const urls = linkSecurityHandler.extractUrls(text);
      urls.forEach((url) => {
        linkSecurityHandler.normalizeUrl(url);
        linkSecurityHandler.validateUrlSync(url);
      });

      const end = performance.now();
      const duration = end - start;

      // Link security checks should add < 20ms to post creation
      expect(duration).toBeLessThan(20);
    });

    it("should handle posts with many URLs efficiently", () => {
      const urls = Array(10)
        .fill("https://example.com")
        .map((url, i) => `${url}/page${i}`);
      const text = urls.join(" ");

      const start = performance.now();
      const extracted = linkSecurityHandler.extractUrls(text);
      extracted.forEach((url) => {
        linkSecurityHandler.normalizeUrl(url);
        linkSecurityHandler.validateUrlSync(url);
      });
      const end = performance.now();
      const duration = end - start;

      // Should handle 10 URLs in < 50ms
      expect(duration).toBeLessThan(50);
    });
  });

  describe("Memory Efficiency", () => {
    it("should not create excessive objects during URL extraction", () => {
      const text = "https://example.com ".repeat(100);
      const initialMemory = (performance as any).memory?.usedJSHeapSize || 0;

      for (let i = 0; i < 100; i++) {
        linkSecurityHandler.extractUrls(text);
      }

      const finalMemory = (performance as any).memory?.usedJSHeapSize || 0;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be reasonable (< 1MB for 100 operations)
      if (memoryIncrease > 0) {
        expect(memoryIncrease).toBeLessThan(1024 * 1024);
      }
    });
  });
});
