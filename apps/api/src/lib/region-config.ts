/**
 * Regional Configuration Module
 *
 * Provides region-specific configuration including:
 * - Feature flags
 * - Endpoints
 * - Timeouts
 * - Provider settings
 *
 * Security: All configurations are validated before use.
 */

import { isValidRegion, type Region } from "./region-detection.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";

/**
 * Feature flags for authentication methods
 */
export interface AuthenticationFlags {
  emailPassword: boolean;
  magicLink: boolean;
  phoneAuth: boolean;
  weChatAuth: boolean;
  qqAuth: boolean;
  microsoftSSO: boolean;
}

/**
 * Feature flags for application features
 */
export interface ApplicationFeatures {
  offlineMode: boolean;
  realTimeUpdates: boolean;
  pushNotifications: boolean;
}

/**
 * Performance configuration flags
 */
export interface PerformanceFlags {
  extendedTimeouts: boolean;
  aggressiveCaching: boolean;
  requestBatching: boolean;
}

/**
 * Security features (always enabled, cannot be disabled)
 */
export interface SecurityFlags {
  encryption: boolean; // Always true
  rateLimiting: boolean; // Always true
  auditLogging: boolean; // Always true
  regionValidation: boolean; // Always true
}

/**
 * Feature flags for a region
 */
export interface FeatureFlags {
  authentication: AuthenticationFlags;
  features: ApplicationFeatures;
  performance: PerformanceFlags;
  security: SecurityFlags; // Always enabled
}

/**
 * Endpoint configuration
 */
export interface EndpointConfig {
  api: string;
  frontend: string;
  cdn: string;
}

/**
 * Timeout configuration (in milliseconds)
 */
export interface TimeoutConfig {
  api: number;
  database: number;
  storage: number;
}

/**
 * Complete regional configuration
 */
export interface RegionConfig {
  region: Region;
  features: FeatureFlags;
  endpoints: EndpointConfig;
  timeouts: TimeoutConfig;
}

/**
 * Environment variables interface for region configuration
 */
export interface Env {
  // Default region
  DEFAULT_REGION?: string;

  // US region endpoints (defaults)
  US_API_ENDPOINT?: string;
  US_FRONTEND_ENDPOINT?: string;
  US_CDN_ENDPOINT?: string;

  // EU region endpoints (optional)
  EU_API_ENDPOINT?: string;
  EU_FRONTEND_ENDPOINT?: string;
  EU_CDN_ENDPOINT?: string;

  // CN region endpoints (optional)
  CN_API_ENDPOINT?: string;
  CN_FRONTEND_ENDPOINT?: string;
  CN_CDN_ENDPOINT?: string;

  // Feature flags (can override defaults via env vars)
  // Format: FEATURE_FLAG_<REGION>_<FEATURE>=true|false
  // Example: FEATURE_FLAG_CN_PHONE_AUTH=true
}

/**
 * Get default US region configuration
 */
function getDefaultUSConfig(env: Env): RegionConfig {
  return {
    region: "US",
    features: {
      authentication: {
        emailPassword: false, // Regular users use magic link (passwordless)
        magicLink: true, // Regular users (B2C)
        phoneAuth: false,
        weChatAuth: false,
        qqAuth: false,
        microsoftSSO: true, // Internal users (unchanged)
      },
      features: {
        offlineMode: false,
        realTimeUpdates: true,
        pushNotifications: true,
      },
      performance: {
        extendedTimeouts: false,
        aggressiveCaching: false,
        requestBatching: false,
      },
      security: {
        encryption: true, // Always enabled
        rateLimiting: true, // Always enabled
        auditLogging: true, // Always enabled
        regionValidation: true, // Always enabled
      },
    },
    endpoints: {
      api: env.US_API_ENDPOINT || "https://api.example.com",
      frontend: env.US_FRONTEND_ENDPOINT || "https://www.example.com",
      cdn: env.US_CDN_ENDPOINT || "https://cdn.example.com",
    },
    timeouts: {
      api: 10000, // 10 seconds
      database: 5000, // 5 seconds
      storage: 5000, // 5 seconds
    },
  };
}

/**
 * Get default EU region configuration
 */
