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
vi.mock("../../../src/lib/reaction-handler", () => ({
  ReactionHandler: class {
    addPostSentiment = mockAddPostSentiment;
    removePostSentiment = mockRemovePostSentiment;
    getPostSentiments = mockGetPostSentiments;
    addCommentSentiment = mockAddCommentSentiment;
    removeCommentSentiment = mockRemoveCommentSentiment;
    getCommentSentiments = mockGetCommentSentiments;
  },
}));

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
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should get post sentiments successfully without session", async () => {
      const mockResponse = new Response(
        JSON.stringify({ sentiments: [{ sentiment: "like", count: 10 }] }),
        { status: 200 },
      );
      mockGetPostSentiments.mockResolvedValue(mockResponse);
      mockGetSession.mockResolvedValue(null);

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
        null,
        mockEnv,
        mockRequestContext,
      );
      expect(response.status).toBe(200);
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
});
