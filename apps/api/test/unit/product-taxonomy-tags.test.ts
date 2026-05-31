/**
 * Unit Tests: Product Taxonomy Tags
 *
 * Tests for product taxonomy tagging functionality.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaxonomyHandler } from "../../src/lib/taxonomy-handler.js";
import type { PrismaClient } from "@prisma/client";

describe("TaxonomyHandler - Product Taxonomy Tags", () => {
  let mockDb: any;
  let handler: TaxonomyHandler;
  const tenantId = "test-tenant";

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      taxonomyTaxon: {
        findMany: vi.fn(),
      },
      productTaxonomyTag: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
        findMany: vi.fn(),
      },
    };

    handler = new TaxonomyHandler(mockDb as any, tenantId);

    // Mock trackTagUsage to avoid errors (it's a private method)
    (handler as any).trackTagUsage = vi.fn().mockResolvedValue(undefined);
  });

  describe("addProductTaxonomyTags", () => {
    it("should add taxonomy tags to product", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          tenantId,
          isActive: true,
        },
        {
          id: "taxon-2",
          taxonId: "life-stage:puppy",
          tenantId,
          isActive: true,
        },
      ];

      mockDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.productTaxonomyTag.createMany.mockResolvedValue({ count: 2 });

      await handler.addProductTaxonomyTags("product-123", [
        "behavior:training:recall",
        "life-stage:puppy",
      ]);

      expect(mockDb.taxonomyTaxon.findMany).toHaveBeenCalledWith({
        where: {
          tenantId,
          taxonId: { in: ["behavior:training:recall", "life-stage:puppy"] },
          isActive: true,
        },
      });

      expect(mockDb.productTaxonomyTag.createMany).toHaveBeenCalledWith({
        data: [
          { tenantId, productId: "product-123", taxonId: "taxon-1" },
          { tenantId, productId: "product-123", taxonId: "taxon-2" },
        ],
        skipDuplicates: true,
      });
    });

    it("should throw error if taxon not found", async () => {
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          tenantId,
          isActive: true,
        },
      ]);

      await expect(
        handler.addProductTaxonomyTags("product-123", [
          "behavior:training:recall",
          "life-stage:puppy",
        ]),
      ).rejects.toThrow("One or more taxons not found or inactive");
    });

    it("should throw error if taxon is inactive", async () => {
      // When taxon is inactive, findMany with isActive: true filter returns empty array
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await expect(
        handler.addProductTaxonomyTags("product-123", [
          "behavior:training:recall",
        ]),
      ).rejects.toThrow("One or more taxons not found or inactive");
    });
  });

  describe("removeProductTaxonomyTags", () => {
    it("should remove taxonomy tags from product", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          tenantId,
        },
      ];

      mockDb.taxonomyTaxon.findMany.mockResolvedValue(mockTaxons);
      mockDb.productTaxonomyTag.deleteMany.mockResolvedValue({ count: 1 });

      await handler.removeProductTaxonomyTags("product-123", [
        "behavior:training:recall",
      ]);

      expect(mockDb.productTaxonomyTag.deleteMany).toHaveBeenCalledWith({
        where: {
          tenantId,
          productId: "product-123",
          taxonId: { in: ["taxon-1"] },
        },
      });
    });

    it("should return early if no taxons found", async () => {
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.removeProductTaxonomyTags("product-123", [
        "behavior:training:recall",
      ]);

      expect(mockDb.productTaxonomyTag.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("getProductTaxonomyTags", () => {
    it("should return taxonomy tags for product", async () => {
      const mockTags = [
        {
          taxon: {
            id: "taxon-1",
            taxonId: "behavior:training:recall",
            displayName: "Recall Training",
            description: "Training for recall commands",
            category: {
              code: "training",
              displayName: "Training",
              dimension: {
                code: "behavior",
                displayName: "Behavior",
              },
            },
          },
        },
      ];

      mockDb.productTaxonomyTag.findMany.mockResolvedValue(mockTags);

      const result = await handler.getProductTaxonomyTags("product-123");

      expect(result.length).toBe(1);
      expect(result[0].taxonId).toBe("behavior:training:recall");
      expect(result[0].displayName).toBe("Recall Training");
    });

    it("should return empty array if product has no tags", async () => {
      mockDb.productTaxonomyTag.findMany.mockResolvedValue([]);

      const result = await handler.getProductTaxonomyTags("product-123");

      expect(result).toEqual([]);
    });
  });
});