function getDefaultEUConfig(env: Env): RegionConfig {
  return {
    region: "EU",
    features: {
      authentication: {
        emailPassword: false, // Regular users use magic link (passwordless)
        magicLink: true, // Regular users (B2C)
        phoneAuth: false,
        weChatAuth: false,
        qqAuth: false,
        microsoftSSO: true, // Internal users (unchanged)
      },
      features: {
        offlineMode: false,
        realTimeUpdates: true,
        pushNotifications: true,
      },
      performance: {
        extendedTimeouts: false,
        aggressiveCaching: false,
        requestBatching: false,
      },
      security: {
        encryption: true, // Always enabled
        rateLimiting: true, // Always enabled
        auditLogging: true, // Always enabled
        regionValidation: true, // Always enabled
      },
    },
    endpoints: {
      api: env.EU_API_ENDPOINT || "https://api-eu.example.com",
      frontend: env.EU_FRONTEND_ENDPOINT || "https://www-eu.example.com",
      cdn: env.EU_CDN_ENDPOINT || "https://cdn-eu.example.com",
    },
    timeouts: {
      api: 10000, // 10 seconds
      database: 5000, // 5 seconds
      storage: 5000, // 5 seconds
    },
  };
}

/**
 * Get default CN region configuration
 *
 * Note: This is a placeholder for future China expansion.
 * Currently uses conservative defaults that assume China infrastructure is not yet set up.
 */
export function getDefaultCNConfig(env: Env): RegionConfig {
  return {
    region: "CN",
    features: {
      authentication: {
        emailPassword: false, // Regular users use phone/WeChat/QQ (passwordless)
        magicLink: false, // Email may be unreliable in China
        phoneAuth: true, // SMS OTP preferred in China (regular users)
        weChatAuth: true, // WeChat OAuth popular in China (regular users)
        qqAuth: true, // QQ OAuth popular in China (regular users)
        microsoftSSO: false, // Microsoft SSO blocked by GFW
      },
      features: {
        offlineMode: true, // Important for unreliable connections
        realTimeUpdates: false, // May not work reliably
        pushNotifications: false, // May not work reliably
      },
      performance: {
        extendedTimeouts: true, // Longer timeouts for slower connections
        aggressiveCaching: true, // Cache more aggressively
        requestBatching: true, // Batch requests to reduce round trips
      },
      security: {
        encryption: true, // Always enabled
        rateLimiting: true, // Always enabled
        auditLogging: true, // Always enabled
        regionValidation: true, // Always enabled
      },
    },
    endpoints: {
      api: env.CN_API_ENDPOINT || "https://api-cn.example.com",
      frontend: env.CN_FRONTEND_ENDPOINT || "https://www-cn.example.com",
      cdn: env.CN_CDN_ENDPOINT || "https://cdn-cn.example.com",
    },
    timeouts: {
      api: 60000, // 60 seconds (longer for China)
      database: 30000, // 30 seconds
      storage: 30000, // 30 seconds
    },
  };
}

/**
 * Validate region configuration
 *
 * Security: Ensures all required fields are present and valid
 *
 * @param config - Region configuration to validate
 * @returns true if valid, throws error if invalid
 */
function validateRegionConfig(config: RegionConfig): void {
  if (!isValidRegion(config.region)) {
    throw new Error(`Invalid region in config: ${config.region}`);
  }

  // Validate endpoints
  if (!config.endpoints.api || !config.endpoints.api.startsWith("http")) {
    throw new Error(`Invalid API endpoint: ${config.endpoints.api}`);
  }
  if (
    !config.endpoints.frontend ||
    !config.endpoints.frontend.startsWith("http")
  ) {
    throw new Error(`Invalid frontend endpoint: ${config.endpoints.frontend}`);
  }
  if (!config.endpoints.cdn || !config.endpoints.cdn.startsWith("http")) {
    throw new Error(`Invalid CDN endpoint: ${config.endpoints.cdn}`);
  }

  // Validate timeouts (must be positive)
  if (
    config.timeouts.api <= 0 ||
    config.timeouts.database <= 0 ||
    config.timeouts.storage <= 0
  ) {
    throw new Error("Invalid timeout values (must be positive)");
  }

  // CRITICAL: Ensure security features are always enabled
  if (!config.features.security.encryption) {
    throw new Error("Security feature encryption cannot be disabled");
  }
  if (!config.features.security.rateLimiting) {
    throw new Error("Security feature rateLimiting cannot be disabled");
  }
  if (!config.features.security.auditLogging) {
    throw new Error("Security feature auditLogging cannot be disabled");
  }
  if (!config.features.security.regionValidation) {
    throw new Error("Security feature regionValidation cannot be disabled");
  }
}

/**
 * Region Configuration Manager class
 */
export class RegionConfigManager {
  private env: Env;
  private logger: Logger;
  // PERFORMANCE: Cache region configs (they're static and don't change at runtime)
  // This avoids recreating config objects on every request
  private static configCache = new Map<
    string,
    { config: RegionConfig; envHash: string }
  >();

