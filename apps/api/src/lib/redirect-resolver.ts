import type { KVNamespace, R2Bucket, CloudflareQueue } from "../types/cloudflare-compat.js";
/**
 * Redirect Resolver
 *
 * Resolves URL redirects and shorteners to their final destination.
 * Follows redirect chains (max 5 hops) and caches results to avoid repeated lookups.
 *
 * SECURITY: Validates final destination against security checks to prevent SSRF attacks.
 */

import { getLogger, Logger, type LoggerEnv } from "./logger.js";

import { LinkSecurityHandler } from "./link-security-handler.js";
import {
  safeFetch,
  SsrfBlockedError,
  type DnsResolver,
  type Transport,
} from "./net/safe-fetch.js";

/**
 * Redirect resolution result
 */
export interface RedirectResult {
  originalUrl: string;
  finalUrl: string;
  redirectChain: string[];
  isShortener: boolean;
  cacheHit: boolean;
}

/**
 * Environment interface for RedirectResolver
 */
export interface RedirectResolverEnv {
  THREAT_INTEL_CACHE_KV?: KVNamespace; // Reuse threat intel cache KV for redirect cache
}

/**
 * Known URL shortener domains
 */
const KNOWN_SHORTENERS = [
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "short.link",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "v.gd",
  "shorte.st",
  "adf.ly",
  "bc.vc",
  "bit.do",
  "clicky.me",
  "soo.gd",
  "tiny.cc",
  "tr.im",
];

/**
 * Cache key prefix for redirect results
 */
const CACHE_KEY_PREFIX = "redirect:";

/**
 * Cache TTL in seconds (7 days)
 */
const CACHE_TTL = 7 * 24 * 60 * 60;

/**
 * Maximum redirect hops to follow
 */
const MAX_REDIRECTS = 5;

/**
 * Request timeout in milliseconds (5 seconds)
 */
const REQUEST_TIMEOUT = 5000;

/**
 * Cap on bytes read while resolving a chain. We only ever want headers, so
 * anything past this is either a misbehaving server or a deliberate attempt to
 * make us buffer a multi-gigabyte body.
 */
const MAX_BODY_BYTES = 64 * 1024;

export class RedirectResolver {
  private logger: Logger;
  private linkSecurityHandler: LinkSecurityHandler;

  constructor(env?: LoggerEnv) {
    this.logger = getLogger();
    this.linkSecurityHandler = new LinkSecurityHandler(env);
  }

