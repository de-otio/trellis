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

/**
 * The `platform` block served by `GET /api/feature-flags` (plan
 * evolvability §2.2 / T9). One boolean per platform-enforcement toggle
 * key, resolved from `FeatureToggleService` GLOBAL values only — this
 * endpoint is unauthenticated and carries no tenant context, so
 * per-tenant overrides are NOT reflected here (they continue to act
 * server-side at the point of enforcement). A toggle that does not
 * exist in the database defaults to `false` (safe default, matching the
 * existing FeatureFlagsManager convention).
 *
 * Kept as a standalone function rather than added to `FeatureFlagsManager`
 * above: that class's `FeatureFlags` shape uses a different, incompatible
 * key name (`entities`, not `entity_profiles`) for a subset of these
 * toggles, is missing four of the eleven keys this contract requires, and
 * is exercised by `feature-flags-async.test.ts` pinned to its exact
 * 7-field shape. Extending it would either break that test or force a
 * rename with no caller. `FeatureFlagsManager` remains dead code (no
 * route imports it); this function is the "bypass" per plan §4/T9.
 */
export interface PlatformFlags {
  posts: boolean;
  comments: boolean;
  friends: boolean;
  sentiments: boolean;
  feeds: boolean;
  map: boolean;
  events: boolean;
  collections: boolean;
  email_subscriptions: boolean;
  year_in_review: boolean;
  entity_profiles: boolean;
}

const PLATFORM_TOGGLE_KEYS: ReadonlyArray<[key: keyof PlatformFlags, toggle: string]> = [
  ["posts", "posts_enabled"],
  ["comments", "comments_enabled"],
  ["friends", "friends_enabled"],
  ["sentiments", "sentiments_enabled"],
  ["feeds", "feeds_enabled"],
  ["map", "map_enabled"],
  ["events", "events_enabled"],
  ["collections", "collections_enabled"],
  ["email_subscriptions", "email_subscriptions_enabled"],
  ["year_in_review", "year_in_review_enabled"],
  ["entity_profiles", "entity_profiles_enabled"],
];

const DEFAULT_PLATFORM_FLAGS: PlatformFlags = {
  posts: false,
  comments: false,
  friends: false,
  sentiments: false,
  feeds: false,
  map: false,
  events: false,
  collections: false,
  email_subscriptions: false,
  year_in_review: false,
  entity_profiles: false,
};

/**
 * Resolve the `platform` block. Never throws — any error (including a
 * database connection failure) falls back to all-false defaults, mirroring
 * the route's existing tolerant-of-DB-failure behavior.
 *
 * @param db - Prisma client. When omitted, returns defaults without any
 *             toggle lookups (mirrors `FeatureFlagsManager`'s no-db path).
 */
export async function getPlatformFlags(db?: unknown): Promise<PlatformFlags> {
  if (!db) {
    return DEFAULT_PLATFORM_FLAGS;
  }

  const logger = getLogger();
  try {
    const { FeatureToggleService } = await import("./feature-toggle-service.js");
    const toggleService = new FeatureToggleService(db as any);

    const entries = await Promise.all(
      PLATFORM_TOGGLE_KEYS.map(async ([key, toggleKey]) => {
        const toggle = await toggleService.getToggle(toggleKey, undefined);
        const value = toggle === null ? DEFAULT_PLATFORM_FLAGS[key] : toggle.enabled;
        return [key, value] as const;
      }),
    );

    return Object.fromEntries(entries) as unknown as PlatformFlags;
  } catch (error) {
    logger.error("[FeatureFlags] Error checking platform toggles:", error);
    return DEFAULT_PLATFORM_FLAGS;
  }
}
