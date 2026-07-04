import { PrismaFeatureToggleStore } from "@de-otio/saas-foundation/feature-toggles/prisma";
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
 * For a full feature toggle system with regions, targeting, etc., see
 * doc/requirements/feature-toggle/RECOMMENDED_IMPLEMENTATION.md
 */
/**
 * P5 authorization for a tenant-scoped toggle write.
 *
 * Pure decision (no I/O) so the authorization boundary is unit-testable in
 * isolation. A SUPER_ADMIN may write any tenant's override (operator tooling,
 * by design). Any other caller may write ONLY their own active tenant's row —
 * cross-tenant toggle writes are forbidden, since a tenant override carries
 * the operational thresholds an adversary would target.
 *
 * Global writes (`targetTenantId === undefined`) are NOT governed here — they
 * stay SUPER_ADMIN-gated at the route layer exactly as before.
 *
 * @returns `true` when the write is allowed, `false` to deny (→ 403).
 */
export function canWriteTenantToggle(input: {
  role: string | undefined;
  callerTenantId: string | undefined;
  targetTenantId: string;
}): boolean {
  if (input.role === "SUPER_ADMIN") return true;
  // Non-super-admins need a concrete active tenant that matches the target.
  return (
    input.callerTenantId !== undefined &&
    input.callerTenantId === input.targetTenantId
  );
}

/** Shape returned by the resolution/list paths (trellis `lastChanged` shape). */
export interface ToggleView {
  key: string;
  enabled: boolean;
  lastChanged?: Date;
  changedBy?: string;
  description?: string;
}

/** The minimal columns every read path selects. Kept in sync with the store. */
const TOGGLE_SELECT = {
  key: true,
  enabled: true,
  changedAt: true,
  changedBy: true,
  description: true,
} as const;

type ToggleReadRow = {
  key: string;
  enabled: boolean;
  changedAt: Date;
  changedBy: string | null;
  description: string | null;
};

/**
 * P5: PostgreSQL treats NULLs as DISTINCT, so the partial unique index
 * `feature_toggles_key_global` (UNIQUE(key) WHERE tenant_id IS NULL) plus the
 * compound `@@unique([key, tenantId])` guarantee AT MOST ONE global row and
 * AT MOST ONE tenant row per key. That lets the tenant-aware resolution use a
 * single query: filter to `(tenant_id = ? OR tenant_id IS NULL)` and order so
 * the tenant row (non-null) sorts before the global row (null). One round-trip,
 * no N+1, and the bounded cardinality makes `LIMIT 1` exact.
 */
function mapRow(row: ToggleReadRow | null): ToggleView | null {
  if (!row) return null;
  return {
    key: row.key,
    enabled: row.enabled,
    lastChanged: row.changedAt,
    changedBy: row.changedBy ?? undefined,
    description: row.description ?? undefined,
  };
}

/** Foundation's table-missing detection (P2021 / "does not exist"). */
function isTableMissingError(err: unknown): boolean {
  if (err instanceof Error) {
    if ((err as { code?: string }).code === "P2021") return true;
    if (err.message.includes("does not exist")) return true;
  }
  return false;
}

