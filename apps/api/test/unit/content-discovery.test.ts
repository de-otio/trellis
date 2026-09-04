/**
 * Unit Tests: Content Discovery
 *
 * Tests for taxonomy-based content discovery functionality.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentDiscovery } from "../../src/lib/content-discovery.js";
import type { PrismaClient } from "@prisma/client";

// Mock dependencies before imports
vi.mock("../../src/lib/data-router", () => {
  const mockDb = {
    postTaxonomyTag: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    post: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    entityTaxonomyTag: {
      groupBy: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
    // M2: the block seam reads through this delegate. Default = no blocks.
    blockedUser: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  return {
    DataRouter: {
      getDatabaseForRegion: vi.fn().mockReturnValue(mockDb),
    },
  };
});

vi.mock("../../src/lib/database-wrapper-helper", () => {
  const mockWrappedDb = {
    taxonomyTaxon: {
      findMany: vi.fn(),
    },
  };
  return {
    getWrappedDatabase: vi.fn(
      (region: string, env: any, request: Request) => mockWrappedDb,
    ),
  };
});

// Mock FeedPersonalization - will be reset per test
const mockGetEntityTaxonomyTags = vi
  .fn()
  .mockResolvedValue(["behavior:training:recall", "life-stage:puppy"]);

vi.mock("../../src/lib/feed-personalization", () => ({
  FeedPersonalization: {
    getEntityTaxonomyTags: (...args: any[]) =>
      mockGetEntityTaxonomyTags(...args),
  },
}));

describe("ContentDiscovery", () => {
  const tenantId = "test-tenant";
  const region = "US";

  // Get mocked instances
  let mockDb: any;
  let mockWrappedDb: any;
  let mockRequest: Request;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create a mock request object
    mockRequest = new Request("https://example.com/api/test", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    // Reset the mock to return default values
    mockGetEntityTaxonomyTags.mockResolvedValue([
      "behavior:training:recall",
      "life-stage:puppy",
    ]);

    // Get mocked instances
    const { DataRouter } = await import("../../src/lib/data-router.js");
    const { getWrappedDatabase } = await import(
      "../../src/lib/database-wrapper-helper.js"
    );

    mockDb = DataRouter.getDatabaseForRegion(region, {} as any, mockRequest);
    mockWrappedDb = getWrappedDatabase(region, {} as any, mockRequest);

    // Reset all mock implementations to ensure clean state
    mockDb.postTaxonomyTag.findMany.mockReset();
    mockDb.post.findUnique.mockReset();
    mockDb.post.findMany.mockReset();
    mockDb.user.findMany.mockReset();
    mockWrappedDb.taxonomyTaxon.findMany.mockReset();
  });

  describe("getRelatedContent", () => {
    it("should return empty array when post has no taxonomy tags", async () => {
      mockDb.postTaxonomyTag.findMany.mockResolvedValue([]);

      const result = await ContentDiscovery.getRelatedContent(
        "post-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
      );

      expect(result).toEqual([]);
    });

    it("should find related posts with matching taxonomy tags", async () => {
      const mockPostTags = [
        {
          taxon: {
            id: "taxon-1",
            taxonId: "behavior:training:recall",
            displayName: "Recall Training",
          },
        },
        {
          taxon: {
            id: "taxon-2",
            taxonId: "life-stage:puppy",
            displayName: "Puppy",
          },
        },
      ];

      const mockRelatedPosts = [
        {
          post: { id: "post-2", createdAt: new Date() },
          taxon: { taxonId: "behavior:training:recall" },
        },
        {
          post: { id: "post-3", createdAt: new Date() },
          taxon: { taxonId: "life-stage:puppy" },
        },
        {
          post: { id: "post-2", createdAt: new Date() },
          taxon: { taxonId: "life-stage:puppy" },
        },
      ];

      mockDb.postTaxonomyTag.findMany
        .mockResolvedValueOnce(mockPostTags)
        .mockResolvedValueOnce(mockRelatedPosts);
      mockDb.post.findUnique.mockResolvedValue({ authorId: "user-123" });

      const result = await ContentDiscovery.getRelatedContent(
        "post-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
        { limit: 10 },
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].postId).toBe("post-2"); // Should have 2 matching tags
      expect(result[0].matchingTags.length).toBe(2);
    });

    it("should exclude posts from same author by default", async () => {
      const mockPostTags = [
        {
          taxon: {
            id: "taxon-1",
            taxonId: "behavior:training:recall",
            displayName: "Recall Training",
          },
        },
      ];

      mockDb.postTaxonomyTag.findMany
        .mockResolvedValueOnce(mockPostTags)
        .mockResolvedValueOnce([]);
      mockDb.post.findUnique.mockResolvedValue({ authorId: "user-123" });

      await ContentDiscovery.getRelatedContent(
        "post-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
      );

      // Verify query excludes same author
      const findManyCall = mockDb.postTaxonomyTag.findMany.mock.calls[1][0];
      expect(findManyCall.where.post.authorId.not).toBe("user-123");
    });

    it("should include posts from same author when includeSameAuthor is true", async () => {
      const mockPostTags = [
        {
          taxon: {
            id: "taxon-1",
            taxonId: "behavior:training:recall",
            displayName: "Recall Training",
          },
        },
      ];

      mockDb.postTaxonomyTag.findMany
        .mockResolvedValueOnce(mockPostTags)
        .mockResolvedValueOnce([]);
      mockDb.post.findUnique.mockResolvedValue({ authorId: "user-123" });

      await ContentDiscovery.getRelatedContent(
        "post-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
        { includeSameAuthor: true },
      );

      // Verify query doesn't exclude same author
      const findManyCall = mockDb.postTaxonomyTag.findMany.mock.calls[1][0];
      expect(findManyCall.where.post.authorId).toBeUndefined();
    });

    it("should filter by minimum matching tags", async () => {
      const mockPostTags = [
        {
          taxon: {
            id: "taxon-1",
            taxonId: "behavior:training:recall",
            displayName: "Recall Training",
          },
        },
        {
          taxon: {
            id: "taxon-2",
            taxonId: "life-stage:puppy",
            displayName: "Puppy",
          },
        },
      ];

      const mockRelatedPosts = [
        {
          post: { id: "post-2", createdAt: new Date() },
          taxon: { taxonId: "behavior:training:recall" },
        },
        {
          post: { id: "post-3", createdAt: new Date() },
          taxon: { taxonId: "life-stage:puppy" },
        },
      ];

      mockDb.postTaxonomyTag.findMany
        .mockResolvedValueOnce(mockPostTags)
        .mockResolvedValueOnce(mockRelatedPosts);
      mockDb.post.findUnique.mockResolvedValue({ authorId: "user-123" });

      const result = await ContentDiscovery.getRelatedContent(
        "post-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
        { minMatchingTags: 2 },
      );

      // Should filter out posts with only 1 matching tag
      expect(result.length).toBe(0);
    });

    it("should calculate relevance scores correctly", async () => {
      const mockPostTags = [
        {
          taxon: {
            id: "taxon-1",
            taxonId: "behavior:training:recall",
            displayName: "Recall Training",
          },
        },
      ];

      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 1); // 1 day ago

      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 30); // 30 days ago

      const mockRelatedPosts = [
        {
          post: { id: "post-recent", createdAt: recentDate },
          taxon: { taxonId: "behavior:training:recall" },
        },
        {
          post: { id: "post-old", createdAt: oldDate },
          taxon: { taxonId: "behavior:training:recall" },
        },
      ];

      mockDb.postTaxonomyTag.findMany
        .mockResolvedValueOnce(mockPostTags)
        .mockResolvedValueOnce(mockRelatedPosts);
      mockDb.post.findUnique.mockResolvedValue({ authorId: "user-123" });

      const result = await ContentDiscovery.getRelatedContent(
        "post-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
      );

      // Recent post should have higher relevance
      expect(result[0].postId).toBe("post-recent");
      expect(result[0].relevanceScore).toBeGreaterThan(
        result[1].relevanceScore,
      );
    });
  });

  describe("getTrendingTopics", () => {
    it("should return trending topics sorted by usage count", async () => {
      const mockPostTagCounts = [
        { taxonId: "taxon-1", _count: { postId: 100 } },
        { taxonId: "taxon-2", _count: { postId: 50 } },
        { taxonId: "taxon-3", _count: { postId: 75 } },
      ];

      const mockEntityTagCounts = [
        { taxonId: "taxon-1", _count: { entityId: 10 } },
        { taxonId: "taxon-2", _count: { entityId: 5 } },
      ];

      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
        },
        { id: "taxon-2", taxonId: "life-stage:puppy", displayName: "Puppy" },
        {
          id: "taxon-3",
          taxonId: "context:location:park",
          displayName: "Dog Park",
        },
      ];

      mockDb.postTaxonomyTag.groupBy.mockResolvedValue(mockPostTagCounts);
      mockDb.entityTaxonomyTag.groupBy.mockResolvedValue(mockEntityTagCounts);
      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);

      const result = await ContentDiscovery.getTrendingTopics(
        tenantId,
        region,
        {} as any,
        mockRequest,
        { limit: 10, period: "week" },
      );

      expect(result.length).toBe(3);
      expect(result[0].usageCount).toBe(100); // Highest usage
      expect(result[0].taxonId).toBe("behavior:training:recall");
      expect(result[1].usageCount).toBe(75);
      expect(result[2].usageCount).toBe(50);
    });

    it("should filter by time period", async () => {
      mockDb.postTaxonomyTag.groupBy.mockResolvedValue([]);
      mockDb.entityTaxonomyTag.groupBy.mockResolvedValue([]);
      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await ContentDiscovery.getTrendingTopics(
        tenantId,
        region,
        {} as any,
        mockRequest,
        { period: "day" },
      );

      // Verify groupBy was called with date filter
      const groupByCall = mockDb.postTaxonomyTag.groupBy.mock.calls[0][0];
      expect(groupByCall.where.post.createdAt.gte).toBeInstanceOf(Date);
    });

    it("should include entity counts", async () => {
      const mockPostTagCounts = [
        { taxonId: "taxon-1", _count: { postId: 100 } },
      ];

      const mockEntityTagCounts = [
        { taxonId: "taxon-1", _count: { entityId: 25 } },
      ];

      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
        },
      ];

      mockDb.postTaxonomyTag.groupBy.mockResolvedValue(mockPostTagCounts);
      mockDb.entityTaxonomyTag.groupBy.mockResolvedValue(mockEntityTagCounts);
      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);

      const result = await ContentDiscovery.getTrendingTopics(
        tenantId,
        region,
        {} as any,
        mockRequest,
      );

      expect(result[0].entityCount).toBe(25);
      expect(result[0].postCount).toBe(100);
    });
  });

  describe("getContentRecommendations", () => {
    it("should return empty array when user has no entity tags", async () => {
      mockGetEntityTaxonomyTags.mockResolvedValueOnce([]);

      const result = await ContentDiscovery.getContentRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
      );

      expect(result).toEqual([]);
    });

    it("should recommend posts based on entity taxonomy tags", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
        { id: "taxon-2", taxonId: "life-stage:puppy" },
      ];

      const mockRecommendedPosts = [
        {
          post: { id: "post-1", createdAt: new Date() },
          taxon: { taxonId: "behavior:training:recall" },
        },
        {
          post: { id: "post-2", createdAt: new Date() },
          taxon: { taxonId: "life-stage:puppy" },
        },
      ];

      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.postTaxonomyTag.findMany.mockResolvedValue(mockRecommendedPosts);

      const result = await ContentDiscovery.getContentRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
        { limit: 10 },
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].matchingTags.length).toBeGreaterThan(0);
      expect(result[0].reason).toContain("dog's interests");
    });

    it("should exclude user's own posts", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.postTaxonomyTag.findMany.mockResolvedValue([]);

      await ContentDiscovery.getContentRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
      );

      // Verify query excludes user's posts
      const findManyCall = mockDb.postTaxonomyTag.findMany.mock.calls[0][0];
      expect(findManyCall.where.post.authorId.not).toBe("user-123");
    });

    it("should calculate relevance scores", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
        { id: "taxon-2", taxonId: "life-stage:puppy" },
      ];

      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 1);

      const mockRecommendedPosts = [
        {
          post: { id: "post-1", createdAt: recentDate },
          taxon: { taxonId: "behavior:training:recall" },
        },
        {
          post: { id: "post-1", createdAt: recentDate },
          taxon: { taxonId: "life-stage:puppy" },
        },
      ];

      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.postTaxonomyTag.findMany.mockResolvedValue(mockRecommendedPosts);

      const result = await ContentDiscovery.getContentRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
      );

      expect(result[0].relevanceScore).toBeGreaterThan(0);
      expect(result[0].relevanceScore).toBeLessThanOrEqual(1);
    });
  });

  describe("getCreatorRecommendations", () => {
    it("should return empty array when user has no entity tags", async () => {
      mockGetEntityTaxonomyTags.mockResolvedValueOnce([]);

      const result = await ContentDiscovery.getCreatorRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
      );

      expect(result).toEqual([]);
    });

    it("should recommend creators based on taxonomy tag overlap", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
        { id: "taxon-2", taxonId: "life-stage:puppy" },
      ];

      const mockPostsWithTags = [
        {
          post: { id: "post-1", authorId: "creator-1" },
          taxon: { id: "taxon-1", taxonId: "behavior:training:recall" },
        },
        {
          post: { id: "post-2", authorId: "creator-1" },
          taxon: { id: "taxon-2", taxonId: "life-stage:puppy" },
        },
      ];

      const mockAllTags = [
        {
          taxon: { taxonId: "behavior:training:recall" },
        },
        {
          taxon: { taxonId: "life-stage:puppy" },
        },
        {
          taxon: { taxonId: "context:location:park" },
        },
      ];

      const mockCreators = [
        {
          id: "creator-1",
          email: "creator@example.com",
          username: "creator1",
        },
      ];

      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.postTaxonomyTag.findMany
        .mockResolvedValueOnce(mockPostsWithTags)
        .mockResolvedValueOnce(mockAllTags);
      mockDb.user.findMany.mockResolvedValue(mockCreators);

      const result = await ContentDiscovery.getCreatorRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
        { limit: 10, minPostCount: 1 },
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].userId).toBe("creator-1");
      expect(result[0].matchingTags.length).toBeGreaterThan(0);
      expect(result[0].specializationTags.length).toBeGreaterThan(0);
    });

    it("should filter by minimum post count", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      const mockPostsWithTags = [
        {
          post: { id: "post-1", authorId: "creator-1" },
          taxon: { id: "taxon-1", taxonId: "behavior:training:recall" },
        },
      ];

      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.postTaxonomyTag.findMany
        .mockResolvedValueOnce(mockPostsWithTags)
        .mockResolvedValueOnce([]);
      mockDb.user.findMany.mockResolvedValue([]);

      const result = await ContentDiscovery.getCreatorRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
        { minPostCount: 5 }, // Require 5 posts
      );

      // Should filter out creator with only 1 post
      expect(result.length).toBe(0);
    });

    it("should filter by minimum matching tags", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
        { id: "taxon-2", taxonId: "life-stage:puppy" },
      ];

      const mockPostsWithTags = [
        {
          post: { id: "post-1", authorId: "creator-1" },
          taxon: { id: "taxon-1", taxonId: "behavior:training:recall" },
        },
      ];

      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.postTaxonomyTag.findMany
        .mockResolvedValueOnce(mockPostsWithTags)
        .mockResolvedValueOnce([]);
      mockDb.user.findMany.mockResolvedValue([]);

      const result = await ContentDiscovery.getCreatorRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
        { minMatchingTags: 2 }, // Require 2 matching tags
      );

      // Should filter out creator with only 1 matching tag
      expect(result.length).toBe(0);
    });

    it("should exclude requesting user from recommendations", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.postTaxonomyTag.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockDb.user.findMany.mockResolvedValue([]); // Mock user.findMany to return empty array

      await ContentDiscovery.getCreatorRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
      );

      // Verify query excludes self
      const findManyCall = mockDb.postTaxonomyTag.findMany.mock.calls[0][0];
      expect(findManyCall.where.post.authorId.not).toBe("user-123");
    });

    it("should calculate relevance scores correctly", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      const mockPostsWithTags = [
        {
          post: { id: "post-1", authorId: "creator-1" },
          taxon: { id: "taxon-1", taxonId: "behavior:training:recall" },
        },
        {
          post: { id: "post-2", authorId: "creator-1" },
          taxon: { id: "taxon-1", taxonId: "behavior:training:recall" },
        },
        {
          post: { id: "post-3", authorId: "creator-1" },
          taxon: { id: "taxon-1", taxonId: "behavior:training:recall" },
        },
      ];

      // Mock all tags for creator's posts (includes matching and non-matching)
      // Note: These should match the taxonId from mockTaxons, not the id
      const mockAllTags = [
        {
          taxon: { taxonId: "behavior:training:recall" },
        },
        {
          taxon: { taxonId: "behavior:training:recall" },
        },
        {
          taxon: { taxonId: "behavior:training:recall" },
        },
        {
          taxon: { taxonId: "context:location:park" },
        },
      ];

      // Ensure the mock returns tags for the specific postIds being queried
      // The implementation queries by postId, so we need to return tags for those posts

      const mockCreators = [
        {
          id: "creator-1",
          email: "creator@example.com",
          username: "creator1",
        },
      ];

      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);

      // Mock implementation to handle multiple calls
      // The implementation makes:
      // 1. First call: find posts with matching taxonomy tags (where.taxonId.in)
      // 2. Subsequent calls: find all tags for each creator's posts (where.postId.in)
      mockDb.postTaxonomyTag.findMany.mockImplementation((args: any) => {
        // First call: matching posts (has taxonId filter in where clause)
        if (args?.where?.taxonId?.in) {
          return Promise.resolve(mockPostsWithTags);
        }
        // Subsequent calls: all tags for creator's posts (has postId filter in where clause)
        // The query filters by postId.in, so return tags for those specific posts
        if (args?.where?.postId?.in) {
          // Return tags for the posts being queried
          // Since we're querying post-1, post-2, post-3, return tags for all of them
          return Promise.resolve(mockAllTags);
        }
        return Promise.resolve([]);
      });
      mockDb.user.findMany.mockResolvedValue(mockCreators);

      // Ensure mock returns the expected entity tags
      mockGetEntityTaxonomyTags.mockResolvedValue(["behavior:training:recall"]);

      const result = await ContentDiscovery.getCreatorRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
        { minPostCount: 1, minMatchingTags: 1 },
      );

      // The test should pass - if it doesn't, the issue is in the mock setup
      // The implementation requires:
      // 1. First findMany returns posts with matching tags (mockPostsWithTags)
      // 2. Second findMany (per creator) returns all tags for that creator's posts (mockAllTags)
      // 3. User findMany returns the creator
      // The matching tags are set in the first loop based on taxonIdMap lookup
      expect(result.length).toBeGreaterThan(0);
      if (result.length > 0) {
        expect(result[0].relevanceScore).toBeGreaterThan(0);
        expect(result[0].relevanceScore).toBeLessThanOrEqual(1);
        expect(result[0].postCount).toBeGreaterThan(0);
        expect(result[0].userId).toBe("creator-1");
        expect(result[0].matchingTags.length).toBeGreaterThan(0);
        expect(result[0].specializationTags.length).toBeGreaterThan(0);
      }
    });

    it("should include specialization tags in recommendations", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      const mockPostsWithTags = [
        {
          post: { id: "post-1", authorId: "creator-1" },
          taxon: { id: "taxon-1", taxonId: "behavior:training:recall" },
        },
      ];

      // Creator specializes in multiple topics
      const mockAllTags = [
        { taxon: { taxonId: "behavior:training:recall" } },
        { taxon: { taxonId: "behavior:training:recall" } },
        { taxon: { taxonId: "behavior:training:recall" } },
        { taxon: { taxonId: "context:location:park" } },
        { taxon: { taxonId: "context:location:park" } },
        { taxon: { taxonId: "life-stage:puppy" } },
      ];

      const mockCreators = [
        {
          id: "creator-1",
          email: "creator@example.com",
        },
      ];

      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      let callCount = 0;
      mockDb.postTaxonomyTag.findMany.mockImplementation((args: any) => {
        callCount++;
        if (args?.where?.taxonId?.in) {
          return Promise.resolve(mockPostsWithTags);
        }
        if (args?.where?.postId?.in) {
          return Promise.resolve(mockAllTags);
        }
        return Promise.resolve([]);
      });
      mockDb.user.findMany.mockResolvedValue(mockCreators);

      const result = await ContentDiscovery.getCreatorRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
        { minPostCount: 1 },
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].specializationTags.length).toBeGreaterThan(0);
      // Should include top specialization tags
      expect(result[0].specializationTags.length).toBeLessThanOrEqual(5);
    });

    it("should exclude suspended users from recommendations", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      const mockPostsWithTags = [
        {
          post: { id: "post-1", authorId: "creator-1" },
          taxon: { id: "taxon-1", taxonId: "behavior:training:recall" },
        },
      ];

      const mockAllTags = [{ taxon: { taxonId: "behavior:training:recall" } }];

      // Creator is suspended
      const mockCreators: any[] = []; // Empty array simulates suspended user filtered out

      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      let callCount = 0;
      mockDb.postTaxonomyTag.findMany.mockImplementation((args: any) => {
        callCount++;
        if (args?.where?.taxonId?.in) {
          return Promise.resolve(mockPostsWithTags);
        }
        if (args?.where?.postId?.in) {
          return Promise.resolve(mockAllTags);
        }
        return Promise.resolve([]);
      });
      mockDb.user.findMany.mockResolvedValue(mockCreators);

      const result = await ContentDiscovery.getCreatorRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
        { minPostCount: 1 },
      );

      // Should exclude suspended creators
      expect(result.length).toBe(0);
    });

    it("should sort recommendations by relevance score", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      // Two creators with different post counts
      const mockPostsWithTags = [
        {
          post: { id: "post-1", authorId: "creator-1" },
          taxon: { id: "taxon-1", taxonId: "behavior:training:recall" },
        },
        {
          post: { id: "post-2", authorId: "creator-2" },
          taxon: { id: "taxon-1", taxonId: "behavior:training:recall" },
        },
        {
          post: { id: "post-3", authorId: "creator-2" },
          taxon: { id: "taxon-1", taxonId: "behavior:training:recall" },
        },
        {
          post: { id: "post-4", authorId: "creator-2" },
          taxon: { id: "taxon-1", taxonId: "behavior:training:recall" },
        },
      ];

      const mockAllTagsCreator1 = [
        { taxon: { taxonId: "behavior:training:recall" } },
      ];

      const mockAllTagsCreator2 = [
        { taxon: { taxonId: "behavior:training:recall" } },
        { taxon: { taxonId: "behavior:training:recall" } },
        { taxon: { taxonId: "behavior:training:recall" } },
        { taxon: { taxonId: "behavior:training:recall" } },
      ];

      const mockCreators = [
        { id: "creator-1", email: "creator1@example.com" },
        { id: "creator-2", email: "creator2@example.com" },
      ];

      mockWrappedDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      let callCount = 0;
      mockDb.postTaxonomyTag.findMany.mockImplementation((args: any) => {
        callCount++;
        if (args?.where?.taxonId?.in) {
          return Promise.resolve(mockPostsWithTags);
        }
        if (args?.where?.postId?.in) {
          // Return different tags based on which creator's posts we're querying
          const postIds = args.where.postId.in;
          if (postIds.includes("post-1")) {
            return Promise.resolve(mockAllTagsCreator1);
          }
          return Promise.resolve(mockAllTagsCreator2);
        }
        return Promise.resolve([]);
      });
      mockDb.user.findMany.mockResolvedValue(mockCreators);

      const result = await ContentDiscovery.getCreatorRecommendations(
        "user-123",
        tenantId,
        region,
        {} as any,
        mockRequest,
        { minPostCount: 1, limit: 10 },
      );

      expect(result.length).toBeGreaterThan(1);
      // Should be sorted by relevance (descending)
      for (let i = 0; i < result.length - 1; i++) {
        expect(result[i].relevanceScore).toBeGreaterThanOrEqual(
          result[i + 1].relevanceScore,
        );
      }
    });
  });
});
