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
import { classifyHostname, parseIpLiteral } from "./net/ip-guard.js";
import {
  assertUrlSafe,
  SsrfBlockedError,
  type DnsResolver,
} from "./net/safe-fetch.js";

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
   * Validate a URL including DNS resolution (full SSRF check).
   *
   * `validateUrlSync` is a lexical gate: it sees the URL text and nothing else,
   * so `metadata.attacker.com` — a perfectly ordinary-looking name whose A
   * record is 169.254.169.254 — passes it. This variant runs the same lexical
   * gate and then resolves the name, rejecting if ANY resolved A or AAAA record
   * lands in a blocked range.
   *
   * Use this wherever the URL is about to be fetched server-side, or handed to
   * a user as a destination. The sync form remains correct for the post/comment
   * write path, which only records and displays the link (adding a DNS round
   * trip per link to every write would buy nothing there, since no socket is
   * opened to the host).
   *
   * @param url - URL to validate
   * @param options - Optional injected resolver (tests)
   * @returns Validation result; BLOCKED carries the specific reason
   */
  async validateUrl(
    url: string,
    options: { resolver?: DnsResolver } = {},
  ): Promise<LinkValidationResult> {
    const lexical = this.validateUrlSync(url);
    if (lexical.status === LinkStatus.BLOCKED) {
      return lexical;
    }

    try {
      await assertUrlSafe(url, { resolver: options.resolver });
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        this.logger.warn("URL failed SSRF validation", {
          url,
          reason: error.reason,
          detail: error.detail,
        });
        return {
          status: LinkStatus.BLOCKED,
          reason:
            error.reason === "dns-failure"
              ? "Host could not be resolved"
              : "Internal network access blocked",
          normalizedUrl: lexical.normalizedUrl,
        };
      }
      throw error;
    }

    return lexical;
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
   * Check whether a host is internal (SSRF protection).
   *
   * Delegates entirely to `net/ip-guard.classifyHostname`, which normalises the
   * host through a real IP parser (decimal / hex / octal / short / IPv4-mapped
   * forms) and range-checks it against loopback, RFC1918, link-local, ULA,
   * CGNAT, multicast, reserved and documentation space, plus the internal-name
   * patterns. The hand-rolled tables that used to live here covered five IPv4
   * ranges and four IPv6 prefixes, and its port-stripping (`host.split(":")[0]`)
   * mangled bracketed IPv6 into `"["`, so the IP branches never ran for IPv6
   * hosts at all — those were caught only by the raw-IP fallback below, with a
   * misleading reason.
   *
   * This is the LEXICAL layer only. It cannot see a DNS answer, so a name like
   * `metadata.attacker.com` with an A record of 169.254.169.254 passes here.
   * Anything that will actually open a socket must use {@link validateUrl}.
   *
   * @param host - Hostname or IP address (may include port)
   * @param domain - Domain name (without port)
   * @returns Check result
   */
  private checkInternalAccess(
    host: string,
    domain: string,
  ): { allowed: boolean; reason?: string } {
    const target = domain || host;
    // Hostless schemes (mailto:, tel:) never open a socket — the scheme
    // allowlist is the whole check for them.
    if (!target) return { allowed: true };

    const verdict = classifyHostname(target);
    if (!verdict.blocked) return { allowed: true };

    if (verdict.reason === "internal-hostname") {
      return { allowed: false, reason: "Internal hostname detected" };
    }
    // Reason wording is preserved from the previous implementation so existing
    // callers, logs and alerts keep matching; only the classification behind it
    // got stricter.
    const literal = parseIpLiteral(target.replace(/^\[|\]$/g, ""));
    return {
      allowed: false,
      reason:
        literal?.family === 6
          ? "IPv6 internal range detected"
          : "Private IP range detected",
    };
  }

  /**
   * Check whether a host is a raw IP literal in any encoding.
   *
   * Policy (unchanged): a bare IP URL is refused even when the address is
   * public — a legitimate link has a name. Private/reserved addresses are
   * reported by {@link checkInternalAccess} first, so this only ever fires for
   * public literals.
   *
   * @param domain - Domain to check
   * @returns True if domain is a raw IP
   */
  private isRawIpUrl(domain: string): boolean {
    return parseIpLiteral(domain.replace(/^\[|\]$/g, "")) !== null;
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
