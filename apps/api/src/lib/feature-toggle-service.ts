import { PrismaFeatureToggleStore } from "@de-otio/saas-foundation/feature-toggles/prisma";
import type { LoggerEnv } from "./logger.js";
import type { PrismaClient } from "@prisma/client";
import { globalScopedFeatureToggleClient } from "./feature-toggle-global-client.js";
import type { TrellisAuditLoggerEnv } from "./audit-composer.js";
import type { Region } from "./region-detection.js";
import { getLogger } from "./logger.js";

/**
 * Optional context for emitting a `feature_toggle.changed` audit event.
 * Callers (admin routes) supply this to bind the write to a user identity.
 *
 * - `userId`: admin's USER ID (never email) used as `changedBy` in audit metadata.
 * - `env`: provides DB access + region defaults for the audit Prisma client.
 * - `region`: resolved request region; defaults to `env.DEFAULT_REGION ?? "EU"`.
 *
 * Emission is best-effort — a failure here NEVER blocks the toggle write.
 */
export interface ToggleAuditContext {
  userId: string;
  env: TrellisAuditLoggerEnv;
  region?: Region;
}

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
    // P1: `key` is no longer a standalone unique column (now [key, tenantId]),
    // so foundation's store can't query `where: { key }` directly. Scope every
    // operation to global rows (tenant_id IS NULL) — identical to pre-P1
    // behavior. P5 replaces this with tenant-aware resolution.
    this.store = new PrismaFeatureToggleStore(
      globalScopedFeatureToggleClient(prisma),
    );
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
   *
   * When `auditCtx` is provided a `feature_toggle.changed` audit event is
   * emitted best-effort after the store write. The event metadata carries:
   *   { key, oldEnabled, newEnabled, changedBy: auditCtx.userId }
   * where `changedBy` in audit metadata is the admin's USER ID (NOT their
   * email). The FeatureToggle.changedBy DB column is unchanged — it still
   * receives the `changedBy` string argument (typically the admin's email).
   *
   * NOTE: Full durable (SQS at-least-once) audit delivery is a deferred
   * follow-up. Current delivery is Postgres best-effort.
   */
  async setToggle(
    key: string,
    enabled: boolean,
    changedBy: string,
    description?: string,
    auditCtx?: ToggleAuditContext,
  ): Promise<{
    key: string;
    enabled: boolean;
    lastChanged: Date;
    changedBy: string;
  }> {
    const { previous, current } = await this.store.set({ key, enabled, changedBy, description });

    const result = {
      key: current.key,
      enabled: current.enabled,
      // changedAt is always set by @updatedAt; assert non-null for the required return type
      lastChanged: current.changedAt!,
      changedBy: current.changedBy ?? changedBy,
    };

    // Best-effort audit emission — never blocks the toggle write.
    if (auditCtx) {
      this._emitToggleAudit(key, previous?.enabled ?? null, enabled, auditCtx).catch(
        (err) => {
          // Audit failures must be observable but must not propagate.
          // Full durable delivery (SQS at-least-once) is a deferred follow-up.
          // eslint-disable-next-line no-console -- audit-fallback line for ops grep
          console.error(
            JSON.stringify({
              auditEmitFailure: true,
              action: "feature_toggle.changed",
              key,
              userId: auditCtx.userId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        },
      );
    }

    return result;
  }

  /**
   * Emit the `feature_toggle.changed` audit event via TrellisAuditLogger.
   * Called only when `auditCtx` is provided in `setToggle`; always
   * best-effort — errors are caught by the caller's `.catch()`.
   */
  private async _emitToggleAudit(
    key: string,
    oldEnabled: boolean | null,
    newEnabled: boolean,
    auditCtx: ToggleAuditContext,
  ): Promise<void> {
    const logger = getLogger();
    try {
      const { TrellisAuditLogger } = await import("./audit-composer.js");
      const { FEATURE_TOGGLE_CHANGED } = await import("./audit-actions.js");
      const region = auditCtx.region ?? (auditCtx.env.DEFAULT_REGION as Region | undefined) ?? "EU";
      const auditLogger = new TrellisAuditLogger();
      await auditLogger.logSystemAction(
        FEATURE_TOGGLE_CHANGED,
        {
          resource: "feature_toggle",
          resourceId: key,
          userId: auditCtx.userId,
          region,
          success: true,
          metadata: {
            key,
            oldEnabled: oldEnabled ?? false,
            newEnabled,
            changedBy: auditCtx.userId,
          },
        },
        auditCtx.env,
      );
    } catch (err) {
      logger.error("[Audit] feature_toggle.changed emit failed", {
        key,
        userId: auditCtx.userId,
        error: err,
      });
      throw err; // re-throw so the .catch() in setToggle can log to stderr
    }
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
