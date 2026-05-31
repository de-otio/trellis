/**
 * Performance Metrics Collection
 *
 * Lightweight metrics collection for Cloudflare Workers.
 * Tracks endpoint performance, database queries, cache performance, and errors.
 */

import { getLogger, Logger, type LoggerEnv } from "./logger.js";

export interface PerformanceMetrics {
  endpoint: string;
  method: string;
  duration: number;
  status: number;
  timestamp: number;
  userId?: string;
  error?: string;
}

export interface DatabaseQueryMetrics {
  operation: string;
  region: string;
  duration: number;
  success: boolean;
  retries: number;
  timestamp: number;
}

export interface CacheMetrics {
  cacheType: string;
  hit: boolean;
  duration?: number;
  timestamp: number;
}

export interface ConnectionPoolMetrics {
  region: string;
  total: number;
  idle: number;
  waiting: number;
  timestamp: number;
}

class PerformanceMetricsCollector {
  private logger: Logger;
  private endpointMetrics: PerformanceMetrics[] = [];
  private databaseMetrics: DatabaseQueryMetrics[] = [];
  private cacheMetrics: CacheMetrics[] = [];
  private connectionPoolMetrics: ConnectionPoolMetrics[] = [];
  private readonly MAX_METRICS_BUFFER = 100; // Keep last 100 metrics in memory

  constructor(env?: LoggerEnv) {
    this.logger = getLogger();
  }

  /**
   * Record endpoint performance metric
   */
  recordEndpointMetric(metric: PerformanceMetrics): void {
    this.endpointMetrics.push(metric);
    if (this.endpointMetrics.length > this.MAX_METRICS_BUFFER) {
      this.endpointMetrics.shift();
    }

    // Log slow endpoints
    if (metric.duration > 1000) {
      this.logger.warn("[PerformanceMetrics] Slow endpoint detected", {
        endpoint: metric.endpoint,
        method: metric.method,
        duration: metric.duration,
        status: metric.status,
        userId: metric.userId,
      });
    }

    // Log errors
    if (metric.status >= 500 || metric.error) {
      this.logger.error("[PerformanceMetrics] Endpoint error", {
        endpoint: metric.endpoint,
        method: metric.method,
        duration: metric.duration,
        status: metric.status,
        error: metric.error,
        userId: metric.userId,
      });
    }
  }

  /**
   * Record database query metric
   */
  recordDatabaseQuery(metric: DatabaseQueryMetrics): void {
    this.databaseMetrics.push(metric);
    if (this.databaseMetrics.length > this.MAX_METRICS_BUFFER) {
      this.databaseMetrics.shift();
    }

    // Log slow queries
    if (metric.duration > 1000) {
      this.logger.warn("[PerformanceMetrics] Slow database query", {
        operation: metric.operation,
        region: metric.region,
        duration: metric.duration,
        retries: metric.retries,
      });
    }

    // Log failed queries
    if (!metric.success) {
      this.logger.error("[PerformanceMetrics] Database query failed", {
        operation: metric.operation,
        region: metric.region,
        duration: metric.duration,
        retries: metric.retries,
      });
    }
  }

  /**
   * Record cache metric
   */
  recordCacheMetric(metric: CacheMetrics): void {
    this.cacheMetrics.push(metric);
    if (this.cacheMetrics.length > this.MAX_METRICS_BUFFER) {
      this.cacheMetrics.shift();
    }
  }

  /**
   * Record connection pool metric
   */
  recordConnectionPoolMetric(metric: ConnectionPoolMetrics): void {
    this.connectionPoolMetrics.push(metric);
    if (this.connectionPoolMetrics.length > this.MAX_METRICS_BUFFER) {
      this.connectionPoolMetrics.shift();
    }

    // Alert if pool is exhausted
    if (metric.waiting > 0) {
      this.logger.warn("[PerformanceMetrics] Connection pool exhausted", {
        region: metric.region,
        total: metric.total,
        idle: metric.idle,
        waiting: metric.waiting,
      });
    }
  }

  /**
   * Calculate percentiles for endpoint response times
   */
  calculateEndpointPercentiles(
    endpoint: string,
    method: string,
  ): {
    p50: number;
    p95: number;
    p99: number;
    count: number;
    average: number;
    max: number;
  } | null {
    const relevantMetrics = this.endpointMetrics.filter(
      (m) => m.endpoint === endpoint && m.method === method,
    );

    if (relevantMetrics.length === 0) {
      return null;
    }

    const durations = relevantMetrics
      .map((m) => m.duration)
      .sort((a, b) => a - b);

    const p50 = durations[Math.floor(durations.length * 0.5)] || 0;
    const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
    const p99 = durations[Math.floor(durations.length * 0.99)] || 0;
    const average = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    const max = durations[durations.length - 1] || 0;

    return {
      p50,
      p95,
      p99,
      count: durations.length,
      average,
      max,
    };
  }

  /**
   * Calculate cache hit rate
   */
  calculateCacheHitRate(cacheType?: string): {
    hitRate: number;
    hitCount: number;
    missCount: number;
    total: number;
  } {
    const relevantMetrics = cacheType
      ? this.cacheMetrics.filter((m) => m.cacheType === cacheType)
      : this.cacheMetrics;

    if (relevantMetrics.length === 0) {
      return { hitRate: 0, hitCount: 0, missCount: 0, total: 0 };
    }

    const hitCount = relevantMetrics.filter((m) => m.hit).length;
    const missCount = relevantMetrics.filter((m) => !m.hit).length;
    const total = relevantMetrics.length;
    const hitRate = total > 0 ? (hitCount / total) * 100 : 0;

    return { hitRate, hitCount, missCount, total };
  }

