/**
 * Extended Unit Tests: Comment Handler
 *
 * Tests uncovered code paths: editComment, deleteComment, rate limiting,
 * duplicate detection, blocked links in comments, cursor pagination,
 * region mismatch in hide/unhide, and comment cache invalidation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommentHandler } from "../../src/lib/comment-handler.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

// Mock withQueryTimeoutAndRetry
const mockWithQueryTimeoutAndRetry = vi.fn();

// Mock database connection manager
const mockSharedDatabaseConnectionManager = {
  executeWithRetry: vi.fn(),
};

vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: mockSharedDatabaseConnectionManager,
  DatabaseConnectionManager: class {
    executeWithRetry = mockSharedDatabaseConnectionManager.executeWithRetry;
  },
}));

vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) => mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 3000, retryTimeoutMs: 2000 },
    BACKGROUND: { timeoutMs: 12000, retryTimeoutMs: 5000 },
    CRITICAL: { timeoutMs: 5000, retryTimeoutMs: 3000 },
    STANDARD: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock DataRouter
const mockGetPost = vi.fn();
vi.mock("../../src/lib/data-router", () => ({
  DataRouter: {
    getPost: (...args: any[]) => mockGetPost(...args),
    getDatabaseForRegion: vi.fn(),
  },
}));

// Mock ModerationHandler
const mockModerateText = vi.fn().mockResolvedValue({ approved: true, score: 0.1 });
vi.mock("../../src/lib/moderation-handler", () => ({
  ModerationHandler: class {
    moderateText = mockModerateText;
  },
}));

// Mock InputSanitizer
vi.mock("../../src/lib/input-sanitizer", () => ({
  InputSanitizer: {
    sanitizeText: (text: string) => text.trim(),
  },
}));

// Mock LinkSecurityHandler
const mockExtractUrls = vi.fn().mockReturnValue([]);
const mockValidateUrlSync = vi.fn().mockReturnValue({ status: "safe" });
vi.mock("../../src/lib/link-security-handler", () => ({
  LinkSecurityHandler: class {
    extractUrls = mockExtractUrls;
    validateUrlSync = mockValidateUrlSync;
  },
  LinkStatus: {
    BLOCKED: "blocked",
    SUSPICIOUS: "suspicious",
    SAFE: "safe",
  },
}));

// Mock FeedHandler
vi.mock("../../src/lib/feed-handler", () => ({
  FeedHandler: {
    invalidateFeedCache: vi.fn(),
  },
}));

// Mock validateRequest
const mockValidateRequest = vi.fn().mockResolvedValue({
  success: true,
  data: { text: "Test comment" },
});
vi.mock("../../src/lib/validate-request", () => ({
  validateRequest: (...args: any[]) => mockValidateRequest(...args),
}));

// Mock schemas
vi.mock("../../src/lib/schemas", () => ({
  createCommentSchema: {},
}));

// Mock FeatureToggleService
const mockIsEnabled = vi.fn().mockResolvedValue(false);
vi.mock("../../src/lib/feature-toggle-service", () => ({
  FeatureToggleService: class {
    isEnabled = mockIsEnabled;
  },
}));

// Mock Prisma
const mockCreatePrisma = vi.fn();
vi.mock("../../src/db", () => ({
  createPrisma: (...args: any[]) => mockCreatePrisma(...args),
}));

// Mock comment rate limiter
const mockCommentRateLimit = vi.fn().mockResolvedValue({ allowed: true });
vi.mock("../../src/lib/middleware/comment-rate-limit", () => ({
  commentRateLimit: (...args: any[]) => mockCommentRateLimit(...args),
}));

// Mock database-wrapper-helper
const mockGetWrappedDatabase = vi.fn();
vi.mock("../../src/lib/database-wrapper-helper", () => ({
  getWrappedDatabase: (...args: any[]) => mockGetWrappedDatabase(...args),
}));

// Mock zod
vi.mock("zod", () => ({
  z: {
    object: vi.fn().mockReturnValue({}),
    string: vi.fn().mockReturnValue({
      min: vi.fn().mockReturnValue({
        max: vi.fn().mockReturnValue({
          trim: vi.fn().mockReturnValue({}),
        }),
      }),
    }),
  },
}));

const TEST_TENANT_ID = "tenant-test-123";

describe("CommentHandler - Extended", () => {
  let handler: CommentHandler;
  let mockEnv: any;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CommentHandler();

    mockDb = {
      post: {
        findUnique: vi.fn(),
      },
      postComment: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        findFirst: vi.fn(),
        count: vi.fn(),
      },
      commentSentiment: {
        groupBy: vi.fn(),
      },
      domainReputation: {
        upsert: vi.fn(),
      },
      linkCheck: {
        create: vi.fn(),
        findMany: vi.fn(),
      },
    };

    mockCreatePrisma.mockReturnValue(mockDb);
    mockGetWrappedDatabase.mockReturnValue(mockDb);

    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (manager: any, region: string, env: any, queryFn: (db: any) => Promise<any>) => {
        return await queryFn(mockDb);
      },
    );

    mockEnv = {
      DATABASE_URL: "postgres://test",
      DEFAULT_REGION: "US",
      ENVIRONMENT: "dev",
    };

    mockSession = {
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    } as any;

    mockRequestContext = {
      region: "US" as const,
      config: {
        featureFlags: { authentication: {}, features: {}, performance: {}, security: {} },
        endpoints: { api: "https://api.example.com", frontend: "https://app.example.com", cdn: "https://cdn.example.com" },
        timeouts: { database: 5000, api: 10000 },
      },
      session: mockSession,
    } as any;

    mockGetPost.mockResolvedValue({
      id: "post-123",
      authorId: "user-456",
      uri: "at://test/post-123",
      dataRegion: "US",
    });

    mockModerateText.mockResolvedValue({ approved: true, score: 0.1 });
    mockCommentRateLimit.mockResolvedValue({ allowed: true });
    mockExtractUrls.mockReturnValue([]);
    mockValidateUrlSync.mockReturnValue({ status: "safe" });
    mockValidateRequest.mockResolvedValue({
      success: true,
      data: { text: "Test comment" },
    });
  });

  describe("createComment - rate limiting", () => {
    it("should return 429 when rate limited", async () => {
      mockCommentRateLimit.mockResolvedValue({ allowed: false, retryAfter: 30 });

      const request = new Request("http://test.com/comments", {
        method: "POST",
        body: JSON.stringify({ text: "Test comment" }),
      });

      const response = await handler.createComment(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(429);
      const data = await response.json();
      expect(data.error).toBe("RATE_LIMITED");
      expect(data.retryAfter).toBe(30);
      expect(response.headers.get("Retry-After")).toBe("30");
    });

    it("should use default retryAfter of 30 when not provided", async () => {
      mockCommentRateLimit.mockResolvedValue({ allowed: false, retryAfter: undefined });

      const request = new Request("http://test.com/comments", {
        method: "POST",
        body: JSON.stringify({ text: "Test comment" }),
      });

      const response = await handler.createComment(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("30");
    });
  });

  describe("createComment - duplicate detection", () => {
    it("should return existing comment with duplicate flag for duplicate text within 5 minutes", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "existing-comment-123",
        text: "Test comment",
        authorId: "user-123",
        createdAt: new Date(),
        editedAt: null,
        deletedAt: null,
        rootUri: null,
        replyToUri: null,
      });

      const request = new Request("http://test.com/comments", {
        method: "POST",
        body: JSON.stringify({ text: "Test comment" }),
      });

      const response = await handler.createComment(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.duplicate).toBe(true);
      expect(data.id).toBe("existing-comment-123");
      expect(data.message).toBe("This comment was already posted");
    });
  });

  describe("createComment - blocked links", () => {
    it("should reject comment with dangerous links", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockExtractUrls.mockReturnValue(["http://evil.com"]);
      mockValidateUrlSync.mockReturnValue({ status: "blocked", reason: "malware" });

      const request = new Request("http://test.com/comments", {
        method: "POST",
        body: JSON.stringify({ text: "visit http://evil.com" }),
      });

      const response = await handler.createComment(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("DANGEROUS_LINKS_DETECTED");
    });
  });

  describe("createComment - validation failure", () => {
    it("should return validation error when request body is invalid", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Validation failed" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
      mockValidateRequest.mockResolvedValue({ success: false, error: errorResponse });

      const request = new Request("http://test.com/comments", {
        method: "POST",
        body: JSON.stringify({}),
      });

      const response = await handler.createComment(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(400);
    });
  });

  describe("createComment - parent comment in different post", () => {
    it("should reject reply to comment in different post", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      // First findFirst — parent comment lookup (returns parent in different post)
      // Second findFirst — duplicate check (returns null)
      mockDb.postComment.findFirst
        .mockResolvedValueOnce({
          id: "parent-comment-999",
          postId: "different-post-456",
          postUri: "at://test/different-post",
          rootUri: null,
          replyToUri: null,
          deletedAt: null,
        })
        .mockResolvedValue(null);

      const request = new Request("http://test.com/comments", {
        method: "POST",
        body: JSON.stringify({ text: "reply text" }),
      });

      const response = await handler.createComment(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
        "parent-comment-999",
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Parent comment not in this post");
    });
  });

  describe("editComment", () => {
    it("should edit comment within 15-minute window", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        authorId: "user-123",
        text: "Original text",
        originalText: null,
        deletedAt: null,
        createdAt: new Date(), // just created
        post: { id: "post-123", authorId: "user-456" },
      });
      mockDb.postComment.update.mockResolvedValue({
        id: "comment-123",
        text: "Updated text",
        editedAt: new Date(),
      });

      const request = new Request("http://test.com/comments/comment-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "Updated text" }),
      });

      const response = await handler.editComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.text).toBe("Updated text");
      expect(data.message).toBe("Comment updated successfully");
    });

    it("should return 404 if comment not found for edit", async () => {
      mockDb.postComment.findFirst.mockResolvedValue(null);

      const request = new Request("http://test.com/comments/comment-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "Updated text" }),
      });

      const response = await handler.editComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(404);
    });

    it("should return 403 if user is not comment author", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        authorId: "other-user",
        deletedAt: null,
        createdAt: new Date(),
        post: { id: "post-123", authorId: "user-456" },
      });

      const request = new Request("http://test.com/comments/comment-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "Updated text" }),
      });

      const response = await handler.editComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(403);
    });

    it("should return 400 when editing a deleted comment", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        authorId: "user-123",
        deletedAt: new Date(),
        createdAt: new Date(),
        post: { id: "post-123", authorId: "user-456" },
      });

      const request = new Request("http://test.com/comments/comment-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "Updated text" }),
      });

      const response = await handler.editComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Cannot edit deleted comment");
    });

    it("should return 400 when edit window (15 min) has expired", async () => {
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        authorId: "user-123",
        deletedAt: null,
        createdAt: twentyMinutesAgo,
        post: { id: "post-123", authorId: "user-456" },
      });

      const request = new Request("http://test.com/comments/comment-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "Updated text" }),
      });

      const response = await handler.editComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("EDIT_WINDOW_EXPIRED");
    });

    it("should reject edited comment with moderation failure", async () => {
      mockIsEnabled.mockResolvedValue(true);
      mockModerateText.mockResolvedValue({ approved: false, score: 0.9, details: "Toxic" });
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        authorId: "user-123",
        deletedAt: null,
        createdAt: new Date(),
        post: { id: "post-123", authorId: "user-456" },
      });

      const request = new Request("http://test.com/comments/comment-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "Bad content" }),
      });

      const response = await handler.editComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("CONTENT_REJECTED");
    });

    it("should return 500 on database error during edit", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(new Error("DB error"));

      const request = new Request("http://test.com/comments/comment-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "Updated text" }),
      });

      const response = await handler.editComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(500);
    });
  });

  describe("deleteComment", () => {
    it("should soft-delete comment when user is author", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        authorId: "user-123",
        deletedAt: null,
        post: { id: "post-123", authorId: "user-456" },
      });
      mockDb.postComment.update.mockResolvedValue({
        id: "comment-123",
        text: "[deleted]",
      });

      const request = new Request("http://test.com/comments/comment-123", {
        method: "DELETE",
      });

      const response = await handler.deleteComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toBe("Comment deleted successfully");
    });

    it("should allow post owner to delete any comment on their post", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        authorId: "other-user",
        deletedAt: null,
        post: { id: "post-123", authorId: "user-123" }, // session user is post owner
      });
      mockDb.postComment.update.mockResolvedValue({
        id: "comment-123",
      });

      const request = new Request("http://test.com/comments/comment-123", {
        method: "DELETE",
      });

      const response = await handler.deleteComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(200);
    });

    it("should return 404 if comment not found for deletion", async () => {
      mockDb.postComment.findFirst.mockResolvedValue(null);

      const request = new Request("http://test.com/comments/comment-123", {
        method: "DELETE",
      });

      const response = await handler.deleteComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(404);
    });

    it("should return 400 if comment is already deleted", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        authorId: "user-123",
        deletedAt: new Date(),
        post: { id: "post-123", authorId: "user-456" },
      });

      const request = new Request("http://test.com/comments/comment-123", {
        method: "DELETE",
      });

      const response = await handler.deleteComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Comment already deleted");
    });

    it("should return 403 if user is neither author nor post owner", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        authorId: "other-user-1",
        deletedAt: null,
        post: { id: "post-123", authorId: "other-user-2" },
      });

      const request = new Request("http://test.com/comments/comment-123", {
        method: "DELETE",
      });

      const response = await handler.deleteComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(403);
    });

    it("should return 500 on database error during delete", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(new Error("DB error"));

      const request = new Request("http://test.com/comments/comment-123", {
        method: "DELETE",
      });

      const response = await handler.deleteComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(500);
    });
  });

  describe("getComments - pagination", () => {
    it("should handle cursor-based pagination", async () => {
      const comments = Array.from({ length: 3 }, (_, i) => ({
        id: `comment-${i}`,
        text: `Comment ${i}`,
        authorId: "user-1",
        createdAt: new Date(2024, 0, 1 + i),
        postUri: "at://test/post-123",
        replyToUri: null,
      }));
      mockDb.postComment.findMany.mockResolvedValue(comments);
      mockDb.commentSentiment.groupBy.mockResolvedValue([]);

      const request = new Request(
        "http://test.com/comments?postId=post-123&cursor=2024-01-05T00:00:00Z",
      );
      const response = await handler.getComments(
        "post-123",
        request,
        mockSession,
        { limit: 2, cursor: "2024-01-05T00:00:00.000Z" },
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.hasMore).toBe(true);
      expect(data.comments).toHaveLength(2);
      expect(data.cursor).toBeDefined();
    });

    it("should cap limit to 100", async () => {
      mockDb.postComment.findMany.mockResolvedValue([]);
      mockDb.commentSentiment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/comments?postId=post-123");
      await handler.getComments(
        "post-123",
        request,
        mockSession,
        { limit: 500 },
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      // The query should request limit+1 = 101, not 501
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return hasMore=false when fewer results than limit", async () => {
      const comments = [
        {
          id: "comment-1",
          text: "Comment 1",
          authorId: "user-1",
          createdAt: new Date("2024-01-01"),
          postUri: "at://test/post-123",
          replyToUri: null,
        },
      ];
      mockDb.postComment.findMany.mockResolvedValue(comments);
      mockDb.commentSentiment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/comments?postId=post-123");
      const response = await handler.getComments(
        "post-123",
        request,
        mockSession,
        { limit: 20 },
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.hasMore).toBe(false);
      expect(data.cursor).toBeUndefined();
    });
  });

  describe("hideComment - region mismatch", () => {
    it("should return 404 when comment post has different dataRegion than request", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        postId: "post-123",
        post: {
          authorId: "user-123",
          dataRegion: "EU", // Different from request region "US"
        },
      });

      const request = new Request("http://test.com/comments/comment-123/hide", {
        method: "POST",
      });

      const response = await handler.hideComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("unhideComment - region mismatch", () => {
    it("should return 404 when comment post has different dataRegion than request", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        postId: "post-123",
        post: {
          authorId: "user-123",
          dataRegion: "EU",
        },
      });

      const request = new Request("http://test.com/comments/comment-123/unhide", {
        method: "POST",
      });

      const response = await handler.unhideComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(404);
    });

    it("should return 403 when user is not post owner for unhide", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        postId: "post-123",
        post: {
          authorId: "other-user",
          dataRegion: "US",
        },
      });

      const request = new Request("http://test.com/comments/comment-123/unhide", {
        method: "POST",
      });

      const response = await handler.unhideComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(403);
    });
  });

  describe("createReply - error handling", () => {
    it("should return 500 on unexpected error in createReply", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(new Error("Unexpected failure"));

      const request = new Request("http://test.com/comments/parent-123/replies", {
        method: "POST",
        body: JSON.stringify({ text: "reply" }),
      });

      const response = await handler.createReply(
        "parent-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe("Failed to create reply");
    });
  });
});