  constructor(env: Env) {
    this.env = env;
    this.logger = getLogger();
  }

  /**
   * Get a simple hash of environment variables that affect config
   * This allows us to invalidate cache when env changes
   */
  private getEnvHash(): string {
    // Only hash env vars that affect config (endpoints)
    return [
      this.env.US_API_ENDPOINT,
      this.env.US_FRONTEND_ENDPOINT,
      this.env.US_CDN_ENDPOINT,
      this.env.EU_API_ENDPOINT,
      this.env.EU_FRONTEND_ENDPOINT,
      this.env.EU_CDN_ENDPOINT,
      this.env.CN_API_ENDPOINT,
      this.env.CN_FRONTEND_ENDPOINT,
      this.env.CN_CDN_ENDPOINT,
    ].join("|");
  }

  /**
   * Get region-specific configuration
   *
   * Security: All configurations are validated before return (first time only)
   *
   * Performance: Configs are cached to avoid recreation on every request.
   * Cache is invalidated if environment variables change.
   *
   * @param region - Region code ('US', 'EU', 'CN')
   * @returns Region configuration
   * @throws Error if region is invalid or configuration is invalid
   */
  getRegionConfig(region: string): RegionConfig {
    // Validate region
    if (!isValidRegion(region)) {
      this.logger.warn(
        `[RegionConfig] Invalid region: ${region}, defaulting to EU`,
      );
      region = "EU";
    }

    // PERFORMANCE: Check cache first
    const envHash = this.getEnvHash();
    const cacheKey = `${region}:${envHash}`;
    const cached = RegionConfigManager.configCache.get(cacheKey);
    if (cached && cached.envHash === envHash) {
      return cached.config;
    }

    // Get base configuration for region
    let config: RegionConfig;
    switch (region) {
      case "CN":
        config = getDefaultCNConfig(this.env);
        break;
      case "US":
        config = getDefaultUSConfig(this.env);
        break;
      case "EU":
      default:
        config = getDefaultEUConfig(this.env);
        break;
    }

    // PERFORMANCE: Only validate on first load (configs are static)
    // Validation is expensive, but configs don't change at runtime
    try {
      validateRegionConfig(config);
    } catch (error) {
      this.logger.error(
        `[RegionConfig] Invalid configuration for region ${region}:`,
        error,
      );
      // Fallback to EU config if validation fails
      if (region !== "EU") {
        this.logger.warn(`[RegionConfig] Falling back to EU configuration`);
        config = getDefaultEUConfig(this.env);
        validateRegionConfig(config); // EU config should always be valid
      } else {
        throw error; // If EU config is invalid, that's a critical error
      }
    }

    // Cache the config
    RegionConfigManager.configCache.set(cacheKey, { config, envHash });

    return config;
  }

  /**
   * Get feature flags for a region
   *
   * Convenience function to get just the feature flags
   *
   * @param region - Region code
   * @returns Feature flags for the region
   */
  getFeatureFlags(region: string): FeatureFlags {
    const config = this.getRegionConfig(region);
    return config.features;
  }

