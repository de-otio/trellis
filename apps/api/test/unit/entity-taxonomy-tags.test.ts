/**
 * Unit Tests: Entity Taxonomy Tags
 *
 * Tests for entity taxonomy tagging functionality.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaxonomyHandler } from "../../src/lib/taxonomy-handler.js";
import type { PrismaClient } from "@prisma/client";

describe("Entity Taxonomy Tags", () => {
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
      entityTaxonomyTag: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
        findMany: vi.fn(),
      },
    };

    handler = new TaxonomyHandler(mockDb as unknown as PrismaClient, tenantId);

    // Mock trackTagUsage to avoid errors (it's a private method)
    (handler as any).trackTagUsage = vi.fn().mockResolvedValue(undefined);
  });

  describe("addEntityTaxonomyTags", () => {
    it("should add taxonomy tags to entity", async () => {
      const entityId = "entity-123";
      const taxonIds = ["behavior:training:recall", "life-stage:puppy"];

      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
        { id: "taxon-2", taxonId: "life-stage:puppy" },
      ];

      mockDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.entityTaxonomyTag.createMany.mockResolvedValue({ count: 2 });

      await handler.addEntityTaxonomyTags(entityId, taxonIds);

      expect(mockDb.taxonomyTaxon.findMany).toHaveBeenCalledWith({
        where: {
          tenantId,
          taxonId: { in: taxonIds },
          isActive: true,
        },
      });

      expect(mockDb.entityTaxonomyTag.createMany).toHaveBeenCalledWith({
        data: [
          { entityId, taxonId: "taxon-1" },
          { entityId, taxonId: "taxon-2" },
        ],
        skipDuplicates: true,
      });
    });

    it("should throw error when taxons not found", async () => {
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await expect(
        handler.addEntityTaxonomyTags("entity-123", ["invalid-taxon"]),
      ).rejects.toThrow("One or more taxons not found or inactive");
    });

    it("should skip duplicates when adding tags", async () => {
      const mockTaxons = [
        { id: "taxon-1", taxonId: "behavior:training:recall" },
      ];

      mockDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.entityTaxonomyTag.createMany.mockResolvedValue({ count: 1 });

      // First call
      await handler.addEntityTaxonomyTags("entity-123", [
        "behavior:training:recall",
      ]);

      // Second call with same tag (should skip duplicate)
      await handler.addEntityTaxonomyTags("entity-123", [
        "behavior:training:recall",
      ]);

      expect(mockDb.entityTaxonomyTag.createMany).toHaveBeenCalledTimes(2);
      expect(mockDb.entityTaxonomyTag.createMany).toHaveBeenCalledWith({
        data: [{ entityId: "entity-123", taxonId: "taxon-1" }],
        skipDuplicates: true,
      });
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

    it("should handle empty taxon list gracefully", async () => {
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.removeEntityTaxonomyTags("entity-123", []);

      expect(mockDb.entityTaxonomyTag.deleteMany).not.toHaveBeenCalled();
    });

    it("should handle non-existent taxons gracefully", async () => {
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.removeEntityTaxonomyTags("entity-123", ["invalid-taxon"]);

      expect(mockDb.entityTaxonomyTag.deleteMany).not.toHaveBeenCalled();
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

      mockDb.entityTaxonomyTag.findMany.mockResolvedValue(mockTags);

      const result = await handler.getEntityTaxonomyTags(entityId);

      expect(mockDb.entityTaxonomyTag.findMany).toHaveBeenCalledWith({
        where: { entityId },
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

    it("should return empty array when entity has no tags", async () => {
      mockDb.entityTaxonomyTag.findMany.mockResolvedValue([]);

      const result = await handler.getEntityTaxonomyTags("entity-123");

      expect(result).toEqual([]);
    });
  });
});
