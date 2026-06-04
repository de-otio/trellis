/**
 * Link Security Handler
 *
 * Handles URL extraction, normalization, validation, and security checks for links in posts and comments.
 * Provides synchronous validation for immediate blocking of dangerous URLs and async queue integration
 * for threat intelligence checks.
 *
 * PREPARATORY: Designed for integration with threat intelligence services and domain reputation system.
 */

import type { Env } from "../env.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";

/**
 * Normalized URL structure
 */
export interface NormalizedUrl {
  original: string;
  normalized: string;
  scheme: string;
  host: string;
  domain: string;
  path: string;
  query: string;
}

/**
 * Link status enumeration
 */
export enum LinkStatus {
  SAFE = "safe",
  WARNING = "warning",
  BLOCKED = "blocked",
  PENDING = "pending",
}

/**
 * Link validation result
 */
export interface LinkValidationResult {
  status: LinkStatus;
  reason?: string;
  normalizedUrl?: NormalizedUrl;
}

/**
 * Domain reputation information
 */
export interface DomainReputationInfo {
  domain: string;
  reputation: number;
  status: string;
  lastChecked: Date | null;
}

/**
 * Environment interface for LinkSecurityHandler
 */
export interface LinkSecurityEnv extends Env {
  DATABASE_URL: string;
}

/**
 * URL extraction regex pattern
 * Matches http:// and https:// URLs, including those with ports, paths, and query strings
 * Excludes trailing punctuation like closing parentheses and periods
 */
const URL_REGEX = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

/**
 * Dangerous URL schemes that should be blocked
 */
const DANGEROUS_SCHEMES = [
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "chrome:",
  "chrome-extension:",
  "moz-extension:",
  "about:",
  "jar:",
];

/**
 * Allowed URL schemes
 */
const ALLOWED_SCHEMES = ["http:", "https:", "mailto:", "tel:"];

/**
 * Private IPv4 ranges
 */
const PRIVATE_IPV4_RANGES = [
  { start: 0x0a000000, end: 0x0affffff }, // 10.0.0.0/8
  { start: 0xac100000, end: 0xac1fffff }, // 172.16.0.0/12
  { start: 0xc0a80000, end: 0xc0a8ffff }, // 192.168.0.0/16
  { start: 0x7f000000, end: 0x7fffffff }, // 127.0.0.0/8
  { start: 0xa9fe0000, end: 0xa9feffff }, // 169.254.0.0/16 (link-local)
];

/**
 * Internal hostname patterns
 */
const INTERNAL_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^localhost\./i, // localhost.localdomain, localhost.local, etc.
  /\.local$/i,
  /\.corp$/i,
  /\.internal$/i,
  /\.lan$/i,
];

export class LinkSecurityHandler {
  private logger: Logger;

  constructor(env?: LoggerEnv) {
    this.logger = getLogger();
  }

  /**
   * Extract all URLs from text
   *
   * @param text - Text to extract URLs from
   * @returns Array of unique URLs found in the text
   */
  extractUrls(text: string): string[] {
    if (!text || typeof text !== "string") {
      return [];
    }

    const matches = text.match(URL_REGEX);
    if (!matches) {
      return [];
    }

    // Deduplicate URLs
    return [...new Set(matches)];
  }

  /**
   * Normalize a URL
   *
   * Normalizes URLs by:
   * - Converting scheme to lowercase
   * - Converting host to lowercase
   * - Resolving punycode for IDN domains
   * - Stripping fragments
   * - Preserving path and query
   *
   * @param url - URL to normalize
   * @returns Normalized URL object or null if invalid
   */
  normalizeUrl(url: string): NormalizedUrl | null {
    if (!url || typeof url !== "string") {
      return null;
    }

    try {
      // Parse URL
      const parsed = new URL(url);

      // Normalize scheme (lowercase)
      const scheme = parsed.protocol.toLowerCase().replace(":", "");

      // Normalize host (lowercase, include port if present)
      let host = parsed.host.toLowerCase();

      // Get hostname (without port, and without brackets for IPv6)
      let hostname = parsed.hostname.toLowerCase();
      // Remove brackets from IPv6 addresses for domain matching
      const domain = hostname.replace(/^\[|\]$/g, "");

      // Resolve punycode for IDN domains
      // Note: The URL constructor already handles punycode, but we ensure it's normalized
      try {
        // If host contains non-ASCII, it's already in punycode form from URL constructor
        // We can use it as-is
        host = host;
      } catch (error) {
        this.logger.warn("Failed to normalize hostname:", error);
        return null;
      }

      // Strip fragment
      const path = parsed.pathname;
      const query = parsed.search;

      // Build normalized URL
      const normalized = `${scheme}://${host}${path}${query}`;

      return {
        original: url,
        normalized,
        scheme,
        host,
        domain,
        path,
        query,
      };
    } catch (error) {
      this.logger.warn("Failed to normalize URL:", error);
      return null;
    }
  }

