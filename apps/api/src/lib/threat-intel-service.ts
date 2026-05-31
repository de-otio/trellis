import type { KVNamespace, R2Bucket, CloudflareQueue } from "../types/cloudflare-compat.js";
/**
 * Threat Intelligence Service
 *
 * Integrates with Google Safe Browsing API to check URLs for known malicious content.
 * Uses KV caching to reduce API calls and improve performance.
 *
 * PREPARATORY: Designed for integration with domain reputation system.
 */


import { getLogger, Logger, type LoggerEnv } from "./logger.js";

/**
 * Threat intelligence result
 */
export interface ThreatIntelResult {
  safe: boolean;
  threats?: string[];
  cacheHit: boolean;
  cachedAt?: Date;
}

/**
 * Google Safe Browsing API response
 */
interface SafeBrowsingResponse {
  matches?: Array<{
    threatType: string;
    platformType: string;
    threat: {
      url: string;
    };
  }>;
}

/**
 * Environment interface for ThreatIntelService
 */
export interface ThreatIntelEnv {
  GOOGLE_SAFE_BROWSING_API_KEY?: string;
  THREAT_INTEL_CACHE_KV?: KVNamespace;
}

/**
 * Cache key prefix for threat intel results
 */
const CACHE_KEY_PREFIX = "threat-intel:";

/**
 * Cache TTL in seconds (24 hours)
 */
const CACHE_TTL = 24 * 60 * 60;

export class ThreatIntelService {
  private logger: Logger;
  private readonly apiUrl =
    "https://safebrowsing.googleapis.com/v4/threatMatches:find";

  constructor(env?: LoggerEnv) {
    this.logger = getLogger();
  }

  /**
   * Check URL against Google Safe Browsing API
   *
   * @param url - URL to check
   * @param env - Environment with API key and KV cache
   * @returns Threat intelligence result
   */
  async checkSafeBrowsing(
    url: string,
    env: ThreatIntelEnv,
  ): Promise<ThreatIntelResult> {
    if (!env.GOOGLE_SAFE_BROWSING_API_KEY) {
      this.logger.warn(
        "Google Safe Browsing API key not configured, skipping check",
      );
      return {
        safe: true, // Fail open - don't block if service unavailable
        cacheHit: false,
      };
    }

    // Check cache first
    const cached = await this.getCachedResult(url, env);
    if (cached) {
      return {
        safe: cached.safe,
        threats: cached.threats,
        cacheHit: true,
        cachedAt: cached.cachedAt,
      };
    }

    try {
      // Call Google Safe Browsing API
      const response = await fetch(
        `${this.apiUrl}?key=${env.GOOGLE_SAFE_BROWSING_API_KEY}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client: {
              clientId: "trellis",
              clientVersion: "1.0.0",
            },
            threatInfo: {
              threatTypes: [
                "MALWARE",
                "SOCIAL_ENGINEERING",
                "UNWANTED_SOFTWARE",
                "POTENTIALLY_HARMFUL_APPLICATION",
              ],
              platformTypes: ["ANY_PLATFORM"],
              threatEntryTypes: ["URL"],
              threatEntries: [
                {
                  url: url,
                },
              ],
            },
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error("Safe Browsing API error:", {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
        });

        // Fail open - don't block if API fails
        return {
          safe: true,
          cacheHit: false,
        };
      }

      const data: SafeBrowsingResponse = await response.json();
      const hasThreats = data.matches && data.matches.length > 0;
      const threats = hasThreats
        ? data.matches!.map((m) => m.threatType)
        : undefined;

      const result: ThreatIntelResult = {
        safe: !hasThreats,
        threats,
        cacheHit: false,
      };

      // Cache the result
      await this.cacheResult(url, result, env);

      return result;
    } catch (error: any) {
      this.logger.error("Error checking Safe Browsing API:", error);
      // Fail open - don't block if service unavailable
      return {
        safe: true,
        cacheHit: false,
      };
    }
  }

  /**
   * Get cached threat intelligence result
   *
   * @param url - URL to check cache for
   * @param env - Environment with KV cache
   * @returns Cached result or null if not found
   */
  async getCachedResult(
    url: string,
    env: ThreatIntelEnv,
  ): Promise<{ safe: boolean; threats?: string[]; cachedAt: Date } | null> {
    if (!env.THREAT_INTEL_CACHE_KV) {
      return null;
    }

    try {
      const cacheKey = this.getCacheKey(url);
      const cached = (await env.THREAT_INTEL_CACHE_KV.get(
        cacheKey,
        "json",
      )) as any;

      if (
        cached &&
        typeof cached === "object" &&
        "safe" in cached &&
        "cachedAt" in cached
      ) {
        return {
          safe: cached.safe,
          threats: cached.threats,
          cachedAt: new Date(cached.cachedAt),
        };
      }
    } catch (error) {
      this.logger.warn("Error reading from threat intel cache:", error);
    }

    return null;
  }

  /**
   * Cache threat intelligence result
   *
   * @param url - URL that was checked
   * @param result - Result to cache
   * @param env - Environment with KV cache
   */
  async cacheResult(
    url: string,
    result: ThreatIntelResult,
    env: ThreatIntelEnv,
  ): Promise<void> {
    if (!env.THREAT_INTEL_CACHE_KV) {
      return;
    }

    try {
      const cacheKey = this.getCacheKey(url);
      const cacheValue = {
        safe: result.safe,
        threats: result.threats,
        cachedAt: new Date().toISOString(),
      };

      await env.THREAT_INTEL_CACHE_KV.put(
        cacheKey,
        JSON.stringify(cacheValue),
        {
          expirationTtl: CACHE_TTL,
        },
      );
    } catch (error) {
      this.logger.warn("Error writing to threat intel cache:", error);
    }
  }

  /**
   * Generate cache key for URL
   *
   * @param url - URL to generate key for
   * @returns Cache key
   */
  private getCacheKey(url: string): string {
    // Use normalized URL (domain + path) as cache key
    try {
      const parsed = new URL(url);
      const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      return `${CACHE_KEY_PREFIX}${normalized}`;
    } catch {
      // Fallback to full URL if parsing fails
      return `${CACHE_KEY_PREFIX}${url}`;
    }
  }
}
