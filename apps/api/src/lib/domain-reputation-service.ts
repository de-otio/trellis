/**
 * Domain Reputation Service
 *
 * Manages domain reputation scoring, blocklists, and allowlists for link security.
 * Integrates with threat intelligence and user reports to build domain reputation over time.
 */

import { DataRouter, type DataRouterEnv } from "./data-router.js";
import { getLogger, Logger } from "./logger.js";

export interface Env extends DataRouterEnv {
  // No additional env vars needed for now
  // Future: Could add reputation thresholds, decay rates, etc.
}

/**
 * Domain reputation status
 */
export type DomainStatus = "unknown" | "safe" | "warning" | "blocked";

/**
 * Reputation signal types
 */
export type ReputationSignal =
  | "threat_intel_positive" // External API flagged as safe
  | "threat_intel_negative" // External API flagged as malicious
  | "user_report" // User reported the domain
  | "many_users" // Many different users linked this domain
  | "no_reports" // No reports over time period
  | "admin_block" // Admin manually blocked
  | "admin_allow" // Admin manually allowed
  | "auto_block" // Auto-blocked due to threshold
  | "auto_unblock"; // Auto-unblocked after review

/**
 * Domain reputation result
 */
export interface DomainReputationResult {
  domain: string;
  reputation: number; // -100 to +100
  status: DomainStatus;
  lastChecked: Date;
  isBlocklisted: boolean;
  isAllowlisted: boolean;
}

/**
 * Service for managing domain reputation
 */
export class DomainReputationService {
  private logger: Logger;

  // Reputation scoring constants
  private readonly MAX_REPUTATION = 100;
  private readonly MIN_REPUTATION = -100;
  private readonly DEFAULT_REPUTATION = 0;

  // Status thresholds
  private readonly SAFE_THRESHOLD = 20; // Reputation >= 20 = safe
  private readonly WARNING_THRESHOLD = -10; // Reputation < -10 = warning
  private readonly BLOCKED_THRESHOLD = -50; // Reputation < -50 = blocked

  // Signal weights for reputation calculation
  private readonly SIGNAL_WEIGHTS: Record<ReputationSignal, number> = {
    threat_intel_positive: +30,
    threat_intel_negative: -50,
    user_report: -10,
    many_users: +5,
    no_reports: +2,
    admin_block: -100, // Immediate block
    admin_allow: +50, // High positive signal
    auto_block: -80,
    auto_unblock: +20,
  };

  // Auto-block threshold (number of reports before auto-blocking)
  private readonly AUTO_BLOCK_REPORT_THRESHOLD = 5;

  constructor(env?: Env) {
    this.logger = getLogger();
  }

  /**
   * Get domain reputation
   *
   * @param domain - Domain name (e.g., "example.com")
   * @param region - Region code ('US', 'EU', 'CN')
   * @param env - Environment variables
   * @returns Domain reputation result
   */
  async getReputation(
    domain: string,
    region: string,
    env: Env,
  ): Promise<DomainReputationResult> {
    const normalizedDomain = this.normalizeDomain(domain);
    const db = DataRouter.getDatabaseForRegion(region, env);

    try {
      let reputation = await db.domainReputation.findUnique({
        where: { domain: normalizedDomain },
      });

      // If domain doesn't exist, create with default reputation
      if (!reputation) {
        reputation = await db.domainReputation.create({
          data: {
            domain: normalizedDomain,
            reputation: this.DEFAULT_REPUTATION,
            status: "unknown",
            lastChecked: new Date(),
          },
        });
      }

      // Check if domain is in blocklist/allowlist (stored in status)
      const isBlocklisted = reputation.status === "blocked";
      const isAllowlisted =
        reputation.status === "safe" &&
        reputation.reputation >= this.SAFE_THRESHOLD;

      return {
        domain: normalizedDomain,
        reputation: reputation.reputation,
        status: reputation.status as DomainStatus,
        lastChecked: reputation.lastChecked,
        isBlocklisted,
        isAllowlisted,
      };
    } catch (error) {
      this.logger.error(
        `[DomainReputationService] Error getting reputation for ${normalizedDomain}:`,
        error,
      );
      // Return default reputation on error
      return {
        domain: normalizedDomain,
        reputation: this.DEFAULT_REPUTATION,
        status: "unknown",
        lastChecked: new Date(),
        isBlocklisted: false,
        isAllowlisted: false,
      };
    }
  }