  /**
   * Validate URL synchronously
   *
   * Performs immediate validation checks:
   * - Scheme validation (block dangerous schemes)
   * - Internal IP/hostname detection (SSRF protection)
   * - Basic security checks
   *
   * @param url - URL to validate
   * @returns Validation result with status and reason
   */
  validateUrlSync(url: string): LinkValidationResult {
    // Check scheme first (before parsing URL, as some schemes like javascript: can't be parsed)
    const schemeMatch = url.match(/^([^:]+):/i);
    if (schemeMatch) {
      // Remove null bytes and normalize scheme
      const scheme = schemeMatch[1].replace(/\0/g, "").toLowerCase();
      const schemeCheck = this.validateScheme(scheme);
      if (!schemeCheck.allowed) {
        return {
          status: LinkStatus.BLOCKED,
          reason: schemeCheck.reason || "Dangerous URL scheme",
        };
      }
    }

    // Normalize URL
    const normalized = this.normalizeUrl(url);
    if (!normalized) {
      return {
        status: LinkStatus.BLOCKED,
        reason: "Invalid URL format",
      };
    }

    // Check for internal IPs and hostnames first (SSRF protection)
    // This catches private IPs and internal hostnames
    // Pass host (may include port) and domain (hostname without port)
    const internalCheck = this.checkInternalAccess(
      normalized.host,
      normalized.domain,
    );
    if (!internalCheck.allowed) {
      return {
        status: LinkStatus.BLOCKED,
        reason: internalCheck.reason || "Internal network access blocked",
        normalizedUrl: normalized,
      };
    }

    // Check for raw IP URLs (potential SSRF) - only public IPs
    // Private IPs are already caught by checkInternalAccess above
    // This check must happen after checkInternalAccess to ensure private IPs
    // are caught with the correct error message
    if (this.isRawIpUrl(normalized.domain)) {
      return {
        status: LinkStatus.BLOCKED,
        reason: "Raw IP URLs are not allowed",
        normalizedUrl: normalized,
      };
    }

    // URL passed all synchronous checks
    return {
      status: LinkStatus.SAFE, // Safe for synchronous checks, may be updated after async threat intel check
      normalizedUrl: normalized,
    };
  }

