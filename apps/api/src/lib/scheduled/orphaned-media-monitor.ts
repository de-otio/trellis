/**
 * Orphaned Media Cleanup Monitor
 *
 * Tracks cleanup job health and sends alerts when issues are detected.
 * Monitors:
 * - Job execution (did it run?)
 * - Processing metrics (how much was cleaned?)
 * - Error rates (are deletions failing?)
 * - Backlog growth (is cleanup keeping up?)
 */

import { getLogger, Logger } from "../logger.js";
import type { Env } from "../../env.js";

export interface CleanupMetrics {
  timestamp: string;
  orphanedCleaned: number;
  r2Deleted: number;
  r2Errors: number;
  duration: number;
  regions: {
    region: string;
    orphanedCleaned: number;
    r2Deleted: number;
    hasMore: boolean;
  }[];
}

export interface HealthStatus {
  healthy: boolean;
  lastRun: string | null;
  hoursSinceLastRun: number | null;
  backlogEstimate: number;
  errorRate: number;
  issues: string[];
}

export interface AlertConfig {
  enabled: boolean;
  webhookUrl?: string;
  emailRecipients?: string[];
  slackWebhook?: string;
}

export interface AlertPayload {
  severity: "warning" | "critical";
  title: string;
  message: string;
  timestamp: string;
  health: HealthStatus;
}

export class OrphanedMediaMonitor {
  private logger: Logger;
  private static readonly KV_KEY_PREFIX = "orphaned_cleanup_metrics";
  private static readonly KV_LAST_RUN = "orphaned_cleanup_last_run";
  private static readonly MAX_HOURS_BETWEEN_RUNS = 26; // Daily job, allow 2h buffer
  private static readonly MAX_ERROR_RATE = 0.1; // 10% error rate threshold

  constructor(env: Env) {
    this.logger = getLogger();
  }

