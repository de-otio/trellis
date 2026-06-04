/**
 * Region Registry (foundation adapter)
 *
 * Builds a singleton foundation `RegionRegistry` configured with trellis's
 * three regions (US, EU, CN) and the country-code -> region mapping that was
 * previously hardcoded in `region-detection.ts`.
 *
 * The registry is consumed by the thin wrapper in `region-detection.ts`,
 * which delegates the pure header / Accept-Language parsing to foundation's
 * `RegionDetector` while keeping trellis's literal `Region` union and its
 * domain-specific session / DB / external-geolocation logic local.
 *
 * Why a module-level singleton (and not foundation's "explicit instance"
 * default): trellis's detection surface is a set of free functions plus a
 * `RegionDetector(env)` facade that take only `env`. The allowed list and
 * country mapping are fixed for the deployment, so a lazily-constructed,
 * cached registry preserves that surface without threading an extra
 * parameter through ~35 call sites.
 */

import { RegionRegistry } from "@de-otio/saas-foundation/region";

/**
 * Trellis's three regions. Kept here as the single source of truth for the
 * foundation registry's allowed list; the literal `Region` union lives in
 * `region-detection.ts`.
 */
export const TRELLIS_REGIONS = ["US", "EU", "CN"] as const;

/**
 * EU member-state country codes that map to the `EU` region.
 *
 * Faithfully copied from the previous hardcoded list in
 * `region-detection.ts` (both the CDN-header and external-geolocation
 * branches used the same 27-entry list).
 */
export const EU_COUNTRY_CODES = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
] as const;

/**
 * Build the country-code -> region mapping for the foundation registry.
 *
 * Mirrors the explicit rules from the legacy `geolocateIPFromHeaders`:
 *   - "CN" -> CN
 *   - "US" -> US
 *   - each EU member-state code -> EU
 *
 * The legacy "default unlisted countries to EU" policy is NOT encoded here
 * (a finite map cannot express a catch-all). The wrapper in
 * `region-detection.ts` applies that policy explicitly for any present,
 * non-unknown CDN country code that the registry does not map.
 */
function buildCountryMapping(): Record<string, string> {
  const mapping: Record<string, string> = {
    CN: "CN",
    US: "US",
  };
  for (const code of EU_COUNTRY_CODES) {
    mapping[code] = "EU";
  }
  return mapping;
}

let cachedRegistry: RegionRegistry | null = null;

/**
 * Lazily construct and cache the trellis `RegionRegistry`.
 *
 * The default region here is `EU`: trellis's safest GDPR fallback and the
 * value the legacy code fell back to when `DEFAULT_REGION` was invalid. The
 * env-driven `DEFAULT_REGION` override is applied by the wrapper, not the
 * registry, so the cached registry stays stable across requests.
 */
export function getRegionRegistry(): RegionRegistry {
  if (cachedRegistry === null) {
    cachedRegistry = new RegionRegistry({
      allowed: [...TRELLIS_REGIONS],
      default: "EU",
      countryMapping: buildCountryMapping(),
    });
  }
  return cachedRegistry;
}

/**
 * Reset the cached registry. Intended for tests that want a fresh instance;
 * production code never needs this.
 */
export function resetRegionRegistry(): void {
  cachedRegistry = null;
}
