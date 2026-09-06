/**
 * IP Address Scrubbing Utility
 *
 * PREPARATORY CHANGE: This utility is created now but not yet used in production.
 * It will be enabled when implementing spy-protection features for at-risk users.
 *
 * Scrubs IP addresses for privacy while maintaining rate limiting effectiveness.
 * Can be enabled/disabled via configuration.
 *
 * FUTURE USE:
 * - When IP_SCRUBBING_ENABLED=true, this utility will scrub IP addresses before
 *   storing them in security events and logs
 * - Helps protect user privacy by preventing full IP addresses from being stored
 * - Maintains rate limiting effectiveness by using partial IPs or user IDs
 *
 * ## The `full` level is a KEYED HMAC (security deep pass DP-9)
 *
 * The previous placeholder returned `hashed:` + truncated base64 of the raw
 * address bytes — i.e. the address itself, re-encoded. A deployment selecting
 * `full` for data minimisation would have stored reversible personal data
 * under a label that claimed the opposite. It is now HMAC-SHA256 under a
 * purpose-specific sub-key (HKDF, info `trellis-ip-scrub-v1`) derived from
 * `IP_SCRUB_HMAC_SECRET` or, failing that, from `SESSION_SECRET` — never the
 * raw secret bytes, and never an unkeyed hash (the IPv4 space is small enough
 * to enumerate). A `full` scrub without a key is an error, not a downgrade.
 */

import { deriveSubKey, hmacHex } from "./field-encryption.js";

/** HKDF info label for the IP-scrub sub-key. Versioned so a change is visible. */
export const IP_SCRUB_KEY_INFO = "trellis-ip-scrub-v1";

export interface IPScrubberConfig {
  enabled: boolean;
  level: "none" | "partial" | "full"; // none=no scrubbing, partial=3 octets, full=keyed hash
  preserveForRateLimit: boolean; // Keep full IP for rate limiting (if needed)
  /** Required when `level` is `full`: the HMAC sub-key from {@link deriveIpScrubKey}. */
  hmacKey?: Buffer;
}

/**
 * Scrub IP address based on configuration
 *
 * FUTURE USE: This function will be called when logging security events
 * to protect user privacy by not storing full IP addresses.
 *
 * @param ip - IP address to scrub
 * @param config - Scrubbing configuration
 * @returns Scrubbed IP address (or original if scrubbing disabled)
 */
export function scrubIPAddress(
  ip: string,
  config: IPScrubberConfig = {
    enabled: true,
    level: "partial",
    preserveForRateLimit: false,
  },
): string {
  if (!config.enabled || config.level === "none") {
    return ip;
  }

  if (config.level === "full") {
    if (!config.hmacKey || config.hmacKey.length < 32) {
      // Fail closed: storing the address in any recoverable form under a
      // "hashed:" label is the defect this replaces.
      throw new Error(
        "ip-scrubber: level 'full' requires a 32-byte HMAC key (derive it with deriveIpScrubKey from IP_SCRUB_HMAC_SECRET or SESSION_SECRET)",
      );
    }
    return `hashed:${hmacHex(config.hmacKey, ip).slice(0, 32)}`;
  }

  // Partial scrubbing (level === 'partial')
  // FUTURE USE: Keep first 3 octets for IPv4 or first 64 bits for IPv6
  // This maintains some usefulness for rate limiting while protecting privacy
  if (ip.includes(".")) {
    // IPv4: Keep first 3 octets (e.g., 192.168.1.x)
    const parts = ip.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
    }
  } else if (ip.includes(":")) {
    // IPv6: Keep first 64 bits (e.g., 2001:db8::x)
    const parts = ip.split(":");
    return parts.slice(0, 4).join(":") + "::x";
  }

  return ip; // Fallback
}

/**
 * Get IP address from request (with optional scrubbing)
 *
 * FUTURE USE: This function will replace direct IP address extraction
 * when IP scrubbing is enabled via environment variables.
 *
 * @param request - Request object
 * @param config - Optional scrubbing configuration
 * @returns IP address (scrubbed if config enabled)
 */
export function getIPAddress(
  request: Request,
  config?: IPScrubberConfig,
): string {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0] ||
    "unknown";

  if (config?.enabled) {
    return scrubIPAddress(ip, config);
  }

  return ip;
}

/**
 * Environment interface for IP scrubbing configuration
 */
export interface IPScrubberEnv {
  IP_SCRUBBING_ENABLED?: string; // 'true' to enable IP scrubbing
  IP_SCRUBBING_LEVEL?: string; // 'none', 'partial', or 'full'
  /**
   * Dedicated master secret for the `full` level (≥ 32 chars). Preferred over
   * deriving from the session secret, so IP pseudonyms survive a
   * `SESSION_SECRET` rotation and are not coupled to session security.
   */
  IP_SCRUB_HMAC_SECRET?: string;
  /** Fallback master for the `full` level when no dedicated secret is set. */
  SESSION_SECRET?: string;
}

// One-entry cache: HKDF is cheap, but the request path should not re-derive
// the same key on every call. Keyed by the exact master string so a rotated
// secret yields a fresh key.
let cachedMaster: string | undefined;
let cachedKey: Buffer | undefined;

/**
 * Derive the `full`-level HMAC sub-key from the environment.
 *
 * Uses `IP_SCRUB_HMAC_SECRET` when present, else `SESSION_SECRET`, always
 * through HKDF with the {@link IP_SCRUB_KEY_INFO} label — the raw secret is
 * never used as key material. Throws when neither is set.
 */
export function deriveIpScrubKey(env: IPScrubberEnv): Buffer {
  const master = env.IP_SCRUB_HMAC_SECRET || env.SESSION_SECRET;
  if (!master) {
    throw new Error(
      "ip-scrubber: IP_SCRUBBING_LEVEL=full needs IP_SCRUB_HMAC_SECRET (or SESSION_SECRET) to derive the HMAC key",
    );
  }
  if (cachedMaster === master && cachedKey) return cachedKey;
  const key = deriveSubKey(master, IP_SCRUB_KEY_INFO);
  cachedMaster = master;
  cachedKey = key;
  return key;
}

/**
 * Get IP address from request with environment-based scrubbing
 * This is the production-ready version that reads configuration from environment
 *
 * @param request - Request object
 * @param env - Environment variables
 * @returns IP address (scrubbed based on environment configuration)
 */
export function getIPAddressWithEnvScrubbing(
  request: Request,
  env?: IPScrubberEnv,
): string {
  const level =
    (env?.IP_SCRUBBING_LEVEL as "none" | "partial" | "full") || "partial";
  const enabled = env?.IP_SCRUBBING_ENABLED === "true";
  const config: IPScrubberConfig = {
    enabled,
    level,
    preserveForRateLimit: false,
    hmacKey: enabled && level === "full" && env ? deriveIpScrubKey(env) : undefined,
  };

  return getIPAddress(request, config);
}
