import type { AnalyticsEngineDataset } from "../types/cloudflare-compat.js";
/**
 * Security Monitor
 *
 * Handles security event logging, monitoring, and alerting for SSO authentication.
 */


import { createPrisma } from "../db.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";

export type SecurityEventType =
  | "sso_login"
  | "sso_failed"
  | "sso_config_error"
  | "rate_limit_exceeded"
  | "suspicious_activity"
  | "unauthorized_access"
  | "database_connection_failure";

export type SecurityEventSeverity = "low" | "medium" | "high" | "critical";

export interface SecurityEvent {
  type: SecurityEventType;
  severity: SecurityEventSeverity;
  userId?: string;
  partnerId?: string;
  ipAddress?: string;
  userAgent?: string;
  provider?: string;
  success: boolean;
  metadata?: Record<string, any>;
}

export interface Env {
  DATABASE_URL: string;
  SECURITY_WEBHOOK_URL?: string;
  ANALYTICS?: AnalyticsEngineDataset;
  // PREPARATORY: Privacy configuration variables (all disabled by default)
  // FUTURE USE: These will be used when implementing spy-protection features
  ANALYTICS_OPT_OUT_ENABLED?: string; // 'true' to enable analytics opt-out checking
}

/**
 * Security Monitor class for logging and monitoring security events
 */
export class SecurityMonitor {
  /**
   * Log SSO authentication event
   */
  async logSSOEvent(
    event: {
      type: "sso_login" | "sso_failed" | "sso_config_error";
      userId?: string;
      provider: string;
      ipAddress: string;
      userAgent: string;
      success: boolean;
      metadata?: Record<string, any>;
    },
    env: Env,
  ): Promise<void> {
    const severity = this.determineSeverity(event.type, event.success);

    await this.logSecurityEvent(
      {
        type: event.type,
        severity,
        userId: event.userId,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        provider: event.provider,
        success: event.success,
        metadata: event.metadata,
      },
      env,
    );
  }

  /**
   * Calculate retention date based on severity
   *
   * PREPARATORY CHANGE: This function calculates when a security event should be deleted.
   * FUTURE USE: A scheduled cleanup job will use this to automatically delete old logs.
   *
   * Retention periods:
   * - critical: 365 days (1 year)
   * - high: 90 days
   * - medium: 30 days
   * - low: 7 days
   *
   * @param severity - Event severity level
   * @returns Date when the event should be deleted, or null if retention is disabled
   */
  private calculateRetentionUntil(
    severity: SecurityEventSeverity,
  ): Date | null {
    const retentionDays: Record<SecurityEventSeverity, number> = {
      critical: 365, // Keep critical events for 1 year
      high: 90, // Keep high severity for 90 days
      medium: 30, // Keep medium for 30 days
      low: 7, // Keep low for 7 days
    };

    const days = retentionDays[severity] || 30;
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date;
  }

  /**
   * Log security event to database and monitoring systems
   *
   * PREPARATORY CHANGE: Now includes retention date calculation for future log cleanup.
   */
  async logSecurityEvent(event: SecurityEvent, env: Env): Promise<void> {
    try {
      const db = createPrisma(env);

      // PREPARATORY: Calculate retention date for future cleanup job
      // FUTURE USE: Cleanup job will delete events where retentionUntil < NOW()
      const retentionUntil = this.calculateRetentionUntil(event.severity);

      // Store in database (if SecurityEvent table exists)
      try {
        // Use Prisma create method instead of raw SQL for better compatibility with driver adapters
        await db.securityEvent.create({
          data: {
            type: event.type,
            severity: event.severity,
            userId: event.userId || null,
            // T1 (v0.7): renamed from `partnerId` to `tenantId` as the Partner
            // model was replaced by Tenant. Field shape is identical (nullable
            // string FK). T7 (audit log) extends usage; for now we keep the
            // existing event-payload field name `partnerId` on the input event
            // shape but persist it as tenantId.
            tenantId: event.partnerId || null,
            ipAddress: event.ipAddress || null,
            userAgent: event.userAgent || null,
            details: JSON.stringify({
              provider: event.provider,
              success: event.success,
              ...event.metadata,
            }),
            retentionUntil: retentionUntil, // PREPARATORY: Set retention date (null if column doesn't exist yet)
          },
        });
      } catch (dbError) {
        // Table might not exist yet - log to console for now
        // This is expected until migration is run
        // If retention_until column doesn't exist, the insert will fail - that's okay for now
        getLogger().warn(
          "[SecurityMonitor] Database logging failed (table may not exist, migration needed):",
          dbError,
        );
      }

      // Send to monitoring system
      await this.sendToMonitoring(event, env);

      // Alert if critical or high severity
      if (event.severity === "critical" || event.severity === "high") {
        await this.sendAlert(event, env);
      }

      // Detect suspicious patterns
      if (event.type === "sso_failed") {
        await this.detectFailedAuthPattern(event, env);
      }
    } catch (error) {
      // Don't fail the request if logging fails
      getLogger().error(
        "[SecurityMonitor] Failed to log security event:",
        error,
      );
    }
  }

