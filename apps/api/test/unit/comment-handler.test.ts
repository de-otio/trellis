/**
 * Unit Tests: Comment Handler
 *
 * Tests for comment creation, retrieval, hiding, and timeout/retry logic.
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
  DatabaseConnectionManager: class DatabaseConnectionManager {
    executeWithRetry = mockSharedDatabaseConnectionManager.executeWithRetry;
  },
}));

vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
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

// Mock the text-moderation seam (fail-closed provider injection point).
// The mock returns canonical ModerationVerdicts; the real gate logic
// (text-moderation-gate.ts) still runs on top of it.
const mockModerateText = vi
  .fn()
  .mockResolvedValue({ decision: "approved", labels: [], provider: "mock-text" });
vi.mock("../../src/lib/media/request-text-moderation", () => ({
  getTextModerationProvider: () => ({ moderateText: mockModerateText }),
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
vi.mock("../../src/lib/validate-request", () => ({
  validateRequest: vi.fn().mockResolvedValue({
    success: true,
    data: { text: "Test comment" },
  }),
}));

// Mock FeatureToggleService
const mockIsEnabled = vi.fn().mockResolvedValue(false);
vi.mock("../../src/lib/feature-toggle-service", () => ({
  FeatureToggleService: class {
    isEnabled = mockIsEnabled;
    // Moderation gate now reads through the fail-closed variant; route it to the
    // same control fn so these tests keep steering moderation via mockIsEnabled.
    isEnabledFailClosed = mockIsEnabled;
  },
}));

// Mock Prisma
const mockCreatePrisma = vi.fn();
vi.mock("../../src/db", () => ({
  createPrisma: (...args: any[]) => mockCreatePrisma(...args),
}));

// Mock the shared read authorizer (H3), default ALLOW. Whether its predicate is
// CORRECT is decided against real Postgres in
// test/integration/post-attachment-read-authz.integration.test.ts — the Prisma
// mock below resolves canned comments regardless of the `where`, so nothing
// here can tell a right predicate from a missing one.
const mockCanReadPost = vi.fn();
vi.mock("../../src/lib/post-read-authorizer", () => ({
  canReadPost: (...args: any[]) => mockCanReadPost(...args),
}));

const TEST_TENANT_ID = "tenant-test-123";

describe("CommentHandler", () => {
  let handler: CommentHandler;
  let mockEnv: any;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CommentHandler();
    mockCanReadPost.mockResolvedValue(true);

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

    // Make createPrisma return mockDb
    mockCreatePrisma.mockReturnValue(mockDb);

    // Default mock: withQueryTimeoutAndRetry executes the query function with mockDb
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (
        manager: any,
        region: string,
        env: any,
        queryFn: (db: any) => Promise<any>,
        options?: any,
      ) => {
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
    };

    mockRequestContext = {
      region: "US" as const,
      config: {
        featureFlags: {
          authentication: {},
          features: {},
          performance: {},
          security: {},
        },
        endpoints: {
          api: "https://api.example.com",
          frontend: "https://app.example.com",
          cdn: "https://cdn.example.com",
        },
        timeouts: {
          database: 5000,
          api: 10000,
        },
      },
      session: mockSession,
    };

    mockGetPost.mockResolvedValue({
      id: "post-123",
      authorId: "user-456",
      uri: "at://test/post-123",
      dataRegion: "US",
    });

    mockModerateText.mockResolvedValue({ decision: "approved", labels: [], provider: "mock-text" });
  });

  describe("createComment", () => {
    it("should create a comment successfully", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockDb.postComment.create.mockResolvedValue({
        id: "comment-123",
        text: "Test comment",
        createdAt: new Date("2024-01-01T10:00:00Z"),
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

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.id).toBe("comment-123");
      expect(data.text).toBe("Test comment");

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return 404 if post not found", async () => {
      mockGetPost.mockResolvedValue(null);

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

      expect(response.status).toBe(404);
    });

    it("should return 404 if post is deleted", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: new Date() });

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

      expect(response.status).toBe(404);
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return 400 if content is rejected by moderation", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockIsEnabled.mockResolvedValue(true); // Enable moderation for this test
      mockModerateText.mockResolvedValue({
        decision: "quarantine",
        labels: [{ category: "category_a", confidence: 0.9 }],
        provider: "mock-text",
      });

      const request = new Request("http://test.com/comments", {
        method: "POST",
        body: JSON.stringify({ text: "Bad comment" }),
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
      expect(data.error).toBe("CONTENT_REJECTED");
    });

    it("should return 400 (not 500, not a silent empty write) for whitespace-only text", async () => {
      // Exercise the REAL validateRequest + createCommentSchema for this one
      // call (both are otherwise mocked/stubbed for the rest of the file) so
      // this pins the actual schema-boundary rejection, not a bypassed mock.
      const { validateRequest } = await import(
        "../../src/lib/validate-request.js"
      );
      const { validateRequest: realValidateRequest } =
        await vi.importActual<typeof import("../../src/lib/validate-request.js")>(
          "../../src/lib/validate-request.js",
        );
      (validateRequest as any).mockImplementationOnce(realValidateRequest);

      const request = new Request("http://test.com/comments", {
        method: "POST",
        body: JSON.stringify({ text: "   " }),
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
      // Never a crash, and the comment is never created with empty text.
      expect(mockDb.postComment.create).not.toHaveBeenCalled();
    });

    it("should use timeout/retry logic with USER_FACING preset", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockDb.postComment.create.mockResolvedValue({
        id: "comment-123",
        text: "Test comment",
        createdAt: new Date(),
      });

      const request = new Request("http://test.com/comments", {
        method: "POST",
        body: JSON.stringify({ text: "Test comment" }),
      });

      await handler.createComment(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      // Verify withQueryTimeoutAndRetry was called with USER_FACING preset
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US",
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          timeoutMs: 3000,
          retryTimeoutMs: 2000,
          maxRetries: 3,
          baseDelayMs: 100,
          context: expect.objectContaining({
            operation: "createComment",
          }),
        }),
      );
    });

    it("should handle database errors gracefully", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

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

      expect(response.status).toBe(500);
    });

    it("should handle errors when creating link checks fails gracefully", async () => {
      // Mock successful post fetch
      mockGetPost.mockResolvedValue({ id: "post-123" });
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockModerateText.mockResolvedValue({ decision: "approved", labels: [], provider: "mock-text" });

      // Add domainReputation and linkCheck to mockDb
      mockDb.domainReputation = {
        upsert: vi.fn().mockRejectedValue(new Error("Link check error")),
      };
      mockDb.postComment.create.mockResolvedValue({
        id: "comment-123",
        text: "Test comment",
        createdAt: new Date(),
      });

      const request = new Request("http://test.com/comments", {
        method: "POST",
        body: JSON.stringify({
          text: "Test comment with http://example.com link",
        }),
      });

      // Should still succeed even if link checks fail
      const response = await handler.createComment(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.id).toBeDefined();
    });

    it("should handle errors when queue send fails gracefully", async () => {
      // Mock successful post fetch
      mockGetPost.mockResolvedValue({ id: "post-123" });
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockModerateText.mockResolvedValue({ decision: "approved", labels: [], provider: "mock-text" });

      // Add domainReputation and linkCheck to mockDb
      mockDb.domainReputation = {
        upsert: vi.fn().mockResolvedValue({ domain: "example.com" }),
      };
      mockDb.linkCheck = {
        create: vi.fn().mockResolvedValue({
          id: "link-123",
          commentId: "comment-123",
          originalUrl: "http://example.com",
          normalizedUrl: "http://example.com",
          domain: "example.com",
          status: "pending",
        }),
      };
      mockDb.postComment.create.mockResolvedValue({
        id: "comment-123",
        text: "Test comment",
        createdAt: new Date(),
      });

      // Mock queue send to fail
      mockEnv.LINK_CHECK_QUEUE = {
        send: vi.fn().mockRejectedValue(new Error("Queue error")),
      };

      const request = new Request("http://test.com/comments", {
        method: "POST",
        body: JSON.stringify({
          text: "Test comment with http://example.com link",
        }),
      });

      // Should still succeed even if queue send fails
      const response = await handler.createComment(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.id).toBeDefined();
    });

    it("should handle errors when fetching link checks for response fails gracefully", async () => {
      // Mock successful post fetch
      mockGetPost.mockResolvedValue({ id: "post-123" });
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockModerateText.mockResolvedValue({ decision: "approved", labels: [], provider: "mock-text" });

      // Add domainReputation and linkCheck to mockDb
      mockDb.domainReputation = {
        upsert: vi.fn().mockResolvedValue({ domain: "example.com" }),
      };
      mockDb.linkCheck = {
        create: vi.fn().mockResolvedValue({
          id: "link-123",
          commentId: "comment-123",
          originalUrl: "http://example.com",
          normalizedUrl: "http://example.com",
          domain: "example.com",
          status: "pending",
        }),
        findMany: vi.fn().mockRejectedValue(new Error("Fetch error")),
      };
      mockDb.postComment.create.mockResolvedValue({
        id: "comment-123",
        text: "Test comment",
        createdAt: new Date(),
      });

      const request = new Request("http://test.com/comments", {
        method: "POST",
        body: JSON.stringify({
          text: "Test comment with http://example.com link",
        }),
      });

      // Should still succeed even if fetching link checks fails
      const response = await handler.createComment(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.id).toBeDefined();
      // Links should be empty array if fetch fails (source returns linksResponse || [])
      expect(data.links).toEqual([]);
    });
  });

  describe("editComment", () => {
    it("should return 400 (not 500, not a silent empty write) for whitespace-only text", async () => {
      // Exercise the REAL validateRequest + inline editCommentSchema for
      // this one call so this pins the actual schema-boundary rejection,
      // not a bypassed mock.
      const { validateRequest } = await import(
        "../../src/lib/validate-request.js"
      );
      const { validateRequest: realValidateRequest } =
        await vi.importActual<typeof import("../../src/lib/validate-request.js")>(
          "../../src/lib/validate-request.js",
        );
      (validateRequest as any).mockImplementationOnce(realValidateRequest);

      const request = new Request("http://test.com/comments/comment-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "   " }),
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
      // Never a crash, and the comment is never updated with empty text.
      expect(mockDb.postComment.update).not.toHaveBeenCalled();
    });
  });

  describe("getComments", () => {
    it("should return comments for a post", async () => {
      const comments = [
        {
          id: "comment-1",
          text: "Comment 1",
          authorId: "user-1",
          createdAt: new Date("2024-01-01T10:00:00Z"),
          postUri: "at://test/post-123",
          replyToUri: null,
        },
        {
          id: "comment-2",
          text: "Comment 2",
          authorId: "user-2",
          createdAt: new Date("2024-01-01T11:00:00Z"),
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
      expect(data.comments).toHaveLength(2);
      expect(data.comments[0].id).toBe("comment-1");

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return 404 if post not found", async () => {
      mockGetPost.mockResolvedValue(null);

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

      expect(response.status).toBe(404);
    });

    // H3: the gate used to be "does the post row exist", via a DataRouter call
    // with no tenant and no audience predicate — so any authenticated caller in
    // any tenant could read a WHISPER post's whole thread by id.
    it("refuses, identically to not-found, when the viewer may not read the post", async () => {
      mockCanReadPost.mockResolvedValue(false);
      mockDb.postComment.findMany.mockResolvedValue([
        {
          id: "comment-1",
          text: "private thread content",
          authorId: "user-1",
          createdAt: new Date("2024-01-01T10:00:00Z"),
          postUri: "at://test/post-123",
          replyToUri: null,
        },
      ]);

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

      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toBe(JSON.stringify({ error: "Post not found" }));
      // Neither the text nor the commenter's id escapes, and the thread query
      // is never run.
      expect(body).not.toContain("private thread content");
      expect(mockDb.postComment.findMany).not.toHaveBeenCalled();
    });

    it("passes the caller's active tenant to the authorizer, never an ambient one", async () => {
      mockDb.postComment.findMany.mockResolvedValue([]);
      mockDb.commentSentiment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/comments?postId=post-123");
      await handler.getComments(
        "post-123",
        request,
        mockSession,
        { limit: 20 },
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(mockCanReadPost).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: "post-123",
          viewerUserId: mockSession.userId,
          tenantId: TEST_TENANT_ID,
        }),
      );
    });

    it("should include sentiment counts", async () => {
      const comments = [
        {
          id: "comment-1",
          text: "Comment 1",
          authorId: "user-1",
          createdAt: new Date("2024-01-01T10:00:00Z"),
          postUri: "at://test/post-123",
          replyToUri: null,
        },
      ];
      mockDb.postComment.findMany.mockResolvedValue(comments);
      mockDb.commentSentiment.groupBy.mockResolvedValue([
        { commentId: "comment-1", sentiment: "like", _count: 5 },
        { commentId: "comment-1", sentiment: "love", _count: 2 },
      ]);

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
      expect(data.comments[0].sentimentCounts).toEqual({
        like: 5,
        love: 2,
      });
    });

    it("should use timeout/retry logic for both queries", async () => {
      mockDb.postComment.findMany.mockResolvedValue([]);
      mockDb.commentSentiment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/comments?postId=post-123");
      await handler.getComments(
        "post-123",
        request,
        mockSession,
        { limit: 20 },
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      // Verify withQueryTimeoutAndRetry was called twice (comments + sentiments)
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(2);
    });

    it("should handle database errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

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

      expect(response.status).toBe(500);
    });
  });

  describe("hideComment", () => {
    it("should hide a comment successfully", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        postId: "post-123",
        post: {
          authorId: "user-123",
          dataRegion: "US",
        },
      });
      mockDb.postComment.update.mockResolvedValue({});

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

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return 404 if comment not found", async () => {
      mockDb.postComment.findFirst.mockResolvedValue(null);

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

    it("should return 403 if user is not post owner", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        postId: "post-123",
        post: {
          authorId: "user-456", // Different user
          dataRegion: "US",
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

      expect(response.status).toBe(403);
    });

    it("should use timeout/retry logic", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        postId: "post-123",
        post: {
          authorId: "user-123",
          dataRegion: "US",
        },
      });
      mockDb.postComment.update.mockResolvedValue({});

      const request = new Request("http://test.com/comments/comment-123/hide", {
        method: "POST",
      });

      await handler.hideComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      // Verify withQueryTimeoutAndRetry was called twice (find + update)
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(2);
    });
  });

  describe("unhideComment", () => {
    it("should unhide a comment successfully", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        postId: "post-123",
        post: {
          authorId: "user-123",
          dataRegion: "US",
        },
      });
      mockDb.postComment.update.mockResolvedValue({});

      const request = new Request(
        "http://test.com/comments/comment-123/unhide",
        {
          method: "POST",
        },
      );

      const response = await handler.unhideComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return 404 if comment not found", async () => {
      mockDb.postComment.findFirst.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/comments/comment-123/unhide",
        {
          method: "POST",
        },
      );

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

    it("should use timeout/retry logic", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "comment-123",
        postId: "post-123",
        post: {
          authorId: "user-123",
          dataRegion: "US",
        },
      });
      mockDb.postComment.update.mockResolvedValue({});

      const request = new Request(
        "http://test.com/comments/comment-123/unhide",
        {
          method: "POST",
        },
      );

      await handler.unhideComment(
        "comment-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      // Verify withQueryTimeoutAndRetry was called twice (find + update)
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(2);
    });
  });

  describe("createReply", () => {
    let mockDb: any;
    let handler: CommentHandler;

    beforeEach(() => {
      vi.clearAllMocks();

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

      // Make createPrisma return mockDb
      mockCreatePrisma.mockReturnValue(mockDb);

      // Default mock: withQueryTimeoutAndRetry executes the query function with mockDb
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
          options?: any,
        ) => {
          return await queryFn(mockDb);
        },
      );

      mockEnv = {
        DATABASE_URL: "postgres://test",
        DEFAULT_REGION: "US",
        ENVIRONMENT: "dev",
      };

      mockRequestContext = {
        region: "US",
      };

      handler = new CommentHandler();
    });

    it("should create a reply to a top-level comment", async () => {
      const parentComment = {
        id: "parent123",
        postId: "post123",
        postUri: "at://did:plc:abc/post/xyz",
        rootUri: null,
        replyToUri: null,
        deletedAt: null,
      };

      // First findFirst — createReply's own parent lookup
      // Second findFirst — createComment's parent thread context lookup
      // Third findFirst — duplicate check (returns null)
      mockDb.postComment.findFirst
        .mockResolvedValueOnce(parentComment)
        .mockResolvedValueOnce(parentComment)
        .mockResolvedValue(null);
      mockGetPost.mockResolvedValue({
        id: "post123",
        authorId: "author123",
        text: "Test post",
        uri: "at://did:plc:abc/post/xyz",
      });
      mockDb.postComment.create.mockResolvedValue({
        id: "reply123",
        postId: "post123",
        authorId: "user456",
        text: "This is a reply",
        rootUri: "at://did:plc:abc/post/xyz",
        replyToUri: "at://did:plc:abc/post/xyz",
        createdAt: new Date(),
      });

      const request = new Request("http://test.com/comments/parent123/replies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "This is a reply" }),
      });

      const response = await handler.createReply(
        "parent123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(201);
      // Verify that findUnique was called to fetch parent comment
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should create a nested reply (reply to reply)", async () => {
      const parentComment = {
        id: "reply123",
        postId: "post123",
        postUri: "at://did:plc:abc/post/xyz",
        rootUri: "at://did:plc:abc/post/xyz",
        replyToUri: "comment:parent123",
        deletedAt: null,
      };

      mockDb.postComment.findFirst
        .mockResolvedValueOnce(parentComment)
        .mockResolvedValueOnce(parentComment)
        .mockResolvedValue(null);
      mockGetPost.mockResolvedValue({
        id: "post123",
        authorId: "author123",
        text: "Test post",
        uri: "at://did:plc:abc/post/xyz",
      });
      mockDb.postComment.create.mockResolvedValue({
        id: "nestedReply456",
        postId: "post123",
        authorId: "user789",
        text: "Nested reply",
        rootUri: "at://did:plc:abc/post/xyz",
        replyToUri: "comment:reply123",
        createdAt: new Date(),
      });

      const request = new Request("http://test.com/comments/reply123/replies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Nested reply" }),
      });

      const response = await handler.createReply(
        "reply123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(201);
      // Verify that createReply properly delegates to createComment with parentCommentId
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should reject reply to deleted comment", async () => {
      mockDb.postComment.findFirst.mockResolvedValue({
        id: "parent123",
        postId: "post123",
        deletedAt: new Date(),
      });

      const request = new Request("http://test.com/comments/parent123/replies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Reply attempt" }),
      });

      const response = await handler.createReply(
        "parent123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe("Cannot reply to deleted comment");
    });

    it("should reject reply to non-existent comment", async () => {
      mockDb.postComment.findFirst.mockResolvedValue(null);

      const request = new Request("http://test.com/comments/invalid/replies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Reply attempt" }),
      });

      const response = await handler.createReply(
        "invalid",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(404);
      const error = await response.json();
      expect(error.error).toBe("Parent comment not found");
    });
  });
});
