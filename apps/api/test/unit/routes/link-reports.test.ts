/**
 * Unit Tests: Link Report Routes
 *
 * Tests for link report submission endpoints for both posts and comments.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { linkReportRoutes } from "../../../src/lib/routes/link-reports.js";
import type { Session } from "../../../src/lib/session-cookie.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

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

// Mock Validator
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));


// Mock DataRouter
const mockLinkCheckFindUnique = vi.fn();
// P4: link reports now write the generalized Report model.
const mockLinkReportCreate = vi.fn();
const mockDb = {
  linkCheck: {
    findUnique: mockLinkCheckFindUnique,
  },
  report: {
    create: mockLinkReportCreate,
  },
};
vi.mock("../../../src/lib/data-router", () => ({
  DataRouter: {
    getDatabaseForRegion: vi.fn(() => mockDb),
  },
}));

// Mock DomainReputationService
const mockUpdateReputation = vi.fn();
const mockShouldAutoBlock = vi.fn();
vi.mock("../../../src/lib/domain-reputation-service", () => ({
  DomainReputationService: class {
    updateReputation = mockUpdateReputation;
    shouldAutoBlock = mockShouldAutoBlock;
  },
}));

// Mock email provider (stable spy so the auto-block notification's HTML can be
// asserted — P4 escaping exception).
const mockSendEmail = vi.fn();
vi.mock("../../../src/lib/email-provider", () => ({
  createEmailProvider: vi.fn(() => ({
    sendEmail: mockSendEmail,
  })),
}));

describe("Link Report Routes", () => {
  let mockEnv: any;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSession = {
      userId: "user-123",
      tenantId: "tenant-123",
      expiresAt: new Date(Date.now() + 3600000),
    } as Session;

    mockRequestContext = {
      tenantId: "tenant-123",
      userId: "user-123",
      region: "EU",
    } as TrellisRequestContext;

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
      DEFAULT_REGION: "EU",
    };

    mockGetSession.mockResolvedValue(mockSession);
    mockApplyRateLimitKV.mockResolvedValue(null);
    mockCreateSecureResponse.mockImplementation(
      (body, options) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockUpdateReputation.mockResolvedValue(undefined);
    mockShouldAutoBlock.mockResolvedValue(false);
  });

  describe("POST /api/posts/:postId/links/:linkId/report", () => {
    const route = linkReportRoutes.find(
      (r) =>
        r.method === "POST" &&
        r.path instanceof RegExp &&
        r.path.source.includes("posts"),
    );

    it("should exist as a route", () => {
      expect(route).toBeDefined();
    });

    it("should require authentication - return 401", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        { method: "POST" },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });

    it("should apply rate limiting (10/hour)", async () => {
      const rateLimitResponse = new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429 },
      );
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        { method: "POST" },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockApplyRateLimitKV).toHaveBeenCalledWith(
        mockEnv,
        request,
        "/link-reports",
        10,
        3600,
        "user-123",
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(rateLimitResponse);
    });

    it("should return 500 when requestContext is missing", async () => {
      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        { method: "POST" },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: undefined,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });

    it("should extract postId and linkId from URL path", async () => {
      const now = new Date();
      mockLinkCheckFindUnique.mockResolvedValue({
        id: "link-1",
        postId: "post-1",
        normalizedUrl: "https://example.org/page",
        originalUrl: "https://example.org/page",
      });
      mockLinkReportCreate.mockResolvedValue({
        id: "report-1",
        status: "pending",
        createdAt: now,
      });

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockLinkCheckFindUnique).toHaveBeenCalledWith({
        where: { id: "link-1" },
        include: { post: { where: { id: "post-1" } } },
      });
      expect(response.status).toBe(201);
    });

    it("should return 404 when link is not found", async () => {
      mockLinkCheckFindUnique.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Link not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    });

    it("should return 404 when link postId does not match", async () => {
      mockLinkCheckFindUnique.mockResolvedValue({
        id: "link-1",
        postId: "different-post",
        normalizedUrl: "https://example.org/page",
        originalUrl: "https://example.org/page",
      });

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Link not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    });

    it("should accept optional reason in body", async () => {
      const now = new Date();
      mockLinkCheckFindUnique.mockResolvedValue({
        id: "link-1",
        postId: "post-1",
        normalizedUrl: "https://malicious.com/phishing",
        originalUrl: "https://malicious.com/phishing",
      });
      mockLinkReportCreate.mockResolvedValue({
        id: "report-1",
        status: "pending",
        createdAt: now,
      });

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Phishing site" }),
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockLinkReportCreate).toHaveBeenCalledWith({
        data: {
          reportType: "LINK",
          resourceType: "url",
          resourceId: "https://malicious.com/phishing",
          reporterUserId: "user-123",
          domain: "malicious.com",
          reason: "Phishing site",
          status: "pending",
        },
      });
    });

    it("should return 201 on successful report submission", async () => {
      const now = new Date();
      mockLinkCheckFindUnique.mockResolvedValue({
        id: "link-1",
        postId: "post-1",
        normalizedUrl: "https://example.org/page",
        originalUrl: "https://example.org/page",
      });
      mockLinkReportCreate.mockResolvedValue({
        id: "report-1",
        status: "pending",
        createdAt: now,
      });

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toEqual({
        success: true,
        report: {
          id: "report-1",
          status: "pending",
          createdAt: now.toISOString(),
        },
      });
    });

    // P4 security exception 1: reason length bounded at the Zod boundary.
    it("should reject a reason over 1000 chars with a 400", async () => {
      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "x".repeat(1001) }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/api/posts/post-1/links/link-1/report"),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(400);
      // No report is written when validation fails.
      expect(mockLinkReportCreate).not.toHaveBeenCalled();
    });

    // P4 security exception 2: moderator email HTML-escapes interpolated values
    // (here the reportId; domain too — defense-in-depth for Phase 1 report text).
    it("HTML-escapes interpolated values in the auto-block notification email", async () => {
      mockLinkCheckFindUnique.mockResolvedValue({
        id: "link-1",
        postId: "post-1",
        normalizedUrl: "https://xss.example/<script>",
        originalUrl: "https://xss.example/<script>",
      });
      mockLinkReportCreate.mockResolvedValue({
        id: "report-<script>",
        status: "pending",
        createdAt: new Date(),
      });
      mockShouldAutoBlock.mockResolvedValue(true);
      const emailEnv = { ...mockEnv, MODERATOR_EMAILS: "mod@example.com" };

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      await route!.handler(request, emailEnv, {
        url: new URL("https://example.com/api/posts/post-1/links/link-1/report"),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      const html = mockSendEmail.mock.calls[0]![0].html as string;
      // The raw <script> from domain + reportId must be neutralized in the HTML.
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("should update domain reputation after report", async () => {
      const now = new Date();
      mockLinkCheckFindUnique.mockResolvedValue({
        id: "link-1",
        postId: "post-1",
        normalizedUrl: "https://example.org/page",
        originalUrl: "https://example.org/page",
      });
      mockLinkReportCreate.mockResolvedValue({
        id: "report-1",
        status: "pending",
        createdAt: now,
      });

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockUpdateReputation).toHaveBeenCalledWith(
        "example.org",
        "user_report",
        "EU",
        mockEnv,
      );
      expect(mockShouldAutoBlock).toHaveBeenCalledWith(
        "example.org",
        "EU",
        mockEnv,
      );
    });

    it("should strip www. prefix from domain", async () => {
      const now = new Date();
      mockLinkCheckFindUnique.mockResolvedValue({
        id: "link-1",
        postId: "post-1",
        normalizedUrl: "https://www.example.org/page",
        originalUrl: "https://www.example.org/page",
      });
      mockLinkReportCreate.mockResolvedValue({
        id: "report-1",
        status: "pending",
        createdAt: now,
      });

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockLinkReportCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            domain: "example.org",
          }),
        }),
      );
    });

    it("should return 400 for invalid link URL", async () => {
      mockLinkCheckFindUnique.mockResolvedValue({
        id: "link-1",
        postId: "post-1",
        normalizedUrl: null,
        originalUrl: "not-a-valid-url",
      });

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Invalid link URL" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });

    it("should handle handler errors with 500", async () => {
      mockLinkCheckFindUnique.mockRejectedValue(
        new Error("Database connection error"),
      );

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(500);
          });

    it("should return 400 for invalid URL format (pathname mismatch)", async () => {
      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/invalid/path",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Invalid URL format" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });

    it("should auto-block domain when threshold is reached", async () => {
      const now = new Date();
      mockLinkCheckFindUnique.mockResolvedValue({
        id: "link-1",
        postId: "post-1",
        normalizedUrl: "https://spam.com/bad",
        originalUrl: "https://spam.com/bad",
      });
      mockLinkReportCreate.mockResolvedValue({
        id: "report-1",
        status: "pending",
        createdAt: now,
      });
      mockShouldAutoBlock.mockResolvedValue(true);

      const request = new Request(
        "https://example.com/api/posts/post-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/posts/post-1/links/link-1/report",
        ),
        pathname: "/api/posts/post-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      // Should call updateReputation twice: once for user_report, once for auto_block
      expect(mockUpdateReputation).toHaveBeenCalledTimes(2);
      expect(mockUpdateReputation).toHaveBeenCalledWith(
        "spam.com",
        "auto_block",
        "EU",
        mockEnv,
      );
          });
  });

  describe("POST /api/comments/:commentId/links/:linkId/report", () => {
    const route = linkReportRoutes.find(
      (r) =>
        r.method === "POST" &&
        r.path instanceof RegExp &&
        r.path.source.includes("comments"),
    );

    it("should exist as a route", () => {
      expect(route).toBeDefined();
    });

    it("should require authentication - return 401", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/api/comments/comment-1/links/link-1/report",
        { method: "POST" },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/comments/comment-1/links/link-1/report",
        ),
        pathname: "/api/comments/comment-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });

    it("should return 201 on successful comment link report", async () => {
      const now = new Date();
      mockLinkCheckFindUnique.mockResolvedValue({
        id: "link-1",
        commentId: "comment-1",
        normalizedUrl: "https://example.org/page",
        originalUrl: "https://example.org/page",
      });
      mockLinkReportCreate.mockResolvedValue({
        id: "report-2",
        status: "pending",
        createdAt: now,
      });

      const request = new Request(
        "https://example.com/api/comments/comment-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Spam link" }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/comments/comment-1/links/link-1/report",
        ),
        pathname: "/api/comments/comment-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    it("should return 404 when comment link is not found", async () => {
      mockLinkCheckFindUnique.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/api/comments/comment-1/links/link-1/report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/comments/comment-1/links/link-1/report",
        ),
        pathname: "/api/comments/comment-1/links/link-1/report",
        params: {},
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Link not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    });
  });
});
