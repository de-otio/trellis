import type { AnalyticsEngineDataset } from "../types/cloudflare-compat.js";
/**
 * Media Metrics
 *
 * Provides structured logging and metrics collection for media operations.
 * Integrates with Cloudflare Analytics Engine for metrics aggregation.
 */

import { getLogger, Logger, type LoggerEnv } from "./logger.js";

export interface MediaMetricsEnv extends LoggerEnv {
  ANALYTICS?: AnalyticsEngineDataset;
}

interface MediaOperationMetrics {
  operation: string; // 'list', 'details', 'grouped', 'stats', 'hide', 'unhide', 'delete'
  endpoint: string; // '/api/media', '/api/media/grouped', etc.
  userId?: string;
  region?: string;
  duration: number; // milliseconds
  statusCode?: number;
  errorType?: string;
  resultCount?: number; // For list/grouped operations
  mediaId?: string; // For single-media operations
}

export class MediaMetrics {
  private logger: Logger;
  private analytics?: AnalyticsEngineDataset;

  constructor(env?: MediaMetricsEnv) {
    this.logger = env ? getLogger() : ({} as Logger);
    this.analytics = env?.ANALYTICS;
  }

  /**
   * Track a media operation with metrics
   */
  trackOperation(metrics: MediaOperationMetrics): void {
    const {
      operation,
      endpoint,
      duration,
      statusCode,
      errorType,
      resultCount,
      region,
    } = metrics;

    // Structured logging
    const logContext = {
      operation,
      endpoint,
      duration,
      statusCode,
      errorType,
      resultCount,
      region,
      timestamp: new Date().toISOString(),
    };

    if (statusCode && statusCode >= 400) {
      this.logger.error(
        `[MediaMetrics] Operation failed: ${operation}`,
        logContext,
      );
    } else if (duration > 2000) {
      this.logger.warn(
        `[MediaMetrics] Slow operation: ${operation}`,
        logContext,
      );
    } else {
      this.logger.info(
        `[MediaMetrics] Operation completed: ${operation}`,
        logContext,
      );
    }

    // Send to Analytics Engine if available
    if (this.analytics) {
      try {
        this.analytics.writeDataPoint({
          blobs: [
            "media-operation",
            operation,
            endpoint,
            region || "unknown",
            errorType || "success",
          ],
          doubles: [Date.now(), duration, statusCode || 200, resultCount || 0],
          indexes: [
            `media:${operation}`,
            `media:${endpoint}`,
            `media:${operation}:${statusCode || 200}`,
            `media:${region || "unknown"}`,
          ],
        });
      } catch (error) {
        // Don't fail the operation if metrics fail
        this.logger.warn(
          "[MediaMetrics] Failed to write analytics data point",
          { error },
        );
      }
    }
  }

  /**
   * Track list operation
   */
  trackList(
    endpoint: string,
    duration: number,
    resultCount: number,
    statusCode: number,
    region?: string,
    userId?: string,
  ): void {
    this.trackOperation({
      operation: "list",
      endpoint,
      duration,
      statusCode,
      resultCount,
      region,
      userId,
    });
  }

  /**
   * Track grouped operation
   */
  trackGrouped(
    endpoint: string,
    duration: number,
    groupCount: number,
    totalItems: number,
    statusCode: number,
    region?: string,
    userId?: string,
  ): void {
    this.trackOperation({
      operation: "grouped",
      endpoint,
      duration,
      statusCode,
      resultCount: groupCount,
      region,
      userId,
    });

    // Also track total items
    if (this.analytics) {
      try {
        this.analytics.writeDataPoint({
          blobs: ["media-grouped-items", endpoint, region || "unknown"],
          doubles: [Date.now(), totalItems],
          indexes: [`media:grouped:items`, `media:${endpoint}`],
        });
      } catch (error) {
        this.logger.warn(
          "[MediaMetrics] Failed to write grouped items metric",
          { error },
        );
      }
    }
  }

  /**
   * Track stats operation
   */
  trackStats(
    endpoint: string,
    duration: number,
    totalCount: number,
    statusCode: number,
    region?: string,
    userId?: string,
  ): void {
    this.trackOperation({
      operation: "stats",
      endpoint,
      duration,
      statusCode,
      resultCount: totalCount,
      region,
      userId,
    });
  }

  /**
   * Track single-media operation (details, hide, unhide, delete)
   */
  trackMediaAction(
    operation: "details" | "hide" | "unhide" | "delete",
    endpoint: string,
    duration: number,
    statusCode: number,
    mediaId: string,
    region?: string,
    userId?: string,
    errorType?: string,
  ): void {
    this.trackOperation({
      operation,
      endpoint,
      duration,
      statusCode,
      mediaId,
      region,
      userId,
      errorType,
    });
  }

  /**
   * Track cleanup job execution
   */
  trackCleanup(
    region: string,
    processed: number,
    deleted: number,
    errors: number,
    skipped: number,
    duration: number,
  ): void {
    const logContext = {
      region,
      processed,
      deleted,
      errors,
      skipped,
      duration,
      timestamp: new Date().toISOString(),
    };

    if (errors > 0) {
      this.logger.error(
        "[MediaMetrics] Cleanup job completed with errors",
        logContext,
      );
    } else {
      this.logger.info("[MediaMetrics] Cleanup job completed", logContext);
    }

    if (this.analytics) {
      try {
        this.analytics.writeDataPoint({
          blobs: ["media-cleanup", region],
          doubles: [Date.now(), processed, deleted, errors, skipped, duration],
          indexes: [`media:cleanup:${region}`, "media:cleanup"],
        });
      } catch (error) {
        this.logger.warn("[MediaMetrics] Failed to write cleanup metric", {
          error,
        });
      }
    }
  }

  /**
   * Track rate limit violation
   */
  trackRateLimit(
    endpoint: string,
    userId?: string,
    ipAddress?: string,
    limit?: number,
    windowSeconds?: number,
  ): void {
    this.logger.warn("[MediaMetrics] Rate limit exceeded", {
      endpoint,
      userId,
      ipAddress,
      limit,
      windowSeconds,
      timestamp: new Date().toISOString(),
    });

    if (this.analytics) {
      try {
        this.analytics.writeDataPoint({
          blobs: ["media-rate-limit", endpoint],
          doubles: [Date.now(), limit || 0, windowSeconds || 0],
          indexes: ["media:rate-limit", `media:rate-limit:${endpoint}`],
        });
      } catch (error) {
        this.logger.warn("[MediaMetrics] Failed to write rate limit metric", {
          error,
        });
      }
    }
  }
}
