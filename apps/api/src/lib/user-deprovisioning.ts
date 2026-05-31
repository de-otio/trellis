/**
 * User Deprovisioning
 *
 * Handles user account suspension and deprovisioning when users are removed from IdP.
 * Required for GDPR compliance and security best practices.
 */

import { createPrisma } from "../db.js";
import { sharedDatabaseConnectionManager } from "./database-connection-manager.js";
import {
  withQueryTimeoutAndRetry,
  QueryTimeoutPresets,
} from "./db-query-helper.js";
import { SecurityMonitor } from "./security-monitor.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";
import { createClaimsCacheFromEnv } from "./auth/claims-cache.js";

export interface Env {
  DATABASE_URL: string;
  SECURITY_WEBHOOK_URL?: string;
}

export interface DeprovisionReason {
  type: "idp_removal" | "manual" | "compliance" | "security";
  description: string;
  initiatedBy?: string; // User ID or system
}

/**
 * User Deprovisioning Handler
 */
export class UserDeprovisioning {
  private securityMonitor: SecurityMonitor;
  private logger: Logger;

  constructor(env?: LoggerEnv) {
    this.securityMonitor = new SecurityMonitor();
    this.logger = getLogger();
  }

  /**
   * Suspend user account
   * Used when user is removed from IdP or for security/compliance reasons
   */
  async suspendUser(
    userId: string,
    reason: DeprovisionReason,
    env: Env,
  ): Promise<void> {
    const db = createPrisma(env);

    try {
      // Fetch cognitoSub before update so we can invalidate the claim cache.
      const userRow = await db.user.findUnique({
        where: { id: userId },
        select: { cognitoSub: true },
      });

      // Update user to suspended
      await db.user.update({
        where: { id: userId },
        data: {
          suspended: true,
          suspendedAt: new Date(),
          suspendedReason: `${reason.type}: ${reason.description}`,
        },
      });

      // Invalidate DDB claim cache so the next token refresh reflects the suspension.
      // Mitigation for G2 H3: suspended users that still have a cached token would
      // bypass the suspension check for up to CACHE_TTL seconds without this call.
      if (userRow?.cognitoSub) {
        try {
          const cache = createClaimsCacheFromEnv();
          await cache.invalidate(userRow.cognitoSub);
        } catch {
          // Best-effort — don't block suspension if DDB is unavailable.
        }
      }

      // Log security event
      await this.securityMonitor.logSecurityEvent(
        {
          type: "suspicious_activity",
          severity: "high",
          userId,
          success: false,
          metadata: {
            action: "user_suspended",
            reason: reason.type,
            description: reason.description,
            initiatedBy: reason.initiatedBy,
          },
        },
        env,
      );

      this.logger.info(
        `[UserDeprovisioning] User ${userId} suspended: ${reason.type} - ${reason.description}`,
      );
    } catch (error) {
      this.logger.error("[UserDeprovisioning] Failed to suspend user:", error);
      throw error;
    }
  }

  /**
   * Check if user is suspended.
   *
   * Fail-open is intentional and required: this is a best-effort hint used by
   * non-critical paths (e.g. surfacing a banner to operators). The
   * authoritative gate is the pre-token-generation Lambda, which already
   * blocks token issuance for suspended users on the next refresh
   * (see lambda/pre-token-generation.ts — the cache TTL bounds the
   * window). Failing closed here would convert a transient RDS hiccup
   * into a denial-of-service against legitimate users; the security
   * properties hold via the pre-token path. Do not change to fail-closed
   * without first moving the authoritative check off the RDS critical path.
   */
  async isUserSuspended(
    userId: string,
    env: Env,
    region: string = "US",
  ): Promise<boolean> {
    try {
      // Create connection manager instance
      const dbManager = sharedDatabaseConnectionManager;

      const user = await withQueryTimeoutAndRetry<{
        suspended: boolean;
      } | null>(
        dbManager,
        region,
        env,
        async (client) => {
          return client.user.findUnique({
            where: { id: userId },
            select: { suspended: true },
          });
        },
        {
          ...QueryTimeoutPresets.CRITICAL, // 5s initial, 3s retry = 8s max (auth check)
          defaultValue: null, // Return null if query fails (will be treated as false below)
          context: {
            operation: "isUserSuspended",
            userId,
          },
        },
      );

      return user && "suspended" in user ? user.suspended : false;
    } catch (error) {
      this.logger.error(
        "[UserDeprovisioning] Failed to check suspension status:",
        error,
      );
      // Fail open — see method-level docstring above for rationale.
      return false;
    }
  }

  /**
   * Restore suspended user account
   */
  async restoreUser(
    userId: string,
    reason: string,
    initiatedBy: string,
    env: Env,
  ): Promise<void> {
    const db = createPrisma(env);

    try {
      // Fetch cognitoSub before update so we can invalidate the claim cache.
      const userRow = await db.user.findUnique({
        where: { id: userId },
        select: { cognitoSub: true },
      });

      await db.user.update({
        where: { id: userId },
        data: {
          suspended: false,
          suspendedAt: null,
          suspendedReason: null,
        },
      });

      // Invalidate DDB claim cache so the next token refresh can succeed with restored status.
      if (userRow?.cognitoSub) {
        try {
          const cache = createClaimsCacheFromEnv();
          await cache.invalidate(userRow.cognitoSub);
        } catch {
          // Best-effort.
        }
      }

      // Log security event
      await this.securityMonitor.logSecurityEvent(
        {
          type: "suspicious_activity",
          severity: "medium",
          userId,
          success: true,
          metadata: {
            action: "user_restored",
            reason,
            initiatedBy,
          },
        },
        env,
      );

      this.logger.info(
        `[UserDeprovisioning] User ${userId} restored by ${initiatedBy}: ${reason}`,
      );
    } catch (error) {
      this.logger.error("[UserDeprovisioning] Failed to restore user:", error);
      throw error;
    }
  }

  /**
   * Check user during SSO login - suspend if removed from IdP
   * This should be called after successful authentication to verify user still exists in IdP
   */
  async verifyUserStillInIdP(
    userId: string,
    provider: string,
    env: Env,
  ): Promise<boolean> {
    // This is a placeholder - actual implementation depends on IdP
    // For Microsoft Entra, we could check via Microsoft Graph API
    // For SAML, we'd need to check with the partner's IdP

    // For now, we assume user is valid if they successfully authenticated
    // In production, you might want to:
    // 1. Check Microsoft Graph API for user existence
    // 2. For SAML, maintain a sync job that checks IdP membership
    // 3. Use SCIM 2.0 for automated provisioning/deprovisioning

    return true; // Placeholder - assume valid
  }
}
