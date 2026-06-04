/**
 * Unit Tests: Taxonomy Search
 *
 * Tests for PostgreSQL full-text search functionality.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaxonomyHandler } from "../../src/lib/taxonomy-handler.js";
import type { PrismaClient } from "@prisma/client";

describe("TaxonomyHandler - Search", () => {
  let handler: TaxonomyHandler;
  let mockDb: any;
  const tenantId = "test-tenant";

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      taxonomyTaxon: {
        findMany: vi.fn(),
      },
      $queryRawUnsafe: vi.fn(),
    };

    handler = new TaxonomyHandler(mockDb as unknown as PrismaClient, tenantId);
  });

  describe("searchTaxons", () => {
    it("should return empty array for empty query", async () => {
      const result = await handler.searchTaxons("");
      expect(result).toEqual([]);
      expect(mockDb.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it("should return empty array for whitespace-only query", async () => {
      const result = await handler.searchTaxons("   ");
      expect(result).toEqual([]);
      expect(mockDb.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it("should limit results to max 50", async () => {
      mockDb.$queryRawUnsafe.mockResolvedValue([]);
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.searchTaxons("test", { limit: 100 });

      // Should cap at 50
      expect(mockDb.$queryRawUnsafe).toHaveBeenCalled();
      const sqlCall = mockDb.$queryRawUnsafe.mock.calls[0];
      // Params array: [tenantId, searchTerm, limit, ...dimension?, ...category?]
      // sqlCall[0] = sql, sqlCall[1] = tenantId, sqlCall[2] = searchTerm, sqlCall[3] = limit
      expect(sqlCall[3]).toBeLessThanOrEqual(50); // limit parameter
    });

    it("should include tenant ID in query", async () => {
      mockDb.$queryRawUnsafe.mockResolvedValue([]);
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.searchTaxons("test");

      expect(mockDb.$queryRawUnsafe).toHaveBeenCalled();
      const sqlCall = mockDb.$queryRawUnsafe.mock.calls[0];
      const sql = sqlCall[0];
      expect(sql).toContain("t.tenant_id = $1");
      expect(sqlCall[1]).toBe(tenantId); // First parameter is tenantId
    });

    it("should filter by dimension when provided", async () => {
      mockDb.$queryRawUnsafe.mockResolvedValue([]);
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.searchTaxons("test", { dimension: "behavior" });

      expect(mockDb.$queryRawUnsafe).toHaveBeenCalled();
      const sqlCall = mockDb.$queryRawUnsafe.mock.calls[0];
      const sql = sqlCall[0];
      expect(sql).toContain("dimension");
      // Params array: [tenantId, searchTerm, limit, dimension, ...category?]
      // sqlCall[0] = sql, sqlCall[1] = tenantId, sqlCall[2] = searchTerm, sqlCall[3] = limit, sqlCall[4] = dimension
      expect(sqlCall[4]).toBe("behavior"); // dimension parameter
    });

    it("should filter by category when provided", async () => {
      mockDb.$queryRawUnsafe.mockResolvedValue([]);
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.searchTaxons("test", { category: "training" });

      expect(mockDb.$queryRawUnsafe).toHaveBeenCalled();
      const sqlCall = mockDb.$queryRawUnsafe.mock.calls[0];
      const sql = sqlCall[0];
      expect(sql).toContain("category");
      // Params array: [tenantId, searchTerm, limit, category]
      // sqlCall[0] = sql, sqlCall[1] = tenantId, sqlCall[2] = searchTerm, sqlCall[3] = limit, sqlCall[4] = category
      expect(sqlCall[4]).toBe("training"); // category parameter
    });

    it("should filter by both dimension and category when provided", async () => {
      mockDb.$queryRawUnsafe.mockResolvedValue([]);
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.searchTaxons("test", {
        dimension: "behavior",
        category: "training",
      });

      expect(mockDb.$queryRawUnsafe).toHaveBeenCalled();
      const sqlCall = mockDb.$queryRawUnsafe.mock.calls[0];
      const sql = sqlCall[0];
      expect(sql).toContain("dimension");
      expect(sql).toContain("category");
      // Params array: [tenantId, searchTerm, limit, dimension, category]
      // sqlCall[0] = sql, sqlCall[1] = tenantId, sqlCall[2] = searchTerm, sqlCall[3] = limit, sqlCall[4] = dimension, sqlCall[5] = category
      expect(sqlCall[4]).toBe("behavior");
      expect(sqlCall[5]).toBe("training");
    });

    it("should sort results by relevance score", async () => {
      // Mock SQL results - must be sorted by relevance_score DESC (as SQL does)
      // Implementation maps directly from SQL results, so mock must include all required fields
      const mockResults = [
        {
          id: "taxon-3",
          tenant_id: "tenant-1",
          category_id: "cat-1",
          taxon_id: "behavior:training:advanced",
          display_name: "Advanced Training",
          description: null,
          order: 3,
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
          id: "taxon-1",
          tenant_id: "tenant-1",
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
        {
          id: "taxon-2",
          tenant_id: "tenant-1",
          category_id: "cat-1",
          taxon_id: "behavior:training:basic",
          display_name: "Basic Obedience",
          description: null,
          order: 2,
          is_active: true,
          synonyms: null,
          user_terms: null,
          parent_taxon_id: null,
          translations: null,
          created_at: new Date(),
          updated_at: new Date(),
          relevance_score: 0.5,
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

      // Implementation maps directly from SQL results, so taxonomyTaxon.findMany is not called
      mockDb.$queryRawUnsafe.mockResolvedValue(mockResults);

      const result = await handler.searchTaxons("training");

      // Should be sorted by relevance (highest first) - SQL already sorts, so mock must be sorted
      expect(result[0].id).toBe("taxon-3"); // relevance_score: 0.9
      expect(result[1].id).toBe("taxon-1"); // relevance_score: 0.8
      expect(result[2].id).toBe("taxon-2"); // relevance_score: 0.5
    });

    it("should use SQL parameterization for security", async () => {
      mockDb.$queryRawUnsafe.mockResolvedValue([]);
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.searchTaxons("test'; DROP TABLE--");

      expect(mockDb.$queryRawUnsafe).toHaveBeenCalled();
      const sqlCall = mockDb.$queryRawUnsafe.mock.calls[0];
      // Should use parameterized query ($1, $2, etc.)
      expect(sqlCall[0]).toContain("$1");
      expect(sqlCall[0]).toContain("$2");
      // Params array: [tenantId, searchTerm, limit]
      // sqlCall[0] = sql, sqlCall[1] = tenantId, sqlCall[2] = searchTerm, sqlCall[3] = limit
      // Query should be passed as parameter, not concatenated
      expect(sqlCall[2]).toBe("test'; DROP TABLE--");
    });

    it("should fallback to Prisma query when SQL fails", async () => {
      mockDb.$queryRawUnsafe.mockRejectedValue(
        new Error("Database connection error"),
      );
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Coming when called",
          order: 1,
          category: null,
          synonyms: null,
          userTerms: null,
        },
      ]);

      const result = await handler.searchTaxons("recall");

      // Should fallback to Prisma query
      expect(mockDb.taxonomyTaxon.findMany).toHaveBeenCalled();
      expect(result.length).toBeGreaterThan(0);
    });

    it("should return empty array when no results found", async () => {
      mockDb.$queryRawUnsafe.mockResolvedValue([]);
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      const result = await handler.searchTaxons("nonexistent");

      expect(result).toEqual([]);
    });

    it("should handle default limit when not provided", async () => {
      mockDb.$queryRawUnsafe.mockResolvedValue([]);
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.searchTaxons("test");

      expect(mockDb.$queryRawUnsafe).toHaveBeenCalled();
      const sqlCall = mockDb.$queryRawUnsafe.mock.calls[0];
      // Default limit is 20, but should be capped at 50
      // sqlCall[0] = sql, sqlCall[1] = tenantId, sqlCall[2] = searchTerm, sqlCall[3] = limit
      expect(sqlCall[3]).toBeLessThanOrEqual(50);
    });

    it("should handle limit less than default", async () => {
      mockDb.$queryRawUnsafe.mockResolvedValue([]);
      mockDb.taxonomyTaxon.findMany.mockResolvedValue([]);

      await handler.searchTaxons("test", { limit: 5 });

      expect(mockDb.$queryRawUnsafe).toHaveBeenCalled();
      const sqlCall = mockDb.$queryRawUnsafe.mock.calls[0];
      // sqlCall[0] = sql, sqlCall[1] = tenantId, sqlCall[2] = searchTerm, sqlCall[3] = limit
      expect(sqlCall[3]).toBe(5);
    });

    it("should map results correctly with category and dimension", async () => {
      // Mock SQL results - must include all fields that implementation expects
      const mockResults = [
        {
          id: "taxon-1",
          tenant_id: "tenant-1",
          category_id: "cat-1",
          taxon_id: "behavior:training:recall",
          display_name: "Recall Training",
          description: "Coming when called",
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

      // Implementation maps directly from SQL results, so taxonomyTaxon.findMany is not called
      mockDb.$queryRawUnsafe.mockResolvedValue(mockResults);

      const result = await handler.searchTaxons("recall");

      expect(result.length).toBe(1);
      expect(result[0].taxonId).toBe("behavior:training:recall");
      expect(result[0].category).toBeDefined();
      expect(result[0].category?.code).toBe("training");
      expect(result[0].category?.dimension?.code).toBe("behavior");
    });
  });
});
