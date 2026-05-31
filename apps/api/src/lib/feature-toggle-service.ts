import { PrismaFeatureToggleStore } from "@de-otio/saas-foundation/feature-toggles/prisma";
import type { LoggerEnv } from "./logger.js";
import type { PrismaClient } from "@prisma/client";

/**
 * Feature toggle service for global feature flags.
 *
 * This is a thin adapter over foundation's PrismaFeatureToggleStore.
 * The public surface is preserved exactly so all existing consumers remain
 * unchanged:
 *   - getToggle / setToggle / getAllToggles return `lastChanged` (trellis shape)
 *   - foundation internally uses `changedAt`; this adapter maps between them
 *
 * The `env` constructor parameter is kept for source-compatibility but is
 * no longer used — foundation's PrismaFeatureToggleStore calls getLogger()
 * internally.
 *
 * For a full feature toggle system with regions, targeting, etc., see
 * doc/requirements/feature-toggle/RECOMMENDED_IMPLEMENTATION.md
 */
export class FeatureToggleService {
  private readonly store: PrismaFeatureToggleStore;

  constructor(
    prisma: PrismaClient,
    // env is accepted for source-compatibility but unused — foundation
    // acquires its logger via getLogger() internally.
    _env?: LoggerEnv,
  ) {
    this.store = new PrismaFeatureToggleStore(prisma);
  }

  /**
   * Check if a feature toggle is enabled.
   * Returns false when the toggle does not exist or on any error (fail-safe).
   */
  async isEnabled(key: string): Promise<boolean> {
    return this.store.isEnabled(key);
  }

  /**
   * Get feature toggle with full details.
   * Maps foundation's `changedAt` → trellis's `lastChanged`.
   */
  async getToggle(key: string): Promise<{
    key: string;
    enabled: boolean;
    lastChanged?: Date;
    changedBy?: string;
    description?: string;
  } | null> {
    const toggle = await this.store.get(key);
    if (!toggle) {
      return null;
    }
    return {
      key: toggle.key,
      enabled: toggle.enabled,
      lastChanged: toggle.changedAt,
      changedBy: toggle.changedBy,
      description: toggle.description,
    };
  }

  /**
   * Set feature toggle state (upsert).
   * Maps foundation's `changedAt` → trellis's `lastChanged` on the return.
   */
  async setToggle(
    key: string,
    enabled: boolean,
    changedBy: string,
    description?: string,
  ): Promise<{
    key: string;
    enabled: boolean;
    lastChanged: Date;
    changedBy: string;
  }> {
    const { current } = await this.store.set({ key, enabled, changedBy, description });
    return {
      key: current.key,
      enabled: current.enabled,
      // changedAt is always set by @updatedAt; assert non-null for the required return type
      lastChanged: current.changedAt!,
      changedBy: current.changedBy ?? changedBy,
    };
  }

  /**
   * Get all feature toggles.
   * Maps foundation's `changedAt` → trellis's `lastChanged` on each entry.
   */
  async getAllToggles(): Promise<
    Array<{
      key: string;
      enabled: boolean;
      lastChanged?: Date;
      changedBy?: string;
      description?: string;
    }>
  > {
    const toggles = await this.store.list();
    return toggles.map((toggle) => ({
      key: toggle.key,
      enabled: toggle.enabled,
      lastChanged: toggle.changedAt,
      changedBy: toggle.changedBy,
      description: toggle.description,
    }));
  }
}