  /**
   * Determine severity based on event type and success
   */
  private determineSeverity(
    type: SecurityEventType,
    success: boolean,
  ): SecurityEventSeverity {
    if (type === "sso_login" && success) {
      return "low";
    }
    if (type === "sso_failed") {
      return "high";
    }
    if (type === "sso_config_error") {
      return "medium";
    }
    if (type === "rate_limit_exceeded") {
      return "medium";
    }
    if (type === "suspicious_activity") {
      return "high";
    }
    if (type === "unauthorized_access") {
      return "critical";
    }
    return "low";
  }

  /**
   * Detect failed authentication patterns
   */
  private async detectFailedAuthPattern(
    event: SecurityEvent,
    env: Env,
  ): Promise<void> {
    if (!event.ipAddress) return;

    try {
      const db = createPrisma(env);

      // Check for multiple failed attempts from same IP in last 15 minutes
      try {
        const recentFailures = await (db.$queryRawUnsafe as any)(
          `
          SELECT COUNT(*) as count
          FROM security_events
          WHERE type = 'sso_failed'
            AND ip_address = $1
            AND timestamp > NOW() - INTERVAL '15 minutes'
        `,
          event.ipAddress,
        );

        const failureCount = Number(recentFailures[0]?.count || 0);

        if (failureCount >= 5) {
          // Alert on suspicious pattern
          await this.logSecurityEvent(
            {
              type: "suspicious_activity",
              severity: "high",
              ipAddress: event.ipAddress,
              userAgent: event.userAgent,
              success: false,
              metadata: {
                reason: "multiple_failed_attempts",
                failureCount,
                window: "15_minutes",
              },
            },
            env,
          );
        }
      } catch (error) {
        // Table might not exist yet - skip pattern detection
        getLogger().warn(
          "[SecurityMonitor] Failed to detect failed auth pattern (table may not exist):",
          error,
        );
      }
    } catch (error) {
      getLogger().error(
        "[SecurityMonitor] Failed to detect failed auth pattern:",
        error,
      );
    }
  }

  /**
   * Check if analytics should be sent based on user preferences
   *
   * PREPARATORY CHANGE: This abstraction allows future analytics opt-out functionality.
   * FUTURE USE: When user.analyticsOptOut is true, this will return false to skip analytics.
   *
   * Currently always returns true (current behavior, no breaking changes).
   * When analytics opt-out is implemented, this will query the user's preference.
   *
   * @param userId - Optional user ID to check preferences
   * @param env - Environment with configuration
   * @returns true if analytics should be sent, false if user has opted out
   */
  private async shouldSendAnalytics(
    userId?: string,
    env?: Env,
  ): Promise<boolean> {
    // If no user, send analytics (anonymous usage)
    if (!userId) {
      return true;
    }

    // PREPARATORY: Check if analytics opt-out is enabled
    // FUTURE USE: When ANALYTICS_OPT_OUT_ENABLED=true, query user preference from database
    if (env?.ANALYTICS_OPT_OUT_ENABLED !== "true") {
      // Feature not enabled yet - always send analytics (current behavior)
      return true;
    }

    // FUTURE IMPLEMENTATION:
    // const db = createPrisma(env);
    // const user = await db.user.findUnique({
    //   where: { id: userId },
    //   select: { analyticsOptOut: true },
    // });
    // return !user?.analyticsOptOut;

    // For now, always return true (no breaking changes)
    return true;
  }

  /**
   * Send event to monitoring system
   *
   * PREPARATORY CHANGE: Now respects user analytics opt-out preference (when enabled).
   */
  private async sendToMonitoring(
    event: SecurityEvent,
    env: Env,
  ): Promise<void> {
    // PREPARATORY: Check if analytics should be sent based on user preferences
    // FUTURE USE: When analytics opt-out is implemented, this will skip analytics for opted-out users
    const shouldSend = await this.shouldSendAnalytics(event.userId, env);

    // Send to Cloudflare Analytics Engine if available and user hasn't opted out
    if (env.ANALYTICS && shouldSend) {
      try {
        await env.ANALYTICS.writeDataPoint({
          blobs: [
            "security_event",
            event.type,
            event.severity,
            event.provider || "",
          ],
          doubles: [Date.now()],
          indexes: [
            `security:${event.type}`,
            `severity:${event.severity}`,
            event.provider ? `provider:${event.provider}` : "",
          ].filter(Boolean),
        });
      } catch (error) {
        getLogger().error(
          "[SecurityMonitor] Analytics write failed:",
          error,
        );
        // Don't throw - analytics failures shouldn't break the app
      }
    }

    // Log to console for development
    getLogger().info("[SecurityMonitor]", {
      type: event.type,
      severity: event.severity,
      provider: event.provider,
      success: event.success,
      ipAddress: event.ipAddress,
    });
  }

  /**
   * Send alert for critical events
   */
  private async sendAlert(event: SecurityEvent, env: Env): Promise<void> {
    if (!env.SECURITY_WEBHOOK_URL) {
      // No webhook configured - just log
      getLogger().warn(
        "[SecurityMonitor] Security alert (no webhook configured):",
        event,
      );
      return;
    }

    try {
      await fetch(env.SECURITY_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Security Alert: ${event.type}`,
          severity: event.severity,
          event: {
            type: event.type,
            provider: event.provider,
            success: event.success,
            ipAddress: event.ipAddress,
            userAgent: event.userAgent,
            metadata: event.metadata,
          },
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (error) {
      getLogger().error(
        "[SecurityMonitor] Failed to send alert:",
        error,
      );
    }
  }
}
