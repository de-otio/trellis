/**
 * Unit Tests: Sentiments Routes
 *
 * Tests for sentiment route handlers including adding, removing, and getting sentiments for posts and comments.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { sentimentsRoutes } from "../../../src/lib/routes/sentiments.js";
import type { Session } from "../../../src/lib/session-cookie.js";

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
    constructor(env: any) {}
  },
}));

// Mock ReactionHandler
const mockAddPostSentiment = vi.fn();
const mockRemovePostSentiment = vi.fn();
const mockGetPostSentiments = vi.fn();
const mockAddCommentSentiment = vi.fn();
const mockRemoveCommentSentiment = vi.fn();
const mockGetCommentSentiments = vi.fn();
const mockGetPostSentimentUsers = vi.fn();
vi.mock("../../../src/lib/reaction-handler", () => ({
  ReactionHandler: class {
    addPostSentiment = mockAddPostSentiment;
    removePostSentiment = mockRemovePostSentiment;
    getPostSentiments = mockGetPostSentiments;
    getPostSentimentUsers = mockGetPostSentimentUsers;
    addCommentSentiment = mockAddCommentSentiment;
    removeCommentSentiment = mockRemoveCommentSentiment;
    getCommentSentiments = mockGetCommentSentiments;
  },
}));

// Mock authMiddleware — the GET routes now need the caller's ACTIVE TENANT
// (H3), which the session cookie alone does not carry.
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const TENANT = "tenant-123";

// Mock Validator
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));

// Mock validateRequest
const mockValidateRequest = vi.fn();
vi.mock("../../../src/lib/validate-request", () => ({
  validateRequest: (...args: any[]) => mockValidateRequest(...args),
}));

// Mock sentimentSchema
vi.mock("../../../src/lib/schemas", () => ({
  sentimentSchema: {
    parse: vi.fn(),
  },
  getSentimentUsersSchema: {
    safeParse: (value: any) => ({ success: true, data: value }),
  },
}));


describe("Sentiments Routes", () => {
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
      "https://example.com/api/posts/post-123/sentiment",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sentiment: "like" }),
      },
    );

    mockGetSession.mockResolvedValue(mockSession);
    mockAuthMiddleware.mockResolvedValue({ activeTenantId: TENANT });
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
  });

  describe("POST /api/posts/:postId/sentiment - Add post sentiment", () => {
    const route = sentimentsRoutes.find(
      (r) =>
        r.method === "POST" &&
        r.path.toString().includes("posts") &&
        r.path.toString().includes("sentiment"),
    );

    it("should add post sentiment successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ success: true, sentiment: "like" }),
        { status: 200 },
      );
      mockAddPostSentiment.mockResolvedValue(mockResponse);
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { sentiment: "like" },
      });

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiment",
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockValidateRequest).toHaveBeenCalled();
      expect(mockAddPostSentiment).toHaveBeenCalledWith(
        "post-123",
        "like",
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiment",
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockAddPostSentiment).not.toHaveBeenCalled();
    });

    it("should return 500 when request context is missing", async () => {
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiment",
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockAddPostSentiment).not.toHaveBeenCalled();
    });

    it("should handle validation errors", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Invalid sentiment" }),
        { status: 400 },
      );
      mockValidateRequest.mockResolvedValue({
        success: false,
        error: errorResponse,
      });

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiment",
        requestContext: mockRequestContext,
      });

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(errorResponse);
      expect(mockAddPostSentiment).not.toHaveBeenCalled();
    });

    it("should handle errors from ReactionHandler", async () => {
      const error = new Error("Database error");
      mockAddPostSentiment.mockRejectedValue(error);
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { sentiment: "like" },
      });

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiment",
        requestContext: mockRequestContext,
      });

            expect(mockSanitizeError).toHaveBeenCalledWith(error);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Database error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("DELETE /api/posts/:postId/sentiment - Remove post sentiment", () => {
    const route = sentimentsRoutes.find(
      (r) =>
        r.method === "DELETE" &&
        r.path.toString().includes("posts") &&
        r.path.toString().includes("sentiment"),
    );

    it("should remove post sentiment successfully", async () => {
      const mockResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
      mockRemovePostSentiment.mockResolvedValue(mockResponse);

      const deleteRequest = new Request(
        "https://example.com/api/posts/post-123/sentiment",
        {
          method: "DELETE",
        },
      );

      const response = await route!.handler(deleteRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiment",
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(deleteRequest, "test-secret", mockEnv);
      expect(mockRemovePostSentiment).toHaveBeenCalledWith(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const deleteRequest = new Request(
        "https://example.com/api/posts/post-123/sentiment",
        {
          method: "DELETE",
        },
      );

      await route!.handler(deleteRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiment",
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockRemovePostSentiment).not.toHaveBeenCalled();
    });

    it("should handle errors from ReactionHandler", async () => {
      const error = new Error("Sentiment not found");
      mockRemovePostSentiment.mockRejectedValue(error);

      const deleteRequest = new Request(
        "https://example.com/api/posts/post-123/sentiment",
        {
          method: "DELETE",
        },
      );

      await route!.handler(deleteRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiment",
        requestContext: mockRequestContext,
      });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Sentiment not found" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("GET /api/posts/:postId/sentiments - Get post sentiments", () => {
    const route = sentimentsRoutes.find(
      (r) =>
        r.method === "GET" &&
        r.path.toString().includes("posts") &&
        r.path.toString().includes("sentiments"),
    );

    it("should get post sentiments successfully with session", async () => {
      const mockResponse = new Response(
        JSON.stringify({ sentiments: [{ sentiment: "like", count: 10 }] }),
        { status: 200 },
      );
      mockGetPostSentiments.mockResolvedValue(mockResponse);

      const getRequest = new Request(
        "https://example.com/api/posts/post-123/sentiments",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(getRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiments",
        requestContext: mockRequestContext,
      });

      expect(mockGetPostSentiments).toHaveBeenCalledWith(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
        TENANT,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    // H3: this route used to pass `session || null` straight through, so it
    // served a post's reaction activity to callers with no session at all —
    // while the post itself requires one. It now refuses.
    it("REFUSES an unauthenticated caller (401), and never reaches the handler", async () => {
      mockGetSession.mockResolvedValue(null);

      const getRequest = new Request(
        "https://example.com/api/posts/post-123/sentiments",
        { method: "GET" },
      );

      const response = await route!.handler(getRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiments",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(401);
      expect(mockGetPostSentiments).not.toHaveBeenCalled();
    });

    it("REFUSES a caller with a session but no active tenant (401)", async () => {
      // No tenant means no tenant predicate, and TENANT_SCOPE_MODE defaults to
      // `off` with no RLS backstop — so there would be nothing left to isolate
      // one tenant's posts from another's.
      mockAuthMiddleware.mockResolvedValue({ activeTenantId: undefined });

      const getRequest = new Request(
        "https://example.com/api/posts/post-123/sentiments",
        { method: "GET" },
      );

      const response = await route!.handler(getRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiments",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(401);
      expect(mockGetPostSentiments).not.toHaveBeenCalled();
    });

    it("should return 500 when request context is missing", async () => {
      const getRequest = new Request(
        "https://example.com/api/posts/post-123/sentiments",
        {
          method: "GET",
        },
      );

      await route!.handler(getRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiments",
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockGetPostSentiments).not.toHaveBeenCalled();
    });

    it("should handle errors from ReactionHandler", async () => {
      const error = new Error("Database error");
      mockGetPostSentiments.mockRejectedValue(error);

      const getRequest = new Request(
        "https://example.com/api/posts/post-123/sentiments",
        {
          method: "GET",
        },
      );

      await route!.handler(getRequest, mockEnv, {
        pathname: "/api/posts/post-123/sentiments",
        requestContext: mockRequestContext,
      });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Database error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("POST /api/comments/:commentId/sentiment - Add comment sentiment", () => {
    const route = sentimentsRoutes.find(
      (r) =>
        r.method === "POST" &&
        r.path.toString().includes("comments") &&
        r.path.toString().includes("sentiment"),
    );

    it("should add comment sentiment successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ success: true, sentiment: "like" }),
        { status: 200 },
      );
      mockAddCommentSentiment.mockResolvedValue(mockResponse);
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { sentiment: "like" },
      });

      const postRequest = new Request(
        "https://example.com/api/comments/comment-123/sentiment",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sentiment: "like" }),
        },
      );

      const response = await route!.handler(postRequest, mockEnv, {
        pathname: "/api/comments/comment-123/sentiment",
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(postRequest, "test-secret", mockEnv);
      expect(mockValidateRequest).toHaveBeenCalled();
      expect(mockAddCommentSentiment).toHaveBeenCalledWith(
        "comment-123",
        "like",
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const postRequest = new Request(
        "https://example.com/api/comments/comment-123/sentiment",
        {
          method: "POST",
        },
      );

      await route!.handler(postRequest, mockEnv, {
        pathname: "/api/comments/comment-123/sentiment",
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCommentSentiment).not.toHaveBeenCalled();
    });

    it("should handle validation errors", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Invalid sentiment" }),
        { status: 400 },
      );
      mockValidateRequest.mockResolvedValue({
        success: false,
        error: errorResponse,
      });

      const postRequest = new Request(
        "https://example.com/api/comments/comment-123/sentiment",
        {
          method: "POST",
        },
      );

      const response = await route!.handler(postRequest, mockEnv, {
        pathname: "/api/comments/comment-123/sentiment",
        requestContext: mockRequestContext,
      });

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(errorResponse);
      expect(mockAddCommentSentiment).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/comments/:commentId/sentiment - Remove comment sentiment", () => {
    const route = sentimentsRoutes.find(
      (r) =>
        r.method === "DELETE" &&
        r.path.toString().includes("comments") &&
        r.path.toString().includes("sentiment"),
    );

    it("should remove comment sentiment successfully", async () => {
      const mockResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
      mockRemoveCommentSentiment.mockResolvedValue(mockResponse);

      const deleteRequest = new Request(
        "https://example.com/api/comments/comment-123/sentiment",
        {
          method: "DELETE",
        },
      );

      const response = await route!.handler(deleteRequest, mockEnv, {
        pathname: "/api/comments/comment-123/sentiment",
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(deleteRequest, "test-secret", mockEnv);
      expect(mockRemoveCommentSentiment).toHaveBeenCalledWith(
        "comment-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const deleteRequest = new Request(
        "https://example.com/api/comments/comment-123/sentiment",
        {
          method: "DELETE",
        },
      );

      await route!.handler(deleteRequest, mockEnv, {
        pathname: "/api/comments/comment-123/sentiment",
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockRemoveCommentSentiment).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/comments/:commentId/sentiments - Get comment sentiments", () => {
    const route = sentimentsRoutes.find(
      (r) =>
        r.method === "GET" &&
        r.path.toString().includes("comments") &&
        r.path.toString().includes("sentiments"),
    );

    it("should get comment sentiments successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ sentiments: [{ sentiment: "like", count: 5 }] }),
        { status: 200 },
      );
      mockGetCommentSentiments.mockResolvedValue(mockResponse);

      const getRequest = new Request(
        "https://example.com/api/comments/comment-123/sentiments",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(getRequest, mockEnv, {
        pathname: "/api/comments/comment-123/sentiments",
        requestContext: mockRequestContext,
      });

      expect(mockGetCommentSentiments).toHaveBeenCalledWith(
        "comment-123",
        mockEnv,
        mockRequestContext,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 500 when request context is missing", async () => {
      const getRequest = new Request(
        "https://example.com/api/comments/comment-123/sentiments",
        {
          method: "GET",
        },
      );

      await route!.handler(getRequest, mockEnv, {
        pathname: "/api/comments/comment-123/sentiments",
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockGetCommentSentiments).not.toHaveBeenCalled();
    });

    it("should handle errors from ReactionHandler", async () => {
      const error = new Error("Database error");
      mockGetCommentSentiments.mockRejectedValue(error);

      const getRequest = new Request(
        "https://example.com/api/comments/comment-123/sentiments",
        {
          method: "GET",
        },
      );

      await route!.handler(getRequest, mockEnv, {
        pathname: "/api/comments/comment-123/sentiments",
        requestContext: mockRequestContext,
      });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Database error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(sentimentsRoutes).toHaveLength(7);
      expect(sentimentsRoutes.filter((r) => r.method === "POST")).toHaveLength(
        2,
      );
      expect(
        sentimentsRoutes.filter((r) => r.method === "DELETE"),
      ).toHaveLength(2);
      expect(sentimentsRoutes.filter((r) => r.method === "GET")).toHaveLength(
        3,
      );
    });

    it("should have middleware configured for all routes", () => {
      sentimentsRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      sentimentsRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });

  // =========================================================================
  // GET /api/v1/posts/:postId/sentiments/users — the who-reacted list (H3)
  // =========================================================================
  describe("GET /api/v1/posts/:postId/sentiments/users", () => {
    const route = sentimentsRoutes.find(
      (r) =>
        r.method === "GET" && r.path.toString().includes("sentiments\\/users"),
    );
    const pathname = "/api/v1/posts/post-123/sentiments/users";
    const usersRequest = () =>
      new Request(`https://example.com${pathname}?sentiment=joy&limit=20`);

    const call = () =>
      route!.handler(usersRequest(), mockEnv, {
        pathname,
        requestContext: mockRequestContext,
      });

    // This endpoint discloses IDENTITIES. It previously required no session at
    // all, so the reader list of a private post was available anonymously.
    it("REFUSES an unauthenticated caller (401), and never reaches the handler", async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await call();

      expect(response.status).toBe(401);
      expect(mockGetPostSentimentUsers).not.toHaveBeenCalled();
    });

    it("REFUSES a caller with a session but no active tenant (401)", async () => {
      mockAuthMiddleware.mockResolvedValue({ activeTenantId: undefined });

      const response = await call();

      expect(response.status).toBe(401);
      expect(mockGetPostSentimentUsers).not.toHaveBeenCalled();
    });

    it("passes the caller's active tenant through to the handler", async () => {
      mockGetPostSentimentUsers.mockResolvedValue(
        new Response(JSON.stringify({ users: [] }), { status: 200 }),
      );

      await call();

      const args = mockGetPostSentimentUsers.mock.calls[0];
      expect(args[0]).toBe("post-123");
      expect(args[4]).toBe(mockSession);
      expect(args[7]).toBe(TENANT);
    });

    // The TEEN branch rewrites the handler's body. Applied unconditionally it
    // parses a 404 refusal as if it were a user list and re-emits it as a 200 —
    // laundering the deny into a success for exactly the accounts the platform
    // is most careful with.
    it("does not launder a refusal into a 200 for a TEEN session", async () => {
      mockGetSession.mockResolvedValue({ ...mockSession, ageTier: "TEEN" });
      const deny = new Response(
        JSON.stringify({ title: "Post Not Found", status: 404 }),
        { status: 404, headers: { "content-type": "application/problem+json" } },
      );
      mockGetPostSentimentUsers.mockResolvedValue(deny);

      const response = await call();

      expect(response.status).toBe(404);
    });

    it("still strips identities for a TEEN on a permitted read", async () => {
      mockGetSession.mockResolvedValue({ ...mockSession, ageTier: "TEEN" });
      mockGetPostSentimentUsers.mockResolvedValue(
        new Response(
          JSON.stringify({
            users: [{ userId: "user-456", handle: "someone", sentiment: "joy" }],
          }),
          { status: 200 },
        ),
      );

      const response = await call();

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain("user-456");
      expect(JSON.parse(body).sentimentTypes).toEqual(["joy"]);
    });
  });
});
