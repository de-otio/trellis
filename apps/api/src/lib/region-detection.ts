/**
 * Region Detection Module
 *
 * Detects user region using multiple sources with priority ordering:
 * 1. User preference (from authenticated session) - Most trusted
 * 2. IP geolocation - Automatic detection
 * 3. Accept-Language header - Fallback
 * 4. Default region - Safe fallback
 *
 * Security: All detected regions are validated against known regions list.
 *
 * ## Foundation adoption
 *
 * The pure header / Accept-Language parsing is delegated to
 * `@de-otio/saas-foundation/region`'s `RegionDetector`, configured via the
 * trellis `RegionRegistry` in `region-registry.ts`. This module keeps:
 *   - trellis's literal `Region` union (`"US" | "EU" | "CN"`),
 *   - `isValidRegion` validating against that union,
 *   - the env-driven `DEFAULT_REGION` handling,
 *   - the legacy "unlisted CDN country -> EU" catch-all policy,
 *   - the trellis-specific user-preference DB lookup, session handling, and
 *     external IP-geolocation fallback.
 *
 * Foundation's `Region` is a generic branded string; by construction the
 * trellis registry only ever yields US/EU/CN, so results are coerced back to
 * the literal union via `coerceRegion`.
 */

import type { Region as FoundationRegion } from "@de-otio/saas-foundation/region";

import { createPrismaForRegion } from "../db.js";
import type { Env } from "../env.js";
import { getIPAddress } from "./ip-scrubber.js";
import { getLogger, Logger } from "./logger.js";
import { getRegionRegistry } from "./region-registry.js";
import { Session, SessionManager } from "./session-cookie.js";

/**
 * Valid regions supported by the application
 */
const VALID_REGIONS = ["US", "EU", "CN"] as const;

export type Region = (typeof VALID_REGIONS)[number];

/** Country codes the CDN uses to signal "unknown location". */
const UNKNOWN_COUNTRY_CODES = new Set(["XX", "T1"]);

/**
 * Coerce a foundation branded `Region` to the trellis literal union.
 *
 * The trellis registry's allowed list is exactly {US, EU, CN}, so foundation
 * can only ever produce one of those. This guard exists to satisfy the type
 * system and to defend against future registry drift; on an unexpected value
 * it returns `null` so callers can fall back to the env default.
 */
function coerceRegion(value: FoundationRegion | string): Region | null {
  return VALID_REGIONS.includes(value as Region) ? (value as Region) : null;
}

/**
 * Re-export `Env` for the legacy `region-config.ts` / extended-test imports
 * that pull the env shape from this module.
 */
export type { Env } from "../env.js";

/**
 * Region Detector class
 */
export class RegionDetector {
  private env: Env;
  private logger: Logger;

  constructor(env: Env) {
    this.env = env;
    this.logger = getLogger();
  }

  /**
   * Validate region against known regions list
   *
   * Security: Prevents region spoofing by only allowing known regions
   *
   * @param region - Region code to validate
   * @returns true if region is valid, false otherwise
   */
  isValidRegion(region: string): region is Region {
    return VALID_REGIONS.includes(region as Region);
  }

  /**
   * Resolve the effective default region from env.
   *
   * Mirrors the legacy behaviour: an invalid `DEFAULT_REGION` falls back to
   * `EU` (the GDPR-safe default), NOT to the raw env value.
   */
  private resolveDefaultRegion(): Region {
    const defaultRegion = (this.env.DEFAULT_REGION as Region) || "EU";
    if (!this.isValidRegion(defaultRegion)) {
      return "EU";
    }
    return defaultRegion;
  }

  /**
   * Map a CDN geolocation header to a region.
   *
   * Reads CloudFront-Viewer-Country (preferred) then CF-IPCountry (legacy
   * Cloudflare fallback). Unknown markers (XX, T1) yield `null`. Mapped
   * countries route via the foundation registry; any other present,
   * non-unknown country defaults to EU per the legacy GDPR-safe policy.
   *
   * @param request - Request object (contains geo headers)
   * @returns Region code or null if no usable CDN country header
   */
  private geolocateIPFromHeaders(request: Request): Region | null {
    const countryCode =
      request.headers.get("CloudFront-Viewer-Country") ||
      request.headers.get("CF-IPCountry");

    if (!countryCode || UNKNOWN_COUNTRY_CODES.has(countryCode)) {
      return null;
    }

    const mapped = getRegionRegistry().countryToRegion(countryCode);
    const coerced = mapped !== null ? coerceRegion(mapped) : null;
    if (coerced !== null) {
      return coerced;
    }

    // POLICY: Default to EU for unlisted countries. EU provides the strictest
    // data residency guarantees and is the safest default for GDPR compliance.
    // To add per-country routing, extend the mapping in region-registry.ts.
    return "EU";
  }