  /**
   * Validate URL scheme
   *
   * @param scheme - URL scheme to validate
   * @returns Validation result
   */
  private validateScheme(scheme: string): {
    allowed: boolean;
    reason?: string;
  } {
    const normalizedScheme = scheme.toLowerCase();

    // Check for dangerous schemes
    if (DANGEROUS_SCHEMES.includes(normalizedScheme + ":")) {
      return {
        allowed: false,
        reason: "Dangerous scheme",
      };
    }

    // Check if scheme is allowed
    if (!ALLOWED_SCHEMES.includes(normalizedScheme + ":")) {
      return {
        allowed: false,
        reason: `Scheme not allowed: ${normalizedScheme}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if host/domain is internal (SSRF protection)
   *
   * @param host - Hostname or IP address (may include port)
   * @param domain - Domain name (without port)
   * @returns Check result
   */
  private checkInternalAccess(
    host: string,
    domain: string,
  ): { allowed: boolean; reason?: string } {
    // Extract hostname without port for IP checking
    // Handle IPv6 addresses in brackets: [::1]:8080 -> [::1 -> ::1
    let hostnameWithoutPort = host.split(":")[0];
    if (hostnameWithoutPort.startsWith("[")) {
      hostnameWithoutPort = hostnameWithoutPort.substring(1);
    }

    // Check for localhost explicitly (before other patterns)
    // Values are already lowercased from normalizeUrl, but check all variations
    const checkLocalhost = (value: string): boolean => {
      if (!value) return false;
      const lower = value.toLowerCase();
      return lower === "localhost" || lower.startsWith("localhost.");
    };

    if (
      checkLocalhost(domain) ||
      checkLocalhost(hostnameWithoutPort) ||
      checkLocalhost(host)
    ) {
      return {
        allowed: false,
        reason: "Internal hostname detected",
      };
    }

    // Check for internal hostname patterns
    for (const pattern of INTERNAL_HOSTNAME_PATTERNS) {
      if (
        pattern.test(host) ||
        pattern.test(hostnameWithoutPort) ||
        pattern.test(domain)
      ) {
        return {
          allowed: false,
          reason: "Internal hostname detected",
        };
      }
    }

    // Check for IPv4 private ranges (use hostname without port)
    const ipv4Match = hostnameWithoutPort.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) {
      // Use unsigned 32-bit arithmetic to avoid overflow
      const ip =
        ((parseInt(ipv4Match[1]) << 24) |
          (parseInt(ipv4Match[2]) << 16) |
          (parseInt(ipv4Match[3]) << 8) |
          parseInt(ipv4Match[4])) >>>
        0;

      for (const range of PRIVATE_IPV4_RANGES) {
        if (ip >= range.start && ip <= range.end) {
          return {
            allowed: false,
            reason: "Private IP range detected",
          };
        }
      }
    }

    // Check for IPv6 internal ranges
    // Domain is already without brackets (from normalizeUrl using hostname)
    if (
      domain === "::1" ||
      domain.startsWith("fe80:") ||
      domain.startsWith("fc00:") ||
      domain.startsWith("fd00:")
    ) {
      return {
        allowed: false,
        reason: "IPv6 internal range detected",
      };
    }

    return { allowed: true };
  }

  /**
   * Check if domain is a raw IP address
   *
   * @param domain - Domain to check
   * @returns True if domain is a raw IP
   */
  private isRawIpUrl(domain: string): boolean {
    // Check for IPv4 (only if it's not already blocked as private IP)
    // This check should only catch public IPs
    if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) {
      // Check if it's a private IP - if so, it's already handled by checkInternalAccess
      const parts = domain.split(".").map(Number);
      // Use unsigned 32-bit arithmetic to avoid overflow
      const ip =
        ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>>
        0;

      for (const range of PRIVATE_IPV4_RANGES) {
        if (ip >= range.start && ip <= range.end) {
          return false; // Private IPs are handled separately
        }
      }
      return true; // Public IP
    }

    // Check for IPv6 (simplified check)
    const ipv6Domain = domain.replace(/^\[|\]$/g, "");
    if (/^[0-9a-f:]+$/i.test(ipv6Domain) && ipv6Domain.includes(":")) {
      // Check if it's an internal IPv6 - if so, it's already handled
      if (
        ipv6Domain === "::1" ||
        ipv6Domain.startsWith("fe80:") ||
        ipv6Domain.startsWith("fc00:") ||
        ipv6Domain.startsWith("fd00:")
      ) {
        return false; // Internal IPv6s are handled separately
      }
      return true; // Public IPv6
    }

    return false;
  }

  /**
   * Check domain reputation from database
   *
   * @param domain - Domain to check
   * @param env - Environment with database connection
   * @returns Domain reputation information or null if not found
   */
  async checkDomainReputation(
    domain: string,
    env: LinkSecurityEnv,
  ): Promise<DomainReputationInfo | null> {
    try {
      const { DomainReputationService } = await import(
        "./domain-reputation-service.js"
      );

      // Get region for reputation service (default to EU if not specified)
      const region = (env.DEFAULT_REGION as "US" | "EU" | "CN") || "EU";

      const reputationService = new DomainReputationService(env);
      const reputation = await reputationService.getReputation(
        domain,
        region,
        env as any,
      );

      return {
        domain: reputation.domain,
        reputation: reputation.reputation,
        status: reputation.status,
        lastChecked: reputation.lastChecked,
      };
    } catch (error) {
      this.logger.error("Failed to check domain reputation:", error);
      return null;
    }
  }

  /**
   * Queue threat intelligence check for a URL
   *
   * Creates a LinkCheck record and queues an async threat intel check.
   *
   * @param params - Parameters for queueing the check
   * @param env - Environment with queue and database connections
   * @returns LinkCheck ID or null if failed
   */
  async queueThreatIntelCheck(
    params: {
      // Required: the LinkCheck inherits the owning post/comment's tenant.
      tenantId: string;
      postId?: string;
      commentId?: string;
      originalUrl: string;
      normalizedUrl: string;
      domain: string;
      status: LinkStatus;
    },
    env: LinkSecurityEnv,
  ): Promise<string | null> {
    try {
      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      // Ensure domain reputation record exists
      await db.domainReputation.upsert({
        where: { domain: params.domain },
        create: {
          domain: params.domain,
          reputation: 0,
          status: "unknown",
        },
        update: {},
      });

      // Create LinkCheck record
      const linkCheck = await db.linkCheck.create({
        data: {
          tenantId: params.tenantId,
          postId: params.postId || null,
          commentId: params.commentId || null,
          originalUrl: params.originalUrl,
          normalizedUrl: params.normalizedUrl,
          domain: params.domain,
          status: params.status,
          checkType: "async",
        },
      });

      // Queue threat intel check if queue is available
      if (env.LINK_CHECK_QUEUE) {
        try {
          await env.LINK_CHECK_QUEUE.send({
            linkCheckId: linkCheck.id,
            url: params.normalizedUrl,
            domain: params.domain,
          });
        } catch (queueError) {
          this.logger.warn("Failed to queue threat intel check:", queueError);
          // Continue - the LinkCheck record is created, can be processed later
        }
      }

      return linkCheck.id;
    } catch (error) {
      this.logger.error("Failed to queue threat intel check:", error);
      return null;
    }
  }
}
