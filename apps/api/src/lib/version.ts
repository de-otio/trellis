/**
 * Application version information
 *
 * For Cloudflare Workers, version is read from APP_VERSION env var (set in wrangler.toml or as secret)
 * Source of truth: apps/api/package.json
 *
 * Best Practice: Single source of truth is package.json, injected at build time via env var
 */

/**
 * Get application version from environment
 * @param env - Cloudflare Workers environment variables
 * @returns Version string (defaults to '0.1.0' from package.json)
 */
export function getAppVersion(env?: { APP_VERSION?: string }): string {
  return env?.APP_VERSION || "0.1.0";
}

/**
 * Get build metadata
 * @param env - Cloudflare Workers environment variables
 */
export function getBuildInfo(env?: {
  APP_VERSION?: string;
  ENVIRONMENT?: string;
}) {
  return {
    version: getAppVersion(env),
    environment: env?.ENVIRONMENT,
  };
}

/**
 * Get formatted version string
 * Format: "1.2.3" or "1.2.3-dev" for dev builds
 */
export function getVersionString(env?: {
  APP_VERSION?: string;
  ENVIRONMENT?: string;
}): string {
  const version = getAppVersion(env);
  const environment = env?.ENVIRONMENT;

  if (!environment || environment === "prod") {
    return version;
  }

  return `${version}-${environment}`;
}
