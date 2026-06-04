import type { PrismaClient } from "@prisma/client";
import type { PrismaFeatureToggleStore } from "@de-otio/saas-foundation/feature-toggles/prisma";

/**
 * Global-scoped Prisma adapter for foundation's `PrismaFeatureToggleStore`.
 *
 * Surveillance-hardening Phase 0 (P1) replaced the standalone `@unique` on
 * `FeatureToggle.key` with `@@unique([key, tenantId])` plus a partial
 * global-unique index. That means `key` is no longer a valid `findUnique`
 * selector, so foundation's store — which queries `where: { key }` — would
 * fail at both the type and runtime level.
 *
 * This adapter preserves EXACTLY the pre-P1 behavior: every operation is
 * scoped to GLOBAL rows (`tenant_id IS NULL`). Per-tenant resolution
 * (tenant row → global row → default) is P5's job; it will supersede this
 * adapter (or parameterize it by tenantId). Until then the platform behaves
 * as a single global toggle namespace, which is what every current caller
 * already assumes.
 *
 * The `key`-only compound selector can't be used for global rows via Prisma's
 * `findUnique`/`upsert`/`delete`: SQL treats `(key, NULL)` as non-unique, so
 * Prisma's compound `key_tenantId` where-input types `tenantId` as a non-null
 * string. Global-row uniqueness is enforced by the partial index instead, and
 * reached here via `findFirst` / manual upsert / `deleteMany`.
 */

const TOGGLE_SELECT = {
  key: true,
  enabled: true,
  changedAt: true,
  changedBy: true,
  description: true,
} as const;

type ToggleRow = {
  key: string;
  enabled: boolean;
  changedAt: Date;
  changedBy: string | null;
  description: string | null;
};

// The structural shape foundation's store consumes. We intentionally do not
// import `PrismaFeatureToggleClient` to construct the value (it is a readonly
// interface); instead we satisfy it structurally via the store's constructor
// parameter type below.
type FoundationClient = ConstructorParameters<typeof PrismaFeatureToggleStore>[0];

export function globalScopedFeatureToggleClient(
  prisma: PrismaClient,
): FoundationClient {
  return {
    featureToggle: {
      async findUnique(args: { where: { key: string } }): Promise<ToggleRow | null> {
        return prisma.featureToggle.findFirst({
          where: { key: args.where.key, tenantId: null },
          select: TOGGLE_SELECT,
        });
      },

      async findMany(args: {
        orderBy: { key: "asc" | "desc" };
      }): Promise<ToggleRow[]> {
        return prisma.featureToggle.findMany({
          where: { tenantId: null },
          select: TOGGLE_SELECT,
          orderBy: args.orderBy,
        });
      },

      async upsert(args: {
        where: { key: string };
        update: { enabled: boolean; changedBy: string; description?: string };
        create: { key: string; enabled: boolean; changedBy: string; description?: string };
      }): Promise<ToggleRow> {
        const existing = await prisma.featureToggle.findFirst({
          where: { key: args.where.key, tenantId: null },
          select: { id: true },
        });
        if (existing) {
          return prisma.featureToggle.update({
            where: { id: existing.id },
            data: args.update,
            select: TOGGLE_SELECT,
          });
        }
        return prisma.featureToggle.create({
          data: { ...args.create, tenantId: null },
          select: TOGGLE_SELECT,
        });
      },

      async delete(args: { where: { key: string } }): Promise<unknown> {
        // deleteMany returns a count and never throws P2025 — foundation's
        // "record not found = no-op" semantics are preserved naturally.
        return prisma.featureToggle.deleteMany({
          where: { key: args.where.key, tenantId: null },
        });
      },
    },
  };
}
