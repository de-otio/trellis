/**
 * Unit Tests: Comments Routes
 *
 * Tests for comment route handlers including creation, retrieval, hiding, and unhiding.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { commentsRoutes } from "../../../src/lib/routes/comments.js";
import type { Session } from "../../../src/lib/session-cookie.js";

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// Mock authMiddleware
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const TEST_TENANT_ID = "tenant-test-123";

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
const mockAddSecurityHeaders = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
    constructor(env: any) {}
  },
}));

// Mock CommentHandler
const mockCreateComment = vi.fn();
const mockGetComments = vi.fn();
const mockHideComment = vi.fn();
const mockUnhideComment = vi.fn();
vi.mock("../../../src/lib/comment-handler", () => ({
  CommentHandler: class {
    createComment = mockCreateComment;
    getComments = mockGetComments;
    hideComment = mockHideComment;
    unhideComment = mockUnhideComment;
  },
}));

// Mock Validator
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));

// Mock validateQueryParams
const mockValidateQueryParams = vi.fn();
vi.mock("../../../src/lib/validate-request", () => ({
  validateQueryParams: (...args: any[]) => mockValidateQueryParams(...args),
}));

// Mock paginationSchema
vi.mock("../../../src/lib/schemas", () => ({
  paginationSchema: {
    parse: vi.fn(),
  },
}));


describe("Comments Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockSession = {
      userId: "user-123",
      tenantId: "tenant-123",
      expiresAt: new Date(Date.now() + 3600000),
    } as Session;

    mockRequestContext = {
      tenantId: "tenant-123",
      userId: "user-123",
      region: "us-east-1",
    } as TrellisRequestContext;

    mockRequest = new Request(
      "https://example.com/api/posts/post-123/comments",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Test comment" }),
      },
    );

    mockGetSession.mockResolvedValue(mockSession);
    mockAuthMiddleware.mockResolvedValue({ activeTenantId: TEST_TENANT_ID, userId: "user-123" });
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
  });

  describe("POST /api/posts/:postId/comments - Create comment", () => {
    const route = commentsRoutes.find(
      (r) => r.method === "POST" && r.path.toString().includes("posts"),
    );

    it("should create a comment successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ id: "comment-123", content: "Test comment" }),
        { status: 201 },
      );
      mockCreateComment.mockResolvedValue(mockResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/comments",
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockCreateComment).toHaveBeenCalledWith(
        "post-123",
        mockRequest,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(201);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/comments",
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockCreateComment).not.toHaveBeenCalled();
    });

    it("should return 500 when request context is missing", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/comments",
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockCreateComment).not.toHaveBeenCalled();
    });

    it("should handle errors from CommentHandler", async () => {
      const error = new Error("Database error");
      mockCreateComment.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/comments",
        requestContext: mockRequestContext,
      });

            expect(mockSanitizeError).toHaveBeenCalledWith(error);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Database error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });

    it("should extract postId correctly from pathname", async () => {
      const mockResponse = new Response(JSON.stringify({}), { status: 201 });
      mockCreateComment.mockResolvedValue(mockResponse);

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/another-post-id/comments",
        requestContext: mockRequestContext,
      });

      expect(mockCreateComment).toHaveBeenCalledWith(
        "another-post-id",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("GET /api/posts/:postId/comments - Get comments", () => {
    const route = commentsRoutes.find(
      (r) => r.method === "GET" && r.path.toString().includes("posts"),
    );

    it("should get comments successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ comments: [], cursor: null }),
        { status: 200 },
      );
      mockGetComments.mockResolvedValue(mockResponse);
      mockValidateQueryParams.mockReturnValue({
        success: true,
        data: { limit: 20, cursor: null },
      });

      const url = new URL(
        "https://example.com/api/posts/post-123/comments?limit=20",
      );
      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/comments",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockValidateQueryParams).toHaveBeenCalled();
      expect(mockGetComments).toHaveBeenCalledWith(
        "post-123",
        mockRequest,
        mockSession,
        { limit: 20, cursor: null },
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const url = new URL("https://example.com/api/posts/post-123/comments");
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/comments",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockGetComments).not.toHaveBeenCalled();
    });

    it("should return 500 when request context is missing", async () => {
      const url = new URL("https://example.com/api/posts/post-123/comments");
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/comments",
        url,
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockGetComments).not.toHaveBeenCalled();
    });

    it("should handle query validation errors", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Invalid query parameters" }),
        { status: 400 },
      );
      mockValidateQueryParams.mockReturnValue({
        success: false,
        error: errorResponse,
      });

      const url = new URL(
        "https://example.com/api/posts/post-123/comments?limit=invalid",
      );
      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/comments",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(errorResponse);
      expect(mockGetComments).not.toHaveBeenCalled();
    });

    it("should handle errors from CommentHandler", async () => {
      const error = new Error("Database error");
      mockGetComments.mockRejectedValue(error);
      mockValidateQueryParams.mockReturnValue({
        success: true,
        data: { limit: 20, cursor: null },
      });

      const url = new URL("https://example.com/api/posts/post-123/comments");
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/comments",
        url,
        requestContext: mockRequestContext,
      });

            expect(mockSanitizeError).toHaveBeenCalledWith(error);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Database error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });

    it("should extract postId correctly from pathname", async () => {
      const mockResponse = new Response(JSON.stringify({}), { status: 200 });
      mockGetComments.mockResolvedValue(mockResponse);
      mockValidateQueryParams.mockReturnValue({
        success: true,
        data: { limit: 20, cursor: null },
      });

      const url = new URL(
        "https://example.com/api/posts/another-post-id/comments",
      );
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/another-post-id/comments",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetComments).toHaveBeenCalledWith(
        "another-post-id",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("PATCH /api/comments/:commentId/hide - Hide comment", () => {
    const route = commentsRoutes.find(
      (r) => r.method === "PATCH" && r.path.toString().includes("hide"),
    );

    it("should hide a comment successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ id: "comment-123", hidden: true }),
        { status: 200 },
      );
      mockHideComment.mockResolvedValue(mockResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123/hide",
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockHideComment).toHaveBeenCalledWith(
        "comment-123",
        mockRequest,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123/hide",
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHideComment).not.toHaveBeenCalled();
    });

    it("should return 500 when request context is missing", async () => {
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123/hide",
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockHideComment).not.toHaveBeenCalled();
    });

    it("should handle errors from CommentHandler", async () => {
      const error = new Error("Comment not found");
      mockHideComment.mockRejectedValue(error);

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123/hide",
        requestContext: mockRequestContext,
      });

            expect(mockSanitizeError).toHaveBeenCalledWith(error);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Comment not found" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });

    it("should extract commentId correctly from pathname", async () => {
      const mockResponse = new Response(JSON.stringify({}), { status: 200 });
      mockHideComment.mockResolvedValue(mockResponse);

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/another-comment-id/hide",
        requestContext: mockRequestContext,
      });

      expect(mockHideComment).toHaveBeenCalledWith(
        "another-comment-id",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("PATCH /api/comments/:commentId/unhide - Unhide comment", () => {
    const route = commentsRoutes.find(
      (r) => r.method === "PATCH" && r.path.toString().includes("unhide"),
    );

    it("should unhide a comment successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ id: "comment-123", hidden: false }),
        { status: 200 },
      );
      mockUnhideComment.mockResolvedValue(mockResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123/unhide",
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockUnhideComment).toHaveBeenCalledWith(
        "comment-123",
        mockRequest,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123/unhide",
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockUnhideComment).not.toHaveBeenCalled();
    });

    it("should return 500 when request context is missing", async () => {
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123/unhide",
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockUnhideComment).not.toHaveBeenCalled();
    });

    it("should handle errors from CommentHandler", async () => {
      const error = new Error("Comment not found");
      mockUnhideComment.mockRejectedValue(error);

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123/unhide",
        requestContext: mockRequestContext,
      });

            expect(mockSanitizeError).toHaveBeenCalledWith(error);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Comment not found" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });

    it("should extract commentId correctly from pathname", async () => {
      const mockResponse = new Response(JSON.stringify({}), { status: 200 });
      mockUnhideComment.mockResolvedValue(mockResponse);

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/another-comment-id/unhide",
        requestContext: mockRequestContext,
      });

      expect(mockUnhideComment).toHaveBeenCalledWith(
        "another-comment-id",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(commentsRoutes).toHaveLength(7);
      expect(commentsRoutes.some((r) => r.method === "POST")).toBe(true);
      expect(commentsRoutes.some((r) => r.method === "GET")).toBe(true);
      expect(commentsRoutes.some((r) => r.method === "PATCH")).toBe(true);
      expect(commentsRoutes.some((r) => r.method === "DELETE")).toBe(true);
    });

    it("should have middleware configured for POST routes", () => {
      const postRoute = commentsRoutes.find((r) => r.method === "POST");
      expect(postRoute?.middleware).toBeDefined();
      expect(postRoute?.middleware?.length).toBeGreaterThan(0);
    });

    it("should have middleware configured for PATCH routes", () => {
      const patchRoutes = commentsRoutes.filter((r) => r.method === "PATCH");
      patchRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
        expect(route.middleware?.length).toBeGreaterThan(0);
      });
    });

    it("should have descriptions for all routes", () => {
      commentsRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
