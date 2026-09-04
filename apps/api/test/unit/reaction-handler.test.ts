/**
 * Unit Tests: Reaction Handler
 *
 * Tests for sentiment reactions on posts and comments, including timeout/retry logic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReactionHandler } from "../../src/lib/reaction-handler.js";
import type { Session } from "../../src/lib/session-cookie.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";

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

// Mock FeedHandler
vi.mock("../../src/lib/feed-handler", () => ({
  FeedHandler: {
    invalidateFeedCache: vi.fn(),
  },
}));

// Mock the shared read authorizer (H3). Default ALLOW, so the existing
// behaviour tests below still exercise the body of each method.
//
// Note what this mock does NOT prove: whether the predicate inside
// `canReadPost` is correct. That is decided by real Postgres in
// test/integration/post-attachment-read-authz.integration.test.ts — a mocked
// Prisma resolves canned rows regardless of the `where`, so a unit test cannot
// tell a right predicate from a missing one.
const mockCanReadPost = vi.fn();
vi.mock("../../src/lib/post-read-authorizer", () => ({
  canReadPost: (...args: any[]) => mockCanReadPost(...args),
}));

const TENANT = "tenant-123";

describe("ReactionHandler", () => {
  let handler: ReactionHandler;
  let mockEnv: any;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReactionHandler();
    mockCanReadPost.mockResolvedValue(true);

    mockDb = {
      post: {
        findUnique: vi.fn(),
      },
      postComment: {
        findUnique: vi.fn(),
      },
      postSentiment: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        deleteMany: vi.fn(),
        groupBy: vi.fn(),
      },
      commentSentiment: {
        upsert: vi.fn(),
        deleteMany: vi.fn(),
        groupBy: vi.fn(),
      },
    };

    // Default mock: withQueryTimeoutAndRetry executes the query function with mockDb
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (
        manager: any,
        region: string,
        env: any,
        queryFn: (db: any) => Promise<any>,
      ) => {
        return await queryFn(mockDb);
      },
    );

    mockEnv = {
      DATABASE_URL: "postgres://test",
      DEFAULT_REGION: "US",
      ENVIRONMENT: "dev",
      FEED_CACHE_KV: {} as any,
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
  });

  describe("addPostSentiment", () => {
    it("should add sentiment reaction successfully", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockDb.postSentiment.upsert.mockResolvedValue({
        id: "sentiment-123",
        sentiment: "love",
      });

      const response = await handler.addPostSentiment(
        "post-123",
        "love",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.sentiment).toBe("love");

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return 400 for invalid sentiment", async () => {
      const response = await handler.addPostSentiment(
        "post-123",
        "invalid-sentiment",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Invalid sentiment");
    });

    it("should return 404 if post not found", async () => {
      mockGetPost.mockResolvedValue(null);

      const response = await handler.addPostSentiment(
        "post-123",
        "love",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
    });

    it("should return 404 if post is deleted", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: new Date() });

      const response = await handler.addPostSentiment(
        "post-123",
        "love",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should use timeout/retry logic with USER_FACING preset", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockDb.postSentiment.upsert.mockResolvedValue({});

      await handler.addPostSentiment(
        "post-123",
        "love",
        mockSession,
        mockEnv,
        mockRequestContext,
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
            operation: "addPostSentiment",
          }),
        }),
      );
    });

    it("should handle database errors gracefully", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const response = await handler.addPostSentiment(
        "post-123",
        "love",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
    });
  });

  describe("removePostSentiment", () => {
    it("should remove sentiment reaction successfully", async () => {
      mockDb.postSentiment.deleteMany.mockResolvedValue({ count: 1 });

      const response = await handler.removePostSentiment(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return 404 if post not found", async () => {
      mockGetPost.mockResolvedValue(null);

      const response = await handler.removePostSentiment(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
    });

    it("should use timeout/retry logic", async () => {
      mockDb.postSentiment.deleteMany.mockResolvedValue({ count: 1 });

      await handler.removePostSentiment(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US",
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          context: expect.objectContaining({
            operation: "removePostSentiment",
          }),
        }),
      );
    });
  });

  describe("getPostSentiments", () => {
    it("should return sentiment counts for a post", async () => {
      mockDb.postSentiment.groupBy.mockResolvedValue([
        { sentiment: "love", _count: 5 },
        { sentiment: "joy", _count: 3 },
      ]);
      mockDb.postSentiment.findUnique.mockResolvedValue({ sentiment: "love" });

      const response = await handler.getPostSentiments(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sentimentCounts).toEqual({
        love: 5,
        joy: 3,
      });
      expect(data.userSentiment).toBe("love");

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return 404 if post not found", async () => {
      mockGetPost.mockResolvedValue(null);

      const response = await handler.getPostSentiments(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(404);
    });

    // H3: reaction counts are an attachment of the post and must not be more
    // readable than it. This method used to accept a null session and gate on
    // "does the post row exist", so a WHISPER post's reaction activity was
    // readable by anyone with the id.
    it("refuses with the not-found body when the viewer may not read the post", async () => {
      mockCanReadPost.mockResolvedValue(false);
      mockDb.postSentiment.groupBy.mockResolvedValue([
        { sentiment: "love", _count: 5 },
      ]);

      const response = await handler.getPostSentiments(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(404);
      // Byte-identical to the absent-post refusal: a distinguishable deny is an
      // existence oracle for private post ids.
      expect(await response.text()).toBe(
        JSON.stringify({ error: "Post not found" }),
      );
      // And no count reached the caller.
      expect(mockDb.postSentiment.groupBy).not.toHaveBeenCalled();
    });

    it("passes the caller's active tenant to the authorizer, never an ambient one", async () => {
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findUnique.mockResolvedValue(null);

      await handler.getPostSentiments(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(mockCanReadPost).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: "post-123",
          viewerUserId: "user-123",
          tenantId: TENANT,
        }),
      );
    });

    it("should use timeout/retry logic for both queries", async () => {
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findUnique.mockResolvedValue(null);

      await handler.getPostSentiments(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      // Verify withQueryTimeoutAndRetry was called twice (counts + user reaction)
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(2);
    });
  });

  describe("addCommentSentiment", () => {
    it("should add sentiment reaction to comment successfully", async () => {
      mockDb.postComment.findUnique.mockResolvedValue({
        id: "comment-123",
        post: { dataRegion: "US" },
      });
      mockDb.commentSentiment.upsert.mockResolvedValue({});

      const response = await handler.addCommentSentiment(
        "comment-123",
        "love",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.sentiment).toBe("love");

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return 400 for invalid sentiment", async () => {
      const response = await handler.addCommentSentiment(
        "comment-123",
        "invalid-sentiment",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("should return 404 if comment not found", async () => {
      mockDb.postComment.findUnique.mockResolvedValue(null);

      const response = await handler.addCommentSentiment(
        "comment-123",
        "love",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
    });

    it("should use timeout/retry logic", async () => {
      mockDb.postComment.findUnique.mockResolvedValue({
        id: "comment-123",
        post: { dataRegion: "US" },
      });
      mockDb.commentSentiment.upsert.mockResolvedValue({});

      await handler.addCommentSentiment(
        "comment-123",
        "love",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      // Verify withQueryTimeoutAndRetry was called twice (find + upsert)
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(2);
    });
  });

  describe("removeCommentSentiment", () => {
    it("should remove sentiment reaction from comment successfully", async () => {
      mockDb.postComment.findUnique.mockResolvedValue({
        post: { dataRegion: "US" },
      });
      mockDb.commentSentiment.deleteMany.mockResolvedValue({ count: 1 });

      const response = await handler.removeCommentSentiment(
        "comment-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return 404 if comment not found", async () => {
      mockDb.postComment.findUnique.mockResolvedValue(null);

      const response = await handler.removeCommentSentiment(
        "comment-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
    });

    it("should use timeout/retry logic", async () => {
      mockDb.postComment.findUnique.mockResolvedValue({
        post: { dataRegion: "US" },
      });
      mockDb.commentSentiment.deleteMany.mockResolvedValue({ count: 1 });

      await handler.removeCommentSentiment(
        "comment-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      // Verify withQueryTimeoutAndRetry was called twice (find + delete)
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(2);
    });
  });

  describe("getCommentSentiments", () => {
    it("should return sentiment counts for a comment", async () => {
      mockDb.postComment.findUnique.mockResolvedValue({
        post: { dataRegion: "US" },
      });
      mockDb.commentSentiment.groupBy.mockResolvedValue([
        { sentiment: "love", _count: 3 },
        { sentiment: "joy", _count: 2 },
      ]);

      const response = await handler.getCommentSentiments(
        "comment-123",
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sentimentCounts).toEqual({
        love: 3,
        joy: 2,
      });

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return 404 if comment not found", async () => {
      mockDb.postComment.findUnique.mockResolvedValue(null);

      const response = await handler.getCommentSentiments(
        "comment-123",
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
    });

    it("should use timeout/retry logic", async () => {
      mockDb.postComment.findUnique.mockResolvedValue({
        post: { dataRegion: "US" },
      });
      mockDb.commentSentiment.groupBy.mockResolvedValue([]);

      await handler.getCommentSentiments(
        "comment-123",
        mockEnv,
        mockRequestContext,
      );

      // Verify withQueryTimeoutAndRetry was called twice (find + groupBy)
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(2);
    });
  });
});
