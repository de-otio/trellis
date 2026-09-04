/**
 * Unit tests for RedirectResolver
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RedirectResolver } from "../../src/lib/redirect-resolver.js";
import type {
  DnsResolver,
  RawResponse,
  Transport,
} from "../../src/lib/net/safe-fetch.js";
import type { KVNamespace } from "@cloudflare/workers-types";

/**
 * The resolver now fetches through the SSRF-safe helper rather than global
 * `fetch`, so these tests inject a transport and a resolver instead of
 * stubbing `globalThis.fetch`. That is a strictly better arrangement: the
 * request actually travels through `assertUrlSafe`, so a test that expects an
 * internal destination to be refused is exercising the real guard.
 */
const publicResolver: DnsResolver = async () => ["93.184.216.34"];

async function* emptyBody(): AsyncIterable<Uint8Array> {
  // no chunks
}

function response(
  status: number,
  headers: Record<string, string> = {},
): RawResponse {
  return { status, headers, body: emptyBody() };
}

/** Transport that answers every request from a URL -> response map. */
function mapTransport(
  routes: Record<string, RawResponse | (() => RawResponse)>,
): { transport: Transport; calls: string[] } {
  const calls: string[] = [];
  const transport: Transport = async (req) => {
    const href = req.target.url.href;
    calls.push(href);
    const entry = routes[href] ?? routes["*"];
    if (!entry) return response(200);
    return typeof entry === "function" ? entry() : entry;
  };
  return { transport, calls };
}

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
      vi.mocked(mockKv.get).mockResolvedValue(null);

      const { transport } = mapTransport({
        "https://bit.ly/test": response(301, {
          location: "https://example.com",
        }),
        "https://example.com/": response(200),
      });

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
        { resolver: publicResolver, transport },
      );

      expect(result).toBeDefined();
      // URL may have trailing slash, so check if it starts with expected URL
      expect(result?.finalUrl).toMatch(/^https:\/\/example\.com\/?$/);
      expect(result?.redirectChain.length).toBeGreaterThan(1);
      expect(mockKv.put).toHaveBeenCalled();
    });

    it("should stop at max redirects", async () => {
      vi.mocked(mockKv.get).mockResolvedValue(null);

      let callCount = 0;
      const transport: Transport = async () => {
        callCount++;
        return response(301, {
          location: `https://example.com/redirect${callCount}`,
        });
      };

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
        { resolver: publicResolver, transport },
      );

      expect(result).toBeDefined();
      expect(callCount).toBeLessThanOrEqual(5); // Max redirects
    });

    it("should detect redirect loops", async () => {
      vi.mocked(mockKv.get).mockResolvedValue(null);

      const { transport, calls } = mapTransport({
        "*": response(301, { location: "https://bit.ly/test" }),
      });

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
        { resolver: publicResolver, transport },
      );

      expect(result).toBeDefined();
      // Loop detection stops the chain after the first hop.
      expect(calls).toHaveLength(1);
    });

    it("should handle transport errors gracefully", async () => {
      vi.mocked(mockKv.get).mockResolvedValue(null);

      const transport: Transport = async () => {
        throw new Error("Request timeout");
      };

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
        { resolver: publicResolver, transport },
      );

      expect(result).toBeNull();
    });

    it("should block redirects to internal IPs", async () => {
      vi.mocked(mockKv.get).mockResolvedValue(null);

      const { transport, calls } = mapTransport({
        "https://bit.ly/test": response(301, {
          location: "http://192.168.1.1",
        }),
      });

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
        { resolver: publicResolver, transport },
      );

      // The chain stops at the last safe hop; the internal address is never
      // dialled.
      expect(result).toBeDefined();
      expect(result?.finalUrl).toBe("https://bit.ly/test");
      expect(calls).toEqual(["https://bit.ly/test"]);
    });

    it("should refuse to fetch an internal INITIAL url (M2)", async () => {
      // The bug this closes: only redirect *destinations* were validated, so
      // hop zero went to the network unchecked. A caller handing this resolver
      // `http://169.254.169.254/` got a metadata fetch.
      vi.mocked(mockKv.get).mockResolvedValue(null);

      const { transport, calls } = mapTransport({ "*": response(200) });

      const result = await redirectResolver.resolveRedirects(
        "http://169.254.169.254/latest/meta-data/",
        mockEnv,
        { resolver: publicResolver, transport },
      );

      expect(result).toBeNull();
      expect(calls).toEqual([]); // no socket was opened at all
    });

    it("should refuse an initial url whose DNS answer is internal (M2)", async () => {
      vi.mocked(mockKv.get).mockResolvedValue(null);

      const { transport, calls } = mapTransport({ "*": response(200) });
      const internalResolver: DnsResolver = async () => ["169.254.169.254"];

      const result = await redirectResolver.resolveRedirects(
        "https://cdn.attacker.example/",
        mockEnv,
        { resolver: internalResolver, transport },
      );

      expect(result).toBeNull();
      expect(calls).toEqual([]);
    });

    it("should cap the response body it will read (M2)", async () => {
      vi.mocked(mockKv.get).mockResolvedValue(null);

      async function* flood(): AsyncIterable<Uint8Array> {
        // Far past the 64 KiB cap; the helper must abort rather than buffer.
        for (let i = 0; i < 64; i++) yield Buffer.alloc(64 * 1024, 0x41);
      }
      const transport: Transport = async () => ({
        status: 200,
        headers: {},
        body: flood(),
      });

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
        { resolver: publicResolver, transport },
      );

      // Over-cap responses surface as a failed resolution, not an OOM.
      expect(result).toBeNull();
    });
  });

  describe("caching", () => {
    it("should cache resolved redirects", async () => {
      vi.mocked(mockKv.get).mockResolvedValue(null);

      const { transport } = mapTransport({ "*": response(200) });

      await redirectResolver.resolveRedirects("https://bit.ly/test", mockEnv, {
        resolver: publicResolver,
        transport,
      });

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
    });
  });

  describe("error handling", () => {
    it("should handle fetch errors gracefully", async () => {
      vi.mocked(mockKv.get).mockResolvedValue(null);

      const transport: Transport = async () => {
        throw new Error("Network error");
      };

      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
        { resolver: publicResolver, transport },
      );

      expect(result).toBeNull();
    });

    it("should handle cache read errors gracefully", async () => {
      vi.mocked(mockKv.get).mockRejectedValue(new Error("Cache error"));

      const { transport } = mapTransport({ "*": response(200) });

      // Should not throw, should continue without cache
      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
        { resolver: publicResolver, transport },
      );

      expect(result).toBeDefined();
    });

    it("should handle cache write errors gracefully", async () => {
      vi.mocked(mockKv.get).mockResolvedValue(null);
      vi.mocked(mockKv.put).mockRejectedValue(new Error("Cache write error"));

      const { transport } = mapTransport({ "*": response(200) });

      // Should not throw, should return result even if cache write fails
      const result = await redirectResolver.resolveRedirects(
        "https://bit.ly/test",
        mockEnv,
        { resolver: publicResolver, transport },
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