  /**
   * Detect a region from the Accept-Language header.
   *
   * Parses the language tags and resolves each to a region via the foundation
   * registry's `countryToRegion`. The language->country heuristic is a
   * trellis domain rule (which languages imply which markets), so it stays
   * local; only the country->region resolution is delegated to foundation.
   *
   * Foundation's own `RegionDetector` cannot be used directly here because its
   * `detectSync` always falls through to the registry default when no language
   * matches, which would mask the "no match" case this priority chain relies
   * on to continue to the env default.
   *
   * Returns `null` when no language maps (so the caller's chain continues).
   */
  private getRegionFromLanguage(request: Request): Region | null {
    const acceptLanguage = request.headers.get("Accept-Language");
    if (!acceptLanguage) {
      return null;
    }

    // Parse "en-US,en;q=0.9,zh-CN;q=0.8" -> ["en-us", "en", "zh-cn"]
    const languages = acceptLanguage
      .split(",")
      .map((lang) => lang.split(";")[0].trim().toLowerCase())
      .filter((lang) => lang.length > 0);

    const registry = getRegionRegistry();

    // Two-letter language code -> plausible country for registry lookup.
    const langToCountry: Readonly<Record<string, string>> = {
      de: "DE",
      fr: "FR",
      es: "ES",
      it: "IT",
      pt: "PT",
      nl: "NL",
    };

    for (const lang of languages) {
      // China-specific language codes (zh-cn, zh-hans, and any other zh-*).
      if (lang.startsWith("zh")) {
        const r = registry.countryToRegion("CN");
        const coerced = r !== null ? coerceRegion(r) : null;
        if (coerced !== null) {
          return coerced;
        }
      }

      const country = langToCountry[lang.slice(0, 2)];
      if (country !== undefined) {
        const r = registry.countryToRegion(country);
        const coerced = r !== null ? coerceRegion(r) : null;
        if (coerced !== null) {
          return coerced;
        }
      }
    }

    return null;
  }

  /**
   * Geolocate IP address using external service (fallback)
   *
   * Only used if CDN geolocation headers are not available
   *
   * @param ip - IP address to geolocate
   * @returns Region code or null if not detected
   */
  private async geolocateIPExternal(ip: string): Promise<Region | null> {
    // Only use external service if explicitly configured
    if (
      !this.env.IP_GEOLOCATION_API_KEY ||
      this.env.IP_GEOLOCATION_SERVICE !== "ipapi"
    ) {
      return null;
    }

    try {
      // Example: ipapi.co (free tier: 1000 requests/day)
      const response = await fetch(`https://ipapi.co/${ip}/country_code/`, {
        headers: {
          "User-Agent": "Trellis-API/1.0",
        },
      });

      if (!response.ok) {
        return null;
      }

      const countryCode = (await response.text()).trim().toUpperCase();

      // Map country code to region using the same rules as the CDN header
      // path: mapped countries via the registry, any other present country
      // defaults to EU.
      const mapped = getRegionRegistry().countryToRegion(countryCode);
      const coerced = mapped !== null ? coerceRegion(mapped) : null;
      if (coerced !== null) {
        return coerced;
      }
      return "EU";
    } catch (error) {
      this.logger.error(
        "[RegionDetection] External geolocation failed:",
        error,
      );
      return null;
    }
  }

