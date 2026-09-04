/**
 * Unit Tests: Out Redirector Routes
 *
 * Tests for safe link redirection with security warnings for risky links.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { outRoutes } from "../../../src/lib/routes/out.js";
import { LinkStatus } from "../../../src/lib/link-security-handler.js";

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
const mockAddSecurityHeaders = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
  },
}));

// Mock RateLimiter
const mockApplyRateLimitKV = vi.fn();
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = mockApplyRateLimitKV;
  },
}));

// Mock LinkSecurityHandler
const mockNormalizeUrl = vi.fn();
const mockValidateUrlSync = vi.fn();
const mockValidateUrl = vi.fn();
vi.mock("../../../src/lib/link-security-handler", async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    LinkSecurityHandler: class {
      normalizeUrl = mockNormalizeUrl;
      validateUrlSync = mockValidateUrlSync;
      validateUrl = mockValidateUrl;
    },
  };
});

// Mock DomainReputationService
const mockGetReputation = vi.fn();
vi.mock("../../../src/lib/domain-reputation-service", () => ({
  DomainReputationService: class {
    getReputation = mockGetReputation;
  },
}));

describe("Out Routes", () => {
  let mockEnv: any;

  const route = outRoutes.find(
    (r) => r.method === "GET" && r.path === "/out",
  );

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      DEFAULT_REGION: "EU",
    };

    mockApplyRateLimitKV.mockResolvedValue(null);
    // The route now uses the DNS-validating `validateUrl` (Phase 6 M1). By
    // default it mirrors whatever the existing `validateUrlSync` arrangement
    // returns, so each test's setup keeps expressing the lexical verdict; the
    // DNS-specific case gets its own test below.
    mockValidateUrl.mockImplementation(async (url: string) =>
      mockValidateUrlSync(url),
    );
    mockCreateSecureResponse.mockImplementation(
      (body, options) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((response) => response);
  });

  it("should exist as a route", () => {
    expect(route).toBeDefined();
  });

  describe("GET /out - redirect handler", () => {
    it("should return 400 for missing URL parameter", async () => {
      const request = new Request("https://example.com/out", {
        method: "GET",
      });

      await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/out"),
        pathname: "/out",
        params: {},
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Missing url parameter" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });

    it("should apply rate limiting (100/hour by IP)", async () => {
      const rateLimitResponse = new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429 },
      );
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      const request = new Request(
        "https://example.com/out?url=https://safe.com",
        {
          method: "GET",
          headers: { "CF-Connecting-IP": "1.2.3.4" },
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/out?url=https://safe.com"),
        pathname: "/out",
        params: {},
      });

      expect(mockApplyRateLimitKV).toHaveBeenCalledWith(
        mockEnv,
        request,
        "/out",
        100,
        3600,
        "1.2.3.4",
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(rateLimitResponse);
    });

    it("should show blocked page for invalid URL format (normalizeUrl returns null)", async () => {
      mockNormalizeUrl.mockReturnValue(null);

      const request = new Request(
        "https://example.com/out?url=not-a-url",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/out?url=not-a-url"),
        pathname: "/out",
        params: {},
      });

      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toContain("Link Blocked");
      expect(body).toContain("Invalid URL format");
    });

    it("should show blocked page for BLOCKED validation status", async () => {
      mockNormalizeUrl.mockReturnValue({
        normalized: "https://evil.com/malware",
        domain: "evil.com",
      });
      mockValidateUrlSync.mockReturnValue({
        status: LinkStatus.BLOCKED,
        reason: "Known malware domain",
      });

      const request = new Request(
        "https://example.com/out?url=https://evil.com/malware",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/out?url=https://evil.com/malware",
        ),
        pathname: "/out",
        params: {},
      });

      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toContain("Link Blocked");
          });

    it("should block a destination whose DNS answer is internal (SSRF)", async () => {
      // Phase 6 M1: the interstitial must run the DNS-validating check, not
      // just the lexical one — `cdn.attacker.example` looks entirely ordinary
      // until you resolve it to the metadata address.
      mockNormalizeUrl.mockReturnValue({
        normalized: "https://cdn.attacker.example/",
        domain: "cdn.attacker.example",
      });
      mockValidateUrlSync.mockReturnValue({ status: LinkStatus.SAFE });
      mockValidateUrl.mockResolvedValue({
        status: LinkStatus.BLOCKED,
        reason: "Internal network access blocked",
      });

      const request = new Request(
        "https://example.com/out?url=https://cdn.attacker.example/",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/out?url=https://cdn.attacker.example/"),
        pathname: "/out",
        params: {},
      });

      expect(mockValidateUrl).toHaveBeenCalled();
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toContain("Link Blocked");
      // Reputation is never consulted — we refuse before spending that lookup.
      expect(mockGetReputation).not.toHaveBeenCalled();
    });

    it("should show blocked page when domain reputation is blocked", async () => {
      mockNormalizeUrl.mockReturnValue({
        normalized: "https://bad-reputation.com",
        domain: "bad-reputation.com",
      });
      mockValidateUrlSync.mockReturnValue({
        status: LinkStatus.SAFE,
      });
      mockGetReputation.mockResolvedValue({
        status: "blocked",
        domain: "bad-reputation.com",
      });

      const request = new Request(
        "https://example.com/out?url=https://bad-reputation.com",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/out?url=https://bad-reputation.com",
        ),
        pathname: "/out",
        params: {},
      });

      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toContain("Link Blocked");
    });

    it("should redirect safe URLs with 302", async () => {
      mockNormalizeUrl.mockReturnValue({
        normalized: "https://safe.com/page",
        domain: "safe.com",
      });
      mockValidateUrlSync.mockReturnValue({
        status: LinkStatus.SAFE,
      });
      mockGetReputation.mockResolvedValue({
        status: "safe",
        domain: "safe.com",
      });

      const request = new Request(
        "https://example.com/out?url=https://safe.com/page",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/out?url=https://safe.com/page"),
        pathname: "/out",
        params: {},
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://safe.com/page");
          });

    it("should show warning page for suspicious URLs (WARNING status)", async () => {
      mockNormalizeUrl.mockReturnValue({
        normalized: "https://suspicious.com/page",
        domain: "suspicious.com",
      });
      mockValidateUrlSync.mockReturnValue({
        status: LinkStatus.WARNING,
      });
      mockGetReputation.mockResolvedValue({
        status: "unknown",
        domain: "suspicious.com",
      });

      const request = new Request(
        "https://example.com/out?url=https://suspicious.com/page",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/out?url=https://suspicious.com/page",
        ),
        pathname: "/out",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Warning: External Link");
      expect(body).toContain("suspicious.com");
    });

    it("should show warning page for PENDING validation status", async () => {
      mockNormalizeUrl.mockReturnValue({
        normalized: "https://unknown.com/page",
        domain: "unknown.com",
      });
      mockValidateUrlSync.mockReturnValue({
        status: LinkStatus.PENDING,
      });
      mockGetReputation.mockResolvedValue({
        status: "unknown",
        domain: "unknown.com",
      });

      const request = new Request(
        "https://example.com/out?url=https://unknown.com/page",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/out?url=https://unknown.com/page",
        ),
        pathname: "/out",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Warning: External Link");
    });

    it("should show warning with reason when domain has low reputation", async () => {
      mockNormalizeUrl.mockReturnValue({
        normalized: "https://low-rep.com/page",
        domain: "low-rep.com",
      });
      mockValidateUrlSync.mockReturnValue({
        status: LinkStatus.SAFE,
      });
      mockGetReputation.mockResolvedValue({
        status: "warning",
        domain: "low-rep.com",
      });

      const request = new Request(
        "https://example.com/out?url=https://low-rep.com/page",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/out?url=https://low-rep.com/page",
        ),
        pathname: "/out",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Warning: External Link");
      expect(body).toContain("Domain has low reputation");
    });

    it("should escape HTML entities in URL to prevent XSS", async () => {
      mockNormalizeUrl.mockReturnValue({
        normalized: "https://example.com/<script>alert(1)</script>",
        domain: "example.com",
      });
      mockValidateUrlSync.mockReturnValue({
        status: LinkStatus.SAFE,
      });
      mockGetReputation.mockResolvedValue({
        status: "warning",
        domain: "example.com",
      });

      const request = new Request(
        'https://example.com/out?url=https://example.com/<script>alert(1)</script>',
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/out?url=https://example.com/%3Cscript%3Ealert(1)%3C/script%3E",
        ),
        pathname: "/out",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      // Should contain escaped HTML, not raw script tags
      expect(body).toContain("&lt;script&gt;");
      expect(body).not.toContain("<script>alert(1)</script>");
    });

    it("should return 500 on unexpected errors", async () => {
      mockNormalizeUrl.mockImplementation(() => {
        throw new Error("Unexpected internal error");
      });

      const request = new Request(
        "https://example.com/out?url=https://example.com",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/out?url=https://example.com"),
        pathname: "/out",
        params: {},
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({ error: "Failed to process link" });
          });

    it("should use X-Forwarded-For when CF-Connecting-IP is not available", async () => {
      const request = new Request(
        "https://example.com/out?url=https://safe.com",
        {
          method: "GET",
          headers: { "X-Forwarded-For": "5.6.7.8, 9.10.11.12" },
        },
      );

      mockNormalizeUrl.mockReturnValue({
        normalized: "https://safe.com",
        domain: "safe.com",
      });
      mockValidateUrlSync.mockReturnValue({
        status: LinkStatus.SAFE,
      });
      mockGetReputation.mockResolvedValue({
        status: "safe",
        domain: "safe.com",
      });

      await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/out?url=https://safe.com"),
        pathname: "/out",
        params: {},
      });

      expect(mockApplyRateLimitKV).toHaveBeenCalledWith(
        mockEnv,
        request,
        "/out",
        100,
        3600,
        "5.6.7.8",
      );
    });

    it("should use 'unknown' when no IP headers are present", async () => {
      const request = new Request(
        "https://example.com/out?url=https://safe.com",
        { method: "GET" },
      );

      mockNormalizeUrl.mockReturnValue({
        normalized: "https://safe.com",
        domain: "safe.com",
      });
      mockValidateUrlSync.mockReturnValue({
        status: LinkStatus.SAFE,
      });
      mockGetReputation.mockResolvedValue({
        status: "safe",
        domain: "safe.com",
      });

      await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/out?url=https://safe.com"),
        pathname: "/out",
        params: {},
      });

      expect(mockApplyRateLimitKV).toHaveBeenCalledWith(
        mockEnv,
        request,
        "/out",
        100,
        3600,
        "unknown",
      );
    });
  });
});
