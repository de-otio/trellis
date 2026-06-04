/**
 * Unit Tests: Taxonomy Handler
 *
 * Tests for taxonomy operations including dimensions, categories, taxons, and tagging.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaxonomyHandler } from "../../src/lib/taxonomy-handler.js";
import type { PrismaClient } from "@prisma/client";

describe("TaxonomyHandler", () => {
  let handler: TaxonomyHandler;
  let mockDb: any;
  const tenantId = "test-tenant";

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      taxonomyDimension: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
      },
      taxonomyCategory: {
        findMany: vi.fn(),
      },
      taxonomyTaxon: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
      postTaxonomyTag: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
        findMany: vi.fn(),
      },
      entityTaxonomyTag: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
        findMany: vi.fn(),
      },
      $queryRawUnsafe: vi.fn(),
    };

    handler = new TaxonomyHandler(
      mockDb as unknown as PrismaClient,
      tenantId,
      undefined,
    );

    // Mock trackTagUsage to avoid errors (it's a private method)
    (handler as any).trackTagUsage = vi.fn().mockResolvedValue(undefined);
  });

  describe("getDimensions", () => {
    it("should return all active dimensions for tenant", async () => {
      const mockDimensions = [
        {
          id: "dim-1",
          tenantId,
          code: "behavior",
          displayName: "Behavior",
          description: "Test",
          order: 1,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockDb.taxonomyDimension.findMany.mockResolvedValue(mockDimensions);

      const result = await handler.getDimensions();

      expect(mockDb.taxonomyDimension.findMany).toHaveBeenCalledWith({
        where: {
          tenantId,
          isActive: true,
        },
        include: {
          categories: false,
        },
        orderBy: { order: "asc" },
      });
      expect(result).toEqual(mockDimensions);
    });

    it("should include categories when requested", async () => {
      mockDb.taxonomyDimension.findMany.mockResolvedValue([]);

      await handler.getDimensions({ includeCategories: true });

      expect(mockDb.taxonomyDimension.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            categories: expect.objectContaining({
              where: { isActive: true },
              include: expect.objectContaining({
                taxons: false,
              }),
              orderBy: { order: "asc" },
            }),
          }),
        }),
      );
    });

    it("should include taxons when requested", async () => {
      mockDb.taxonomyDimension.findMany.mockResolvedValue([]);

      await handler.getDimensions({
        includeCategories: true,
        includeTaxons: true,
      });

      expect(mockDb.taxonomyDimension.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            categories: expect.objectContaining({
              where: { isActive: true },
              include: expect.objectContaining({
                taxons: expect.objectContaining({
                  where: { isActive: true },
                }),
              }),
              orderBy: { order: "asc" },
            }),
          }),
        }),
      );
    });
  });

  describe("getDimensionByCode", () => {
    it("should return dimension by code", async () => {
      const mockDimension = {
        id: "dim-1",
        tenantId,
        code: "behavior",
        displayName: "Behavior",
        categories: [],
      };

      mockDb.taxonomyDimension.findUnique.mockResolvedValue(mockDimension);

      const result = await handler.getDimensionByCode("behavior");

      expect(mockDb.taxonomyDimension.findUnique).toHaveBeenCalledWith({
        where: {
          tenantId_code: {
            tenantId,
            code: "behavior",
          },
          isActive: true,
        },
        include: {
          categories: false,
        },
      });
      expect(result).toEqual(mockDimension);
    });

    it("should return null when dimension not found", async () => {
      mockDb.taxonomyDimension.findUnique.mockResolvedValue(null);

      const result = await handler.getDimensionByCode("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("searchTaxons", () => {
    it("should search taxons by query string", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          tenantId,
          categoryId: "cat-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Coming when called",
          order: 1,
          isActive: true,
          synonyms: ["come", "off-leash"],
          userTerms: ["coming-when-called"],
          parentTaxonId: null,
          translations: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          category: {
            id: "cat-1",
            dimension: {
              id: "dim-1",
              code: "behavior",
            },
          },
        },
      ];

      mockDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);

      const result = await handler.searchTaxons("recall");

      expect(mockDb.taxonomyTaxon.findMany).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].taxonId).toBe("behavior:training:recall");
    });

    it("should filter by dimension when provided", async () => {
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.searchTaxons("recall", { dimension: "behavior" });

      expect(mockDb.taxonomyTaxon.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            category: expect.objectContaining({
              dimension: expect.objectContaining({
                code: "behavior",
              }),
            }),
          }),
        }),
      );
    });

    it("should filter by category when provided", async () => {
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.searchTaxons("recall", { category: "training" });

      expect(mockDb.taxonomyTaxon.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            category: expect.objectContaining({
              code: "training",
            }),
          }),
        }),
      );
    });

    it("should respect limit", async () => {
      const manyTaxons = Array.from({ length: 30 }, (_, i) => ({
        id: `taxon-${i}`,
        tenantId,
        taxonId: `behavior:training:taxon-${i}`,
        displayName: `Taxon ${i}`,
        description: null,
        order: i,
        isActive: true,
        synonyms: null,
        userTerms: null,
        parentTaxonId: null,
        translations: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        category: {
          id: "cat-1",
          dimension: { id: "dim-1", code: "behavior" },
        },
      }));

      // Mock SQL query to return limited results
      mockDb.$queryRawUnsafe.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({
          id: `taxon-${i}`,
          relevance_score: 0.9 - i * 0.05,
        })),
      );
      mockDb.taxonomyTaxon.findMany.mockResolvedValue(manyTaxons.slice(0, 10));

      const result = await handler.searchTaxons("taxon", { limit: 10 });

      expect(result.length).toBeLessThanOrEqual(10);
    });

    it("should filter by synonyms and userTerms", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          tenantId,
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Test",
          synonyms: ["come", "off-leash-training"],
          userTerms: ["coming-when-called"],
          category: {
            id: "cat-1",
            dimension: { id: "dim-1", code: "behavior" },
          },
        },
        {
          id: "taxon-2",
          tenantId,
          taxonId: "behavior:training:other",
          displayName: "Other",
          description: "Test",
          synonyms: null,
          userTerms: null,
          category: {
            id: "cat-1",
            dimension: { id: "dim-1", code: "behavior" },
          },
        },
      ];

      mockDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);

      // Search for synonym
      const result1 = await handler.searchTaxons("come");
      expect(result1.length).toBeGreaterThan(0);

      // Search for userTerm
      const result2 = await handler.searchTaxons("coming-when-called");
      expect(result2.length).toBeGreaterThan(0);
    });
  });

  describe("getTaxonByTaxonId", () => {
    it("should return taxon by taxonId", async () => {
      const mockTaxon = {
        id: "taxon-1",
        tenantId,
        taxonId: "behavior:training:recall",
        displayName: "Recall Training",
        category: {
          id: "cat-1",
          dimension: {
            id: "dim-1",
            code: "behavior",
          },
        },
      };

      mockDb.taxonomyTaxon.findFirst.mockResolvedValue(mockTaxon);

      const result = await handler.getTaxonByTaxonId(
        "behavior:training:recall",
      );

      expect(mockDb.taxonomyTaxon.findFirst).toHaveBeenCalledWith({
        where: {
          tenantId,
          taxonId: "behavior:training:recall",
          isActive: true,
        },
        include: {
          category: {
            include: {
              dimension: true,
            },
          },
        },
      });
      expect(result).toEqual(mockTaxon);
    });

    it("should return null when taxon not found", async () => {
      mockDb.taxonomyTaxon.findFirst.mockResolvedValue(null);

      const result = await handler.getTaxonByTaxonId("nonexistent:taxon:id");

      expect(result).toBeNull();
    });
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
            category: {
              id: "cat-1",
              dimension: { id: "dim-1", code: "behavior" },
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
  });

  describe("addEntityTaxonomyTags", () => {
    it("should add taxonomy tags to entity", async () => {
      const entityId = "entity-123";
      const taxonIds = ["behavior:training:recall"];

      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      mockDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.entityTaxonomyTag.createMany.mockResolvedValue({ count: 1 });

      await handler.addEntityTaxonomyTags(entityId, taxonIds);

      expect(mockDb.entityTaxonomyTag.createMany).toHaveBeenCalledWith({
        data: [{ entityId, taxonId: "taxon-1" }],
        skipDuplicates: true,
      });
    });

    it("should throw error when taxons not found", async () => {
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await expect(
        handler.addEntityTaxonomyTags("entity-123", ["invalid-taxon"]),
      ).rejects.toThrow("One or more taxons not found or inactive");
    });
  });

  describe("removeEntityTaxonomyTags", () => {
    it("should remove taxonomy tags from entity", async () => {
      const entityId = "entity-123";
      const taxonIds = ["behavior:training:recall"];

      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      mockDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.entityTaxonomyTag.deleteMany.mockResolvedValue({ count: 1 });

      await handler.removeEntityTaxonomyTags(entityId, taxonIds);

      expect(mockDb.entityTaxonomyTag.deleteMany).toHaveBeenCalledWith({
        where: {
          entityId,
          taxonId: { in: ["taxon-1"] },
        },
      });
    });
  });

  describe("getEntityTaxonomyTags", () => {
    it("should return taxonomy tags for entity", async () => {
      const entityId = "entity-123";
      const mockTags = [
        {
          id: "tag-1",
          entityId,
          taxonId: "taxon-1",
          taxon: {
            id: "taxon-1",
            taxonId: "behavior:training:recall",
            displayName: "Recall Training",
            category: {
              id: "cat-1",
              dimension: { id: "dim-1", code: "behavior" },
            },
          },
        },
      ];

      mockDb.entityTaxonomyTag.findMany.mockResolvedValue(mockTags);

      const result = await handler.getEntityTaxonomyTags(entityId);

      expect(result).toHaveLength(1);
      expect(result[0].taxonId).toBe("behavior:training:recall");
    });
  });
});
