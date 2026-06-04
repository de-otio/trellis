/**
 * Unit Tests: Post Taxonomy Tags
 *
 * Tests for post taxonomy tagging functionality.
 * Note: Full route tests are complex due to Cloudflare Workers context mocking.
 * These tests focus on the core logic that can be unit tested.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaxonomyHandler } from "../../src/lib/taxonomy-handler.js";
import type { PrismaClient } from "@prisma/client";

describe("Post Taxonomy Tags", () => {
  let handler: TaxonomyHandler;
  let mockDb: any;
  const tenantId = "test-tenant";

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      taxonomyTaxon: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
      postTaxonomyTag: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
        findMany: vi.fn(),
      },
    };

    handler = new TaxonomyHandler(mockDb as unknown as PrismaClient, tenantId);

    // Mock trackTagUsage to avoid errors (it's a private method)
    (handler as any).trackTagUsage = vi.fn().mockResolvedValue(undefined);
  });

  describe("addPostTaxonomyTags", () => {
    it("should add taxonomy tags to post", async () => {
      const postId = "post-123";
      const taxonIds = ["behavior:training:recall", "life-stage:puppy"];
      const addedBy = "user-123";

      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
        { id: "taxon-2", taxonId: "life-stage:puppy" },
      ];

      mockDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.postTaxonomyTag.createMany.mockResolvedValue({ count: 2 });

      await handler.addPostTaxonomyTags(postId, taxonIds, addedBy);

      expect(mockDb.taxonomyTaxon.findMany).toHaveBeenCalledWith({
        where: {
          tenantId,
          taxonId: { in: taxonIds },
          isActive: true,
        },
      });

      expect(mockDb.postTaxonomyTag.createMany).toHaveBeenCalledWith({
        data: [
          { postId, taxonId: "taxon-1", addedBy },
          { postId, taxonId: "taxon-2", addedBy },
        ],
        skipDuplicates: true,
      });
    });

    it("should throw error when taxons not found", async () => {
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await expect(
        handler.addPostTaxonomyTags("post-123", ["invalid-taxon"], "user-123"),
      ).rejects.toThrow("One or more taxons not found or inactive");
    });

    it("should throw error when some taxons not found", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      mockDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);

      await expect(
        handler.addPostTaxonomyTags(
          "post-123",
          ["behavior:training:recall", "invalid-taxon"],
          "user-123",
        ),
      ).rejects.toThrow("One or more taxons not found or inactive");
    });

    it("should skip duplicates when adding tags", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      mockDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.postTaxonomyTag.createMany.mockResolvedValue({ count: 1 });

      // First call
      await handler.addPostTaxonomyTags(
        "post-123",
        ["behavior:training:recall"],
        "user-123",
      );

      // Second call with same tag (should skip duplicate)
      await handler.addPostTaxonomyTags(
        "post-123",
        ["behavior:training:recall"],
        "user-123",
      );

      expect(mockDb.postTaxonomyTag.createMany).toHaveBeenCalledTimes(2);
      expect(mockDb.postTaxonomyTag.createMany).toHaveBeenCalledWith({
        data: [{ postId: "post-123", taxonId: "taxon-1", addedBy: "user-123" }],
        skipDuplicates: true,
      });
    });
  });

  describe("removePostTaxonomyTags", () => {
    it("should remove taxonomy tags from post", async () => {
      const postId = "post-123";
      const taxonIds = ["behavior:training:recall"];

      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      mockDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.postTaxonomyTag.deleteMany.mockResolvedValue({ count: 1 });

      await handler.removePostTaxonomyTags(postId, taxonIds);

      expect(mockDb.postTaxonomyTag.deleteMany).toHaveBeenCalledWith({
        where: {
          postId,
          taxonId: { in: ["taxon-1"] },
        },
      });
    });

    it("should handle empty taxon list gracefully", async () => {
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.removePostTaxonomyTags("post-123", []);

      expect(mockDb.postTaxonomyTag.deleteMany).not.toHaveBeenCalled();
    });

    it("should handle non-existent taxons gracefully", async () => {
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.removePostTaxonomyTags("post-123", ["invalid-taxon"]);

      expect(mockDb.postTaxonomyTag.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("getPostTaxonomyTags", () => {
    it("should return taxonomy tags for post", async () => {
      const postId = "post-123";
      const mockTags = [
        {
          id: "tag-1",
          postId,
          taxonId: "taxon-1",
          taxon: {
            id: "taxon-1",
            taxonId: "behavior:training:recall",
            displayName: "Recall Training",
            description: "Coming when called",
            category: {
              id: "cat-1",
              code: "training",
              displayName: "Training Topics",
              dimension: {
                id: "dim-1",
                code: "behavior",
                displayName: "Behavior",
              },
            },
          },
        },
      ];

      mockDb.postTaxonomyTag.findMany.mockResolvedValue(mockTags);

      const result = await handler.getPostTaxonomyTags(postId);

      expect(mockDb.postTaxonomyTag.findMany).toHaveBeenCalledWith({
        where: { postId },
        include: {
          taxon: {
            include: {
              category: {
                include: {
                  dimension: true,
                },
              },
            },
          },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0].taxonId).toBe("behavior:training:recall");
    });

    it("should return empty array when post has no tags", async () => {
      mockDb.postTaxonomyTag.findMany.mockResolvedValue([]);

      const result = await handler.getPostTaxonomyTags("post-123");

      expect(result).toEqual([]);
    });
  });
});
