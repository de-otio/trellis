/**
 * Unit Tests: Reaction Handler - Caching
 *
 * Tests for sentiment count caching functionality including KV cache operations,
 * cache invalidation, and fallback behavior.
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

describe("ReactionHandler - Caching", () => {
  let handler: ReactionHandler;
  let mockEnv: any;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockDb: any;
  let mockKV: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReactionHandler();

    mockKV = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

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
      FEED_CACHE_KV: mockKV as any,
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

  describe("getPostSentiments - Caching", () => {
    it("should return cached sentiment counts when available", async () => {
      const cachedData = { joy: 5, love: 3, calm: 2 };
      mockKV.get.mockResolvedValue(JSON.stringify(cachedData));

      const response = await handler.getPostSentiments(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sentimentCounts).toEqual(cachedData);

      // Should NOT query database
      expect(mockDb.postSentiment.groupBy).not.toHaveBeenCalled();

      // Should have cache-control header
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=30, stale-while-revalidate=60",
      );
    });

    it("should query database and cache results when cache miss", async () => {
      mockKV.get.mockResolvedValue(null); // Cache miss
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
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sentimentCounts).toEqual({ love: 5, joy: 3 });

      // Should query database
      expect(mockDb.postSentiment.groupBy).toHaveBeenCalled();

      // Should cache the results
      expect(mockKV.put).toHaveBeenCalledWith(
        "sentiments:post-123",
        JSON.stringify({ love: 5, joy: 3 }),
        { expirationTtl: 30 },
      );
    });

    it("should use database on cache read error", async () => {
      mockKV.get.mockRejectedValue(new Error("KV read error"));
      mockDb.postSentiment.groupBy.mockResolvedValue([
        { sentiment: "joy", _count: 2 },
      ]);
      mockDb.postSentiment.findUnique.mockResolvedValue(null);

      const response = await handler.getPostSentiments(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sentimentCounts).toEqual({ joy: 2 });

      // Should log warning
      
      // Should still query database
      expect(mockDb.postSentiment.groupBy).toHaveBeenCalled();
    });

    it("should continue on cache write error", async () => {
      mockKV.get.mockResolvedValue(null);
      mockKV.put.mockRejectedValue(new Error("KV write error"));
      mockDb.postSentiment.groupBy.mockResolvedValue([
        { sentiment: "joy", _count: 1 },
      ]);
      mockDb.postSentiment.findUnique.mockResolvedValue(null);

      const response = await handler.getPostSentiments(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sentimentCounts).toEqual({ joy: 1 });

      // Should log warning about cache write failure
          });

    it("should work without KV configured", async () => {
      const envWithoutKV = { ...mockEnv, FEED_CACHE_KV: undefined };
      mockDb.postSentiment.groupBy.mockResolvedValue([
        { sentiment: "love", _count: 4 },
      ]);
      mockDb.postSentiment.findUnique.mockResolvedValue(null);

      const response = await handler.getPostSentiments(
        "post-123",
        mockSession,
        envWithoutKV,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sentimentCounts).toEqual({ love: 4 });

      // Should NOT try to use KV
      expect(mockKV.get).not.toHaveBeenCalled();
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it("should handle empty sentiment counts correctly", async () => {
      mockKV.get.mockResolvedValue(null);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findUnique.mockResolvedValue(null);

      const response = await handler.getPostSentiments(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sentimentCounts).toEqual({});

      // Should cache empty result
      expect(mockKV.put).toHaveBeenCalledWith(
        "sentiments:post-123",
        JSON.stringify({}),
        { expirationTtl: 30 },
      );
    });

    it("should include user sentiment in response", async () => {
      mockKV.get.mockResolvedValue(JSON.stringify({ joy: 5 }));
      mockDb.postSentiment.findUnique.mockResolvedValue({ sentiment: "joy" });

      const response = await handler.getPostSentiments(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      const data = await response.json();
      expect(data.userSentiment).toBe("joy");
    });

    it("should not include user sentiment for unauthenticated users", async () => {
      mockKV.get.mockResolvedValue(JSON.stringify({ joy: 5 }));

      const response = await handler.getPostSentiments(
        "post-123",
        null,
        mockEnv,
        mockRequestContext,
      );

      const data = await response.json();
      expect(data.userSentiment).toBeUndefined();
      expect(mockDb.postSentiment.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("getCommentSentiments - Caching", () => {
    beforeEach(() => {
      mockDb.postComment.findUnique.mockResolvedValue({
        id: "comment-123",
        post: { dataRegion: "US" },
      });
    });

    it("should return cached comment sentiment counts when available", async () => {
      const cachedData = { love: 3, joy: 2 };
      mockKV.get.mockResolvedValue(JSON.stringify(cachedData));

      const response = await handler.getCommentSentiments(
        "comment-123",
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sentimentCounts).toEqual(cachedData);

      // Should NOT query database for counts
      expect(mockDb.commentSentiment.groupBy).not.toHaveBeenCalled();
    });

    it("should query database and cache results on cache miss", async () => {
      mockKV.get.mockResolvedValue(null);
      mockDb.commentSentiment.groupBy.mockResolvedValue([
        { sentiment: "joy", _count: 2 },
      ]);

      const response = await handler.getCommentSentiments(
        "comment-123",
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sentimentCounts).toEqual({ joy: 2 });

      // Should cache with correct key
      expect(mockKV.put).toHaveBeenCalledWith(
        "sentiments:comment:comment-123",
        JSON.stringify({ joy: 2 }),
        { expirationTtl: 30 },
      );
    });

    it("should have cache-control headers", async () => {
      mockKV.get.mockResolvedValue(JSON.stringify({ joy: 1 }));

      const response = await handler.getCommentSentiments(
        "comment-123",
        mockEnv,
        mockRequestContext,
      );

      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=30, stale-while-revalidate=60",
      );
    });

    it("should handle cache errors gracefully", async () => {
      mockKV.get.mockRejectedValue(new Error("Cache error"));
      mockDb.commentSentiment.groupBy.mockResolvedValue([
        { sentiment: "love", _count: 1 },
      ]);

      const response = await handler.getCommentSentiments(
        "comment-123",
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
          });
  });

  describe("Cache Invalidation", () => {
    it("should invalidate post sentiment cache on add", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockDb.postSentiment.upsert.mockResolvedValue({});

      await handler.addPostSentiment(
        "post-123",
        "love",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(mockKV.delete).toHaveBeenCalledWith("sentiments:post-123");
    });

    it("should invalidate post sentiment cache on remove", async () => {
      mockDb.postSentiment.deleteMany.mockResolvedValue({ count: 1 });

      await handler.removePostSentiment(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(mockKV.delete).toHaveBeenCalledWith("sentiments:post-123");
    });

    it("should invalidate comment sentiment cache on add", async () => {
      mockDb.postComment.findUnique.mockResolvedValue({
        id: "comment-123",
        post: { dataRegion: "US" },
      });
      mockDb.commentSentiment.upsert.mockResolvedValue({});

      await handler.addCommentSentiment(
        "comment-123",
        "joy",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(mockKV.delete).toHaveBeenCalledWith(
        "sentiments:comment:comment-123",
      );
    });

    it("should invalidate comment sentiment cache on remove", async () => {
      mockDb.postComment.findUnique.mockResolvedValue({
        id: "comment-123",
        post: { dataRegion: "US" },
      });
      mockDb.commentSentiment.deleteMany.mockResolvedValue({ count: 1 });

      await handler.removeCommentSentiment(
        "comment-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(mockKV.delete).toHaveBeenCalledWith(
        "sentiments:comment:comment-123",
      );
    });

    it("should handle cache invalidation errors gracefully", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockDb.postSentiment.upsert.mockResolvedValue({});
      mockKV.delete.mockRejectedValue(new Error("Delete error"));

      const response = await handler.addPostSentiment(
        "post-123",
        "love",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      // Should still succeed despite cache invalidation error
      expect(response.status).toBe(200);
          });

    it("should skip invalidation when KV not configured", async () => {
      const envWithoutKV = { ...mockEnv, FEED_CACHE_KV: undefined };
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockDb.postSentiment.upsert.mockResolvedValue({});

      await handler.addPostSentiment(
        "post-123",
        "love",
        mockSession,
        envWithoutKV,
        mockRequestContext,
      );

      // Should NOT attempt to delete from KV
      expect(mockKV.delete).not.toHaveBeenCalled();
    });
  });

  describe("Cache Performance", () => {
    it("should avoid database query when cache hit", async () => {
      mockKV.get.mockResolvedValue(JSON.stringify({ joy: 10, love: 5 }));

      await handler.getPostSentiments(
        "post-123",
        null,
        mockEnv,
        mockRequestContext,
      );

      // Should NOT call database groupBy
      expect(mockDb.postSentiment.groupBy).not.toHaveBeenCalled();
    });

    it("should use correct cache keys for different entities", async () => {
      mockKV.get.mockResolvedValue(null);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findUnique.mockResolvedValue(null);

      await handler.getPostSentiments(
        "post-456",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(mockKV.put).toHaveBeenCalledWith(
        "sentiments:post-456",
        expect.any(String),
        { expirationTtl: 30 },
      );
    });

    it("should set 30-second TTL on cache entries", async () => {
      mockKV.get.mockResolvedValue(null);
      mockDb.postSentiment.groupBy.mockResolvedValue([{ sentiment: "joy", _count: 1 }]);
      mockDb.postSentiment.findUnique.mockResolvedValue(null);

      await handler.getPostSentiments(
        "post-123",
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(mockKV.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        { expirationTtl: 30 },
      );
    });
  });
});
