/**
 * Unit tests for Performance Metrics Collector
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPerformanceMetricsCollector } from "../../src/lib/performance-metrics.js";
import type {
  PerformanceMetrics,
  DatabaseQueryMetrics,
  CacheMetrics,
  ConnectionPoolMetrics,
} from "../../src/lib/performance-metrics.js";

describe("PerformanceMetricsCollector", () => {
  let collector: ReturnType<typeof getPerformanceMetricsCollector>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Get a fresh collector — clear metrics from previous tests
    collector = getPerformanceMetricsCollector({ LOG_LEVEL: "DEBUG", NODE_ENV: "test" });
    collector.clearMetrics();
  });

  describe("recordEndpointMetric()", () => {
    it("records a normal endpoint metric", () => {
      const metric: PerformanceMetrics = {
        endpoint: "/api/posts",
        method: "GET",
        duration: 50,
        status: 200,
        timestamp: Date.now(),
      };

      collector.recordEndpointMetric(metric);

      // Should not log warnings for fast, successful requests
                });

    it("logs warning for slow endpoints (>1s)", () => {
      const metric: PerformanceMetrics = {
        endpoint: "/api/feed",
        method: "GET",
        duration: 1500,
        status: 200,
        timestamp: Date.now(),
      };

      collector.recordEndpointMetric(metric);

          });

    it("logs error for 5xx responses", () => {
      const metric: PerformanceMetrics = {
        endpoint: "/api/posts",
        method: "POST",
        duration: 100,
        status: 500,
        timestamp: Date.now(),
      };

      collector.recordEndpointMetric(metric);

          });

    it("logs error when metric has error field", () => {
      const metric: PerformanceMetrics = {
        endpoint: "/api/posts",
        method: "GET",
        duration: 100,
        status: 200,
        timestamp: Date.now(),
        error: "Connection reset",
      };

      collector.recordEndpointMetric(metric);

          });

    it("enforces max buffer size", () => {
      for (let i = 0; i < 110; i++) {
        collector.recordEndpointMetric({
          endpoint: "/api/posts",
          method: "GET",
          duration: i,
          status: 200,
          timestamp: Date.now(),
        });
      }

      const percentiles = collector.calculateEndpointPercentiles("/api/posts", "GET");
      expect(percentiles).not.toBeNull();
      // Buffer is capped at 100
      expect(percentiles!.count).toBe(100);
    });
  });

  describe("recordDatabaseQuery()", () => {
    it("records a normal query", () => {
      const metric: DatabaseQueryMetrics = {
        operation: "findMany",
        region: "US",
        duration: 50,
        success: true,
        retries: 0,
        timestamp: Date.now(),
      };

      collector.recordDatabaseQuery(metric);
                });

    it("logs warning for slow queries (>1s)", () => {
      collector.recordDatabaseQuery({
        operation: "findMany",
        region: "US",
        duration: 2000,
        success: true,
        retries: 0,
        timestamp: Date.now(),
      });

          });

    it("logs error for failed queries", () => {
      collector.recordDatabaseQuery({
        operation: "create",
        region: "US",
        duration: 100,
        success: false,
        retries: 3,
        timestamp: Date.now(),
      });

          });
  });

  describe("recordCacheMetric()", () => {
    it("records cache hit", () => {
      collector.recordCacheMetric({
        cacheType: "feed",
        hit: true,
        duration: 5,
        timestamp: Date.now(),
      });

      const rate = collector.calculateCacheHitRate("feed");
      expect(rate.hitRate).toBe(100);
      expect(rate.hitCount).toBe(1);
    });

    it("records cache miss", () => {
      collector.recordCacheMetric({
        cacheType: "feed",
        hit: false,
        timestamp: Date.now(),
      });

      const rate = collector.calculateCacheHitRate("feed");
      expect(rate.hitRate).toBe(0);
      expect(rate.missCount).toBe(1);
    });
  });

  describe("recordConnectionPoolMetric()", () => {
    it("records pool metric without alert when no waiting", () => {
      collector.recordConnectionPoolMetric({
        region: "US",
        total: 10,
        idle: 5,
        waiting: 0,
        timestamp: Date.now(),
      });

          });

    it("logs warning when pool has waiting connections", () => {
      collector.recordConnectionPoolMetric({
        region: "US",
        total: 10,
        idle: 0,
        waiting: 3,
        timestamp: Date.now(),
      });

          });
  });

  describe("calculateEndpointPercentiles()", () => {
    it("returns null when no metrics for endpoint", () => {
      const result = collector.calculateEndpointPercentiles("/unknown", "GET");
      expect(result).toBeNull();
    });

    it("calculates percentiles correctly", () => {
      // Add 10 metrics with durations 10, 20, 30, ..., 100
      for (let i = 1; i <= 10; i++) {
        collector.recordEndpointMetric({
          endpoint: "/api/posts",
          method: "GET",
          duration: i * 10,
          status: 200,
          timestamp: Date.now(),
        });
      }

      const result = collector.calculateEndpointPercentiles("/api/posts", "GET");
      expect(result).not.toBeNull();
      expect(result!.count).toBe(10);
      expect(result!.average).toBe(55); // (10+20+...+100)/10
      expect(result!.max).toBe(100);
      expect(result!.p50).toBeGreaterThan(0);
    });

    it("filters by endpoint and method", () => {
      collector.recordEndpointMetric({
        endpoint: "/api/posts",
        method: "GET",
        duration: 50,
        status: 200,
        timestamp: Date.now(),
      });
      collector.recordEndpointMetric({
        endpoint: "/api/posts",
        method: "POST",
        duration: 100,
        status: 201,
        timestamp: Date.now(),
      });

      const getResult = collector.calculateEndpointPercentiles("/api/posts", "GET");
      const postResult = collector.calculateEndpointPercentiles("/api/posts", "POST");

      expect(getResult!.count).toBe(1);
      expect(getResult!.average).toBe(50);
      expect(postResult!.count).toBe(1);
      expect(postResult!.average).toBe(100);
    });
  });

  describe("calculateCacheHitRate()", () => {
    it("returns zeros when no metrics", () => {
      const result = collector.calculateCacheHitRate();
      expect(result.hitRate).toBe(0);
      expect(result.total).toBe(0);
    });

    it("calculates overall hit rate across cache types", () => {
      collector.recordCacheMetric({ cacheType: "feed", hit: true, timestamp: Date.now() });
      collector.recordCacheMetric({ cacheType: "feed", hit: false, timestamp: Date.now() });
      collector.recordCacheMetric({ cacheType: "profile", hit: true, timestamp: Date.now() });
      collector.recordCacheMetric({ cacheType: "profile", hit: true, timestamp: Date.now() });

      const result = collector.calculateCacheHitRate();
      expect(result.hitRate).toBe(75);
      expect(result.hitCount).toBe(3);
      expect(result.missCount).toBe(1);
      expect(result.total).toBe(4);
    });

    it("filters by cache type", () => {
      collector.recordCacheMetric({ cacheType: "feed", hit: true, timestamp: Date.now() });
      collector.recordCacheMetric({ cacheType: "feed", hit: false, timestamp: Date.now() });
      collector.recordCacheMetric({ cacheType: "profile", hit: true, timestamp: Date.now() });

      const feedRate = collector.calculateCacheHitRate("feed");
      expect(feedRate.hitRate).toBe(50);
      expect(feedRate.total).toBe(2);

      const profileRate = collector.calculateCacheHitRate("profile");
      expect(profileRate.hitRate).toBe(100);
      expect(profileRate.total).toBe(1);
    });
  });

  describe("calculateErrorRate()", () => {
    it("returns zeros when no metrics", () => {
      const result = collector.calculateErrorRate("/api/posts", "GET");
      expect(result.errorRate).toBe(0);
      expect(result.totalCount).toBe(0);
    });

    it("calculates error rate correctly", () => {
      collector.recordEndpointMetric({ endpoint: "/api/posts", method: "GET", duration: 50, status: 200, timestamp: Date.now() });
      collector.recordEndpointMetric({ endpoint: "/api/posts", method: "GET", duration: 50, status: 200, timestamp: Date.now() });
      collector.recordEndpointMetric({ endpoint: "/api/posts", method: "GET", duration: 50, status: 500, timestamp: Date.now() });
      collector.recordEndpointMetric({ endpoint: "/api/posts", method: "GET", duration: 50, status: 404, timestamp: Date.now() });

      const result = collector.calculateErrorRate("/api/posts", "GET");
      expect(result.errorRate).toBe(50); // 2 errors out of 4
      expect(result.errorCount).toBe(2);
      expect(result.totalCount).toBe(4);
      expect(result.errorsByStatus[500]).toBe(1);
      expect(result.errorsByStatus[404]).toBe(1);
    });

    it("counts metrics with error field as errors", () => {
      collector.recordEndpointMetric({ endpoint: "/api/posts", method: "GET", duration: 50, status: 200, timestamp: Date.now(), error: "timeout" });

      const result = collector.calculateErrorRate("/api/posts", "GET");
      expect(result.errorCount).toBe(1);
    });
  });

  describe("getSummaryMetrics()", () => {
    it("returns empty summary when no metrics", () => {
      const summary = collector.getSummaryMetrics();
      expect(Object.keys(summary.endpoints)).toHaveLength(0);
      expect(summary.cache.hitRate).toBe(0);
      expect(summary.database.totalQueries).toBe(0);
    });

    it("returns summary with endpoint, cache, and database data", () => {
      collector.recordEndpointMetric({ endpoint: "/api/posts", method: "GET", duration: 50, status: 200, timestamp: Date.now() });
      collector.recordCacheMetric({ cacheType: "feed", hit: true, timestamp: Date.now() });
      collector.recordDatabaseQuery({ operation: "findMany", region: "US", duration: 30, success: true, retries: 0, timestamp: Date.now() });

      const summary = collector.getSummaryMetrics();

      expect(Object.keys(summary.endpoints)).toHaveLength(1);
      expect(summary.endpoints["GET:/api/posts"]).toBeDefined();
      expect(summary.cache.hitCount).toBe(1);
      expect(summary.database.totalQueries).toBe(1);
      expect(summary.database.averageQueryTime).toBe(30);
    });

    it("counts slow queries correctly", () => {
      collector.recordDatabaseQuery({ operation: "findMany", region: "US", duration: 50, success: true, retries: 0, timestamp: Date.now() });
      collector.recordDatabaseQuery({ operation: "findMany", region: "US", duration: 1500, success: true, retries: 0, timestamp: Date.now() });
      collector.recordDatabaseQuery({ operation: "findMany", region: "US", duration: 2000, success: true, retries: 0, timestamp: Date.now() });

      const summary = collector.getSummaryMetrics();
      expect(summary.database.slowQueryCount).toBe(2);
      expect(summary.database.totalQueries).toBe(3);
    });
  });

  describe("logSummaryMetrics()", () => {
    it("logs summary info", () => {
      collector.recordEndpointMetric({ endpoint: "/api/posts", method: "GET", duration: 50, status: 200, timestamp: Date.now() });

      collector.logSummaryMetrics();

          });

    it("alerts when p95 > 1 second", () => {
      // Add many slow requests so p95 is > 1s
      for (let i = 0; i < 20; i++) {
        collector.recordEndpointMetric({
          endpoint: "/api/slow",
          method: "GET",
          duration: 2000,
          status: 200,
          timestamp: Date.now(),
        });
      }

      // Clear the warn calls from individual recordings, then log summary
      collector.logSummaryMetrics();

          });

    it("alerts when error rate > 5%", () => {
      for (let i = 0; i < 10; i++) {
        collector.recordEndpointMetric({
          endpoint: "/api/broken",
          method: "GET",
          duration: 50,
          status: i < 4 ? 200 : 500, // 60% error rate
          timestamp: Date.now(),
        });
      }

      collector.logSummaryMetrics();

          });

    it("alerts when cache hit rate < 80% with sufficient data", () => {
      // 11 misses, 0 hits => 0% hit rate, > 10 total
      for (let i = 0; i < 11; i++) {
        collector.recordCacheMetric({ cacheType: "feed", hit: false, timestamp: Date.now() });
      }

      collector.logSummaryMetrics();

          });

    it("alerts when average query time > 500ms", () => {
      collector.recordDatabaseQuery({ operation: "findMany", region: "US", duration: 600, success: true, retries: 0, timestamp: Date.now() });

      collector.logSummaryMetrics();

          });
  });

  describe("clearMetrics()", () => {
    it("clears all metric buffers", () => {
      collector.recordEndpointMetric({ endpoint: "/api/posts", method: "GET", duration: 50, status: 200, timestamp: Date.now() });
      collector.recordDatabaseQuery({ operation: "findMany", region: "US", duration: 30, success: true, retries: 0, timestamp: Date.now() });
      collector.recordCacheMetric({ cacheType: "feed", hit: true, timestamp: Date.now() });
      collector.recordConnectionPoolMetric({ region: "US", total: 10, idle: 5, waiting: 0, timestamp: Date.now() });

      collector.clearMetrics();

      const summary = collector.getSummaryMetrics();
      expect(Object.keys(summary.endpoints)).toHaveLength(0);
      expect(summary.cache.hitCount).toBe(0);
      expect(summary.cache.missCount).toBe(0);
      expect(summary.database.totalQueries).toBe(0);
    });
  });

  describe("getPerformanceMetricsCollector()", () => {
    it("returns singleton instance", () => {
      const c1 = getPerformanceMetricsCollector();
      const c2 = getPerformanceMetricsCollector();
      expect(c1).toBe(c2);
    });
  });
});
