/**
 * Database Monitoring Service
 *
 * Monitors database connection health, tracks failures, and alerts on unusual patterns.
 *
 * Features:
 * - Connection failure tracking
 * - Unusual error pattern detection
 * - Security event alerting
 * - Query performance monitoring (trace level only)
 */

import { getLogger, Logger } from "./logger.js";
import { SecurityMonitor, type SecurityEvent } from "./security-monitor.js";
import type { Env } from "./security-monitor.js";

export interface DatabaseMonitorEnv extends Env {
  LOG_LEVEL?: string;
}

export interface DatabaseConnectionFailure {
  region: string;
  error: string;
  timestamp: Date;
  operation?: string;
  userId?: string;
}

export interface DatabaseQueryLog {
  operation: string;
  region: string;
  duration?: number;
  success: boolean;
  error?: string;
  userId?: string;
  timestamp: Date;
}

export class DatabaseMonitor {
  private logger: Logger;
  private securityMonitor: SecurityMonitor;
  private failureCounts: Map<string, number> = new Map(); // region -> count
  private lastFailureTime: Map<string, Date> = new Map(); // region -> timestamp
  private readonly FAILURE_THRESHOLD = 5; // Alert after 5 failures in window
  private readonly FAILURE_WINDOW_MS = 60000; // 1 minute window
  private readonly ALERT_COOLDOWN_MS = 300000; // 5 minutes between alerts

  constructor(env: DatabaseMonitorEnv) {
    this.logger = getLogger();
    this.securityMonitor = new SecurityMonitor();
  }

  /**
   * Log database connection failure
   *
   * @param failure - Connection failure details
   * @param env - Environment variables
   */
  async logConnectionFailure(
    failure: DatabaseConnectionFailure,
    env: DatabaseMonitorEnv,
  ): Promise<void> {
    const key = `${failure.region}:${failure.operation || "unknown"}`;
    const now = new Date();

    // Update failure counts
    const count = (this.failureCounts.get(key) || 0) + 1;
    this.failureCounts.set(key, count);
    this.lastFailureTime.set(key, now);

    // Log failure
    this.logger.error("[DatabaseMonitor] Connection failure", {
      region: failure.region,
      operation: failure.operation,
      error: failure.error,
      count,
      userId: failure.userId,
    });

    // Check if threshold exceeded
    if (count >= this.FAILURE_THRESHOLD) {
      await this.alertOnFailurePattern(key, failure, env);
    }

    // Log security event for critical failures
    if (this.isCriticalFailure(failure.error)) {
      await this.logSecurityEvent(failure, env);
    }

    // Cleanup old entries (prevent memory leak)
    this.cleanupOldEntries(now);
  }

  /**
   * Log database query (trace level only)
   *
   * SECURITY: Only logs at TRACE level to prevent sensitive data exposure
   *
   * @param log - Query log details
   * @param env - Environment variables
   */
  logQuery(log: DatabaseQueryLog, env: DatabaseMonitorEnv): void {
    // Only log at TRACE level
    const logLevel = env.LOG_LEVEL?.toUpperCase() || "INFO";
    if (logLevel !== "TRACE" && logLevel !== "DEBUG") {
      return; // Skip logging if not at trace/debug level
    }

    // Log query details (sanitized)
    this.logger.debug("[DatabaseMonitor] Query executed", {
      operation: log.operation,
      region: log.region,
      duration: log.duration,
      success: log.success,
      userId: log.userId,
      // SECURITY: Do not log error details at trace level (may contain sensitive data)
      // Only log error type, not full message
      errorType: log.error ? this.extractErrorType(log.error) : undefined,
    });
  }

  /**
   * Alert on failure pattern
   */
  private async alertOnFailurePattern(
    key: string,
    failure: DatabaseConnectionFailure,
    env: DatabaseMonitorEnv,
  ): Promise<void> {
    const lastAlert = this.lastFailureTime.get(`${key}:alert`);
    const now = new Date();

    // Check cooldown
    if (
      lastAlert &&
      now.getTime() - lastAlert.getTime() < this.ALERT_COOLDOWN_MS
    ) {
      return; // Still in cooldown
    }

    // Update alert time
    this.lastFailureTime.set(`${key}:alert`, now);

    // Log alert
    this.logger.error("[DatabaseMonitor] Failure pattern detected", {
      region: failure.region,
      operation: failure.operation,
      failureCount: this.failureCounts.get(key),
      threshold: this.FAILURE_THRESHOLD,
    });

    // Log security event
    await this.logSecurityEvent(
      {
        ...failure,
        error: `Multiple connection failures detected (${this.failureCounts.get(key)} failures)`,
      },
      env,
    );
  }

  /**
   * Log security event for database failures
   */
  private async logSecurityEvent(
    failure: DatabaseConnectionFailure,
    env: DatabaseMonitorEnv,
  ): Promise<void> {
    try {
      const event: SecurityEvent = {
        type: "database_connection_failure",
        severity: this.isCriticalFailure(failure.error) ? "high" : "medium",
        userId: failure.userId,
        provider: "database",
        ipAddress: "internal", // Database failures are internal
        userAgent: "database-monitor",
        success: false,
        metadata: {
          region: failure.region,
          operation: failure.operation,
          error: failure.error,
        },
      };

      await this.securityMonitor.logSecurityEvent(event, env);
    } catch (error) {
      // Don't fail if security logging fails
      this.logger.warn("[DatabaseMonitor] Failed to log security event", {
        error,
      });
    }
  }

  /**
   * Check if error is critical
   */
  private isCriticalFailure(error: string): boolean {
    const criticalPatterns = [
      /authentication.*failed/gi,
      /connection.*refused/gi,
      /timeout/gi,
      /network.*error/gi,
      /ssl.*error/gi,
      /certificate.*error/gi,
    ];

    return criticalPatterns.some((pattern) => pattern.test(error));
  }

  /**
   * Extract error type from error message (sanitized)
   */
  private extractErrorType(error: string): string {
    // Extract just the error type, not the full message
    const match = error.match(/^([A-Za-z]+Error|Error|Timeout|Connection)/);
    return match ? match[1] : "UnknownError";
  }

  /**
   * Cleanup old failure entries
   */
  private cleanupOldEntries(now: Date): void {
    const cutoff = now.getTime() - this.FAILURE_WINDOW_MS;

    for (const [key, timestamp] of this.lastFailureTime.entries()) {
      if (timestamp.getTime() < cutoff && !key.includes(":alert")) {
        this.failureCounts.delete(key);
        this.lastFailureTime.delete(key);
      }
    }
  }

  /**
   * Get failure statistics
   */
  getFailureStats(): Record<
    string,
    { count: number; lastFailure: Date | null }
  > {
    const stats: Record<string, { count: number; lastFailure: Date | null }> =
      {};

    for (const [key, count] of this.failureCounts.entries()) {
      if (!key.includes(":alert")) {
        stats[key] = {
          count,
          lastFailure: this.lastFailureTime.get(key) || null,
        };
      }
    }

    return stats;
  }

  /**
   * Reset failure statistics
   */
  resetStats(): void {
    this.failureCounts.clear();
    this.lastFailureTime.clear();
  }
}
