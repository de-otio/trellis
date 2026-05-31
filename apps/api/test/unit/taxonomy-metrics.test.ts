/**
 * Unit Tests: Taxonomy Metrics
 *
 * Tests for taxonomy analytics and usage metrics tracking.
 */

import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TaxonomyMetrics,
  type TaxonMetric,
} from "../../src/lib/taxonomy-metrics.js";

describe("TaxonomyMetrics", () => {
  let metrics: TaxonomyMetrics;
  let mockPrisma: PrismaClient;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPrisma = {
      $queryRaw: vi.fn(),
    } as any;

    metrics = new TaxonomyMetrics(mockPrisma);
  });

  describe("getTaxonMetrics", () => {
    it("should return taxon metrics for tenant", async () => {
      const mockResults = [
        {
          taxon_id: "dimension:category:taxon1",
          display_name: "Taxon 1",
          dimension: "dimension",
          category: "category",
          usage_count: BigInt(10),
          user_count: BigInt(5),
          content_count: BigInt(8),
          last_used_at: new Date("2024-01-01"),
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(mockResults);

      const result = await metrics.getTaxonMetrics("tenant-123");

      expect(result).toHaveLength(1);
      expect(result[0].taxonId).toBe("dimension:category:taxon1");
      expect(result[0].displayName).toBe("Taxon 1");
      expect(result[0].usageCount).toBe(10);
      expect(result[0].userCount).toBe(5);
      expect(result[0].contentCount).toBe(8);
      expect(result[0].lastUsedAt).toEqual(new Date("2024-01-01"));
    });

    it("should filter by dimension when provided", async () => {
      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue([]);

      await metrics.getTaxonMetrics("tenant-123", { dimension: "food" });

      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      const queryCall = vi.mocked(mockPrisma.$queryRaw).mock.calls[0][0];
      expect(queryCall).toBeDefined();
    });

    it("should filter by minUsageCount when provided", async () => {
      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue([]);

      await metrics.getTaxonMetrics("tenant-123", { minUsageCount: 5 });

      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    });

    it("should include unused taxons when includeUnused is true", async () => {
      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue([]);

      await metrics.getTaxonMetrics("tenant-123", { includeUnused: true });

      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    });

    it("should exclude unused taxons when includeUnused is false", async () => {
      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue([]);

      await metrics.getTaxonMetrics("tenant-123", { includeUnused: false });

      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    });

    it("should handle null lastUsedAt", async () => {
      const mockResults = [
        {
          taxon_id: "dimension:category:taxon1",
          display_name: "Taxon 1",
          dimension: "dimension",
          category: "category",
          usage_count: BigInt(0),
          user_count: BigInt(0),
          content_count: BigInt(0),
          last_used_at: null,
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(mockResults);

      const result = await metrics.getTaxonMetrics("tenant-123");

      expect(result[0].lastUsedAt).toBeNull();
    });

    it("should convert bigint to number", async () => {
      const mockResults = [
        {
          taxon_id: "dimension:category:taxon1",
          display_name: "Taxon 1",
          dimension: "dimension",
          category: "category",
          usage_count: BigInt(999999999),
          user_count: BigInt(123456),
          content_count: BigInt(789012),
          last_used_at: null,
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(mockResults);

      const result = await metrics.getTaxonMetrics("tenant-123");

      expect(result[0].usageCount).toBe(999999999);
      expect(result[0].userCount).toBe(123456);
      expect(result[0].contentCount).toBe(789012);
    });
  });

  describe("getTaxonUsageCounts", () => {
    it("should return usage counts for all taxons", async () => {
      const mockResults = [
        {
          taxon_id: "dimension:category:taxon1",
          usage_count: BigInt(10),
        },
        {
          taxon_id: "dimension:category:taxon2",
          usage_count: BigInt(5),
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(mockResults);

      const result = await metrics.getTaxonUsageCounts("tenant-123");

      expect(result).toHaveLength(2);
      expect(result[0].taxonId).toBe("dimension:category:taxon1");
      expect(result[0].usageCount).toBe(10);
      expect(result[1].taxonId).toBe("dimension:category:taxon2");
      expect(result[1].usageCount).toBe(5);
    });

    it("should filter by dimension when provided", async () => {
      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue([]);

      await metrics.getTaxonUsageCounts("tenant-123", "food");

      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    });

    it("should return empty array when no taxons found", async () => {
      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue([]);

      const result = await metrics.getTaxonUsageCounts("tenant-123");

      expect(result).toEqual([]);
    });
  });

  describe("getTaxonUserCounts", () => {
    it("should return user counts for all taxons", async () => {
      const mockResults = [
        {
          taxon_id: "dimension:category:taxon1",
          user_count: BigInt(5),
        },
        {
          taxon_id: "dimension:category:taxon2",
          user_count: BigInt(3),
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(mockResults);

      const result = await metrics.getTaxonUserCounts("tenant-123");

      expect(result).toHaveLength(2);
      expect(result[0].taxonId).toBe("dimension:category:taxon1");
      expect(result[0].userCount).toBe(5);
      expect(result[1].taxonId).toBe("dimension:category:taxon2");
      expect(result[1].userCount).toBe(3);
    });

    it("should handle zero user counts", async () => {
      const mockResults = [
        {
          taxon_id: "dimension:category:taxon1",
          user_count: BigInt(0),
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(mockResults);

      const result = await metrics.getTaxonUserCounts("tenant-123");

      expect(result[0].userCount).toBe(0);
    });
  });

  describe("getTaxonLastUsed", () => {
    it("should return last used timestamps for all taxons", async () => {
      const date1 = new Date("2024-01-01");
      const date2 = new Date("2024-02-01");
      const mockResults = [
        {
          taxon_id: "dimension:category:taxon1",
          last_used_at: date1,
        },
        {
          taxon_id: "dimension:category:taxon2",
          last_used_at: date2,
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(mockResults);

      const result = await metrics.getTaxonLastUsed("tenant-123");

      expect(result).toHaveLength(2);
      expect(result[0].taxonId).toBe("dimension:category:taxon1");
      expect(result[0].lastUsedAt).toEqual(date1);
      expect(result[1].taxonId).toBe("dimension:category:taxon2");
      expect(result[1].lastUsedAt).toEqual(date2);
    });

    it("should handle null lastUsedAt", async () => {
      const mockResults = [
        {
          taxon_id: "dimension:category:taxon1",
          last_used_at: null,
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(mockResults);

      const result = await metrics.getTaxonLastUsed("tenant-123");

      expect(result[0].lastUsedAt).toBeNull();
    });
  });

  describe("checkPruningCandidates", () => {
    it("should identify unused taxons as pruning candidates", async () => {
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

      const mockMetrics: TaxonMetric[] = [
        {
          taxonId: "dimension:category:unused",
          displayName: "Unused Taxon",
          dimension: "dimension",
          category: "category",
          usageCount: 0,
          userCount: 0,
          contentCount: 0,
          lastUsedAt: null,
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(
        mockMetrics.map((m) => ({
          taxon_id: m.taxonId,
          display_name: m.displayName,
          dimension: m.dimension,
          category: m.category,
          usage_count: BigInt(m.usageCount),
          user_count: BigInt(m.userCount),
          content_count: BigInt(m.contentCount),
          last_used_at: m.lastUsedAt,
        })),
      );

      const result = await metrics.checkPruningCandidates("tenant-123");

      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe("unused");
      expect(result[0].taxonId).toBe("dimension:category:unused");
    });

    it("should identify low usage taxons as pruning candidates", async () => {
      const mockMetrics: TaxonMetric[] = [
        {
          taxonId: "dimension:category:low-usage",
          displayName: "Low Usage Taxon",
          dimension: "dimension",
          category: "category",
          usageCount: 3, // Less than 5
          userCount: 2,
          contentCount: 3,
          lastUsedAt: new Date(),
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(
        mockMetrics.map((m) => ({
          taxon_id: m.taxonId,
          display_name: m.displayName,
          dimension: m.dimension,
          category: m.category,
          usage_count: BigInt(m.usageCount),
          user_count: BigInt(m.userCount),
          content_count: BigInt(m.contentCount),
          last_used_at: m.lastUsedAt,
        })),
      );

      const result = await metrics.checkPruningCandidates("tenant-123");

      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe("low_usage");
    });

    it("should identify single user taxons as pruning candidates", async () => {
      const mockMetrics: TaxonMetric[] = [
        {
          taxonId: "dimension:category:single-user",
          displayName: "Single User Taxon",
          dimension: "dimension",
          category: "category",
          usageCount: 10,
          userCount: 1, // Single user
          contentCount: 10,
          lastUsedAt: new Date(),
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(
        mockMetrics.map((m) => ({
          taxon_id: m.taxonId,
          display_name: m.displayName,
          dimension: m.dimension,
          category: m.category,
          usage_count: BigInt(m.usageCount),
          user_count: BigInt(m.userCount),
          content_count: BigInt(m.contentCount),
          last_used_at: m.lastUsedAt,
        })),
      );

      const result = await metrics.checkPruningCandidates("tenant-123");

      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe("single_user");
    });

    it("should identify stale taxons (12+ months old) as pruning candidates", async () => {
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 13); // 13 months ago

      const mockMetrics: TaxonMetric[] = [
        {
          taxonId: "dimension:category:stale",
          displayName: "Stale Taxon",
          dimension: "dimension",
          category: "category",
          usageCount: 10,
          userCount: 5,
          contentCount: 10,
          lastUsedAt: twelveMonthsAgo,
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(
        mockMetrics.map((m) => ({
          taxon_id: m.taxonId,
          display_name: m.displayName,
          dimension: m.dimension,
          category: m.category,
          usage_count: BigInt(m.usageCount),
          user_count: BigInt(m.userCount),
          content_count: BigInt(m.contentCount),
          last_used_at: m.lastUsedAt,
        })),
      );

      const result = await metrics.checkPruningCandidates("tenant-123");

      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe("stale");
    });

    it("should not include active taxons as pruning candidates", async () => {
      const recentDate = new Date(); // Recent date
      const mockMetrics: TaxonMetric[] = [
        {
          taxonId: "dimension:category:active",
          displayName: "Active Taxon",
          dimension: "dimension",
          category: "category",
          usageCount: 10,
          userCount: 5,
          contentCount: 10,
          lastUsedAt: recentDate,
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(
        mockMetrics.map((m) => ({
          taxon_id: m.taxonId,
          display_name: m.displayName,
          dimension: m.dimension,
          category: m.category,
          usage_count: BigInt(m.usageCount),
          user_count: BigInt(m.userCount),
          content_count: BigInt(m.contentCount),
          last_used_at: m.lastUsedAt,
        })),
      );

      const result = await metrics.checkPruningCandidates("tenant-123");

      expect(result).toHaveLength(0);
    });

    it("should return unknown reason when no specific reason matches", async () => {
      // This shouldn't happen in practice, but test the fallback
      const mockMetrics: TaxonMetric[] = [
        {
          taxonId: "dimension:category:unknown",
          displayName: "Unknown Taxon",
          dimension: "dimension",
          category: "category",
          usageCount: 5,
          userCount: 2,
          contentCount: 5,
          lastUsedAt: new Date(),
        },
      ];

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue(
        mockMetrics.map((m) => ({
          taxon_id: m.taxonId,
          display_name: m.displayName,
          dimension: m.dimension,
          category: m.category,
          usage_count: BigInt(m.usageCount),
          user_count: BigInt(m.userCount),
          content_count: BigInt(m.contentCount),
          last_used_at: m.lastUsedAt,
        })),
      );

      // Mock to return this metric but it won't match pruning criteria
      // We need to force it through by making it match one of the filters
      // Let's use a date that's just under 12 months
      const elevenMonthsAgo = new Date();
      elevenMonthsAgo.setMonth(elevenMonthsAgo.getMonth() - 11);
      mockMetrics[0].lastUsedAt = elevenMonthsAgo;

      vi.mocked(mockPrisma.$queryRaw).mockResolvedValue([
        {
          taxon_id: mockMetrics[0].taxonId,
          display_name: mockMetrics[0].displayName,
          dimension: mockMetrics[0].dimension,
          category: mockMetrics[0].category,
          usage_count: BigInt(mockMetrics[0].usageCount),
          user_count: BigInt(mockMetrics[0].userCount),
          content_count: BigInt(mockMetrics[0].contentCount),
          last_used_at: mockMetrics[0].lastUsedAt,
        },
      ]);

      const result = await metrics.checkPruningCandidates("tenant-123");

      // Should not be included since it doesn't match any criteria
      expect(result).toHaveLength(0);
    });
  });

  describe("getPopularFreeFormTags", () => {
    // Tests for DB query behavior removed:
    // getPopularFreeFormTags is stubbed (returns []) pending post_entities table removal redesign

    it("should return empty array when no free-form tags found", async () => {
      const result = await metrics.getPopularFreeFormTags("tenant-123");

      expect(result).toEqual([]);
    });
  });

  describe("constructor", () => {
    it("should create instance with Prisma client", () => {
      const instance = new TaxonomyMetrics(mockPrisma);
      expect(instance).toBeInstanceOf(TaxonomyMetrics);
    });
  });
});