  /**
   * Resolve redirects and shorteners to final destination
   *
   * @param url - URL to resolve
   * @param env - Environment with KV cache
   * @returns Redirect resolution result
   */
  async resolveRedirects(
    url: string,
    env: RedirectResolverEnv,
    options: { resolver?: DnsResolver; transport?: Transport } = {},
  ): Promise<RedirectResult | null> {
    // Check cache first
    const cached = await this.getCachedResult(url, env);
    if (cached) {
      return {
        ...cached,
        cacheHit: true,
      };
    }

    // Validate URL first (security check)
    const normalized = this.linkSecurityHandler.normalizeUrl(url);
    if (!normalized) {
      this.logger.warn("Invalid URL for redirect resolution:", url);
      return null;
    }

    // Check if it's a shortener
    const isShortener = this.isShortener(normalized.domain);

    try {
      const redirectChain: string[] = [normalized.normalized];
      let currentUrl = normalized.normalized;
      let hops = 0;

      // Follow redirects up to MAX_REDIRECTS
      while (hops < MAX_REDIRECTS) {
        // Every hop — INCLUDING the first — goes through the SSRF-safe fetch,
        // which validates the URL (DNS resolution and all resolved A/AAAA
        // records) before a socket is opened and pins the connection to the
        // validated address. Previously only redirect *destinations* were
        // checked, so the initial URL was fetched entirely unvalidated: this
        // resolver would happily HEAD `http://169.254.169.254/` on hop zero.
        let response: Awaited<ReturnType<typeof safeFetch>>;
        try {
          response = await this.fetchHop(currentUrl, options);
        } catch (error) {
          if (error instanceof SsrfBlockedError) {
            this.logger.warn("Redirect hop blocked by SSRF guard:", {
              originalUrl: url,
              blockedUrl: currentUrl,
              reason: error.reason,
              detail: error.detail,
            });
            // The very first hop being unsafe means we have nothing to return.
            if (hops === 0) return null;
            break;
          }
          throw error;
        }

        const isRedirectStatus =
          response.status === 301 ||
          response.status === 302 ||
          response.status === 303 ||
          response.status === 307 ||
          response.status === 308;

        if (
          !isRedirectStatus &&
          (response.status < 200 || response.status >= 300)
        ) {
          // Not a redirect, return current URL as final
          break;
        }

        // Check for redirect
        const locationHeader = response.headers["location"];
        const location = Array.isArray(locationHeader)
          ? locationHeader[0]
          : locationHeader;
        if (!location) {
          // No redirect header, current URL is final
          break;
        }

        // Resolve relative redirects
        const nextUrl = new URL(location, currentUrl).href;

        // Security check: validate redirect destination. This is the lexical
        // pre-screen; the authoritative check (DNS + pinning) runs inside
        // `fetchHop` on the next iteration.
        const redirectValidation =
          this.linkSecurityHandler.validateUrlSync(nextUrl);
        if (redirectValidation.status === "blocked") {
          this.logger.warn("Redirect destination blocked:", {
            originalUrl: url,
            blockedUrl: nextUrl,
            reason: redirectValidation.reason,
          });
          // Return current URL as final (don't follow blocked redirect)
          break;
        }

        // Check for redirect loop
        if (redirectChain.includes(nextUrl)) {
          this.logger.warn("Redirect loop detected:", {
            originalUrl: url,
            loopUrl: nextUrl,
          });
          // Return current URL as final
          break;
        }

        redirectChain.push(nextUrl);
        currentUrl = nextUrl;
        hops++;
      }

      const result: RedirectResult = {
        originalUrl: url,
        finalUrl: currentUrl,
        redirectChain,
        isShortener,
        cacheHit: false,
      };

      // Cache the result
      await this.cacheResult(url, result, env);

      return result;
    } catch (error: any) {
      this.logger.error("Error resolving redirects:", {
        url,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Check if domain is a known URL shortener
   *
   * @param domain - Domain to check
   * @returns True if domain is a known shortener
   */
  isShortener(domain: string): boolean {
    const normalizedDomain = domain.toLowerCase();
    return KNOWN_SHORTENERS.includes(normalizedDomain);
  }

  /**
   * Fetch one hop through the SSRF-safe fetcher.
   *
   * `maxRedirects: 0` returns the 3xx rather than following it, so this class
   * keeps its own chain bookkeeping (loop detection, "stop at the last good
   * hop" behaviour) while the validation, IP pinning, timeout and body cap all
   * come from the shared helper.
   *
   * @param url - URL to fetch (validated inside `safeFetch`)
   * @param options - Injected resolver/transport for tests
   * @returns The response for this single hop
   */
  private async fetchHop(
    url: string,
    options: { resolver?: DnsResolver; transport?: Transport },
  ): Promise<Awaited<ReturnType<typeof safeFetch>>> {
    const common = {
      timeoutMs: REQUEST_TIMEOUT,
      maxRedirects: 0,
      maxBytes: MAX_BODY_BYTES,
      headers: { "user-agent": "Trellis-LinkSecurity/1.0" },
      resolver: options.resolver,
      transport: options.transport,
    };

    // HEAD first (cheap); fall back to GET where the origin refuses it.
    const response = await safeFetch(url, { ...common, method: "HEAD" });
    if (response.status === 405 || response.status === 501) {
      return safeFetch(url, { ...common, method: "GET" });
    }
    return response;
  }

  /**
   * Get cached redirect result
   *
   * @param url - URL to check cache for
   * @param env - Environment with KV cache
   * @returns Cached result or null if not found
   */
  async getCachedResult(
    url: string,
    env: RedirectResolverEnv,
  ): Promise<Omit<RedirectResult, "cacheHit"> | null> {
    if (!env.THREAT_INTEL_CACHE_KV) {
      return null;
    }

    try {
      const cacheKey = this.getCacheKey(url);
      const cached = await env.THREAT_INTEL_CACHE_KV.get(cacheKey, "json");

      if (cached && typeof cached === "object") {
        return {
          originalUrl: (cached as any).originalUrl,
          finalUrl: (cached as any).finalUrl,
          redirectChain: (cached as any).redirectChain,
          isShortener: (cached as any).isShortener,
        };
      }
    } catch (error) {
      this.logger.warn("Error reading from redirect cache:", error);
    }

    return null;
  }

  /**
   * Cache redirect result
   *
   * @param url - URL that was resolved
   * @param result - Result to cache
   * @param env - Environment with KV cache
   */
  async cacheResult(
    url: string,
    result: RedirectResult,
    env: RedirectResolverEnv,
  ): Promise<void> {
    if (!env.THREAT_INTEL_CACHE_KV) {
      return;
    }

    try {
      const cacheKey = this.getCacheKey(url);
      const cacheValue = {
        originalUrl: result.originalUrl,
        finalUrl: result.finalUrl,
        redirectChain: result.redirectChain,
        isShortener: result.isShortener,
      };

      await env.THREAT_INTEL_CACHE_KV.put(
        cacheKey,
        JSON.stringify(cacheValue),
        {
          expirationTtl: CACHE_TTL,
        },
      );
    } catch (error) {
      this.logger.warn("Error writing to redirect cache:", error);
    }
  }

  /**
   * Generate cache key for URL
   *
   * @param url - URL to generate key for
   * @returns Cache key
   */
  private getCacheKey(url: string): string {
    // Use normalized URL as cache key
    const normalized = this.linkSecurityHandler.normalizeUrl(url);
    if (normalized) {
      return `${CACHE_KEY_PREFIX}${normalized.normalized}`;
    }
    // Fallback to original URL if normalization fails
    return `${CACHE_KEY_PREFIX}${url}`;
  }
}
