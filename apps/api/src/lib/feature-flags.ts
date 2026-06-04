/**
 * Feature Flags
 *
 * Provides feature flag structure for white-label support.
 * Now checks FeatureToggleService for dynamic control.
 */

import { getLogger, Logger, type LoggerEnv } from "./logger.js";

export interface FeatureFlags {
  posts: boolean;
  comments: boolean;
  entities: boolean;
  friends: boolean;
  sentiments: boolean;
  feeds: boolean;
  map: boolean;
}

/**
 * Default feature flags (general defaults - should be false for safety)
 *
 * Note: These are fallback defaults when feature toggles don't exist in the database.
 * For application-specific defaults, configure FEATURE_FLAGS in environments/{env}/config.yaml
 * and run the seed script to populate the database.
 */
const DEFAULT_FEATURES: FeatureFlags = {
  posts: false, // General default: false (safe)
  comments: false, // General default: false (safe)
  entities: false, // General default: false (safe)
  friends: false, // General default: false (safe)
  sentiments: false, // General default: false (safe)
  feeds: false, // General default: false (safe)
  map: false, // General default: false (safe)
};

/**
 * Feature Flags Manager class
 */
export class FeatureFlagsManager {
  private db?: any;
  private env?: LoggerEnv;
  private logger: Logger;

  constructor(db?: any, env?: LoggerEnv) {
    this.db = db;
    this.env = env;
    this.logger = getLogger();
  }

  /**
   * Get feature flags for a tenant
   *
   * Checks FeatureToggleService for each feature flag.
   * Falls back to defaults if toggle doesn't exist.
   *
   * @param tenantId - Optional tenant ID. When provided, each flag resolves the
   *                   tenant override first, falling back to the global row,
   *                   then the coded default (P5). When omitted, resolution is
   *                   global-only — unchanged from before.
   * @returns Feature flags object
   */
  async getFeatureFlags(tenantId?: string): Promise<FeatureFlags> {
    // If no database provided, return defaults (backward compatibility)
    if (!this.db) {
      return DEFAULT_FEATURES;
    }

    try {
      const { FeatureToggleService } = await import("./feature-toggle-service.js");
      const toggleService = new FeatureToggleService(this.db);

      // Helper function to check toggle or use default. Threads the optional
      // tenantId through so a tenant override beats the global row, which beats
      // the coded default. When tenantId is undefined, getToggle stays on the
      // global (cached) path.
      const checkToggle = async (
        key: string,
        defaultValue: boolean,
      ): Promise<boolean> => {
        const toggle = await toggleService.getToggle(key, tenantId);
        // If toggle doesn't exist, use default; otherwise use toggle value
        return toggle === null ? defaultValue : toggle.enabled;
      };

      // Check each feature toggle
      // Format: <feature>_enabled (e.g., posts_enabled)
      return {
        posts: await checkToggle("posts_enabled", DEFAULT_FEATURES.posts),
        comments: await checkToggle(
          "comments_enabled",
          DEFAULT_FEATURES.comments,
        ),
        entities: await checkToggle(
          "entity_profiles_enabled",
          DEFAULT_FEATURES.entities,
        ),
        friends: await checkToggle("friends_enabled", DEFAULT_FEATURES.friends),
        sentiments: await checkToggle(
          "sentiments_enabled",
          DEFAULT_FEATURES.sentiments,
        ),
        feeds: await checkToggle("feeds_enabled", DEFAULT_FEATURES.feeds),
        map: await checkToggle("map_enabled", DEFAULT_FEATURES.map),
      };
    } catch (error) {
      this.logger.error(
        "[FeatureFlags] Error checking feature toggles:",
        error,
      );
      // Fall back to defaults on error
      return DEFAULT_FEATURES;
    }
  }

  /**
   * Get feature flags synchronously
   *
   * @deprecated Use getFeatureFlags() instead for dynamic control
   * This function returns defaults only for backward compatibility
   */
  getFeatureFlagsSync(tenantId?: string): FeatureFlags {
    return DEFAULT_FEATURES;
  }
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use new FeatureFlagsManager class instead
 */
export async function getFeatureFlags(
  tenantId?: string,
  db?: any,
  env?: { LOG_LEVEL?: string; NODE_ENV?: string },
): Promise<FeatureFlags> {
  return new FeatureFlagsManager(db, env).getFeatureFlags(tenantId);
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use new FeatureFlagsManager class instead
 */
export function getFeatureFlagsSync(tenantId?: string): FeatureFlags {
  return DEFAULT_FEATURES;
}
