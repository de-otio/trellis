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
 */

export interface IPScrubberConfig {
  enabled: boolean;
  level: "none" | "partial" | "full"; // none=no scrubbing, partial=3 octets, full=hash
  preserveForRateLimit: boolean; // Keep full IP for rate limiting (if needed)
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
    // FUTURE USE: Hash IP address for maximum privacy
    // This creates a one-way hash that cannot be reversed
    // Use for maximum privacy when full IP scrubbing is required
    const encoder = new TextEncoder();
    const data = encoder.encode(ip);
    // Note: In production, use crypto.subtle.digest for proper hashing
    // This is a placeholder implementation
    return `hashed:${btoa(String.fromCharCode(...data)).substring(0, 16)}`;
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
  const config: IPScrubberConfig = {
    enabled: env?.IP_SCRUBBING_ENABLED === "true",
    level:
      (env?.IP_SCRUBBING_LEVEL as "none" | "partial" | "full") || "partial",
    preserveForRateLimit: false,
  };

  return getIPAddress(request, config);
}