  /**
   * Get feature flags for a region with database toggle checks
   *
   * This async version checks FeatureToggleService for overrides.
   * Falls back to default config if toggle doesn't exist.
   *
   * @param region - Region code
   * @param db - Prisma client (optional, will create if not provided)
   * @returns Feature flags for the region with toggle overrides
   */
  async getFeatureFlagsAsync(region: string, db?: any): Promise<FeatureFlags> {
    // Get base config (synchronous, uses defaults)
    const baseConfig = this.getRegionConfig(region);
    const baseFlags = baseConfig.features;

    // If no database provided, return base flags
    if (!db) {
      return baseFlags;
    }

    try {
      const { FeatureToggleService } = await import("./feature-toggle-service.js");
      const toggleService = new FeatureToggleService(db);

      // Helper function to check toggle or use default
      const checkToggle = async (
        key: string,
        defaultValue: boolean,
      ): Promise<boolean> => {
        const toggle = await toggleService.getToggle(key);
        // If toggle doesn't exist, use default; otherwise use toggle value
        return toggle === null ? defaultValue : toggle.enabled;
      };

      // Check region-specific toggles
      // Format: region_<REGION>_<feature> (e.g., region_CN_weChatAuth)
      const regionPrefix = `region_${region.toUpperCase()}_`;

      // Authentication flags
      const authFlags: AuthenticationFlags = {
        emailPassword: await checkToggle(
          `${regionPrefix}auth_email_password`,
          baseFlags.authentication.emailPassword,
        ),
        magicLink: await checkToggle(
          `${regionPrefix}auth_magic_link`,
          baseFlags.authentication.magicLink,
        ),
        phoneAuth: await checkToggle(
          `${regionPrefix}auth_phone`,
          baseFlags.authentication.phoneAuth,
        ),
        weChatAuth: await checkToggle(
          `${regionPrefix}auth_wechat`,
          baseFlags.authentication.weChatAuth,
        ),
        qqAuth: await checkToggle(
          `${regionPrefix}auth_qq`,
          baseFlags.authentication.qqAuth,
        ),
        microsoftSSO: await checkToggle(
          `${regionPrefix}auth_microsoft_sso`,
          baseFlags.authentication.microsoftSSO,
        ),
      };

      // Application features
      const appFeatures: ApplicationFeatures = {
        offlineMode: await checkToggle(
          `${regionPrefix}app_offline_mode`,
          baseFlags.features.offlineMode,
        ),
        realTimeUpdates: await checkToggle(
          `${regionPrefix}app_realtime_updates`,
          baseFlags.features.realTimeUpdates,
        ),
        pushNotifications: await checkToggle(
          `${regionPrefix}app_push_notifications`,
          baseFlags.features.pushNotifications,
        ),
      };

      // Performance flags
      const perfFlags: PerformanceFlags = {
        extendedTimeouts: await checkToggle(
          `${regionPrefix}perf_extended_timeouts`,
          baseFlags.performance.extendedTimeouts,
        ),
        aggressiveCaching: await checkToggle(
          `${regionPrefix}perf_aggressive_caching`,
          baseFlags.performance.aggressiveCaching,
        ),
        requestBatching: await checkToggle(
          `${regionPrefix}perf_request_batching`,
          baseFlags.performance.requestBatching,
        ),
      };

      // Security flags are always enabled (cannot be overridden)
      const securityFlags: SecurityFlags = baseFlags.security;

      return {
        authentication: authFlags,
        features: appFeatures,
        performance: perfFlags,
        security: securityFlags,
      };
    } catch (error) {
      this.logger.error(
        `[RegionConfig] Error checking feature toggles for region ${region}:`,
        error,
      );
      // Fall back to base config on error
      return baseFlags;
    }
  }

  /**
   * Get endpoints for a region
   *
   * Convenience function to get just the endpoints
   *
   * @param region - Region code
   * @returns Endpoints for the region
   */
  getEndpoints(region: string): EndpointConfig {
    const config = this.getRegionConfig(region);
    return config.endpoints;
  }

  /**
   * Get timeouts for a region
   *
   * Convenience function to get just the timeouts
   *
   * @param region - Region code
   * @returns Timeouts for the region
   */
  getTimeouts(region: string): TimeoutConfig {
    const config = this.getRegionConfig(region);
    return config.timeouts;
  }
}

// PERFORMANCE: Cache region configs (they're static and don't change at runtime)
// This avoids recreating config objects on every request
const configCache = new Map<
  string,
  { config: RegionConfig; envHash: string }
>();

/**
 * Get a simple hash of environment variables that affect config
 * This allows us to invalidate cache when env changes
 */
function getEnvHash(env: Env): string {
  // Only hash env vars that affect config (endpoints)
  return [
    env.US_API_ENDPOINT,
    env.US_FRONTEND_ENDPOINT,
    env.US_CDN_ENDPOINT,
    env.EU_API_ENDPOINT,
    env.EU_FRONTEND_ENDPOINT,
    env.EU_CDN_ENDPOINT,
    env.CN_API_ENDPOINT,
    env.CN_FRONTEND_ENDPOINT,
    env.CN_CDN_ENDPOINT,
  ].join("|");
}

/**
 * Legacy functions for backward compatibility
 * @deprecated Use new RegionConfigManager class instead
 */
export function getRegionConfig(region: string, env: Env): RegionConfig {
  const manager = new RegionConfigManager(env);
  return manager.getRegionConfig(region);
}

export function getFeatureFlags(region: string, env: Env): FeatureFlags {
  const manager = new RegionConfigManager(env);
  return manager.getFeatureFlags(region);
}

export async function getFeatureFlagsAsync(
  region: string,
  env: Env,
  db?: any,
): Promise<FeatureFlags> {
  const manager = new RegionConfigManager(env);
  return manager.getFeatureFlagsAsync(region, db);
}

export function getEndpoints(region: string, env: Env): EndpointConfig {
  const manager = new RegionConfigManager(env);
  return manager.getEndpoints(region);
}

export function getTimeouts(region: string, env: Env): TimeoutConfig {
  const manager = new RegionConfigManager(env);
  return manager.getTimeouts(region);
}
