import type { KVNamespace, R2Bucket, CloudflareQueue } from "../types/cloudflare-compat.js";
/**
 * Taxonomy Search Metrics
 *
 * Tracks search queries and results for analytics and continuous improvement.
 */


import { getLogger, Logger, type LoggerEnv } from "./logger.js";

export interface SearchMetrics {
  query: string;
  resultCount: number;
  timestamp: number;
  dimension?: string;
  category?: string;
  tenantId: string;
  userId?: string;
}

export interface SearchMetricsSummary {
  totalQueries: number;
  uniqueQueries: number;
  averageResultCount: number;
  topQueries: Array<{ query: string; count: number }>;
  queriesWithNoResults: number;
}

export class TaxonomySearchMetrics {
  private kv?: KVNamespace;
  private enabled: boolean;
  private logger: Logger;

  constructor(
    kv?: KVNamespace,
    enabled: boolean = true,
    env?: LoggerEnv | any,
  ) {
    this.kv = kv;
    this.enabled = enabled;
    this.logger = getLogger();
  }

  /**
   * Track a search query
   */
  async trackSearch(metrics: SearchMetrics): Promise<void> {
    if (!this.enabled || !this.kv) {
      return;
    }

    try {
      const key = `search:metrics:${metrics.tenantId}:${Date.now()}:${Math.random()}`;
      await this.kv.put(key, JSON.stringify(metrics), {
        expirationTtl: 86400 * 30, // 30 days
      });

      // Also track in aggregate counters
      await this.incrementQueryCount(metrics.tenantId, metrics.query);
    } catch (error) {
      // Don't fail search if metrics tracking fails
      this.logger.error("Error tracking search metrics:", error);
    }
  }

  /**
   * Increment query count for analytics
   */
  private async incrementQueryCount(
    tenantId: string,
    query: string,
  ): Promise<void> {
    if (!this.kv) return;

    try {
      const normalizedQuery = query.toLowerCase().trim();
      const counterKey = `search:counter:${tenantId}:${normalizedQuery}`;
      const current = await this.kv.get(counterKey);
      const count = current ? parseInt(current, 10) + 1 : 1;
      await this.kv.put(counterKey, count.toString(), {
        expirationTtl: 86400 * 90, // 90 days
      });
    } catch (error) {
      this.logger.error("Error incrementing query count:", error);
    }
  }

  /**
   * Get search metrics summary (for analytics dashboard)
   */
  async getSearchSummary(
    tenantId: string,
    days: number = 7,
  ): Promise<SearchMetricsSummary> {
    // This would require scanning KV keys, which is expensive
    // For production, consider using a time-series database or analytics service
    // This is a placeholder implementation
    return {
      totalQueries: 0,
      uniqueQueries: 0,
      averageResultCount: 0,
      topQueries: [],
      queriesWithNoResults: 0,
    };
  }
}