  /**
   * Update domain reputation based on a signal
   *
   * @param domain - Domain name
   * @param signal - Reputation signal type
   * @param region - Region code
   * @param env - Environment variables
   * @param metadata - Optional metadata (e.g., report count, user count)
   */
  async updateReputation(
    domain: string,
    signal: ReputationSignal,
    region: string,
    env: Env,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const normalizedDomain = this.normalizeDomain(domain);
    const db = DataRouter.getDatabaseForRegion(region, env);

    try {
      // Get current reputation
      let reputation = await db.domainReputation.findUnique({
        where: { domain: normalizedDomain },
      });

      if (!reputation) {
        // Create new reputation record
        reputation = await db.domainReputation.create({
          data: {
            domain: normalizedDomain,
            reputation: this.DEFAULT_REPUTATION,
            status: "unknown",
            lastChecked: new Date(),
          },
        });
      }

      // Calculate reputation change
      const signalWeight = this.SIGNAL_WEIGHTS[signal];
      const newReputation = Math.max(
        this.MIN_REPUTATION,
        Math.min(this.MAX_REPUTATION, reputation.reputation + signalWeight),
      );

      // Determine new status based on reputation
      let newStatus: DomainStatus = reputation.status as DomainStatus;
      if (signal === "admin_block" || signal === "auto_block") {
        newStatus = "blocked";
      } else if (signal === "admin_allow") {
        newStatus = "safe";
      } else {
        // Auto-determine status based on reputation score
        if (newReputation >= this.SAFE_THRESHOLD) {
          newStatus = "safe";
        } else if (newReputation <= this.BLOCKED_THRESHOLD) {
          newStatus = "blocked";
        } else if (newReputation < this.WARNING_THRESHOLD) {
          newStatus = "warning";
        } else {
          newStatus = "unknown";
        }
      }

      // Update reputation
      await db.domainReputation.update({
        where: { domain: normalizedDomain },
        data: {
          reputation: newReputation,
          status: newStatus,
          lastChecked: new Date(),
          updatedAt: new Date(),
        },
      });

      this.logger.debug(
        `[DomainReputationService] Updated reputation for ${normalizedDomain}: ${reputation.reputation} -> ${newReputation} (${signal})`,
      );
    } catch (error) {
      this.logger.error(
        `[DomainReputationService] Error updating reputation for ${normalizedDomain}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Block a domain (admin action)
   *
   * @param domain - Domain name
   * @param region - Region code
   * @param env - Environment variables
   */
  async blockDomain(domain: string, region: string, env: Env): Promise<void> {
    await this.updateReputation(domain, "admin_block", region, env);
    this.logger.info(`[DomainReputationService] Domain blocked: ${domain}`);
  }

  /**
   * Unblock a domain (admin action)
   *
   * @param domain - Domain name
   * @param region - Region code
   * @param env - Environment variables
   */
  async unblockDomain(domain: string, region: string, env: Env): Promise<void> {
    const normalizedDomain = this.normalizeDomain(domain);
    const db = DataRouter.getDatabaseForRegion(region, env);

    try {
      // Reset reputation to neutral and set status to unknown
      await db.domainReputation.update({
        where: { domain: normalizedDomain },
        data: {
          reputation: this.DEFAULT_REPUTATION,
          status: "unknown",
          lastChecked: new Date(),
          updatedAt: new Date(),
        },
      });

      this.logger.info(`[DomainReputationService] Domain unblocked: ${domain}`);
    } catch (error) {
      this.logger.error(
        `[DomainReputationService] Error unblocking domain ${normalizedDomain}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Add domain to allowlist (admin action)
   *
   * @param domain - Domain name
   * @param region - Region code
   * @param env - Environment variables
   */
  async addToAllowlist(
    domain: string,
    region: string,
    env: Env,
  ): Promise<void> {
    await this.updateReputation(domain, "admin_allow", region, env);
    this.logger.info(
      `[DomainReputationService] Domain added to allowlist: ${domain}`,
    );
  }

  /**
   * Check if domain should be auto-blocked based on report count
   *
   * @param domain - Domain name
   * @param region - Region code
   * @param env - Environment variables
   * @returns True if domain should be auto-blocked
   */
  async shouldAutoBlock(
    domain: string,
    region: string,
    env: Env,
  ): Promise<boolean> {
    const normalizedDomain = this.normalizeDomain(domain);
    const db = DataRouter.getDatabaseForRegion(region, env);

    try {
      // Count pending/reviewed reports for this domain
      const reportCount = await db.linkReport.count({
        where: {
          domain: normalizedDomain,
          status: {
            in: ["pending", "reviewed"],
          },
        },
      });

      // Check if threshold exceeded
      if (reportCount >= this.AUTO_BLOCK_REPORT_THRESHOLD) {
        // Check current status - don't auto-block if already blocked
        const reputation = await db.domainReputation.findUnique({
          where: { domain: normalizedDomain },
        });

        if (reputation && reputation.status !== "blocked") {
          return true;
        }
      }

      return false;
    } catch (error) {
      this.logger.error(
        `[DomainReputationService] Error checking auto-block for ${normalizedDomain}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Apply reputation decay over time
   * (Called periodically by a background job)
   *
   * @param region - Region code
   * @param env - Environment variables
   * @param decayRate - Reputation points to decay per day (default: 1)
   */
  async applyReputationDecay(
    region: string,
    env: Env,
    decayRate: number = 1,
  ): Promise<void> {
    const db = DataRouter.getDatabaseForRegion(region, env);

    try {
      // Get all domains that haven't been checked recently (30+ days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const staleDomains = await db.domainReputation.findMany({
        where: {
          lastChecked: {
            lt: thirtyDaysAgo,
          },
          // Only decay domains that aren't explicitly blocked or allowlisted
          status: {
            not: "blocked",
          },
        },
      });

      for (const domain of staleDomains) {
        // Decay reputation towards neutral (0)
        const daysSinceCheck = Math.floor(
          (Date.now() - domain.lastChecked.getTime()) / (1000 * 60 * 60 * 24),
        );
        const decayAmount = daysSinceCheck * decayRate;

        let newReputation = domain.reputation;
        if (domain.reputation > 0) {
          // Decay positive reputation
          newReputation = Math.max(0, domain.reputation - decayAmount);
        } else if (domain.reputation < 0) {
          // Decay negative reputation (move towards 0)
          newReputation = Math.min(0, domain.reputation + decayAmount);
        }

        // Update status based on new reputation
        let newStatus: DomainStatus = domain.status as DomainStatus;
        if (newReputation >= this.SAFE_THRESHOLD) {
          newStatus = "safe";
        } else if (newReputation <= this.BLOCKED_THRESHOLD) {
          newStatus = "blocked";
        } else if (newReputation < this.WARNING_THRESHOLD) {
          newStatus = "warning";
        } else {
          newStatus = "unknown";
        }

        await db.domainReputation.update({
          where: { id: domain.id },
          data: {
            reputation: newReputation,
            status: newStatus,
            updatedAt: new Date(),
          },
        });
      }

      this.logger.debug(
        `[DomainReputationService] Applied reputation decay to ${staleDomains.length} domains`,
      );
    } catch (error) {
      this.logger.error(
        "[DomainReputationService] Error applying reputation decay:",
        error,
      );
      throw error;
    }
  }

  /**
   * Normalize domain name (lowercase, remove www, etc.)
   *
   * @param domain - Domain name
   * @returns Normalized domain
   */
  private normalizeDomain(domain: string): string {
    let normalized = domain.toLowerCase().trim();

    // Remove protocol if present (do this first)
    normalized = normalized.replace(/^https?:\/\//, "");

    // Remove www. prefix
    if (normalized.startsWith("www.")) {
      normalized = normalized.substring(4);
    }

    // Remove trailing slash
    normalized = normalized.replace(/\/$/, "");

    // Remove path, query, fragment
    const urlParts = normalized.split("/");
    normalized = urlParts[0];

    return normalized;
  }
}
