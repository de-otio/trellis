/**
 * Unit Tests: Reaction Handler - Who Reacted Feature
 *
 * Tests for getPostSentimentUsers method (summary and detailed modes)
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

describe("ReactionHandler - getPostSentimentUsers", () => {
  let handler: ReactionHandler;
  let mockEnv: any;
  let mockSession: Session | null;
  let mockRequestContext: TrellisRequestContext;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReactionHandler();

    mockDb = {
      $queryRaw: vi.fn(),
      postSentiment: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
      user: {
        findMany: vi.fn(),
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

  describe("Summary Mode (sentiment = null)", () => {
    it("should return counts and top 3 users per sentiment", async () => {
      // Mock window function query results
      mockDb.$queryRaw.mockResolvedValue([
        // Joy sentiment (5 total, showing top 3)
        {
          sentiment: "joy",
          totalCount: 5,
          userId: "user-1",
          handle: "@alice",
          displayName: "Alice Wonder",
          avatar: null,
        },
        {
          sentiment: "joy",
          totalCount: 5,
          userId: "user-2",
          handle: "@bob",
          displayName: "Bob Smith",
          avatar: null,
        },
        {
          sentiment: "joy",
          totalCount: 5,
          userId: "user-3",
          handle: "@charlie",
          displayName: "Charlie Brown",
          avatar: null,
        },
        // Love sentiment (2 total, showing top 2)
        {
          sentiment: "love",
          totalCount: 2,
          userId: "user-4",
          handle: "@diana",
          displayName: "Diana Prince",
          avatar: null,
        },
        {
          sentiment: "love",
          totalCount: 2,
          userId: "user-5",
          handle: "@eve",
          displayName: "Eve Adams",
          avatar: null,
        },
      ]);

      const response = await handler.getPostSentimentUsers(
        "post-123",
        null, // Summary mode
        20,
        null,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.summary).toHaveLength(2); // 2 sentiments (joy, love)
      expect(data.totalCount).toBe(7); // 5 + 2 = 7 total reactions

      // Check joy sentiment
      const joySentiment = data.summary.find((s: any) => s.sentiment === "joy");
      expect(joySentiment.count).toBe(5);
      expect(joySentiment.topUsers).toHaveLength(3);
      expect(joySentiment.hasMore).toBe(true); // 5 total > 3 shown

      // Check love sentiment
      const loveSentiment = data.summary.find((s: any) => s.sentiment === "love");
      expect(loveSentiment.count).toBe(2);
      expect(loveSentiment.topUsers).toHaveLength(2);
      expect(loveSentiment.hasMore).toBe(false); // 2 total <= 3 shown
    });

    it("should handle empty results (no reactions)", async () => {
      mockDb.$queryRaw.mockResolvedValue([]);

      const response = await handler.getPostSentimentUsers(
        "post-123",
        null,
        20,
        null,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.summary).toHaveLength(0);
      expect(data.totalCount).toBe(0);
    });

    it("should return 404 if post not found", async () => {
      mockGetPost.mockResolvedValue(null);

      const response = await handler.getPostSentimentUsers(
        "post-999",
        null,
        20,
        null,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.type).toBe("https://api.example.com/errors/not-found");
      expect(data.title).toBe("Post Not Found");
    });

    it("should include cache headers", async () => {
      mockDb.$queryRaw.mockResolvedValue([]);

      const response = await handler.getPostSentimentUsers(
        "post-123",
        null,
        20,
        null,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=30, stale-while-revalidate=60",
      );
      expect(response.headers.get("x-ratelimit-limit")).toBe("60");
    });
  });

  describe("Detailed Mode (sentiment provided)", () => {
    it("should return paginated users for specific sentiment", async () => {
      // Mock pagination query
      mockDb.postSentiment.findMany.mockResolvedValue([
        {
          id: "sentiment-1",
          postId: "post-123",
          authorId: "user-1",
          sentiment: "joy",
          createdAt: new Date("2026-02-15T10:00:00Z"),
        },
        {
          id: "sentiment-2",
          postId: "post-123",
          authorId: "user-2",
          sentiment: "joy",
          createdAt: new Date("2026-02-15T09:00:00Z"),
        },
      ]);

      mockDb.postSentiment.count.mockResolvedValue(5); // Total count

      mockDb.user.findMany.mockResolvedValue([
        { id: "user-1", handle: "@alice", email: "Alice Wonder" },
        { id: "user-2", handle: "@bob", email: "Bob Smith" },
      ]);

      const response = await handler.getPostSentimentUsers(
        "post-123",
        "joy",
        2,
        null,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.sentiment).toBe("joy");
      expect(data.totalCount).toBe(5);
      expect(data.users).toHaveLength(2);
      expect(data.users[0].userId).toBe("user-1");
      expect(data.users[0].handle).toBe("@alice");
      expect(data.users[0].reactedAt).toBe("2026-02-15T10:00:00.000Z");
      expect(data.hasMore).toBe(false);
      expect(data.nextCursor).toBeNull();
    });

    it("should handle cursor pagination", async () => {
      const cursor = btoa(
        JSON.stringify({
          lastId: "sentiment-2",
          lastCreatedAt: "2026-02-15T09:00:00.000Z",
        }),
      );

      mockDb.postSentiment.findMany.mockResolvedValue([
        {
          id: "sentiment-3",
          postId: "post-123",
          authorId: "user-3",
          sentiment: "joy",
          createdAt: new Date("2026-02-15T08:00:00Z"),
        },
      ]);

      mockDb.postSentiment.count.mockResolvedValue(5);

      mockDb.user.findMany.mockResolvedValue([
        { id: "user-3", handle: "@charlie", email: "Charlie Brown" },
      ]);

      const response = await handler.getPostSentimentUsers(
        "post-123",
        "joy",
        2,
        cursor,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.users).toHaveLength(1);
      expect(data.users[0].userId).toBe("user-3");

      // Verify cursor was decoded and used in query
      expect(mockDb.postSentiment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.anything(),
          }),
        }),
      );
    });

    it("should set hasMore=true when there are more results", async () => {
      // Return limit+1 items to indicate more results
      mockDb.postSentiment.findMany.mockResolvedValue([
        {
          id: "sentiment-1",
          postId: "post-123",
          authorId: "user-1",
          sentiment: "joy",
          createdAt: new Date("2026-02-15T10:00:00Z"),
        },
        {
          id: "sentiment-2",
          postId: "post-123",
          authorId: "user-2",
          sentiment: "joy",
          createdAt: new Date("2026-02-15T09:00:00Z"),
        },
        {
          id: "sentiment-3",
          postId: "post-123",
          authorId: "user-3",
          sentiment: "joy",
          createdAt: new Date("2026-02-15T08:00:00Z"),
        },
      ]);

      mockDb.postSentiment.count.mockResolvedValue(10);

      mockDb.user.findMany.mockResolvedValue([
        { id: "user-1", handle: "@alice", email: "Alice" },
        { id: "user-2", handle: "@bob", email: "Bob" },
        { id: "user-3", handle: "@charlie", email: "Charlie" },
      ]);

      const response = await handler.getPostSentimentUsers(
        "post-123",
        "joy",
        2, // Limit = 2, but got 3 results
        null,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.users).toHaveLength(2); // Should only return 2 (limit)
      expect(data.hasMore).toBe(true);
      expect(data.nextCursor).not.toBeNull();

      // Decode and verify cursor
      const decodedCursor = JSON.parse(atob(data.nextCursor));
      expect(decodedCursor.lastId).toBe("sentiment-2");
    });

    it("should return 404 if post not found", async () => {
      mockGetPost.mockResolvedValue(null);

      const response = await handler.getPostSentimentUsers(
        "post-999",
        "joy",
        20,
        null,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.type).toBe("https://api.example.com/errors/not-found");
    });
  });

  describe("Error Handling", () => {
    it("should return 500 on database error", async () => {
      mockDb.$queryRaw.mockRejectedValue(new Error("Database error"));

      const response = await handler.getPostSentimentUsers(
        "post-123",
        null,
        20,
        null,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.type).toBe("https://api.example.com/errors/internal-server-error");
      expect(data.title).toBe("Internal Server Error");
    });
  });
});
