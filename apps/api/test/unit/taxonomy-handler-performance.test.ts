/**
 * Unit Tests: Taxonomy Handler Performance Optimizations
 *
 * Tests for performance optimizations:
 * 1. SQL query includes relations (no second query)
 * 2. Caching for getDimensions and getDimensionByCode
 * 3. No redundant sorting in searchTaxons
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaxonomyHandler } from "../../src/lib/taxonomy-handler.js";
import type { PrismaClient } from "@prisma/client";
import type { KVNamespace } from "@cloudflare/workers-types";

describe("TaxonomyHandler Performance Optimizations", () => {
  let handler: TaxonomyHandler;
  let mockDb: any;
  let mockCacheKv: any;
  const tenantId = "test-tenant";

  beforeEach(() => {
    vi.clearAllMocks();

    mockCacheKv = {
      get: vi.fn(),
      put: vi.fn(),
    };

    mockDb = {
      taxonomyDimension: {
        findMany: vi.fn(),
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
      mockCacheKv as KVNamespace,
    );

    // Mock trackTagUsage to avoid errors (it's a private method)
    (handler as any).trackTagUsage = vi.fn().mockResolvedValue(undefined);
  });

  describe("Optimization 1: SQL Query Includes Relations", () => {
    it("should include category and dimension data in SQL query results", async () => {
      const mockSqlResults = [
        {
          id: "taxon-1",
          tenant_id: tenantId,
          category_id: "cat-1",
          taxon_id: "behavior:training:recall",
          display_name: "Recall Training",
          description: "Training for recall",
          order: 1,
          is_active: true,
          synonyms: ["come", "here"],
          user_terms: ["come here"],
          parent_taxon_id: null,
          translations: null,
          created_at: new Date(),
          updated_at: new Date(),
          relevance_score: 0.9,
          // Category data
          category_id_full: "cat-1",
          category_code: "training",
          category_display_name: "Training",
          category_description: "Training category",
          category_order: 1,
          category_is_active: true,
          category_created_at: new Date(),
          category_updated_at: new Date(),
          // Dimension data
          dimension_id: "dim-1",
          dimension_code: "behavior",
          dimension_display_name: "Behavior",
          dimension_description: "Behavior dimension",
          dimension_order: 1,
          dimension_is_active: true,
          dimension_created_at: new Date(),
          dimension_updated_at: new Date(),
        },
      ];

      mockDb.$queryRawUnsafe.mockResolvedValue(mockSqlResults);

      const result = await handler.searchTaxons("recall");

      // Verify only ONE query was made (no second Prisma query)
      expect(mockDb.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      expect(mockDb.taxonomyTaxon.findMany).not.toHaveBeenCalled();

      // Verify result includes category and dimension data
      expect(result).toHaveLength(1);
      expect(result[0].category).toBeDefined();
      expect(result[0].category?.code).toBe("training");
      expect(result[0].category?.dimension).toBeDefined();
      expect(result[0].category?.dimension?.code).toBe("behavior");
    });

    it("should not perform second Prisma query when SQL returns results", async () => {
      const mockSqlResults = [
        {
          id: "taxon-1",
          tenant_id: tenantId,
          category_id: "cat-1",
          taxon_id: "behavior:training:recall",
          display_name: "Recall Training",
          description: null,
          order: 1,
          is_active: true,
          synonyms: null,
          user_terms: null,
          parent_taxon_id: null,
          translations: null,
          created_at: new Date(),
          updated_at: new Date(),
          relevance_score: 0.8,
          category_id_full: "cat-1",
          category_code: "training",
          category_display_name: "Training",
          category_description: null,
          category_order: 1,
          category_is_active: true,
          category_created_at: new Date(),
          category_updated_at: new Date(),
          dimension_id: "dim-1",
          dimension_code: "behavior",
          dimension_display_name: "Behavior",
          dimension_description: null,
          dimension_order: 1,
          dimension_is_active: true,
          dimension_created_at: new Date(),
          dimension_updated_at: new Date(),
        },
      ];

      mockDb.$queryRawUnsafe.mockResolvedValue(mockSqlResults);

      await handler.searchTaxons("recall");

      // Verify no second query was made
      expect(mockDb.taxonomyTaxon.findMany).not.toHaveBeenCalled();
    });
  });

  describe("Optimization 2: Caching for getDimensions", () => {
    it("should return cached result when available", async () => {
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

      const cacheKey = `taxonomy:dimensions:${tenantId}::`;
      mockCacheKv.get.mockResolvedValue(mockDimensions);

      const result = await handler.getDimensions();

      // Should use cache
      expect(mockCacheKv.get).toHaveBeenCalledWith(cacheKey, "json");
      // Should NOT query database
      expect(mockDb.taxonomyDimension.findMany).not.toHaveBeenCalled();
      expect(result).toEqual(mockDimensions);
    });

    it("should query database and cache result when cache miss", async () => {
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

      const cacheKey = `taxonomy:dimensions:${tenantId}::`;
      mockCacheKv.get.mockResolvedValue(null); // Cache miss
      mockDb.taxonomyDimension.findMany.mockResolvedValue(mockDimensions);

      const result = await handler.getDimensions();

      // Should try cache first
      expect(mockCacheKv.get).toHaveBeenCalledWith(cacheKey, "json");
      // Should query database
      expect(mockDb.taxonomyDimension.findMany).toHaveBeenCalled();
      // Should cache the result
      expect(mockCacheKv.put).toHaveBeenCalledWith(
        cacheKey,
        JSON.stringify(mockDimensions),
        { expirationTtl: 3600 },
      );
      expect(result).toEqual(mockDimensions);
    });

    it("should use different cache keys for different options", async () => {
      mockCacheKv.get.mockResolvedValue(null);
      mockDb.taxonomyDimension.findMany.mockResolvedValue([]);

      await handler.getDimensions({ includeCategories: true });
      const cacheKey1 = `taxonomy:dimensions:${tenantId}:cats:`;
      expect(mockCacheKv.get).toHaveBeenCalledWith(cacheKey1, "json");
      mockCacheKv.get.mockClear();

      await handler.getDimensions({
        includeCategories: true,
        includeTaxons: true,
      });
      const cacheKey2 = `taxonomy:dimensions:${tenantId}:cats:taxons`;
      expect(mockCacheKv.get).toHaveBeenCalledWith(cacheKey2, "json");
    });

    it("should handle cache read errors gracefully", async () => {
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

      mockCacheKv.get.mockRejectedValue(new Error("Cache error"));
      mockDb.taxonomyDimension.findMany.mockResolvedValue(mockDimensions);

      const result = await handler.getDimensions();

      // Should fall back to database query
      expect(mockDb.taxonomyDimension.findMany).toHaveBeenCalled();
      expect(result).toEqual(mockDimensions);
    });

    it("should handle cache write errors gracefully", async () => {
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

      mockCacheKv.get.mockResolvedValue(null);
      mockDb.taxonomyDimension.findMany.mockResolvedValue(mockDimensions);
      mockCacheKv.put.mockRejectedValue(new Error("Cache write error"));

      const result = await handler.getDimensions();

      // Should still return result even if cache write fails
      expect(result).toEqual(mockDimensions);
    });
  });

  describe("Optimization 2: Caching for getDimensionByCode", () => {
    it("should return cached result when available", async () => {
      const mockDimension = {
        id: "dim-1",
        tenantId,
        code: "behavior",
        displayName: "Behavior",
        description: "Test",
        order: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        categories: [],
      };

      const cacheKey = `taxonomy:dimension:${tenantId}:behavior::`;
      mockCacheKv.get.mockResolvedValue(mockDimension);

      const result = await handler.getDimensionByCode("behavior");

      // Should use cache
      expect(mockCacheKv.get).toHaveBeenCalledWith(cacheKey, "json");
      // Should NOT query database
      expect(mockDb.taxonomyDimension.findUnique).not.toHaveBeenCalled();
      expect(result).toEqual(mockDimension);
    });

    it("should query database and cache result when cache miss", async () => {
      const mockDimension = {
        id: "dim-1",
        tenantId,
        code: "behavior",
        displayName: "Behavior",
        description: "Test",
        order: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        categories: [],
      };

      const cacheKey = `taxonomy:dimension:${tenantId}:behavior::`;
      mockCacheKv.get.mockResolvedValue(null); // Cache miss
      mockDb.taxonomyDimension.findUnique.mockResolvedValue(mockDimension);

      const result = await handler.getDimensionByCode("behavior");

      // Should try cache first
      expect(mockCacheKv.get).toHaveBeenCalledWith(cacheKey, "json");
      // Should query database
      expect(mockDb.taxonomyDimension.findUnique).toHaveBeenCalled();
      // Should cache the result
      expect(mockCacheKv.put).toHaveBeenCalledWith(
        cacheKey,
        JSON.stringify(mockDimension),
        { expirationTtl: 3600 },
      );
      expect(result).toEqual(mockDimension);
    });

    it("should not cache null results", async () => {
      mockCacheKv.get.mockResolvedValue(null);
      mockDb.taxonomyDimension.findUnique.mockResolvedValue(null);

      const result = await handler.getDimensionByCode("nonexistent");

      // Should not cache null result
      expect(mockCacheKv.put).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe("Optimization 3: No Redundant Sorting", () => {
    it("should return results in SQL order without additional sorting", async () => {
      const mockSqlResults = [
        {
          id: "taxon-1",
          tenant_id: tenantId,
          category_id: "cat-1",
          taxon_id: "behavior:training:recall",
          display_name: "Recall Training",
          description: null,
          order: 1,
          is_active: true,
          synonyms: null,
          user_terms: null,
          parent_taxon_id: null,
          translations: null,
          created_at: new Date(),
          updated_at: new Date(),
          relevance_score: 0.9,
          category_id_full: "cat-1",
          category_code: "training",
          category_display_name: "Training",
          category_description: null,
          category_order: 1,
          category_is_active: true,
          category_created_at: new Date(),
          category_updated_at: new Date(),
          dimension_id: "dim-1",
          dimension_code: "behavior",
          dimension_display_name: "Behavior",
          dimension_description: null,
          dimension_order: 1,
          dimension_is_active: true,
          dimension_created_at: new Date(),
          dimension_updated_at: new Date(),
        },
        {
          id: "taxon-2",
          tenant_id: tenantId,
          category_id: "cat-1",
          taxon_id: "behavior:training:sit",
          display_name: "Sit Training",
          description: null,
          order: 2,
          is_active: true,
          synonyms: null,
          user_terms: null,
          parent_taxon_id: null,
          translations: null,
          created_at: new Date(),
          updated_at: new Date(),
          relevance_score: 0.8,
          category_id_full: "cat-1",
          category_code: "training",
          category_display_name: "Training",
          category_description: null,
          category_order: 1,
          category_is_active: true,
          category_created_at: new Date(),
          category_updated_at: new Date(),
          dimension_id: "dim-1",
          dimension_code: "behavior",
          dimension_display_name: "Behavior",
          dimension_description: null,
          dimension_order: 1,
          dimension_is_active: true,
          dimension_created_at: new Date(),
          dimension_updated_at: new Date(),
        },
      ];

      mockDb.$queryRawUnsafe.mockResolvedValue(mockSqlResults);

      const result = await handler.searchTaxons("training");

      // Results should be in the same order as SQL results (sorted by relevance_score DESC)
      expect(result).toHaveLength(2);
      expect(result[0].taxonId).toBe("behavior:training:recall"); // Higher relevance_score
      expect(result[1].taxonId).toBe("behavior:training:sit"); // Lower relevance_score
    });
  });

  describe("Cache Key Generation", () => {
    it("should generate correct cache keys for getDimensions", async () => {
      const handler = new TaxonomyHandler(
        mockDb as unknown as PrismaClient,
        "tenant-1",
        mockCacheKv as KVNamespace,
      );

      mockCacheKv.get.mockResolvedValue(null);
      mockDb.taxonomyDimension.findMany.mockResolvedValue([]);

      await handler.getDimensions();
      expect(mockCacheKv.get).toHaveBeenCalledWith(
        "taxonomy:dimensions:tenant-1::",
        "json",
      );
      mockCacheKv.get.mockClear();

      await handler.getDimensions({ includeCategories: true });
      expect(mockCacheKv.get).toHaveBeenCalledWith(
        "taxonomy:dimensions:tenant-1:cats:",
        "json",
      );
      mockCacheKv.get.mockClear();

      await handler.getDimensions({
        includeCategories: true,
        includeTaxons: true,
      });
      expect(mockCacheKv.get).toHaveBeenCalledWith(
        "taxonomy:dimensions:tenant-1:cats:taxons",
        "json",
      );
    });

    it("should generate correct cache keys for getDimensionByCode", async () => {
      const handler = new TaxonomyHandler(
        mockDb as unknown as PrismaClient,
        "tenant-1",
        mockCacheKv as KVNamespace,
      );

      mockCacheKv.get.mockResolvedValue(null);
      mockDb.taxonomyDimension.findUnique.mockResolvedValue(null);

      await handler.getDimensionByCode("behavior");
      expect(mockCacheKv.get).toHaveBeenCalledWith(
        "taxonomy:dimension:tenant-1:behavior::",
        "json",
      );
      mockCacheKv.get.mockClear();

      await handler.getDimensionByCode("behavior", { includeCategories: true });
      expect(mockCacheKv.get).toHaveBeenCalledWith(
        "taxonomy:dimension:tenant-1:behavior:cats:",
        "json",
      );
      mockCacheKv.get.mockClear();

      await handler.getDimensionByCode("behavior", {
        includeCategories: true,
        includeTaxons: true,
      });
      expect(mockCacheKv.get).toHaveBeenCalledWith(
        "taxonomy:dimension:tenant-1:behavior:cats:taxons",
        "json",
      );
    });
  });
});
