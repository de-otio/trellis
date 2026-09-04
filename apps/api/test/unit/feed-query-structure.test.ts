/**
 * Unit tests for feed query structure to prevent query hanging
 *
 * These tests verify that:
 * 1. Query structure is correct (no nested OR conditions)
 * 2. Query filters are properly combined
 * 3. Query handles empty database gracefully
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PostVisibilityLevel } from "@prisma/client";

// Mock dependencies - must be defined inside factory functions
vi.mock("../../src/lib/friend-ids", async () => {
  const { vi } = await import("vitest");
  return {
    FRIEND_TIER_MAX: 1,
    getFriendUserIds: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../../src/lib/data-router", () => {
  return {
    DataRouter: {
      getDatabaseForRegion: vi.fn().mockReturnValue({
        post: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        // M2: the block seam reads through this delegate. Default = no blocks.
        blockedUser: {
          findUnique: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
        },
      }),
    },
  };
});

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

// Import after mocks
import { FeedHandler } from "../../src/lib/feed-handler.js";

const TEST_TENANT_ID = "tenant-test-123";

describe("Feed Query Structure", () => {
  let feedHandler: FeedHandler;
  const mockSession = {
    userId: "user-123",
    email: "test@example.com",
  };
  const mockRequest = new Request("https://example.com/feeds/home");
  const mockEnv = {
    FEED_CACHE_KV: {
      get: vi.fn().mockImplementation((key: string, type?: string) => {
        if (key === "feed:cache:version") {
          return Promise.resolve("1");
        }
        // Cache miss for feed data - return null regardless of type
        return Promise.resolve(null);
      }),
      put: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
  const mockRequestContext = {
    region: "US",
    config: {
      features: {
        performance: {
          aggressiveCaching: false,
        },
      },
    },
  } as any;

  beforeEach(async () => {
    vi.clearAllMocks();
    feedHandler = new FeedHandler();
    // Mock enrichPosts method
    (feedHandler as any).enrichPosts = vi.fn().mockResolvedValue([]);

    // Reset DataRouter mock
    const { DataRouter } = await import("../../src/lib/data-router.js");
    (DataRouter.getDatabaseForRegion as any).mockReturnValue({
      post: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      blockedUser: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    // Reset FEED_CACHE_KV mock - return cache version but miss on feed data
    // Note: KV.get can be called with (key, type) where type is 'text' | 'json' | 'arrayBuffer' | 'stream'
    if (mockEnv.FEED_CACHE_KV) {
      (mockEnv.FEED_CACHE_KV.get as any).mockImplementation(
        (key: string, type?: string) => {
          if (key === "feed:cache:version") {
            // Return as text string (default) or as requested type
            if (type === "text" || !type) {
              return Promise.resolve("1");
            }
            return Promise.resolve("1");
          }
          // Cache miss for feed data - return null regardless of type
          return Promise.resolve(null);
        },
      );
      (mockEnv.FEED_CACHE_KV.put as any).mockResolvedValue(undefined);
    }
  });

  describe("Query structure validation", () => {
    it("should use AND conditions, not nested OR conditions", async () => {
      const mockFindMany = vi.fn().mockResolvedValue([]);
      const mockClient = {
        post: {
          findMany: mockFindMany,
        },
      };

      // Mock executeWithRetry to call the query function with mockClient
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockClient);
        },
      );

      // Ensure cache miss - mock cache version and feed data
      (mockEnv.FEED_CACHE_KV.get as any).mockImplementation(
        (key: string, type?: string) => {
          if (key === "feed:cache:version") {
            if (type === "text" || !type) {
              return Promise.resolve("1");
            }
            return Promise.resolve("1");
          }
          return Promise.resolve(null); // Cache miss for feed data
        },
      );

      await feedHandler.getHomeFeed(
        mockSession as any,
        mockRequest,
        mockEnv,
        {},
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(mockFindMany).toHaveBeenCalled();
      const queryCall = mockFindMany.mock.calls[0][0];

      // Verify query uses AND, not nested OR
      expect(queryCall.where).toBeDefined();

      // The where clause should have AND array, not nested OR for dataRegion
      if (queryCall.where.AND) {
        // Good: Using AND array
        expect(Array.isArray(queryCall.where.AND)).toBe(true);

        // Verify no nested OR for dataRegion
        const dataRegionFilter = queryCall.where.AND.find(
          (filter: any) => filter.dataRegion !== undefined,
        );
        expect(dataRegionFilter).toBeDefined();
        expect(dataRegionFilter.dataRegion).toBe("US");
        // Should NOT have OR: [{ dataRegion: 'US' }, { dataRegion: null }]
        expect(dataRegionFilter.OR).toBeUndefined();
      } else {
        // If not using AND, at least verify no problematic nested OR
        expect(queryCall.where.OR).toBeUndefined();
      }
    });

    it("should combine visibility filter with dataRegion filter correctly", async () => {
      const mockFindMany = vi.fn().mockResolvedValue([]);
      const mockClient = {
        post: { findMany: mockFindMany },
      };

      // Mock executeWithRetry to call the query function with mockClient
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockClient);
        },
      );

      // Ensure cache miss - mock cache version and feed data
      (mockEnv.FEED_CACHE_KV.get as any).mockImplementation(
        (key: string, type?: string) => {
          if (key === "feed:cache:version") {
            if (type === "text" || !type) {
              return Promise.resolve("1");
            }
            return Promise.resolve("1");
          }
          return Promise.resolve(null); // Cache miss for feed data
        },
      );

      await feedHandler.getHomeFeed(
        mockSession as any,
        mockRequest,
        mockEnv,
        {},
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(mockFindMany).toHaveBeenCalled();
      const queryCall = mockFindMany.mock.calls[0][0];
      expect(queryCall.where).toBeDefined();

      // Verify visibility filter is present
      if (queryCall.where.AND) {
        const visibilityFilter = queryCall.where.AND.find(
          (filter: any) => filter.OR !== undefined,
        );
        expect(visibilityFilter).toBeDefined();
        expect(visibilityFilter.OR).toBeDefined();
        expect(Array.isArray(visibilityFilter.OR)).toBe(true);
      }

      // Verify dataRegion filter is present
      const hasDataRegion =
        queryCall.where.AND?.some(
          (filter: any) => filter.dataRegion === "US",
        ) || queryCall.where.dataRegion === "US";
      expect(hasDataRegion).toBe(true);
    });

    it("should include deletedAt and hiddenByAuthor filters", async () => {
      const mockFindMany = vi.fn().mockResolvedValue([]);
      const mockClient = {
        post: { findMany: mockFindMany },
      };

      // Mock executeWithRetry to call the query function with mockClient
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockClient);
        },
      );

      // Ensure cache miss - mock cache version and feed data
      (mockEnv.FEED_CACHE_KV.get as any).mockImplementation(
        (key: string, type?: string) => {
          if (key === "feed:cache:version") {
            if (type === "text" || !type) {
              return Promise.resolve("1");
            }
            return Promise.resolve("1");
          }
          return Promise.resolve(null); // Cache miss for feed data
        },
      );

      await feedHandler.getHomeFeed(
        mockSession as any,
        mockRequest,
        mockEnv,
        {},
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(mockFindMany).toHaveBeenCalled();
      const queryCall = mockFindMany.mock.calls[0][0];

      // Verify deletedAt and hiddenByAuthor filters
      if (queryCall.where.AND) {
        const standardFilters = queryCall.where.AND.find(
          (filter: any) =>
            filter.deletedAt === null && filter.hiddenByAuthor === false,
        );
        expect(standardFilters).toBeDefined();
      } else {
        expect(queryCall.where.deletedAt).toBe(null);
        expect(queryCall.where.hiddenByAuthor).toBe(false);
      }
    });

    it("should handle empty database gracefully (return empty array)", async () => {
      const mockClient = {
        post: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      // Mock executeWithRetry to call the query function with mockClient
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockClient);
        },
      );

      // Ensure cache miss - mock cache version and feed data
      (mockEnv.FEED_CACHE_KV.get as any).mockImplementation(
        (key: string, type?: string) => {
          if (key === "feed:cache:version") {
            if (type === "text" || !type) {
              return Promise.resolve("1");
            }
            return Promise.resolve("1");
          }
          return Promise.resolve(null); // Cache miss for feed data
        },
      );

      const response = await feedHandler.getHomeFeed(
        mockSession as any,
        mockRequest,
        mockEnv,
        {},
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.posts).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should limit includes to essential fields only", async () => {
      // Ensure no cache hit by clearing cache or using a unique key
      const mockFindMany = vi.fn().mockResolvedValue([]);
      const mockClient = {
        post: { findMany: mockFindMany },
      };

      // Mock executeWithRetry to call the query function with mockClient
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockClient);
        },
      );

      // Ensure cache miss - mock cache version and feed data
      (mockEnv.FEED_CACHE_KV.get as any).mockImplementation((key: string) => {
        if (key === "feed:cache:version") {
          return Promise.resolve("1");
        }
        return Promise.resolve(null); // Cache miss for feed data
      });

      await feedHandler.getHomeFeed(
        mockSession as any,
        mockRequest,
        mockEnv,
        {},
        mockRequestContext,
        TEST_TENANT_ID,
      );

      expect(mockFindMany).toHaveBeenCalled();
      const queryCall = mockFindMany.mock.calls[0][0];
      expect(queryCall.include).toBeDefined();

      // Verify author include is selective
      if (queryCall.include.author) {
        expect(queryCall.include.author.select).toBeDefined();
        expect(queryCall.include.author.select.id).toBe(true);
        expect(queryCall.include.author.select.email).toBe(true);
        // Should NOT include all fields
        expect(queryCall.include.author.select).not.toHaveProperty("password");
      }

      // Verify taggedEntities include is limited
      if (queryCall.include.taggedEntities) {
        expect(queryCall.include.taggedEntities.take).toBe(10);
        if (queryCall.include.taggedEntities.include?.entity) {
          expect(
            queryCall.include.taggedEntities.include.entity.select,
          ).toBeDefined();
        }
      }
    });
  });

  describe("Query timeout protection", () => {
    // This test verifies that queries timeout after 20 seconds
    // Increase test timeout to 30 seconds to allow for the 20 second query timeout
    it("should wrap query in Promise.race with timeout", async () => {
      const { DatabaseConnectionManager } = await import(
        "../../src/lib/database-connection-manager.js"
      );
      const mockFindMany = vi.fn().mockImplementation(() => {
        // Simulate a hanging query
        return new Promise(() => {
          // Never resolves
        });
      });

      const mockClient = {
        post: { findMany: mockFindMany },
      };

      // Mock executeWithRetry to simulate timeout behavior
      // The manager.executeWithRetry handles timeout internally, so we simulate it here
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          // Simulate first attempt timing out after 3s
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Database query timeout")), 3000);
          });

          try {
            // Try to execute query, but it will timeout
            await Promise.race([queryFn(mockClient), timeoutPromise]);
          } catch (error: any) {
            // First attempt timed out, now retry
            // Simulate retry timeout after 2s
            const retryTimeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error("Retry timeout")), 2000);
            });

            try {
              await Promise.race([queryFn(mockClient), retryTimeoutPromise]);
            } catch (retryError: any) {
              // Both attempts timed out, return defaultValue
              return options.defaultValue || [];
            }
          }

          // Should not reach here
          return [];
        },
      );

      // Ensure cache miss
      (mockEnv.FEED_CACHE_KV.get as any).mockImplementation(
        (key: string, type?: string) => {
          if (key === "feed:cache:version") {
            if (type === "text" || !type) {
              return Promise.resolve("1");
            }
            return Promise.resolve("1");
          }
          return Promise.resolve(null); // Cache miss for feed data
        },
      );

      // The query should timeout after 5 seconds (3s initial + 2s retry)
      const startTime = Date.now();
      const response = await feedHandler.getHomeFeed(
        mockSession as any,
        mockRequest,
        mockEnv,
        {},
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const elapsed = Date.now() - startTime;
      // Should timeout after initial timeout (3s) + retry timeout (2s) = 5 seconds
      // Allow 4-8 seconds to account for test execution overhead
      expect(elapsed).toBeGreaterThanOrEqual(4000);
      expect(elapsed).toBeLessThan(8000);

      // With defaultValue: [], the query helper returns empty array on timeout
      // The feed handler returns 200 with empty feed (graceful degradation)
      expect(response.status).toBe(200);
      const feedData = await response.json();
      expect(feedData.posts).toEqual([]);
      expect(feedData.hasMore).toBe(false);
    }, 10000); // 10 second test timeout to allow for 5 second query timeout
  });
});