  /**
   * Detect user region from request (optimized async version)
   *
   * Priority order (most trusted first):
   * 1. User preference (from authenticated session)
   * 2. IP geolocation (CloudFront-Viewer-Country / CF-IPCountry header)
   * 3. Accept-Language header
   * 4. Default region
   *
   * Security: All detected regions are validated against known regions list
   *
   * @param request - Request object
   * @param sessionManager - Session manager instance (optional, for user preference)
   * @param session - Existing session (optional, to avoid re-fetching)
   * @returns Detected region code (always valid)
   */
  async detectRegion(
    request: Request,
    sessionManager?: SessionManager,
    session?: Session | null,
  ): Promise<Region> {
    const defaultRegion = this.resolveDefaultRegion();

    // Priority 1: User preference (from authenticated session) - Most trusted
    // First, try to get session if not provided
    let activeSession = session;
    if (!activeSession && sessionManager) {
      try {
        const sessionSecret = this.env.SESSION_SECRET;
        activeSession = await sessionManager.getSession(
          request,
          sessionSecret,
          this.env,
        );
      } catch (error) {
        // If session fetch fails, continue without user preference
        this.logger.debug("[RegionDetection] Could not fetch session:", error);
      }
    }

    // Priority 1: User preference (from authenticated session) - Most trusted
    // Query database for user region preference if we have a session
    if (activeSession?.userId && this.env.DATABASE_URL) {
      try {
        // Try to get user region preference from database
        // We'll try EU region first (default), then fallback to others if needed
        // Note: Type assertion needed since Prisma client hasn't been regenerated with region field
        // TODO: Remove type assertion after running `npx prisma generate`
        // Using retry logic with exponential backoff for connection resilience
        const { sharedDatabaseConnectionManager } = await import(
          "./database-connection-manager.js"
        );
        const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
          "./db-query-helper.js"
        );

        const user = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          "EU",
          this.env as any,
          async (db) => {
            return await (db.user.findUnique({
              where: { id: activeSession.userId },
              select: { region: true } as any,
            }) as unknown as Promise<{ region: string | null } | null>);
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "region_detection_getUserPreference",
              userId: activeSession.userId,
            },
          },
        );

        if (user?.region && this.isValidRegion(user.region)) {
          // User preference takes highest priority
          return user.region;
        }
      } catch (error) {
        // If database query fails, fall through to other detection methods
        // Don't log error here to avoid noise (database might not be available in all contexts)
        this.logger.debug(
          "[RegionDetection] Could not fetch user region preference from database:",
          error,
        );
      }
    }

    // Fast path: Use sync version if external IP geolocation is not configured
    if (
      !this.env.IP_GEOLOCATION_API_KEY ||
      this.env.IP_GEOLOCATION_SERVICE !== "ipapi"
    ) {
      return this.detectRegionSync(request);
    }

    // Slow path: Only if external IP geolocation is configured (rare)

    // Priority 2: IP geolocation
    if (this.env.ENABLE_IP_GEOLOCATION !== "false") {
      // Try CDN geolocation first (CloudFront-Viewer-Country / CF-IPCountry, synchronous)
      const cdnRegion = this.geolocateIPFromHeaders(request);
      if (cdnRegion && this.isValidRegion(cdnRegion)) {
        return cdnRegion;
      }

      // Fallback to external service (only if configured and CDN headers unavailable)
      const ip = getIPAddress(request);
      if (ip && ip !== "unknown") {
        const externalRegion = await this.geolocateIPExternal(ip);
        if (externalRegion && this.isValidRegion(externalRegion)) {
          return externalRegion;
        }
      }
    }

    // Priority 3: Accept-Language header (least trusted)
    const langRegion = this.getRegionFromLanguage(request);
    if (langRegion && this.isValidRegion(langRegion)) {
      return langRegion;
    }

    // Priority 4: Default fallback
    return defaultRegion;
  }

  /**
   * Synchronous version of detectRegion (for cases where async is not needed)
   *
   * Uses only:
   * - CloudFront-Viewer-Country / CF-IPCountry header (synchronous)
   * - Accept-Language header (synchronous)
   * - Default region (synchronous)
   *
   * Does NOT use:
   * - User session (requires async)
   * - External IP geolocation (requires async)
   *
   * @param request - Request object
   * @returns Detected region code (always valid)
   */
  detectRegionSync(request: Request): Region {
    const defaultRegion = this.resolveDefaultRegion();

    // Try CDN geolocation (synchronous)
    if (this.env.ENABLE_IP_GEOLOCATION !== "false") {
      const cdnRegion = this.geolocateIPFromHeaders(request);
      if (cdnRegion && this.isValidRegion(cdnRegion)) {
        return cdnRegion;
      }
    }

    // Try Accept-Language header
    const langRegion = this.getRegionFromLanguage(request);
    if (langRegion && this.isValidRegion(langRegion)) {
      return langRegion;
    }

    // Default fallback
    return defaultRegion;
  }
}

/**
 * Legacy functions for backward compatibility
 * @deprecated Use new RegionDetector class instead
 */
export function isValidRegion(region: string): region is Region {
  return VALID_REGIONS.includes(region as Region);
}

export async function detectRegion(
  request: Request,
  env: Env,
  sessionManager?: SessionManager,
  session?: Session | null,
): Promise<Region> {
  const detector = new RegionDetector(env);
  return detector.detectRegion(request, sessionManager, session);
}

export function detectRegionSync(request: Request, env: Env): Region {
  const detector = new RegionDetector(env);
  return detector.detectRegionSync(request);
}
