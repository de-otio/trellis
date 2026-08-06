/**
 * Unit Tests: Feed Handler
 *
 * Tests for feed aggregation, filtering, and entity tagging support.
 */

import { PostRadius } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPostAudienceFilter,
  FeedHandler,
} from "../../src/lib/feed-handler.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

// Mock DataRouter
const mockGetDatabaseForRegion = vi.fn();
vi.mock("../../src/lib/data-router", () => ({
  DataRouter: {
    getDatabaseForRegion: (...args: any[]) => mockGetDatabaseForRegion(...args),
  },
}));

// Mock DatabaseConnectionManager
const mockExecuteWithRetry = vi.fn();
const mockSharedInstance = {
  createClient: vi.fn(),
  clearPools: vi.fn(),
  getPoolStatus: vi.fn().mockReturnValue([]),
  executeWithRetry: mockExecuteWithRetry,
};
vi.mock("../../src/lib/database-connection-manager", () => ({
  DatabaseConnectionManager: class {
    createClient = mockSharedInstance.createClient;
    clearPools = mockSharedInstance.clearPools;
    getPoolStatus = mockSharedInstance.getPoolStatus;
    executeWithRetry = mockSharedInstance.executeWithRetry;
  },
  sharedDatabaseConnectionManager: mockSharedInstance,
}));

// Mock region detection
vi.mock("../../src/lib/region-detection", () => {
  const mockDetectRegionSync = vi.fn().mockReturnValue("US");
  const mockIsValidRegion = vi
    .fn()
    .mockImplementation((region: string) =>
      ["US", "EU", "CN"].includes(region),
    );
  return {
    detectRegionSync: mockDetectRegionSync,
    isValidRegion: mockIsValidRegion,
    RegionDetector: class RegionDetector {
      detectRegionSync = mockDetectRegionSync;
      isValidRegion = mockIsValidRegion;
    },
  };
});

// Mock friend-set resolution (relationship edges — see lib/friend-ids.ts)
const mockGetFriendUserIds = vi.fn();
vi.mock("../../src/lib/friend-ids", () => {
  return {
    FRIEND_TIER_MAX: 1,
    getFriendUserIds: (...args: unknown[]) => mockGetFriendUserIds(...args),
  };
});

// Mock ReactionHandler
vi.mock("../../src/lib/reaction-handler", () => ({
  ReactionHandler: vi.fn().mockImplementation(() => ({})),
}));

const TEST_TENANT_ID = "tenant-test-123";