  /**
   * Calculate error rate for an endpoint
   */
  calculateErrorRate(
    endpoint: string,
    method: string,
  ): {
    errorRate: number;
    errorCount: number;
    totalCount: number;
    errorsByStatus: Record<number, number>;
  } {
    const relevantMetrics = this.endpointMetrics.filter(
      (m) => m.endpoint === endpoint && m.method === method,
    );

    if (relevantMetrics.length === 0) {
      return {
        errorRate: 0,
        errorCount: 0,
        totalCount: 0,
        errorsByStatus: {},
      };
    }

    const errorMetrics = relevantMetrics.filter(
      (m) => m.status >= 400 || m.error,
    );
    const errorsByStatus: Record<number, number> = {};

    errorMetrics.forEach((m) => {
      errorsByStatus[m.status] = (errorsByStatus[m.status] || 0) + 1;
    });

    const errorCount = errorMetrics.length;
    const totalCount = relevantMetrics.length;
    const errorRate = totalCount > 0 ? (errorCount / totalCount) * 100 : 0;

    return { errorRate, errorCount, totalCount, errorsByStatus };
  }

  /**
   * Get summary metrics for logging
   */
  getSummaryMetrics(): {
    endpoints: Record<
      string,
      {
        p50: number;
        p95: number;
        p99: number;
        average: number;
        count: number;
        errorRate: number;
      }
    >;
    cache: {
      hitRate: number;
      hitCount: number;
      missCount: number;
    };
    database: {
      averageQueryTime: number;
      slowQueryCount: number;
      totalQueries: number;
    };
  } {
    const endpoints: Record<
      string,
      {
        p50: number;
        p95: number;
        p99: number;
        average: number;
        count: number;
        errorRate: number;
      }
    > = {};

    // Calculate metrics for each unique endpoint
    const endpointKeys = new Set(
      this.endpointMetrics.map((m) => `${m.method}:${m.endpoint}`),
    );

    endpointKeys.forEach((key) => {
      const [method, endpoint] = key.split(":");
      const percentiles = this.calculateEndpointPercentiles(endpoint, method);
      const errorRate = this.calculateErrorRate(endpoint, method);

      if (percentiles) {
        endpoints[key] = {
          p50: percentiles.p50,
          p95: percentiles.p95,
          p99: percentiles.p99,
          average: percentiles.average,
          count: percentiles.count,
          errorRate: errorRate.errorRate,
        };
      }
    });

    const cache = this.calculateCacheHitRate();
    const slowQueryCount = this.databaseMetrics.filter(
      (m) => m.duration > 1000,
    ).length;
    const averageQueryTime =
      this.databaseMetrics.length > 0
        ? this.databaseMetrics.reduce((sum, m) => sum + m.duration, 0) /
          this.databaseMetrics.length
        : 0;

    return {
      endpoints,
      cache: {
        hitRate: cache.hitRate,
        hitCount: cache.hitCount,
        missCount: cache.missCount,
      },
      database: {
        averageQueryTime,
        slowQueryCount,
        totalQueries: this.databaseMetrics.length,
      },
    };
  }

  /**
   * Log summary metrics (call periodically)
   */
  logSummaryMetrics(): void {
    const summary = this.getSummaryMetrics();

    this.logger.info("[PerformanceMetrics] Summary metrics", {
      endpoints: summary.endpoints,
      cache: summary.cache,
      database: summary.database,
      timestamp: Date.now(),
    });

    // Check for alert conditions
    Object.entries(summary.endpoints).forEach(([key, metrics]) => {
      // Alert if p95 > 1 second
      if (metrics.p95 > 1000) {
        this.logger.warn(
          "[PerformanceMetrics] ALERT: Endpoint p95 latency > 1s",
          {
            endpoint: key,
            p95: metrics.p95,
            p99: metrics.p99,
          },
        );
      }

      // Alert if error rate > 5%
      if (metrics.errorRate > 5) {
        this.logger.error(
          "[PerformanceMetrics] ALERT: Endpoint error rate > 5%",
          {
            endpoint: key,
            errorRate: metrics.errorRate,
            count: metrics.count,
          },
        );
      }
    });

    // Alert if cache hit rate < 80%
    if (
      summary.cache.hitRate < 80 &&
      summary.cache.hitCount + summary.cache.missCount > 10
    ) {
      this.logger.warn("[PerformanceMetrics] ALERT: Cache hit rate < 80%", {
        hitRate: summary.cache.hitRate,
        hitCount: summary.cache.hitCount,
        missCount: summary.cache.missCount,
      });
    }

    // Alert if average query time > 500ms
    if (summary.database.averageQueryTime > 500) {
      this.logger.warn(
        "[PerformanceMetrics] ALERT: Average database query time > 500ms",
        {
          averageQueryTime: summary.database.averageQueryTime,
          slowQueryCount: summary.database.slowQueryCount,
          totalQueries: summary.database.totalQueries,
        },
      );
    }
  }

  /**
   * Clear metrics (call periodically to prevent memory growth)
   */
  clearMetrics(): void {
    this.endpointMetrics = [];
    this.databaseMetrics = [];
    this.cacheMetrics = [];
    this.connectionPoolMetrics = [];
  }
}

// Singleton instance
let sharedPerformanceMetricsCollector: PerformanceMetricsCollector | null =
  null;

export function getPerformanceMetricsCollector(
  env?: LoggerEnv,
): PerformanceMetricsCollector {
  if (!sharedPerformanceMetricsCollector) {
    sharedPerformanceMetricsCollector = new PerformanceMetricsCollector(env);
  }
  return sharedPerformanceMetricsCollector;
}
