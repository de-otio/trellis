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
import type { MetricsPort } from "./workers/metrics-port.js";

/**
 * Disposition of a threat-intel lookup.
 *
 * The distinction between SAFE and UNKNOWN is the entire point of this type.
 * Previously every failure mode — unset key, non-ok response, thrown error —
 * returned `safe: true`, i.e. an attacker who wanted a malware link to pass
 * only had to make the call fail (flood the quota, trip a transient error).
 * A lookup that did not happen is now UNKNOWN, and callers are expected to
 * render the interstitial for it rather than waving the link through.
 */
export type ThreatIntelStatus = "safe" | "unsafe" | "unknown";

/**
 * Threat intelligence result
 */
export interface ThreatIntelResult {
  /**
   * Kept for source compatibility. NOTE: `safe === true` no longer means "we
   * checked and it was clean" on its own — read `status` when the difference
   * matters. It is false for both "unsafe" and "unknown".
   */
  safe: boolean;
  status: ThreatIntelStatus;
  threats?: string[];
  cacheHit: boolean;
  cachedAt?: Date;
  /** Present when `status === "unknown"`: why the lookup could not complete. */
  failOpenReason?: ThreatIntelFailReason;
}

/** Why a lookup could not produce a verdict. */
export type ThreatIntelFailReason =
  | "api-key-missing"
  | "api-error"
  | "api-exception";

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
  /** Optional sink for the fail-open counter. */
  METRICS?: MetricsPort;
  STAGE?: string;
  NODE_ENV?: string;
}

/**
 * Cache key prefix for threat intel results
 */
const CACHE_KEY_PREFIX = "threat-intel:";

/**
 * Cache TTL in seconds (24 hours)
 */
const CACHE_TTL = 24 * 60 * 60;

/** Metric name for the fail-open counter — alarm on this. */
export const THREAT_INTEL_FAIL_OPEN_METRIC = "ThreatIntelFailOpen";

/**
 * Startup assertion: in production, a missing Safe Browsing key is a
 * misconfiguration, not a degraded mode. Without it every link check returns
 * UNKNOWN forever and the interstitial fires on everything — better to refuse
 * the deploy than to ship a link-safety feature that silently does nothing.
 *
 * Returns a list of error strings so it can be folded into `validateEnv()`.
 */
export function validateThreatIntelEnv(env: {
  GOOGLE_SAFE_BROWSING_API_KEY?: string;
  STAGE?: string;
  NODE_ENV?: string;
}): string[] {
  const isProd = env.STAGE === "prod" || env.NODE_ENV === "production";
  if (isProd && !env.GOOGLE_SAFE_BROWSING_API_KEY) {
    return [
      "GOOGLE_SAFE_BROWSING_API_KEY is required in production — without it every link check fails to UNKNOWN and the safety interstitial fires on every uncached link",
    ];
  }
  return [];
}

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
      // A cached verdict is still trustworthy even with the key now absent —
      // prefer it over UNKNOWN so a key rotation does not interstitial the
      // whole corpus.
      const cachedWithoutKey = await this.getCachedResult(url, env);
      if (cachedWithoutKey) {
        return {
          safe: cachedWithoutKey.safe,
          status: cachedWithoutKey.safe ? "safe" : "unsafe",
          threats: cachedWithoutKey.threats,
          cacheHit: true,
          cachedAt: cachedWithoutKey.cachedAt,
        };
      }
      return this.failOpen("api-key-missing", env, {
        message: "Google Safe Browsing API key not configured",
      });
    }

    // Check cache first
    const cached = await this.getCachedResult(url, env);
    if (cached) {
      return {
        safe: cached.safe,
        status: cached.safe ? "safe" : "unsafe",
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
        return this.failOpen("api-error", env, {
          message: "Safe Browsing API returned a non-ok response",
          status: response.status,
          statusText: response.statusText,
          error: errorText.slice(0, 500),
        });
      }

      // Explicit assertion: under the api tsconfig (DOM lib) `json()` is
      // `Promise<any>` and the annotation alone suffices, but the worker image
      // compiles this same source WITHOUT the DOM lib (apps/worker/tsconfig:
      // lib ["ES2022"] + @types/node), where undici's `json()` returns
      // `Promise<unknown>` — the bare annotation is then a TS2322 that breaks
      // the worker Docker build.
      const data = (await response.json()) as SafeBrowsingResponse;
      const hasThreats = data.matches && data.matches.length > 0;
      const threats = hasThreats
        ? data.matches!.map((m) => m.threatType)
        : undefined;

      const result: ThreatIntelResult = {
        safe: !hasThreats,
        status: hasThreats ? "unsafe" : "safe",
        threats,
        cacheHit: false,
      };

      // Cache the result
      await this.cacheResult(url, result, env);

      return result;
    } catch (error: any) {
      return this.failOpen("api-exception", env, {
        message: "Error checking Safe Browsing API",
        error: (error as Error)?.message,
      });
    }
  }

  /**
   * Record a lookup that could not produce a verdict and return UNKNOWN.
   *
   * Every branch that used to `return { safe: true }` funnels through here, so
   * there is exactly one place that (a) emits the alarm-able counter and (b)
   * decides the disposition. The disposition is deliberately NOT "safe": an
   * uncached link whose check failed gets the interstitial.
   */
  private failOpen(
    reason: ThreatIntelFailReason,
    env: ThreatIntelEnv,
    context: Record<string, unknown>,
  ): ThreatIntelResult {
    this.logger.error("[ThreatIntel] fail-open: lookup produced no verdict", {
      ...context,
      reason,
      metric: THREAT_INTEL_FAIL_OPEN_METRIC,
    });

    // Metrics must never change the disposition — swallow any sink failure.
    try {
      env.METRICS?.emitCounts(
        { reason },
        [{ name: THREAT_INTEL_FAIL_OPEN_METRIC, value: 1 }],
      );
    } catch {
      // deliberately ignored
    }

    return {
      safe: false,
      status: "unknown",
      cacheHit: false,
      failOpenReason: reason,
    };
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
