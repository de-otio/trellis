/**
 * Unit Tests: Link Security Handler
 *
 * Tests URL extraction, normalization, validation, and security checks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkSecurityEnv } from "../../src/lib/link-security-handler.js";
import {
  LinkSecurityHandler,
  LinkStatus,
} from "../../src/lib/link-security-handler.js";

// Mock DomainReputationService
const mockGetReputation = vi.fn();
vi.mock("../../src/lib/domain-reputation-service", () => ({
  DomainReputationService: class {
    getReputation = mockGetReputation;
  },
}));

// Mock db module
const mockDomainReputationUpsert = vi.fn();
const mockLinkCheckCreate = vi.fn();
vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => ({
    domainReputation: {
      upsert: mockDomainReputationUpsert,
    },
    linkCheck: {
      create: mockLinkCheckCreate,
    },
  })),
}));

describe("LinkSecurityHandler", () => {
  let handler: LinkSecurityHandler;
  let mockEnv: LinkSecurityEnv;

  beforeEach(() => {
    handler = new LinkSecurityHandler();
    mockEnv = {
      DATABASE_URL: "postgresql://test",
      LINK_CHECK_QUEUE: {
        send: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    // Reset mocks
    vi.clearAllMocks();
  });

  describe("extractUrls", () => {
    it("should extract single URL from text", () => {
      const text = "Check out https://example.com for more info";
      const urls = handler.extractUrls(text);
      expect(urls).toEqual(["https://example.com"]);
    });

    it("should extract multiple URLs from text", () => {
      const text = "Visit https://example.com and https://test.com for details";
      const urls = handler.extractUrls(text);
      expect(urls).toEqual(["https://example.com", "https://test.com"]);
    });

    it("should extract URLs with query parameters", () => {
      const text = "See https://example.com/page?param=value&other=123";
      const urls = handler.extractUrls(text);
      expect(urls).toEqual(["https://example.com/page?param=value&other=123"]);
    });

    it("should extract URLs with paths", () => {
      const text = "Check https://example.com/path/to/page";
      const urls = handler.extractUrls(text);
      expect(urls).toEqual(["https://example.com/path/to/page"]);
    });

    it("should extract URLs in markdown format", () => {
      const text = "See [link](https://example.com) for more";
      const urls = handler.extractUrls(text);
      expect(urls).toEqual(["https://example.com"]);
    });

    it("should deduplicate URLs", () => {
      const text = "Visit https://example.com and https://example.com again";
      const urls = handler.extractUrls(text);
      expect(urls).toEqual(["https://example.com"]);
    });

    it("should return empty array for text with no URLs", () => {
      const text = "This is just plain text with no URLs";
      const urls = handler.extractUrls(text);
      expect(urls).toEqual([]);
    });

    it("should handle empty string", () => {
      const urls = handler.extractUrls("");
      expect(urls).toEqual([]);
    });

    it("should handle null/undefined input gracefully", () => {
      expect(handler.extractUrls(null as any)).toEqual([]);
      expect(handler.extractUrls(undefined as any)).toEqual([]);
    });
  });

  describe("normalizeUrl", () => {
    it("should normalize valid HTTP URL", () => {
      const result = handler.normalizeUrl(
        "http://example.com/path?query=value#fragment",
      );
      expect(result).not.toBeNull();
      expect(result?.scheme).toBe("http");
      expect(result?.host).toBe("example.com");
      expect(result?.domain).toBe("example.com");
      expect(result?.path).toBe("/path");
      expect(result?.query).toBe("?query=value");
      expect(result?.normalized).toBe("http://example.com/path?query=value");
    });

    it("should normalize valid HTTPS URL", () => {
      const result = handler.normalizeUrl("HTTPS://EXAMPLE.COM/PATH");
      expect(result).not.toBeNull();
      expect(result?.scheme).toBe("https");
      expect(result?.host).toBe("example.com");
      expect(result?.normalized).toBe("https://example.com/PATH");
    });

    it("should strip fragments from URL", () => {
      const result = handler.normalizeUrl("https://example.com/page#section");
      expect(result).not.toBeNull();
      expect(result?.normalized).toBe("https://example.com/page");
    });

    it("should handle URLs with ports", () => {
      const result = handler.normalizeUrl("https://example.com:8080/path");
      expect(result).not.toBeNull();
      expect(result?.host).toBe("example.com:8080");
      expect(result?.domain).toBe("example.com");
    });

    it("should return null for invalid URL", () => {
      const result = handler.normalizeUrl("not-a-valid-url");
      expect(result).toBeNull();
    });

    it("should return null for empty string", () => {
      const result = handler.normalizeUrl("");
      expect(result).toBeNull();
    });

    it("should handle null/undefined input gracefully", () => {
      expect(handler.normalizeUrl(null as any)).toBeNull();
      expect(handler.normalizeUrl(undefined as any)).toBeNull();
    });
  });

  describe("validateUrlSync", () => {
    it("should allow safe HTTPS URL", () => {
      const result = handler.validateUrlSync("https://example.com");
      expect(result.status).toBe(LinkStatus.SAFE);
      expect(result.normalizedUrl).not.toBeNull();
    });

    it("should allow safe HTTP URL", () => {
      const result = handler.validateUrlSync("http://example.com");
      expect(result.status).toBe(LinkStatus.SAFE);
      expect(result.normalizedUrl).not.toBeNull();
    });

    it("should block javascript: scheme", () => {
      const result = handler.validateUrlSync('javascript:alert("xss")');
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Dangerous scheme");
    });

    it("should block data: scheme", () => {
      const result = handler.validateUrlSync(
        'data:text/html,<script>alert("xss")</script>',
      );
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Dangerous scheme");
    });

    it("should block file: scheme", () => {
      const result = handler.validateUrlSync("file:///etc/passwd");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Dangerous scheme");
    });

    it("should block vbscript: scheme", () => {
      const result = handler.validateUrlSync('vbscript:msgbox("xss")');
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Dangerous scheme");
    });

    it("should block chrome: scheme", () => {
      const result = handler.validateUrlSync("chrome://settings");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Dangerous scheme");
    });

    it("should block internal IPv4 addresses (10.0.0.0/8)", () => {
      const result = handler.validateUrlSync("https://10.0.0.1");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Private IP range");
    });

    it("should block internal IPv4 addresses (172.16.0.0/12)", () => {
      const result = handler.validateUrlSync("https://172.16.0.1");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Private IP range");
    });

    it("should block internal IPv4 addresses (192.168.0.0/16)", () => {
      const result = handler.validateUrlSync("https://192.168.1.1");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Private IP range");
    });

    it("should block localhost (127.0.0.0/8)", () => {
      const result = handler.validateUrlSync("https://127.0.0.1");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Private IP range");
    });

    it("should block localhost hostname", () => {
      const result = handler.validateUrlSync("https://localhost");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Internal hostname");
    });

    it("should block .local hostnames", () => {
      const result = handler.validateUrlSync("https://server.local");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Internal hostname");
    });

    it("should block .corp hostnames", () => {
      const result = handler.validateUrlSync("https://internal.corp");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Internal hostname");
    });

    it("should block .internal hostnames", () => {
      const result = handler.validateUrlSync("https://server.internal");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Internal hostname");
    });

    it("should block .lan hostnames", () => {
      const result = handler.validateUrlSync("https://server.lan");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Internal hostname");
    });

    it("should block IPv6 localhost (::1)", () => {
      const result = handler.validateUrlSync("https://[::1]");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("IPv6 internal range");
    });

    it("should block raw IP URLs", () => {
      const result = handler.validateUrlSync("https://8.8.8.8");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toContain("Raw IP URLs are not allowed");
    });

    it("should return blocked status for invalid URL format", () => {
      const result = handler.validateUrlSync("not-a-valid-url");
      expect(result.status).toBe(LinkStatus.BLOCKED);
      expect(result.reason).toBe("Invalid URL format");
    });
  });

  describe("checkDomainReputation", () => {
    it("should return domain reputation when found", async () => {
      const mockReputation = {
        domain: "example.com",
        reputation: 50,
        status: "safe" as const,
      };
      mockGetReputation.mockResolvedValue(mockReputation);

      const result = await handler.checkDomainReputation(
        "example.com",
        mockEnv,
      );

      expect(result).not.toBeNull();
      expect(result?.domain).toBe("example.com");
      expect(result?.reputation).toBe(50);
      expect(result?.status).toBe("safe");
      expect(mockGetReputation).toHaveBeenCalledWith(
        "example.com",
        "EU",
        mockEnv,
      );
    });

    it("should return null when domain not found", async () => {
      mockGetReputation.mockResolvedValue(null);

      const result = await handler.checkDomainReputation(
        "unknown.com",
        mockEnv,
      );

      expect(result).toBeNull();
      expect(mockGetReputation).toHaveBeenCalledWith(
        "unknown.com",
        "EU",
        mockEnv,
      );
    });

    it("should handle database errors gracefully", async () => {
      mockGetReputation.mockRejectedValue(new Error("Database error"));

      const result = await handler.checkDomainReputation(
        "example.com",
        mockEnv,
      );

      expect(result).toBeNull();
    });
  });

  describe("queueThreatIntelCheck", () => {
    it("should create LinkCheck record and queue threat intel check", async () => {
      const mockLinkCheck = {
        id: "check-123",
        postId: "post-123",
        originalUrl: "https://example.com",
        normalizedUrl: "https://example.com",
        domain: "example.com",
        status: "pending",
        checkType: "async",
      };

      mockDomainReputationUpsert.mockResolvedValue({
        domain: "example.com",
        reputation: 0,
        status: "unknown",
      });
      mockLinkCheckCreate.mockResolvedValue(mockLinkCheck);

      const result = await handler.queueThreatIntelCheck(
        {
          tenantId: "tenant-x",
          postId: "post-123",
          originalUrl: "https://example.com",
          normalizedUrl: "https://example.com",
          domain: "example.com",
          status: LinkStatus.PENDING,
        },
        mockEnv,
      );

      expect(result).toBe("check-123");
      expect(mockDomainReputationUpsert).toHaveBeenCalledWith({
        where: { domain: "example.com" },
        create: {
          domain: "example.com",
          reputation: 0,
          status: "unknown",
        },
        update: {},
      });
      expect(mockLinkCheckCreate).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant-x",
          postId: "post-123",
          commentId: null,
          originalUrl: "https://example.com",
          normalizedUrl: "https://example.com",
          domain: "example.com",
          status: "pending",
          checkType: "async",
        },
      });
      expect(mockEnv.LINK_CHECK_QUEUE?.send).toHaveBeenCalledWith({
        linkCheckId: "check-123",
        url: "https://example.com",
        domain: "example.com",
      });
    });

    it("should handle comment links", async () => {
      const mockLinkCheck = {
        id: "check-456",
        commentId: "comment-456",
        originalUrl: "https://test.com",
        normalizedUrl: "https://test.com",
        domain: "test.com",
        status: "pending",
        checkType: "async",
      };

      mockDomainReputationUpsert.mockResolvedValue({
        domain: "test.com",
        reputation: 0,
        status: "unknown",
      });
      mockLinkCheckCreate.mockResolvedValue(mockLinkCheck);

      const result = await handler.queueThreatIntelCheck(
        {
          tenantId: "tenant-x",
          commentId: "comment-456",
          originalUrl: "https://test.com",
          normalizedUrl: "https://test.com",
          domain: "test.com",
          status: LinkStatus.PENDING,
        },
        mockEnv,
      );

      expect(result).toBe("check-456");
      expect(mockLinkCheckCreate).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant-x",
          postId: null,
          commentId: "comment-456",
          originalUrl: "https://test.com",
          normalizedUrl: "https://test.com",
          domain: "test.com",
          status: "pending",
          checkType: "async",
        },
      });
    });

    it("should continue if queue is not available", async () => {
      const mockLinkCheck = {
        id: "check-789",
        postId: "post-789",
        originalUrl: "https://example.com",
        normalizedUrl: "https://example.com",
        domain: "example.com",
        status: "pending",
        checkType: "async",
      };

      const envWithoutQueue = {
        ...mockEnv,
        LINK_CHECK_QUEUE: undefined,
      };

      mockDomainReputationUpsert.mockResolvedValue({
        domain: "example.com",
        reputation: 0,
        status: "unknown",
      });
      mockLinkCheckCreate.mockResolvedValue(mockLinkCheck);

      const result = await handler.queueThreatIntelCheck(
        {
          tenantId: "tenant-x",
          postId: "post-789",
          originalUrl: "https://example.com",
          normalizedUrl: "https://example.com",
          domain: "example.com",
          status: LinkStatus.PENDING,
        },
        envWithoutQueue as any,
      );

      expect(result).toBe("check-789");
      expect(mockLinkCheckCreate).toHaveBeenCalled();
    });

    it("should handle queue send errors gracefully", async () => {
      const mockLinkCheck = {
        id: "check-999",
        postId: "post-999",
        originalUrl: "https://example.com",
        normalizedUrl: "https://example.com",
        domain: "example.com",
        status: "pending",
        checkType: "async",
      };

      mockDomainReputationUpsert.mockResolvedValue({
        domain: "example.com",
        reputation: 0,
        status: "unknown",
      });
      mockLinkCheckCreate.mockResolvedValue(mockLinkCheck);
      (mockEnv.LINK_CHECK_QUEUE?.send as any).mockRejectedValue(
        new Error("Queue error"),
      );

      const result = await handler.queueThreatIntelCheck(
        {
          tenantId: "tenant-x",
          postId: "post-999",
          originalUrl: "https://example.com",
          normalizedUrl: "https://example.com",
          domain: "example.com",
          status: LinkStatus.PENDING,
        },
        mockEnv,
      );

      // Should still return the link check ID even if queue fails
      expect(result).toBe("check-999");
    });

    it("should return null on database error", async () => {
      mockDomainReputationUpsert.mockRejectedValue(new Error("Database error"));

      const result = await handler.queueThreatIntelCheck(
        {
          tenantId: "tenant-x",
          postId: "post-123",
          originalUrl: "https://example.com",
          normalizedUrl: "https://example.com",
          domain: "example.com",
          status: LinkStatus.PENDING,
        },
        mockEnv,
      );

      expect(result).toBeNull();
    });
  });
});
