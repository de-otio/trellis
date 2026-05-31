/**
 * Unit tests for TaxonomySearchMetrics
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaxonomySearchMetrics } from "../../src/lib/taxonomy-search-metrics.js";

describe("TaxonomySearchMetrics", () => {
  let mockKv: any;
  let metrics: TaxonomySearchMetrics;

  beforeEach(() => {
    mockKv = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
    };

  });

  describe("constructor", () => {
    it("should create instance with KV and enabled by default", () => {
      metrics = new TaxonomySearchMetrics(mockKv);

      expect(metrics).toBeInstanceOf(TaxonomySearchMetrics);
    });

    it("should create instance with enabled flag", () => {
      metrics = new TaxonomySearchMetrics(mockKv, true);

      expect(metrics).toBeInstanceOf(TaxonomySearchMetrics);
    });

    it("should create instance with disabled flag", () => {
      metrics = new TaxonomySearchMetrics(mockKv, false);

      expect(metrics).toBeInstanceOf(TaxonomySearchMetrics);
    });

    it("should create instance without KV", () => {
      metrics = new TaxonomySearchMetrics(undefined);

      expect(metrics).toBeInstanceOf(TaxonomySearchMetrics);
    });
  });

  describe("trackSearch", () => {
    beforeEach(() => {
      metrics = new TaxonomySearchMetrics(mockKv, true);
    });

    it("should track search metrics when enabled", async () => {
      const searchMetrics = {
        query: "test query",
        resultCount: 5,
        timestamp: Date.now(),
        dimension: "dog",
        category: "breed",
        tenantId: "tenant-123",
        userId: "user-456",
      };

      await metrics.trackSearch(searchMetrics);

      expect(mockKv.put).toHaveBeenCalledTimes(2); // One for metrics, one for counter
      expect(mockKv.put).toHaveBeenCalledWith(
        expect.stringMatching(/^search:metrics:tenant-123:\d+:/),
        JSON.stringify(searchMetrics),
        { expirationTtl: 86400 * 30 },
      );
    });

    it("should not track when disabled", async () => {
      metrics = new TaxonomySearchMetrics(mockKv, false);

      await metrics.trackSearch({
        query: "test",
        resultCount: 0,
        timestamp: Date.now(),
        tenantId: "tenant-123",
      });

      expect(mockKv.put).not.toHaveBeenCalled();
    });

    it("should not track when KV is not provided", async () => {
      metrics = new TaxonomySearchMetrics(undefined, true);

      await metrics.trackSearch({
        query: "test",
        resultCount: 0,
        timestamp: Date.now(),
        tenantId: "tenant-123",
      });

      expect(mockKv.put).not.toHaveBeenCalled();
    });

    it("should handle errors gracefully", async () => {
      const error = new Error("KV error");
      mockKv.put.mockRejectedValueOnce(error);

      await metrics.trackSearch({
        query: "test",
        resultCount: 0,
        timestamp: Date.now(),
        tenantId: "tenant-123",
      });

          });

    it("should increment query counter", async () => {
      await metrics.trackSearch({
        query: "Test Query",
        resultCount: 5,
        timestamp: Date.now(),
        tenantId: "tenant-123",
      });

      expect(mockKv.get).toHaveBeenCalledWith(
        "search:counter:tenant-123:test query",
      );
      expect(mockKv.put).toHaveBeenCalledWith(
        "search:counter:tenant-123:test query",
        "1",
        { expirationTtl: 86400 * 90 },
      );
    });

    it("should increment existing counter", async () => {
      mockKv.get.mockResolvedValueOnce("5");

      await metrics.trackSearch({
        query: "existing query",
        resultCount: 3,
        timestamp: Date.now(),
        tenantId: "tenant-123",
      });

      expect(mockKv.put).toHaveBeenCalledWith(
        "search:counter:tenant-123:existing query",
        "6",
        { expirationTtl: 86400 * 90 },
      );
    });

    it("should handle counter increment errors gracefully", async () => {
      const error = new Error("Counter error");
      mockKv.get.mockRejectedValueOnce(error);

      await metrics.trackSearch({
        query: "test",
        resultCount: 0,
        timestamp: Date.now(),
        tenantId: "tenant-123",
      });

          });

    it("should normalize query for counter key", async () => {
      await metrics.trackSearch({
        query: "  TEST QUERY  ",
        resultCount: 0,
        timestamp: Date.now(),
        tenantId: "tenant-123",
      });

      expect(mockKv.get).toHaveBeenCalledWith(
        "search:counter:tenant-123:test query",
      );
    });
  });

  describe("getSearchSummary", () => {
    beforeEach(() => {
      metrics = new TaxonomySearchMetrics(mockKv, true);
    });

    it("should return empty summary (placeholder implementation)", async () => {
      const summary = await metrics.getSearchSummary("tenant-123");

      expect(summary).toEqual({
        totalQueries: 0,
        uniqueQueries: 0,
        averageResultCount: 0,
        topQueries: [],
        queriesWithNoResults: 0,
      });
    });

    it("should accept days parameter", async () => {
      const summary = await metrics.getSearchSummary("tenant-123", 30);

      expect(summary).toEqual({
        totalQueries: 0,
        uniqueQueries: 0,
        averageResultCount: 0,
        topQueries: [],
        queriesWithNoResults: 0,
      });
    });

    it("should use default days when not provided", async () => {
      const summary = await metrics.getSearchSummary("tenant-123");

      expect(summary).toEqual({
        totalQueries: 0,
        uniqueQueries: 0,
        averageResultCount: 0,
        topQueries: [],
        queriesWithNoResults: 0,
      });
    });
  });
});