export class FeatureToggleService {
  private readonly store: PrismaFeatureToggleStore;
  // Raw client retained for the tenant-aware resolution path. The global path
  // (no tenantId) goes through `store` to preserve EXACT pre-P5 behavior,
  // including foundation's per-instance read cache.
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    // P1: `key` is no longer a standalone unique column (now [key, tenantId]),
    // so foundation's store can't query `where: { key }` directly. Scope every
    // operation to global rows (tenant_id IS NULL) — identical to pre-P1
    // behavior. P5 adds tenant-aware resolution on top of this.
    this.prisma = prisma;
    this.store = new PrismaFeatureToggleStore(
      globalScopedFeatureToggleClient(prisma),
    );
  }

  /**
   * Resolve a single tenant-scoped row → global row, in ONE query.
   * Returns the tenant override when one exists, else the global row, else
   * null. Fail-soft (returns null) on DB error, mirroring foundation's `get`.
   *
   * NOTE: deliberately does NOT use foundation's store cache — that cache is
   * keyed by `key` only and would leak tenant A's value to tenant B. This path
   * is uncached; the global path (store) keeps its cache.
   */
  private async resolveScoped(
    key: string,
    tenantId: string,
  ): Promise<ToggleView | null> {
    try {
      const row = await this.prisma.featureToggle.findFirst({
        where: { key, OR: [{ tenantId }, { tenantId: null }] },
        select: TOGGLE_SELECT,
        // Tenant row (non-null tenant_id) sorts before the global row (null).
        orderBy: { tenantId: { sort: "desc", nulls: "last" } },
      });
      return mapRow(row as ToggleReadRow | null);
    } catch (err) {
      if (isTableMissingError(err)) {
        getLogger().warn("[FeatureToggle] table missing; resolve → null", {
          key,
          tenantId,
        });
        return null;
      }
      getLogger().error("[FeatureToggle] scoped resolve failed", {
        key,
        tenantId,
        err,
      });
      return null;
    }
  }

  /**
   * Check if a feature toggle is enabled.
   * Returns false when the toggle does not exist or on any error (fail-safe).
   *
   * @param key      Toggle key.
   * @param tenantId Optional tenant. When provided, resolves the tenant
   *                 override first, falling back to the global row. When
   *                 omitted, behaves EXACTLY as before (global-only, cached).
   */
  async isEnabled(key: string, tenantId?: string): Promise<boolean> {
    if (tenantId === undefined) {
      return this.store.isEnabled(key);
    }
    const toggle = await this.resolveScoped(key, tenantId);
    return toggle?.enabled ?? false;
  }

  /**
   * Get feature toggle with full details.
   * Maps foundation's `changedAt` → trellis's `lastChanged`.
   *
   * @param key      Toggle key.
   * @param tenantId Optional tenant. When provided, resolves tenant override →
   *                 global → null. When omitted, returns the GLOBAL row only —
   *                 byte-identical to pre-P5 behavior.
   */
  async getToggle(key: string, tenantId?: string): Promise<ToggleView | null> {
    if (tenantId === undefined) {
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
    return this.resolveScoped(key, tenantId);
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
   *
   * @param tenantId Optional tenant. When provided, the write targets the
   *                 `[key, tenantId]` row (a per-tenant OVERRIDE), leaving the
   *                 global row untouched. When omitted, writes the GLOBAL row —
   *                 byte-identical to pre-P5 behavior. AUTHORIZATION (caller is
   *                 scoped to the tenant, or SUPER_ADMIN) is enforced at the
   *                 route layer, not here.
   */
  async setToggle(
    key: string,
    enabled: boolean,
    changedBy: string,
    description?: string,
    auditCtx?: ToggleAuditContext,
    tenantId?: string,
  ): Promise<{
    key: string;
    enabled: boolean;
    lastChanged: Date;
    changedBy: string;
  }> {
    const { previous, current } =
      tenantId === undefined
        ? await this.store.set({ key, enabled, changedBy, description })
        : await this._setScoped(key, enabled, changedBy, tenantId, description);

    const result = {
      key: current.key,
      enabled: current.enabled,
      // changedAt is always set by @updatedAt; assert non-null for the required return type
      lastChanged: current.changedAt!,
      changedBy: current.changedBy ?? changedBy,
    };

    // Best-effort audit emission — never blocks the toggle write.
    if (auditCtx) {
      this._emitToggleAudit(
        key,
        previous?.enabled ?? null,
        enabled,
        auditCtx,
        tenantId,
      ).catch(
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
   * Tenant-scoped upsert of the `[key, tenantId]` override row. Mirrors
   * foundation's `set` return contract ({ previous, current }) so the caller
   * is agnostic to which path ran. The compound `@@unique([key, tenantId])`
   * makes the find-then-update/create race-equivalent to foundation's upsert.
   */
  private async _setScoped(
    key: string,
    enabled: boolean,
    changedBy: string,
    tenantId: string,
    description?: string,
  ): Promise<{ previous: ToggleView | null; current: ToggleReadRow }> {
    const existing = (await this.prisma.featureToggle.findFirst({
      where: { key, tenantId },
      select: { id: true, ...TOGGLE_SELECT },
    })) as (ToggleReadRow & { id: string }) | null;

    const data = {
      enabled,
      changedBy,
      ...(description !== undefined ? { description } : {}),
    };

    const current = (
      existing
        ? await this.prisma.featureToggle.update({
            where: { id: existing.id },
            data,
            select: TOGGLE_SELECT,
          })
        : await this.prisma.featureToggle.create({
            data: { key, tenantId, ...data },
            select: TOGGLE_SELECT,
          })
    ) as ToggleReadRow;

    const { id: _id, ...prevRow } = existing ?? { id: undefined };
    return {
      previous: existing ? mapRow(prevRow as ToggleReadRow) : null,
      current,
    };
  }

  /**
   * Emit the `feature_toggle.changed` audit event via TrellisAuditLogger.
   * Called only when `auditCtx` is provided in `setToggle`; always
   * best-effort — errors are caught by the caller's `.catch()`.
   *
   * `tenantId` (when present) is recorded in the audit metadata so the change
   * history of a per-tenant override is attributable to its tenant — these are
   * the operational thresholds of the future, and their provenance matters.
   */
  private async _emitToggleAudit(
    key: string,
    oldEnabled: boolean | null,
    newEnabled: boolean,
    auditCtx: ToggleAuditContext,
    tenantId?: string,
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
            // Only present for tenant-scoped writes — keeps global-write audit
            // metadata byte-identical to pre-P5.
            ...(tenantId !== undefined ? { tenantId } : {}),
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
   *
   * @param tenantId Optional tenant. When omitted, returns the GLOBAL rows only
   *                 (byte-identical to pre-P5). When provided, returns the
   *                 EFFECTIVE config for that tenant: global rows, with each key
   *                 the tenant overrides replaced by the tenant's row. Another
   *                 tenant's rows are NEVER returned — not even their key names,
   *                 since the mere existence of an override is target-selection
   *                 intel for an adversary.
   *
   * Isolation note: the query filters to `(tenant_id = ? OR tenant_id IS NULL)`,
   * so a foreign tenant's rows are excluded at the DB, not post-filtered.
   */
  async getAllToggles(tenantId?: string): Promise<ToggleView[]> {
    if (tenantId === undefined) {
      const toggles = await this.store.list();
      return toggles.map((toggle) => ({
        key: toggle.key,
        enabled: toggle.enabled,
        lastChanged: toggle.changedAt,
        changedBy: toggle.changedBy,
        description: toggle.description,
      }));
    }

    try {
      // Single query: global rows + this tenant's rows only. Order tenant rows
      // (non-null tenant_id) AFTER global rows per key so the tenant override
      // wins the de-dup below.
      const rows = (await this.prisma.featureToggle.findMany({
        where: { OR: [{ tenantId }, { tenantId: null }] },
        select: { ...TOGGLE_SELECT, tenantId: true },
        orderBy: [{ key: "asc" }, { tenantId: { sort: "asc", nulls: "first" } }],
      })) as Array<ToggleReadRow & { tenantId: string | null }>;

      // De-dup by key, tenant override (later in the per-key order) overwrites
      // the global. Map preserves first-seen key insertion order (asc by key).
      const byKey = new Map<string, ToggleView>();
      for (const row of rows) {
        byKey.set(row.key, mapRow(row)!);
      }
      return [...byKey.values()];
    } catch (err) {
      if (isTableMissingError(err)) {
        getLogger().warn("[FeatureToggle] table missing; list → []", {
          tenantId,
        });
        return [];
      }
      getLogger().error("[FeatureToggle] scoped list failed", { tenantId, err });
      return [];
    }
  }
}