  /**
   * Record cleanup metrics after job completes
   */
  async recordMetrics(metrics: CleanupMetrics, env: Env): Promise<void> {
    try {
      const kv = (env as any).RATE_LIMIT_KV; // Reuse existing KV namespace
      if (!kv) {
        this.logger.warn("[OrphanedMediaMonitor] KV namespace not available");
        return;
      }

      // Store latest metrics
      await kv.put(
        OrphanedMediaMonitor.KV_LAST_RUN,
        JSON.stringify({
          timestamp: metrics.timestamp,
          metrics,
        }),
        {
          expirationTtl: 7 * 24 * 60 * 60, // Keep for 7 days
        },
      );

      // Store historical metrics (for trend analysis)
      const historyKey = `${OrphanedMediaMonitor.KV_KEY_PREFIX}:${new Date().toISOString().split("T")[0]}`;
      await kv.put(historyKey, JSON.stringify(metrics), {
        expirationTtl: 30 * 24 * 60 * 60, // Keep for 30 days
      });

      this.logger.info("[OrphanedMediaMonitor] Metrics recorded", {
        orphanedCleaned: metrics.orphanedCleaned,
        r2Deleted: metrics.r2Deleted,
        r2Errors: metrics.r2Errors,
      });
    } catch (error) {
      this.logger.error("[OrphanedMediaMonitor] Failed to record metrics", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check health status of cleanup job
   */
  async checkHealth(env: Env): Promise<HealthStatus> {
    const issues: string[] = [];
    let healthy = true;

    try {
      const kv = (env as any).RATE_LIMIT_KV;
      if (!kv) {
        return {
          healthy: false,
          lastRun: null,
          hoursSinceLastRun: null,
          backlogEstimate: 0,
          errorRate: 0,
          issues: ["KV namespace not available"],
        };
      }

      // Get last run metrics
      const lastRunData = await kv.get(OrphanedMediaMonitor.KV_LAST_RUN);
      if (!lastRunData) {
        return {
          healthy: false,
          lastRun: null,
          hoursSinceLastRun: null,
          backlogEstimate: 0,
          errorRate: 0,
          issues: ["No cleanup job has run yet"],
        };
      }

      const { timestamp, metrics } = JSON.parse(lastRunData);
      const lastRun = new Date(timestamp);
      const now = new Date();
      const hoursSinceLastRun =
        (now.getTime() - lastRun.getTime()) / (1000 * 60 * 60);

      // Check 1: Job running on schedule?
      if (hoursSinceLastRun > OrphanedMediaMonitor.MAX_HOURS_BETWEEN_RUNS) {
        healthy = false;
        issues.push(
          `Cleanup job hasn't run in ${hoursSinceLastRun.toFixed(1)} hours (expected: 24h)`,
        );
      }

      // Check 2: High error rate?
      const errorRate =
        metrics.r2Deleted > 0
          ? metrics.r2Errors / (metrics.r2Deleted + metrics.r2Errors)
          : 0;

      if (errorRate > OrphanedMediaMonitor.MAX_ERROR_RATE) {
        healthy = false;
        issues.push(
          `High error rate: ${(errorRate * 100).toFixed(1)}% (threshold: ${OrphanedMediaMonitor.MAX_ERROR_RATE * 100}%)`,
        );
      }

      // Check 3: Backlog growing?
      const hasBacklog = metrics.regions.some((r: any) => r.hasMore);
      const backlogEstimate = hasBacklog
        ? metrics.orphanedCleaned * 2 // Rough estimate: if we hit limits, assume 2x more
        : 0;

      if (hasBacklog) {
        issues.push(
          `Cleanup backlog detected: ~${backlogEstimate} items remaining`,
        );
        // Not necessarily unhealthy, just informational
      }

      // Check 4: Zero activity (might indicate issue)
      if (metrics.orphanedCleaned === 0 && metrics.r2Deleted === 0) {
        // This is actually normal if there's nothing to clean
        // Only flag if this persists for multiple days
        this.logger.debug("[OrphanedMediaMonitor] No cleanup activity", {
          timestamp: metrics.timestamp,
        });
      }

      return {
        healthy,
        lastRun: timestamp,
        hoursSinceLastRun,
        backlogEstimate,
        errorRate,
        issues,
      };
    } catch (error) {
      this.logger.error("[OrphanedMediaMonitor] Health check failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        healthy: false,
        lastRun: null,
        hoursSinceLastRun: null,
        backlogEstimate: 0,
        errorRate: 0,
        issues: [
          "Health check failed: " +
            (error instanceof Error ? error.message : String(error)),
        ],
      };
    }
  }

  /**
   * Get estimated backlog size by querying database
   */
  async getBacklogSize(env: Env): Promise<{
    orphanedCount: number;
    softDeletedCount: number;
  }> {
    try {
      const { sharedDatabaseConnectionManager } = await import(
        "../database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "../db-query-helper.js"
      );

      // Count orphaned media (ready for soft delete)
      const gracePeriodCutoff = new Date();
      gracePeriodCutoff.setHours(gracePeriodCutoff.getHours() - 24);

      const orphanedCount = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        "US", // Just check one region for estimate
        env,
        (db) =>
          db.mediaFile.count({
            where: {
              attachedToPost: false,
              orphanedAt: {
                lte: gracePeriodCutoff,
              },
              deletedAt: null,
            },
          }),
        QueryTimeoutPresets.STANDARD,
      );

      // Count soft-deleted media (ready for R2 deletion)
      const deletionCutoff = new Date();
      deletionCutoff.setDate(deletionCutoff.getDate() - 7);

      const softDeletedCount = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        "US",
        env,
        (db) =>
          db.mediaFile.count({
            where: {
              deletedAt: {
                lte: deletionCutoff,
              },
            },
          }),
        QueryTimeoutPresets.STANDARD,
      );

      return {
        orphanedCount,
        softDeletedCount,
      };
    } catch (error) {
      this.logger.error("[OrphanedMediaMonitor] Failed to get backlog size", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        orphanedCount: 0,
        softDeletedCount: 0,
      };
    }
  }

  /**
   * Send alert when health check fails
   * Supports multiple alert channels:
   * - Webhook (generic HTTP POST)
   * - Slack (via webhook)
   * - Email (via Cloudflare Email Workers)
   */
  async sendAlert(health: HealthStatus, env: Env): Promise<void> {
    if (health.healthy) {
      return; // No alert needed
    }

    const severity = this.determineAlertSeverity(health);
    const alert: AlertPayload = {
      severity,
      title: `Orphaned Media Cleanup ${severity === "critical" ? "CRITICAL" : "Warning"}`,
      message: this.formatAlertMessage(health),
      timestamp: new Date().toISOString(),
      health,
    };

    try {
      // Send to configured alert channels
      await Promise.allSettled([
        this.sendWebhookAlert(alert, env),
        this.sendSlackAlert(alert, env),
        this.logAlert(alert, env),
      ]);
    } catch (error) {
      this.logger.error("[OrphanedMediaMonitor] Failed to send alert", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Determine alert severity based on health status
   */
  private determineAlertSeverity(health: HealthStatus): "warning" | "critical" {
    // Critical if:
    // - Job hasn't run in 48+ hours
    // - Error rate > 50%
    if (
      (health.hoursSinceLastRun !== null && health.hoursSinceLastRun > 48) ||
      health.errorRate > 0.5
    ) {
      return "critical";
    }
    return "warning";
  }

  /**
   * Format alert message for human readability
   */
  private formatAlertMessage(health: HealthStatus): string {
    const lines = [
      "Orphaned media cleanup system health check failed:",
      "",
      ...health.issues.map((issue) => `• ${issue}`),
      "",
      "Details:",
    ];

    if (health.lastRun) {
      lines.push(
        `• Last run: ${health.lastRun} (${health.hoursSinceLastRun?.toFixed(1)}h ago)`,
      );
    } else {
      lines.push("• Last run: Never");
    }

    lines.push(`• Error rate: ${(health.errorRate * 100).toFixed(1)}%`);
    lines.push(`• Backlog estimate: ${health.backlogEstimate} items`);

    return lines.join("\n");
  }

  /**
   * Send alert to generic webhook
   */
  private async sendWebhookAlert(alert: AlertPayload, env: Env): Promise<void> {
    const webhookUrl = (env as any).ORPHANED_MEDIA_ALERT_WEBHOOK;
    if (!webhookUrl) {
      return; // Webhook not configured
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(alert),
      });

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }

      this.logger.info("[OrphanedMediaMonitor] Alert sent to webhook", {
        severity: alert.severity,
      });
    } catch (error) {
      this.logger.error("[OrphanedMediaMonitor] Failed to send webhook alert", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send alert to Slack
   */
  private async sendSlackAlert(alert: AlertPayload, env: Env): Promise<void> {
    const slackWebhook = (env as any).ORPHANED_MEDIA_SLACK_WEBHOOK;
    if (!slackWebhook) {
      return; // Slack not configured
    }

    try {
      const color = alert.severity === "critical" ? "danger" : "warning";
      const emoji = alert.severity === "critical" ? "🚨" : "⚠️";

      const slackPayload = {
        text: `${emoji} ${alert.title}`,
        attachments: [
          {
            color,
            title: "Health Check Details",
            text: alert.message,
            footer: "Orphaned Media Cleanup Monitor",
            ts: Math.floor(new Date(alert.timestamp).getTime() / 1000),
          },
        ],
      };

      const response = await fetch(slackWebhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(slackPayload),
      });

      if (!response.ok) {
        throw new Error(`Slack webhook returned ${response.status}`);
      }

      this.logger.info("[OrphanedMediaMonitor] Alert sent to Slack", {
        severity: alert.severity,
      });
    } catch (error) {
      this.logger.error("[OrphanedMediaMonitor] Failed to send Slack alert", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Log alert to Cloudflare Analytics Engine (if available)
   */
  private async logAlert(alert: AlertPayload, env: Env): Promise<void> {
    try {
      // Log to standard logger (always available)
      this.logger.error("[OrphanedMediaMonitor] ALERT", {
        severity: alert.severity,
        title: alert.title,
        issues: alert.health.issues,
        lastRun: alert.health.lastRun,
        hoursSinceLastRun: alert.health.hoursSinceLastRun,
        errorRate: alert.health.errorRate,
        backlogEstimate: alert.health.backlogEstimate,
      });

      // TODO: Add Cloudflare Analytics Engine integration
      // const analytics = (env as any).ANALYTICS_ENGINE;
      // if (analytics) {
      //   await analytics.writeDataPoint({
      //     blobs: [alert.severity, alert.title],
      //     doubles: [alert.health.errorRate, alert.health.backlogEstimate],
      //     indexes: ['orphaned_media_alert'],
      //   });
      // }
    } catch (error) {
      // Don't throw - logging failure shouldn't break alerting
      this.logger.error("[OrphanedMediaMonitor] Failed to log alert", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
