/**
 * Unit Tests: Comments Routes - Edit/Delete/Reply
 *
 * Tests for comment edit, delete, and reply route handlers.
 * Complements comments.test.ts which covers create, get, hide, and unhide.
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
const mockEditComment = vi.fn();
const mockDeleteComment = vi.fn();
const mockCreateReply = vi.fn();
vi.mock("../../../src/lib/comment-handler", () => ({
  CommentHandler: class {
    editComment = mockEditComment;
    deleteComment = mockDeleteComment;
    createReply = mockCreateReply;
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


describe("Comments Routes - Edit/Delete/Reply", () => {
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
      "https://example.com/api/comments/comment-123",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Updated comment" }),
      },
    );

    mockGetSession.mockResolvedValue(mockSession);
    mockAuthMiddleware.mockResolvedValue({ activeTenantId: TEST_TENANT_ID, userId: "user-123" });
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
  });

  describe("PATCH /api/comments/:commentId - Edit comment", () => {
    const route = commentsRoutes.find(
      (r) =>
        r.method === "PATCH" &&
        r.path.toString().includes("comments") &&
        !r.path.toString().includes("hide") &&
        !r.path.toString().includes("unhide"),
    );

    it("should have a matching route", () => {
      expect(route).toBeDefined();
    });

    it("should require authentication - return 401", async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123",
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockEditComment).not.toHaveBeenCalled();
    });

    it("should extract commentId from URL path", async () => {
      const mockResponse = new Response(
        JSON.stringify({ id: "comment-456", content: "Updated" }),
        { status: 200 },
      );
      mockEditComment.mockResolvedValue(mockResponse);

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-456",
        requestContext: mockRequestContext,
      });

      expect(mockEditComment).toHaveBeenCalledWith(
        "comment-456",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should call commentHandler.editComment with correct params", async () => {
      const mockResponse = new Response(
        JSON.stringify({ id: "comment-123", content: "Updated" }),
        { status: 200 },
      );
      mockEditComment.mockResolvedValue(mockResponse);

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123",
        requestContext: mockRequestContext,
      });

      expect(mockEditComment).toHaveBeenCalledWith(
        "comment-123",
        mockRequest,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );
    });

    it("should return handler response on success", async () => {
      const mockResponse = new Response(
        JSON.stringify({ id: "comment-123", content: "Updated comment" }),
        { status: 200 },
      );
      mockEditComment.mockResolvedValue(mockResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123",
        requestContext: mockRequestContext,
      });

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 500 on missing requestContext", async () => {
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123",
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockEditComment).not.toHaveBeenCalled();
    });

    it("should sanitize errors via validator", async () => {
      const error = new Error("Edit failed");
      mockEditComment.mockRejectedValue(error);

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/comments/comment-123",
        requestContext: mockRequestContext,
      });

            expect(mockSanitizeError).toHaveBeenCalledWith(error);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Edit failed" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("DELETE /api/comments/:commentId - Delete comment", () => {
    const route = commentsRoutes.find((r) => r.method === "DELETE");

    it("should have a matching route", () => {
      expect(route).toBeDefined();
    });

    it("should require authentication - return 401", async () => {
      mockGetSession.mockResolvedValue(null);

      const deleteRequest = new Request(
        "https://example.com/api/comments/comment-123",
        { method: "DELETE" },
      );

      const response = await route!.handler(deleteRequest, mockEnv, {
        pathname: "/api/comments/comment-123",
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockDeleteComment).not.toHaveBeenCalled();
    });

    it("should extract commentId from URL path", async () => {
      const mockResponse = new Response(JSON.stringify({ deleted: true }), {
        status: 200,
      });
      mockDeleteComment.mockResolvedValue(mockResponse);

      const deleteRequest = new Request(
        "https://example.com/api/comments/comment-789",
        { method: "DELETE" },
      );

      await route!.handler(deleteRequest, mockEnv, {
        pathname: "/api/comments/comment-789",
        requestContext: mockRequestContext,
      });

      expect(mockDeleteComment).toHaveBeenCalledWith(
        "comment-789",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should call commentHandler.deleteComment with correct params", async () => {
      const mockResponse = new Response(JSON.stringify({ deleted: true }), {
        status: 200,
      });
      mockDeleteComment.mockResolvedValue(mockResponse);

      const deleteRequest = new Request(
        "https://example.com/api/comments/comment-123",
        { method: "DELETE" },
      );

      await route!.handler(deleteRequest, mockEnv, {
        pathname: "/api/comments/comment-123",
        requestContext: mockRequestContext,
      });

      expect(mockDeleteComment).toHaveBeenCalledWith(
        "comment-123",
        deleteRequest,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );
    });

    it("should return handler response on success", async () => {
      const mockResponse = new Response(JSON.stringify({ deleted: true }), {
        status: 200,
      });
      mockDeleteComment.mockResolvedValue(mockResponse);

      const deleteRequest = new Request(
        "https://example.com/api/comments/comment-123",
        { method: "DELETE" },
      );

      const response = await route!.handler(deleteRequest, mockEnv, {
        pathname: "/api/comments/comment-123",
        requestContext: mockRequestContext,
      });

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 500 on missing requestContext", async () => {
      const deleteRequest = new Request(
        "https://example.com/api/comments/comment-123",
        { method: "DELETE" },
      );

      await route!.handler(deleteRequest, mockEnv, {
        pathname: "/api/comments/comment-123",
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockDeleteComment).not.toHaveBeenCalled();
    });

    it("should sanitize errors via validator", async () => {
      const error = new Error("Delete failed");
      mockDeleteComment.mockRejectedValue(error);

      const deleteRequest = new Request(
        "https://example.com/api/comments/comment-123",
        { method: "DELETE" },
      );

      await route!.handler(deleteRequest, mockEnv, {
        pathname: "/api/comments/comment-123",
        requestContext: mockRequestContext,
      });

            expect(mockSanitizeError).toHaveBeenCalledWith(error);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Delete failed" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("POST /api/comments/:commentId/replies - Create reply", () => {
    const route = commentsRoutes.find(
      (r) =>
        r.method === "POST" && r.path.toString().includes("replies"),
    );

    it("should have a matching route", () => {
      expect(route).toBeDefined();
    });

    it("should require authentication - return 401", async () => {
      mockGetSession.mockResolvedValue(null);

      const replyRequest = new Request(
        "https://example.com/api/comments/comment-123/replies",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "A reply" }),
        },
      );

      const response = await route!.handler(replyRequest, mockEnv, {
        pathname: "/api/comments/comment-123/replies",
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockCreateReply).not.toHaveBeenCalled();
    });

    it("should extract parentCommentId from URL path", async () => {
      const mockResponse = new Response(
        JSON.stringify({ id: "reply-1", content: "A reply" }),
        { status: 201 },
      );
      mockCreateReply.mockResolvedValue(mockResponse);

      const replyRequest = new Request(
        "https://example.com/api/comments/parent-comment-456/replies",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "A reply" }),
        },
      );

      await route!.handler(replyRequest, mockEnv, {
        pathname: "/api/comments/parent-comment-456/replies",
        requestContext: mockRequestContext,
      });

      expect(mockCreateReply).toHaveBeenCalledWith(
        "parent-comment-456",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should call commentHandler.createReply with correct params", async () => {
      const mockResponse = new Response(
        JSON.stringify({ id: "reply-1", content: "A reply" }),
        { status: 201 },
      );
      mockCreateReply.mockResolvedValue(mockResponse);

      const replyRequest = new Request(
        "https://example.com/api/comments/comment-123/replies",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "A reply" }),
        },
      );

      await route!.handler(replyRequest, mockEnv, {
        pathname: "/api/comments/comment-123/replies",
        requestContext: mockRequestContext,
      });

      expect(mockCreateReply).toHaveBeenCalledWith(
        "comment-123",
        replyRequest,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );
    });

    it("should return handler response on success", async () => {
      const mockResponse = new Response(
        JSON.stringify({ id: "reply-1", content: "A reply" }),
        { status: 201 },
      );
      mockCreateReply.mockResolvedValue(mockResponse);

      const replyRequest = new Request(
        "https://example.com/api/comments/comment-123/replies",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "A reply" }),
        },
      );

      const response = await route!.handler(replyRequest, mockEnv, {
        pathname: "/api/comments/comment-123/replies",
        requestContext: mockRequestContext,
      });

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(201);
    });

    it("should return 500 on missing requestContext", async () => {
      const replyRequest = new Request(
        "https://example.com/api/comments/comment-123/replies",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "A reply" }),
        },
      );

      await route!.handler(replyRequest, mockEnv, {
        pathname: "/api/comments/comment-123/replies",
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockCreateReply).not.toHaveBeenCalled();
    });

    it("should sanitize errors via validator", async () => {
      const error = new Error("Reply failed");
      mockCreateReply.mockRejectedValue(error);

      const replyRequest = new Request(
        "https://example.com/api/comments/comment-123/replies",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "A reply" }),
        },
      );

      await route!.handler(replyRequest, mockEnv, {
        pathname: "/api/comments/comment-123/replies",
        requestContext: mockRequestContext,
      });

            expect(mockSanitizeError).toHaveBeenCalledWith(error);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Reply failed" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });
});