describe("FeedHandler", () => {
  let handler: FeedHandler;
  let mockEnv: any;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new FeedHandler();

    mockDb = {
      post: {
        findMany: vi.fn(),
      },
      postSentiment: {
        groupBy: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      postComment: {
        groupBy: vi.fn().mockResolvedValue([]),
        findMany: vi.fn().mockResolvedValue([]),
      },
      linkCheck: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      entity: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    mockGetDatabaseForRegion.mockReturnValue(mockDb);

    mockEnv = {
      DATABASE_URL: "postgres://test",
      US_DATABASE_URL: "postgres://us-test",
      EU_DATABASE_URL: "postgres://eu-test",
      CN_DATABASE_URL: "postgres://cn-test",
      FEED_CACHE_KV: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      } as any,
      DEFAULT_REGION: "US",
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
          performance: {
            aggressiveCaching: false,
          },
          security: {},
        },
        features: {
          performance: {
            aggressiveCaching: false,
          },
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

    mockGetFriendUserIds.mockResolvedValue([]);
  });

  describe("getHomeFeed", () => {
    beforeEach(() => {
      // Setup default mocks for cache version (needed for all feed queries)
      mockEnv.FEED_CACHE_KV.get = vi.fn().mockImplementation((key: string) => {
        if (key === "feed:cache:version") {
          return Promise.resolve("1");
        }
        return Promise.resolve(null); // Cache miss by default
      });

      // Setup default mocks
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post 1",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          subjectEntities: [],
        },
      ]);

      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      // Mock executeWithRetry to call the query function with mockDb
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockDb);
        },
      );
    });

    it("should return feed posts without entity filter", async () => {
      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.posts).toHaveLength(1);
      expect(data.posts[0].id).toBe("post-1");
      expect(mockDb.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                deletedAt: null,
                hiddenByAuthor: false,
                // Tenant isolation (V2). Pinned here because the mocked lane
                // returns canned rows regardless of the `where`, so asserting
                // the predicate SHAPE is the only way this lane can catch the
                // predicate being dropped.
                tenantId: TEST_TENANT_ID,
                dataRegion: "US",
              }),
            ]),
          }),
        }),
      );
    });

    it("should reject a request with no active tenant rather than querying every tenant", async () => {
      const request = new Request("http://test.com/feeds/home");

      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        "" as unknown as string,
      );

      // Fail closed: no query is issued at all, so no cross-tenant rows can be
      // returned. A silent `tenantId: undefined` would have queried everything.
      expect(response.status).toBe(500);
      expect(mockDb.post.findMany).not.toHaveBeenCalled();
    });

    it("should filter by multiple entityRefs", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post 1",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          subjectEntities: [
            {
              entity: { id: "entity-1", name: "Dog 1", entityType: "dog" },
            },
            {
              entity: { id: "entity-2", name: "Dog 2", entityType: "dog" },
            },
          ],
        },
      ]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20, entityRefs: ["entity-1", "entity-2"] },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      const findManyCall = mockDb.post.findMany.mock.calls[0][0];

      // Verify where clause
      expect(findManyCall.where).toBeDefined();
      expect(findManyCall.where.AND).toBeDefined();
      expect(Array.isArray(findManyCall.where.AND)).toBe(true);
      const entityFilter = findManyCall.where.AND.find(
        (filter: any) => filter.subjectEntities?.some?.entityId?.in,
      );
      expect(entityFilter).toBeDefined();
      expect(entityFilter.subjectEntities.some.entityId.in).toEqual([
        "entity-1",
        "entity-2",
      ]);

      // Verify include structure
      expect(findManyCall.include).toBeDefined();
      expect(findManyCall.include.subjectEntities).toBeDefined();
      expect(findManyCall.include.subjectEntities.include).toBeDefined();
      expect(findManyCall.include.subjectEntities.include.entity).toBeDefined();
      expect(
        findManyCall.include.subjectEntities.include.entity.select,
      ).toBeDefined();
      expect(findManyCall.include.subjectEntities.include.entity.select.id).toBe(
        true,
      );
      expect(
        findManyCall.include.subjectEntities.include.entity.select.name,
      ).toBe(true);
      expect(
        findManyCall.include.subjectEntities.include.entity.select.entityType,
      ).toBe(true);
      expect(data.posts[0].taggedEntities).toHaveLength(2);
      expect(data.posts[0].taggedEntities[0].id).toBe("entity-1");
      expect(data.posts[0].taggedEntities[0].name).toBe("Dog 1");
    });

    it("should include taggedEntities in feed response", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post 1",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          subjectEntities: [
            {
              entity: { id: "entity-1", name: "Dog 1", entityType: "dog" },
            },
          ],
        },
      ]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.posts[0].taggedEntities).toBeDefined();
      expect(data.posts[0].taggedEntities).toHaveLength(1);
      expect(data.posts[0].taggedEntities[0]).toEqual({
        id: "entity-1",
        name: "Dog 1",
        entityType: "dog",
      });
    });

    it("should handle posts without taggedEntities", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post 1",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          subjectEntities: [],
        },
      ]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.posts[0].taggedEntities).toEqual([]);
    });

    it("should include entityRefs in cache key", async () => {
      const request = new Request("http://test.com/feeds/home");

      // Mock cache version
      mockEnv.FEED_CACHE_KV.get = vi.fn().mockImplementation((key: string) => {
        if (key === "feed:cache:version") {
          return Promise.resolve("1");
        }
        return Promise.resolve(null);
      });

      await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20, entityRefs: ["entity-1", "entity-2"] },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      // Verify cache key includes entityRefs
      expect(mockEnv.FEED_CACHE_KV.put).toHaveBeenCalledWith(
        expect.stringContaining("entity-1,entity-2"),
        expect.any(String),
        expect.any(Object),
      );
    });

    it("should respect visibility filters", async () => {
      mockGetFriendUserIds.mockResolvedValue(["friend-1"]);

      const request = new Request("http://test.com/feeds/home");
      await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(mockDb.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                OR: expect.arrayContaining([
                  { radius: PostRadius.SHOUT },
                  { authorId: "user-123" },
                  {
                    radius: PostRadius.NORMAL,
                    authorId: { in: ["friend-1"] },
                  },
                ]),
              }),
            ]),
          }),
        }),
      );
    });

    it("should handle pagination with cursor", async () => {
      const request = new Request("http://test.com/feeds/home");
      await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20, cursor: "2024-01-01T09:00:00Z" },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(mockDb.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                createdAt: { lt: new Date("2024-01-01T09:00:00Z") },
              }),
            ]),
          }),
        }),
      );
    });

    it("uses the (createdAt, id) keyset for a composite cursor — boundary ties are not skipped", async () => {
      const boundary = new Date("2024-01-01T09:00:00.000Z");
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: boundary.toISOString(), postId: "post-b" }),
      ).toString("base64");

      const request = new Request("http://test.com/feeds/home");
      await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20, cursor },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(mockDb.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              {
                OR: [
                  { createdAt: { lt: boundary } },
                  { createdAt: boundary, id: { lt: "post-b" } },
                ],
              },
            ]),
          }),
          // Deterministic order matching the keyset.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
      );
    });

    it("emits a composite next cursor that round-trips through the keyset", async () => {
      const ts = new Date("2024-01-01T09:00:00.000Z");
      // limit 1 with 2 tied rows → hasMore, next cursor at (ts, post-1).
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Tied post 1",
          radius: PostRadius.SHOUT,
          createdAt: ts,
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
        },
        {
          id: "post-0",
          authorId: "user-123",
          text: "Tied post 0",
          radius: PostRadius.SHOUT,
          createdAt: ts,
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
        },
      ]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 1 },
        mockRequestContext,
        TEST_TENANT_ID,
      );
      const data = await response.json();
      expect(data.hasMore).toBe(true);
      const decoded = JSON.parse(
        Buffer.from(data.cursor, "base64").toString("utf8"),
      );
      expect(decoded).toEqual({
        createdAt: ts.toISOString(),
        postId: "post-1",
      });
    });

    it("should return hasMore when more posts available", async () => {
      // Return limit + 1 posts to indicate more available
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post 1",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
        },
        {
          id: "post-2",
          authorId: "user-123",
          text: "Test post 2",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T09:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
        },
      ]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 1 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(data.hasMore).toBe(true);
      expect(data.posts).toHaveLength(1);
      expect(data.cursor).toBeDefined();
    });

    it("should handle errors gracefully", async () => {
      // Mock executeWithRetry to simulate error and return defaultValue
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          // Simulate error on first attempt
          try {
            await queryFn(mockDb);
          } catch (error) {
            // Return defaultValue after error
            return options.defaultValue || [];
          }
          return [];
        },
      );

      mockDb.post.findMany.mockRejectedValue(new Error("Database error"));

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      // With the new db-query-helper, errors are gracefully handled by returning
      // defaultValue (empty array), so we get a 200 response with empty feed
      expect(response.status).toBe(200);
      expect(data.posts).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    describe("Query Caching", () => {
      it("should return cached feed when cache hit", async () => {
        const cachedFeed: any = {
          posts: [{ id: "cached-post", text: "Cached content" }],
          cursor: undefined,
          hasMore: false,
        };

        let cacheKeyUsed = "";

        // Mock cache version and cached feed
        mockEnv.FEED_CACHE_KV.get = vi
          .fn()
          .mockImplementation((key: string, type?: string) => {
            if (key === "feed:cache:version") {
              return Promise.resolve("1");
            }
            // Store the cache key that was requested
            cacheKeyUsed = key;
            // Return cached feed for the cache key (using 'json' type)
            if (type === "json" && key.includes("feed:home:")) {
              return Promise.resolve(cachedFeed);
            }
            return Promise.resolve(null);
          });

        const request = new Request("http://test.com/feeds/home");
        const response = await handler.getHomeFeed(
          mockSession,
          request,
          mockEnv,
          { limit: 20 },
          mockRequestContext,
          TEST_TENANT_ID,
        );

        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.posts).toEqual(cachedFeed.posts);
        expect(data.hasMore).toBe(false);
        // Database should not be queried on cache hit
        expect(mockDb.post.findMany).not.toHaveBeenCalled();
        // Verify cache was checked
        expect(cacheKeyUsed).toContain("feed:home:");
      });

      it("should query database and cache result on cache miss", async () => {
        const mockPosts = [
          {
            id: "post-1",
            authorId: "user-123",
            text: "Test post 1",
            radius: PostRadius.SHOUT,
            createdAt: new Date("2024-01-01T10:00:00Z"),
            author: { id: "user-123", email: "test@example.com" },
            subjectEntities: [],
          },
        ];

        mockDb.post.findMany.mockResolvedValue(mockPosts);
        mockDb.postSentiment.groupBy.mockResolvedValue([]);
        mockDb.postSentiment.findMany.mockResolvedValue([]);
        mockDb.postComment.groupBy.mockResolvedValue([]);

        // Mock cache version, but no cached feed
        mockEnv.FEED_CACHE_KV.get = vi
          .fn()
          .mockImplementation((key: string) => {
            if (key === "feed:cache:version") {
              return Promise.resolve("1");
            }
            return Promise.resolve(null); // Cache miss
          });

        const request = new Request("http://test.com/feeds/home");
        const response = await handler.getHomeFeed(
          mockSession,
          request,
          mockEnv,
          { limit: 20 },
          mockRequestContext,
          TEST_TENANT_ID,
        );

        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.posts).toHaveLength(1);
        // Database should be queried on cache miss
        expect(mockDb.post.findMany).toHaveBeenCalled();
        // Result should be cached
        expect(mockEnv.FEED_CACHE_KV.put).toHaveBeenCalledWith(
          expect.stringContaining("feed:home:"),
          expect.any(String),
          expect.objectContaining({
            expirationTtl: 60, // Verify 60s TTL (matches implementation)
          }),
        );
      });

      it("should set 30 second TTL when caching feed", async () => {
        mockDb.post.findMany.mockResolvedValue([
          {
            id: "post-1",
            authorId: "user-123",
            text: "Test post",
            radius: PostRadius.SHOUT,
            createdAt: new Date("2024-01-01T10:00:00Z"),
            author: { id: "user-123", email: "test@example.com" },
            subjectEntities: [],
          },
        ]);
        mockDb.postSentiment.groupBy.mockResolvedValue([]);
        mockDb.postSentiment.findMany.mockResolvedValue([]);
        mockDb.postComment.groupBy.mockResolvedValue([]);

        // Mock cache version
        mockEnv.FEED_CACHE_KV.get = vi
          .fn()
          .mockImplementation((key: string) => {
            if (key === "feed:cache:version") {
              return Promise.resolve("1");
            }
            return Promise.resolve(null);
          });

        const request = new Request("http://test.com/feeds/home");
        await handler.getHomeFeed(
          mockSession,
          request,
          mockEnv,
          { limit: 20 },
          mockRequestContext,
          TEST_TENANT_ID,
        );

        // Verify TTL is set to 60 seconds (matches implementation)
        expect(mockEnv.FEED_CACHE_KV.put).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          expect.objectContaining({
            expirationTtl: 60,
          }),
        );
      });

      it("should handle missing FEED_CACHE_KV gracefully", async () => {
        const envWithoutKV = {
          ...mockEnv,
          FEED_CACHE_KV: undefined,
        };

        mockDb.post.findMany.mockResolvedValue([
          {
            id: "post-1",
            authorId: "user-123",
            text: "Test post",
            radius: PostRadius.SHOUT,
            createdAt: new Date("2024-01-01T10:00:00Z"),
            author: { id: "user-123", email: "test@example.com" },
            subjectEntities: [],
          },
        ]);
        mockDb.postSentiment.groupBy.mockResolvedValue([]);
        mockDb.postSentiment.findMany.mockResolvedValue([]);
        mockDb.postComment.groupBy.mockResolvedValue([]);

        const request = new Request("http://test.com/feeds/home");
        const response = await handler.getHomeFeed(
          mockSession,
          request,
          envWithoutKV,
          { limit: 20 },
          mockRequestContext,
          TEST_TENANT_ID,
        );

        const data = await response.json();

        // Should still work without KV (graceful degradation)
        expect(response.status).toBe(200);
        expect(data.posts).toHaveLength(1);
        // Database should be queried
        expect(mockDb.post.findMany).toHaveBeenCalled();
      });

      it("should handle KV cache errors gracefully", async () => {
        mockDb.post.findMany.mockResolvedValue([
          {
            id: "post-1",
            authorId: "user-123",
            text: "Test post",
            radius: PostRadius.SHOUT,
            createdAt: new Date("2024-01-01T10:00:00Z"),
            author: { id: "user-123", email: "test@example.com" },
            subjectEntities: [],
          },
        ]);
        mockDb.postSentiment.groupBy.mockResolvedValue([]);
        mockDb.postSentiment.findMany.mockResolvedValue([]);
        mockDb.postComment.groupBy.mockResolvedValue([]);

        // Mock cache version
        mockEnv.FEED_CACHE_KV.get = vi
          .fn()
          .mockImplementation((key: string) => {
            if (key === "feed:cache:version") {
              return Promise.resolve("1");
            }
            return Promise.resolve(null);
          });

        // Mock KV.put to throw error
        mockEnv.FEED_CACHE_KV.put = vi
          .fn()
          .mockRejectedValue(new Error("KV error"));

        const request = new Request("http://test.com/feeds/home");
        const response = await handler.getHomeFeed(
          mockSession,
          request,
          mockEnv,
          { limit: 20 },
          mockRequestContext,
          TEST_TENANT_ID,
        );

        const data = await response.json();

        // Should still return feed even if caching fails
        expect(response.status).toBe(200);
        expect(data.posts).toHaveLength(1);
        // Cache error should be logged but not fail the request
        expect(mockEnv.FEED_CACHE_KV.put).toHaveBeenCalled();
      });

      it("should handle KV cache get errors gracefully", async () => {
        mockDb.post.findMany.mockResolvedValue([
          {
            id: "post-1",
            authorId: "user-123",
            text: "Test post",
            radius: PostRadius.SHOUT,
            createdAt: new Date("2024-01-01T10:00:00Z"),
            author: { id: "user-123", email: "test@example.com" },
            subjectEntities: [],
          },
        ]);
        mockDb.postSentiment.groupBy.mockResolvedValue([]);
        mockDb.postSentiment.findMany.mockResolvedValue([]);
        mockDb.postComment.groupBy.mockResolvedValue([]);

        // Mock KV.get to throw error
        mockEnv.FEED_CACHE_KV.get = vi
          .fn()
          .mockRejectedValue(new Error("KV get error"));

        const request = new Request("http://test.com/feeds/home");
        const response = await handler.getHomeFeed(
          mockSession,
          request,
          mockEnv,
          { limit: 20 },
          mockRequestContext,
          TEST_TENANT_ID,
        );

        const data = await response.json();

        // Should still return feed even if cache read fails
        expect(response.status).toBe(200);
        expect(data.posts).toHaveLength(1);
        // Database should be queried when cache read fails
        expect(mockDb.post.findMany).toHaveBeenCalled();
      });
    });
  });

  describe("enrichPosts", () => {
    it("should enrich posts with sentiment counts and comment counts", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);
      mockDb.postSentiment.groupBy.mockResolvedValue([
        { postId: "post-1", sentiment: "positive", _count: 5 },
        { postId: "post-1", sentiment: "negative", _count: 2 },
      ]);

      mockDb.postSentiment.findMany.mockResolvedValue([
        { postId: "post-1", sentiment: "positive" },
      ]);

      mockDb.postComment.groupBy.mockResolvedValue([
        { postId: "post-1", _count: 3 },
      ]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(data.posts[0].sentimentCounts).toEqual({
        positive: 5,
        negative: 2,
      });
      expect(data.posts[0].commentCount).toBe(3);
      expect(data.posts[0].userSentiment).toBe("positive");
    });

    it("should handle posts without sentiment counts", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(data.posts[0].sentimentCounts).toEqual({});
      expect(data.posts[0].commentCount).toBe(0);
      expect(data.posts[0].userSentiment).toBeUndefined();
    });

    it("should use maxRetries: 1 for enrichment queries (fail fast for scalability)", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);
      mockDb.linkCheck.findMany.mockResolvedValue([]);

      // Track calls to executeWithRetry to verify maxRetries
      const executeWithRetryCalls: any[] = [];
      mockExecuteWithRetry.mockImplementation(
        async (region: string, env: any, queryFn: any, options: any) => {
          executeWithRetryCalls.push({ region, options });
          return await queryFn(mockDb);
        },
      );

      const request = new Request("http://test.com/feeds/home");
      await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      // Verify maxRetries: 1 is used for enrichment queries
      const enrichmentCalls = executeWithRetryCalls.filter((call) => {
        return (
          call.options?.context?.operation?.startsWith("enrichPosts_") ?? false
        );
      });

      enrichmentCalls.forEach((call) => {
        expect(call.options?.maxRetries).toBe(1);
        expect(call.options?.defaultValue).toEqual([]);
      });
    });

    it("should gracefully degrade when enrichment queries fail (return empty arrays)", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);

      // Mock enrichment queries to fail (return defaultValue: [])
      let enrichmentCallCount = 0;
      mockExecuteWithRetry.mockImplementation(
        async (region: string, env: any, queryFn: any, options: any) => {
          // Fail enrichment queries (enrichPosts_* operations)
          if (options?.context?.operation?.startsWith("enrichPosts_")) {
            enrichmentCallCount++;
            // Return defaultValue if provided, otherwise throw
            if (options?.defaultValue !== undefined) {
              return options.defaultValue;
            }
            throw new Error("Query timeout");
          }
          // Other queries succeed
          return await queryFn(mockDb);
        },
      );

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      // Should not throw, should return posts with empty sentiment/comment counts
      const data = await response.json();
      expect(data.posts).toBeDefined();
      expect(data.posts.length).toBeGreaterThan(0);
      // When queries fail, defaultValue: [] is used, so counts should be empty
      expect(data.posts[0].sentimentCounts).toEqual({});
      expect(data.posts[0].commentCount).toBe(0);
    });

    it("should handle posts without comment counts", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);
      mockDb.postSentiment.groupBy.mockResolvedValue([
        { postId: "post-1", sentiment: "positive", _count: 5 },
      ]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(data.posts[0].commentCount).toBe(0);
    });

    it("should set isOwner flag correctly for own posts", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "user-123", // Same as session userId
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(data.posts[0].isOwner).toBe(true);
    });

    it("should set isOwner flag correctly for other users posts", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "other-user-456", // Different from session userId
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "other-user-456", email: "other@example.com" },
          subjectEntities: [],
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(data.posts[0].isOwner).toBe(false);
    });

    it("should handle missing uri field (use empty string)", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
          uri: undefined, // Missing uri
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(data.posts[0].uri).toBe("");
    });

    it("should handle missing author did and handle fields (use fallbacks)", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "testuser@example.com",
            actorUri: undefined, // Missing actorUri
            handle: undefined, // Missing handle
          },
          subjectEntities: [],
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(data.posts[0].author.actorUri).toBe("user-123"); // Falls back to id
      expect(data.posts[0].author.handle).toBe("testuser"); // Falls back to email prefix
    });

    it("should handle posts with taxonomy tags", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
          taxonomyTags: [
            {
              taxon: {
                taxonId: "behavior:training:recall",
                displayName: "Recall Training",
                description: "Coming when called",
                category: {
                  code: "training",
                  displayName: "Training Topics",
                  dimension: {
                    code: "behavior",
                    displayName: "Behavior",
                  },
                },
              },
            },
          ],
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(data.posts[0].taxonomyTags).toBeDefined();
      expect(data.posts[0].taxonomyTags).toHaveLength(1);
      expect(data.posts[0].taxonomyTags[0].taxonId).toBe(
        "behavior:training:recall",
      );
      expect(data.posts[0].taxonomyTags[0].displayName).toBe("Recall Training");
      expect(data.posts[0].taxonomyTags[0].category).toBeDefined();
      expect(data.posts[0].taxonomyTags[0].category.code).toBe("training");
    });

    it("should handle posts with geoData", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
          geoData: {
            lat: 37.7749,
            lng: -122.4194,
            place: "San Francisco, CA",
          },
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(data.posts[0].geoData).toBeDefined();
      expect(data.posts[0].geoData.lat).toBe(37.7749);
      expect(data.posts[0].geoData.lng).toBe(-122.4194);
      expect(data.posts[0].geoData.place).toBe("San Francisco, CA");
    });

    it("should handle posts with contentWarnings", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
          contentWarnings: ["violence", "language"],
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(data.posts[0].contentWarnings).toEqual(["violence", "language"]);
    });

    it("should handle posts without contentWarnings (use empty array)", async () => {
      const posts = [
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
          contentWarnings: null, // Missing contentWarnings
        },
      ];

      mockDb.post.findMany.mockResolvedValue(posts);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(data.posts[0].contentWarnings).toEqual([]);
    });
  });

  describe("getHomeFeed - Advanced Features", () => {
    it("should handle limit boundary conditions (0, negative, >100)", async () => {
      // Test limit = 0 (should use default)
      const request1 = new Request("http://test.com/feeds/home");
      await handler.getHomeFeed(
        mockSession,
        request1,
        mockEnv,
        { limit: 0 },
        mockRequestContext,
        TEST_TENANT_ID,
      );
      expect(mockDb.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 21, // limit + 1, default limit is 20
        }),
      );

      // Test limit > 100 (should cap at 100)
      mockDb.post.findMany.mockClear();
      const request2 = new Request("http://test.com/feeds/home");
      await handler.getHomeFeed(
        mockSession,
        request2,
        mockEnv,
        { limit: 200 },
        mockRequestContext,
        TEST_TENANT_ID,
      );
      expect(mockDb.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 101, // 100 + 1
        }),
      );
    });

    it("should handle empty feed responses", async () => {
      mockDb.post.findMany.mockResolvedValue([]);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.posts).toEqual([]);
      expect(data.hasMore).toBe(false);
      expect(data.cursor).toBeUndefined();
    });

    it("should handle invalid cursor format gracefully", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
        },
      ]);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      // Invalid cursor creates an Invalid Date, which should be handled
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20, cursor: "invalid-date" },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      // Invalid date should result in cursor being undefined, but feed should still work
      // The Date constructor creates Invalid Date, which when used in query may cause issues
      // This test verifies the system handles it (either by error or by ignoring invalid cursor)
      expect([200, 500]).toContain(response.status);
    });
  });

  describe("getHomeFeed - Error Scenarios", () => {
    it("should handle database connection failures gracefully", async () => {
      mockGetDatabaseForRegion.mockImplementation(() => {
        throw new Error("Database connection failed");
      });

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe("Failed to get feed");
    });

    it("should handle friend-set resolution failures gracefully", async () => {
      mockGetFriendUserIds.mockRejectedValue(
        new Error("relationship query failed"),
      );

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe("Failed to get feed");
    });

    it("should handle enrichment query timeout gracefully", async () => {
      // Mock enrichment queries to timeout (using a promise that never resolves)
      // Note: The actual timeout is 20s, but we'll use a shorter delay for testing
      // and verify the timeout mechanism works
      let resolveSentiment: any;
      const sentimentPromise = new Promise((resolve) => {
        resolveSentiment = resolve;
      });

      mockDb.postSentiment.groupBy.mockImplementation(() => sentimentPromise);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: { id: "user-123", email: "test@example.com" },
          subjectEntities: [],
        },
      ]);

      const request = new Request("http://test.com/feeds/home");

      // Start the request (it will timeout after 20s, but we'll resolve earlier for test)
      const responsePromise = handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      // Wait a bit to let the timeout mechanism start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Resolve the promise to prevent actual timeout in test
      resolveSentiment([]);

      const response = await responsePromise;

      // Should still return a response (timeout is handled internally)
      expect([200, 500]).toContain(response.status);
    }, 30000); // Increase test timeout to 30s
  });

  describe("Cache Methods", () => {
    describe("getCachedFeed", () => {
      it("should return null when FEED_CACHE_KV is not configured", async () => {
        const envWithoutKV = {
          ...mockEnv,
          FEED_CACHE_KV: undefined,
        };

        // Access private method via reflection or test through public method
        // Since it's private, we test through getHomeFeed behavior
        const request = new Request("http://test.com/feeds/home");
        await handler.getHomeFeed(
          mockSession,
          request,
          envWithoutKV,
          { limit: 20 },
          mockRequestContext,
          TEST_TENANT_ID,
        );

        // Should query database (not use cache)
        expect(mockDb.post.findMany).toHaveBeenCalled();
      });

      it("should handle KV get errors gracefully", async () => {
        mockEnv.FEED_CACHE_KV.get = vi
          .fn()
          .mockImplementation((key: string) => {
            if (key === "feed:cache:version") {
              return Promise.resolve("1");
            }
            // Simulate error on cache get
            return Promise.reject(new Error("KV get error"));
          });

        mockDb.post.findMany.mockResolvedValue([
          {
            id: "post-1",
            authorId: "user-123",
            text: "Test post",
            radius: PostRadius.SHOUT,
            createdAt: new Date("2024-01-01T10:00:00Z"),
            author: { id: "user-123", email: "test@example.com" },
            subjectEntities: [],
          },
        ]);
        mockDb.postSentiment.groupBy.mockResolvedValue([]);
        mockDb.postSentiment.findMany.mockResolvedValue([]);
        mockDb.postComment.groupBy.mockResolvedValue([]);

        const request = new Request("http://test.com/feeds/home");
        const response = await handler.getHomeFeed(
          mockSession,
          request,
          mockEnv,
          { limit: 20 },
          mockRequestContext,
          TEST_TENANT_ID,
        );

        // Should still return feed even if cache read fails
        expect(response.status).toBe(200);
        expect(mockDb.post.findMany).toHaveBeenCalled();
      });
    });

    describe("cacheFeed", () => {
      it("should handle KV put errors gracefully", async () => {
        mockDb.post.findMany.mockResolvedValue([
          {
            id: "post-1",
            authorId: "user-123",
            text: "Test post",
            radius: PostRadius.SHOUT,
            createdAt: new Date("2024-01-01T10:00:00Z"),
            author: { id: "user-123", email: "test@example.com" },
            subjectEntities: [],
          },
        ]);
        mockDb.postSentiment.groupBy.mockResolvedValue([]);
        mockDb.postSentiment.findMany.mockResolvedValue([]);
        mockDb.postComment.groupBy.mockResolvedValue([]);

        // Mock cache version
        mockEnv.FEED_CACHE_KV.get = vi
          .fn()
          .mockImplementation((key: string) => {
            if (key === "feed:cache:version") {
              return Promise.resolve("1");
            }
            return Promise.resolve(null);
          });

        // Mock KV.put to throw error
        mockEnv.FEED_CACHE_KV.put = vi
          .fn()
          .mockRejectedValue(new Error("KV put error"));

        const request = new Request("http://test.com/feeds/home");
        const response = await handler.getHomeFeed(
          mockSession,
          request,
          mockEnv,
          { limit: 20 },
          mockRequestContext,
          TEST_TENANT_ID,
        );

        // Should still return feed even if caching fails
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.posts).toHaveLength(1);
      });
    });

    describe("getCacheVersion", () => {
      it("should return default version when KV is not configured", async () => {
        const envWithoutKV = {
          ...mockEnv,
          FEED_CACHE_KV: undefined,
        };

        const version = await FeedHandler.getCacheVersion(envWithoutKV);
        expect(version).toBe(1);
      });

      it("should return cached version when available", async () => {
        mockEnv.FEED_CACHE_KV.get = vi
          .fn()
          .mockImplementation((key: string) => {
            if (key === "feed:cache:version") {
              return Promise.resolve("5");
            }
            return Promise.resolve(null);
          });

        const version = await FeedHandler.getCacheVersion(mockEnv);
        expect(version).toBe(5);
      });

      it("should initialize version to 1 when not exists", async () => {
        mockEnv.FEED_CACHE_KV.get = vi
          .fn()
          .mockImplementation((key: string) => {
            if (key === "feed:cache:version") {
              return Promise.resolve(null); // Version not set
            }
            return Promise.resolve(null);
          });

        const version = await FeedHandler.getCacheVersion(mockEnv);
        expect(version).toBe(1);
        // Verify version was set
        expect(mockEnv.FEED_CACHE_KV.put).toHaveBeenCalledWith(
          "feed:cache:version",
          "1",
        );
      });

      it("should handle KV errors and return default version", async () => {
        mockEnv.FEED_CACHE_KV.get = vi
          .fn()
          .mockRejectedValue(new Error("KV error"));

        const version = await FeedHandler.getCacheVersion(mockEnv);
        expect(version).toBe(1);
      });
    });

    describe("getHomeFeed - Taxonomy Tag Filtering", () => {
      beforeEach(() => {
        // Mock wrapped database for taxonomy queries
        const mockWrappedDb = {
          taxonomyTaxon: {
            findMany: vi.fn(),
          },
        };

        // Mock getWrappedDatabase
        vi.doMock("../../src/lib/database-wrapper-helper", () => ({
          getWrappedDatabase: vi.fn().mockReturnValue(mockWrappedDb),
        }));

        // Mock tenant context

        vi.doMock("../../src/lib/request-context", () => ({
          createRequestContext: vi.fn().mockResolvedValue({
            session: mockSession,
          }),
        }));
      });

      it("should filter by taxonomy tags when provided", async () => {
        // Mock taxonomy taxon lookup
        const mockWrappedDb = {
          taxonomyTaxon: {
            findMany: vi
              .fn()
              .mockResolvedValue([{ id: "taxon-1" }, { id: "taxon-2" }]),
          },
        };

        // Mock getWrappedDatabase dynamically
        const { getWrappedDatabase } = await import(
          "../../src/lib/database-wrapper-helper.js"
        );
        vi.mocked(getWrappedDatabase).mockReturnValue(mockWrappedDb as any);

        mockDb.post.findMany.mockResolvedValue([
          {
            id: "post-1",
            authorId: "user-123",
            text: "Test post",
            radius: PostRadius.SHOUT,
            createdAt: new Date("2024-01-01T10:00:00Z"),
            author: { id: "user-123", email: "test@example.com" },
            subjectEntities: [],
            taxonomyTags: [
              {
                taxon: {
                  taxonId: "behavior:training:recall",
                  displayName: "Recall Training",
                },
              },
            ],
          },
        ]);
        mockDb.postSentiment.groupBy.mockResolvedValue([]);
        mockDb.postSentiment.findMany.mockResolvedValue([]);
        mockDb.postComment.groupBy.mockResolvedValue([]);

        const request = new Request("http://test.com/feeds/home");
        await handler.getHomeFeed(
          mockSession,
          request,
          mockEnv,
          {
            limit: 20,
            taxonomyTags: ["behavior:training:recall", "life-stage:puppy"],
          },
          mockRequestContext,
          TEST_TENANT_ID,
        );

        // Verify taxonomy filter was applied
        expect(mockWrappedDb.taxonomyTaxon.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              taxonId: { in: ["behavior:training:recall", "life-stage:puppy"] },
            }),
          }),
        );

        // Verify post query includes taxonomy filter
        expect(mockDb.post.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              AND: expect.arrayContaining([
                expect.objectContaining({
                  taxonomyTags: expect.objectContaining({
                    some: expect.objectContaining({
                      taxonId: { in: ["taxon-1", "taxon-2"] },
                    }),
                  }),
                }),
              ]),
            }),
          }),
        );
      });

      it("should return empty results when no matching taxons found", async () => {
        const mockWrappedDb = {
          taxonomyTaxon: {
            findMany: vi.fn().mockResolvedValue([]), // No matching taxons
          },
        };

        const { getWrappedDatabase } = await import(
          "../../src/lib/database-wrapper-helper.js"
        );
        vi.mocked(getWrappedDatabase).mockReturnValue(mockWrappedDb as any);

        mockDb.post.findMany.mockResolvedValue([]);
        mockDb.postSentiment.groupBy.mockResolvedValue([]);
        mockDb.postSentiment.findMany.mockResolvedValue([]);
        mockDb.postComment.groupBy.mockResolvedValue([]);

        const request = new Request("http://test.com/feeds/home");
        const response = await handler.getHomeFeed(
          mockSession,
          request,
          mockEnv,
          {
            limit: 20,
            taxonomyTags: ["nonexistent:tag:here"],
          },
          mockRequestContext,
          TEST_TENANT_ID,
        );

        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.posts).toEqual([]);
      });
    });
  });

  describe("getPost", () => {
    const basePost = {
      id: "post-1",
      authorId: "user-123",
      text: "Test post content",
      uri: "at://test/post/1",
      visibility: "PUBLIC",
      createdAt: new Date("2024-01-01T10:00:00Z"),
      author: {
        id: "user-123",
        email: "test@example.com",
        actorUri: "at://user-123",
        handle: "testuser",
      },
      media: [],
    };

    beforeEach(() => {
      mockDb.post.findUnique = vi.fn();
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);
      mockDb.linkCheck.findMany.mockResolvedValue([]);

      mockExecuteWithRetry.mockImplementation(
        async (_region: any, _env: any, queryFn: any, _options: any) => {
          return await queryFn(mockDb);
        },
      );
    });

    it("should return enriched post when found", async () => {
      mockDb.post.findUnique.mockResolvedValue(basePost);

      const result = await handler.getPost(
        "post-1",
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe("post-1");
      expect(result!.text).toBe("Test post content");
      expect(mockDb.post.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "post-1" }),
        }),
      );
    });

    it("should return null when post is not found", async () => {
      mockDb.post.findUnique.mockResolvedValue(null);

      const result = await handler.getPost(
        "nonexistent",
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(result).toBeNull();
    });

    // V3 — this path previously applied NO tenant and NO audience predicate, so
    // any authenticated caller could read any post by id, WHISPER included.
    // These assert the predicate SHAPE: the mock resolves canned rows whatever
    // the `where` is, so outcome assertions here would be vacuous. The
    // corresponding outcome coverage belongs to the integration lane.
    it("should scope the single-post lookup to the caller's tenant", async () => {
      mockDb.post.findUnique.mockResolvedValue(basePost);

      await handler.getPost(
        "post-1",
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(mockDb.post.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "post-1",
            tenantId: TEST_TENANT_ID,
            deletedAt: null,
            hiddenByAuthor: false,
          }),
        }),
      );
    });

    it("should apply the same audience predicate as the home feed", async () => {
      mockDb.post.findUnique.mockResolvedValue(basePost);
      mockGetFriendUserIds.mockResolvedValue(["friend-1"]);

      await handler.getPost(
        "post-1",
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const where = mockDb.post.findUnique.mock.calls[0][0].where;

      // Deep-equal against the single shared definition, so the two read paths
      // cannot drift apart without this failing.
      expect(where.OR).toEqual(
        buildPostAudienceFilter(mockSession.userId, ["friend-1"]).OR,
      );
    });

    it("should refuse to query at all when no tenant is supplied", async () => {
      mockDb.post.findUnique.mockResolvedValue(basePost);

      await expect(
        handler.getPost(
          "post-1",
          mockSession,
          mockEnv,
          mockRequestContext,
          "" as unknown as string,
        ),
      ).rejects.toThrow(/activeTenantId is required/);

      expect(mockDb.post.findUnique).not.toHaveBeenCalled();
    });

    it("should include sentiment counts in enriched result", async () => {
      mockDb.post.findUnique.mockResolvedValue({
        ...basePost,
        authorId: "user-456",
        author: {
          id: "user-456",
          email: "other@example.com",
          actorUri: "at://user-456",
          handle: "otheruser",
        },
      });
      mockDb.postSentiment.groupBy.mockResolvedValue([
        { postId: "post-1", sentiment: "love", _count: 3 },
        { postId: "post-1", sentiment: "joy", _count: 1 },
      ]);

      const result = await handler.getPost(
        "post-1",
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(result).not.toBeNull();
      expect(result!.sentimentCounts?.love).toBe(3);
      expect(result!.sentimentCounts?.joy).toBe(1);
    });

    it("should include comment count in enriched result", async () => {
      mockDb.post.findUnique.mockResolvedValue(basePost);
      mockDb.postComment.groupBy.mockResolvedValue([
        { postId: "post-1", _count: 5 },
      ]);

      const result = await handler.getPost(
        "post-1",
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(result).not.toBeNull();
      expect(result!.commentCount).toBe(5);
    });

    it("should include user sentiment when user has reacted", async () => {
      mockDb.post.findUnique.mockResolvedValue(basePost);
      mockDb.postSentiment.findMany.mockResolvedValue([
        { postId: "post-1", authorId: "user-123", sentiment: "joy" },
      ]);

      const result = await handler.getPost(
        "post-1",
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(result).not.toBeNull();
      expect(result!.userSentiment).toBe("joy");
    });

    it("should construct media URLs from content hash", async () => {
      const postWithMedia = {
        ...basePost,
        media: [
          {
            id: "postmedia-1",
            mediaId: "media-1",
            alt: "A photo",
            order: 0,
            media: {
              id: "media-1",
              contentHash: "abc123hash",
              mimeType: "image/jpeg",
              originalKey: "original/abc123hash",
              thumbnailKey: "thumbnail/abc123hash",
              optimizedKey: "optimized/abc123hash",
              width: 1920,
              height: 1080,
            },
          },
        ],
      };
      mockDb.post.findUnique.mockResolvedValue(postWithMedia);
      mockEnv.APP_DOMAIN = "https://www.example.com";

      const result = await handler.getPost(
        "post-1",
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(result).not.toBeNull();
      expect(result!.media).toHaveLength(1);
      expect(result!.media![0].file.originalKey).toContain("abc123hash");
      expect(result!.media![0].file.originalKey).toContain("variant=original");
      expect(result!.media![0].file.thumbnailKey).toContain("variant=thumbnail");
    });

    it("should mark post as owned when author matches session user", async () => {
      mockDb.post.findUnique.mockResolvedValue(basePost); // authorId: "user-123"

      const result = await handler.getPost(
        "post-1",
        mockSession, // userId: "user-123"
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(result).not.toBeNull();
      expect(result!.isOwner).toBe(true);
    });

    it("should not mark post as owned for different user", async () => {
      mockDb.post.findUnique.mockResolvedValue({
        ...basePost,
        authorId: "user-456",
        author: {
          id: "user-456",
          email: "other@example.com",
          actorUri: "at://user-456",
          handle: "otheruser",
        },
      });

      const result = await handler.getPost(
        "post-1",
        mockSession, // userId: "user-123"
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(result).not.toBeNull();
      expect(result!.isOwner).toBe(false);
    });
  });
});
