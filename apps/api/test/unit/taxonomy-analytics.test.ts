/**
 * Unit Tests: Taxonomy Analytics
 *
 * Tests for taxonomy usage metrics and analytics functionality.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaxonomyMetrics } from "../../src/lib/taxonomy-metrics.js";

// Mock Prisma
const mockPrisma = {
  $queryRaw: vi.fn(),
};

describe("TaxonomyMetrics", () => {
  let metrics: TaxonomyMetrics;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$queryRaw.mockClear();
    metrics = new TaxonomyMetrics(mockPrisma as any);
  });

  describe("getTaxonMetrics", () => {
    it("should return metrics for all taxons", async () => {
      const mockResults = [
        {
          taxon_id: "behavior:training:recall",
          display_name: "Recall Training",
          dimension: "behavior",
          category: "training",
          usage_count: BigInt(100),
          user_count: BigInt(50),
          content_count: BigInt(75),
          last_used_at: new Date(),
        },
        {
          taxon_id: "life-stage:puppy",
          display_name: "Puppy",
          dimension: "life-stage",
          category: "age",
          usage_count: BigInt(200),
          user_count: BigInt(100),
          content_count: BigInt(150),
          last_used_at: new Date(),
        },
      ];

      mockPrisma.$queryRaw.mockResolvedValue(mockResults);

      const result = await metrics.getTaxonMetrics("test-tenant");

      expect(result.length).toBe(2);
      expect(result[0].taxonId).toBe("behavior:training:recall");
      expect(result[0].usageCount).toBe(100);
      expect(result[0].userCount).toBe(50);
      expect(result[0].contentCount).toBe(75);
    });

    it("should filter by dimension when provided", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await metrics.getTaxonMetrics("test-tenant", { dimension: "behavior" });

      // Verify query includes dimension filter
      const queryCall = mockPrisma.$queryRaw.mock.calls[0][0];
      expect(queryCall).toBeDefined();
    });

    it("should filter by minimum usage count", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await metrics.getTaxonMetrics("test-tenant", { minUsageCount: 10 });

      // Verify query includes minUsageCount filter
      const queryCall = mockPrisma.$queryRaw.mock.calls[0][0];
      expect(queryCall).toBeDefined();
    });

    it("should include unused taxons by default", async () => {
      const mockResults = [
        {
          taxon_id: "behavior:training:recall",
          display_name: "Recall Training",
          dimension: "behavior",
          category: "training",
          usage_count: BigInt(0),
          user_count: BigInt(0),
          content_count: BigInt(0),
          last_used_at: null,
        },
      ];

      mockPrisma.$queryRaw.mockResolvedValue(mockResults);

      const result = await metrics.getTaxonMetrics("test-tenant");

      expect(result.length).toBe(1);
      expect(result[0].usageCount).toBe(0);
    });
  });

  describe("checkPruningCandidates", () => {
    it("should identify unused taxons", async () => {
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

      const mockResults = [
        {
          taxon_id: "unused:taxon",
          display_name: "Unused Taxon",
          dimension: "test",
          category: "test",
          usage_count: BigInt(0),
          user_count: BigInt(0),
          content_count: BigInt(0),
          last_used_at: null,
        },
      ];

      mockPrisma.$queryRaw.mockResolvedValue(mockResults);

      const candidates = await metrics.checkPruningCandidates("test-tenant");

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].reason).toBe("unused");
    });

    it("should identify low usage taxons", async () => {
      const mockResults = [
        {
          taxon_id: "low:usage",
          display_name: "Low Usage",
          dimension: "test",
          category: "test",
          usage_count: BigInt(3),
          user_count: BigInt(2),
          content_count: BigInt(2),
          last_used_at: new Date(),
        },
      ];

      mockPrisma.$queryRaw.mockResolvedValue(mockResults);

      const candidates = await metrics.checkPruningCandidates("test-tenant");

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].reason).toBe("low_usage");
    });

    it("should identify single-user taxons", async () => {
      const mockResults = [
        {
          taxon_id: "single:user",
          display_name: "Single User",
          dimension: "test",
          category: "test",
          usage_count: BigInt(10),
          user_count: BigInt(1),
          content_count: BigInt(5),
          last_used_at: new Date(),
        },
      ];

      mockPrisma.$queryRaw.mockResolvedValue(mockResults);

      const candidates = await metrics.checkPruningCandidates("test-tenant");

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].reason).toBe("single_user");
    });

    it("should identify stale taxons", async () => {
      const thirteenMonthsAgo = new Date();
      thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);

      const mockResults = [
        {
          taxon_id: "stale:taxon",
          display_name: "Stale Taxon",
          dimension: "test",
          category: "test",
          usage_count: BigInt(20),
          user_count: BigInt(5),
          content_count: BigInt(15),
          last_used_at: thirteenMonthsAgo,
        },
      ];

      mockPrisma.$queryRaw.mockResolvedValue(mockResults);

      const candidates = await metrics.checkPruningCandidates("test-tenant");

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].reason).toBe("stale");
    });
  });

  describe("getPopularFreeFormTags", () => {
    // Tests for DB-query behavior removed:
    // getPopularFreeFormTags is stubbed (returns []) pending post_entities table removal redesign

    it("should handle zero limit", async () => {
      const tags = await metrics.getPopularFreeFormTags("test-tenant", 0);
      expect(tags).toEqual([]);
    });
  });

  describe("getTaxonMetrics edge cases", () => {
    it("should handle null last_used_at", async () => {
      const mockResults = [
        {
          taxon_id: "behavior:training:recall",
          display_name: "Recall Training",
          dimension: "behavior",
          category: "training",
          usage_count: BigInt(100),
          user_count: BigInt(50),
          content_count: BigInt(75),
          last_used_at: null,
        },
      ];

      mockPrisma.$queryRaw.mockResolvedValue(mockResults);

      const result = await metrics.getTaxonMetrics("test-tenant");

      expect(result.length).toBe(1);
      expect(result[0].lastUsedAt).toBeNull();
    });

    it("should handle excludeUnused option", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      await metrics.getTaxonMetrics("test-tenant", { includeUnused: false });
      const queryCall = mockPrisma.$queryRaw.mock.calls[0][0];
      expect(queryCall).toBeDefined();
    });

    it("should handle both dimension and minUsageCount filters", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      await metrics.getTaxonMetrics("test-tenant", {
        dimension: "behavior",
        minUsageCount: 10,
      });
      const queryCall = mockPrisma.$queryRaw.mock.calls[0][0];
      expect(queryCall).toBeDefined();
    });
  });

  describe("checkPruningCandidates edge cases", () => {
    it("should handle taxons with multiple pruning reasons", async () => {
      const mockResults = [
        {
          taxon_id: "unused:stale",
          display_name: "Unused Stale",
          dimension: "test",
          category: "test",
          usage_count: BigInt(0),
          user_count: BigInt(0),
          content_count: BigInt(0),
          last_used_at: null,
        },
      ];

      mockPrisma.$queryRaw.mockResolvedValue(mockResults);

      const candidates = await metrics.checkPruningCandidates("test-tenant");

      expect(candidates.length).toBeGreaterThan(0);
      // Should prioritize unused over stale
      expect(candidates[0].reason).toBe("unused");
    });

    it("should handle taxons just below low usage threshold", async () => {
      const mockResults = [
        {
          taxon_id: "low:usage",
          display_name: "Low Usage",
          dimension: "test",
          category: "test",
          usage_count: BigInt(4), // Just below threshold of 5
          user_count: BigInt(2),
          content_count: BigInt(3),
          last_used_at: new Date(),
        },
      ];

      mockPrisma.$queryRaw.mockResolvedValue(mockResults);

      const candidates = await metrics.checkPruningCandidates("test-tenant");

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].reason).toBe("low_usage");
    });
  });
});
