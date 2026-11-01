import type { Prisma } from "@prisma/client";

/**
 * The create payload for a new entity plus its creator's ownership row,
 * written in the same statement so an entity is never persisted without an
 * owner. (The graph dual-write also upserts the ownership, but only when an
 * AMBIENT tenant is set, which it is not in the default scope mode.)
 *
 * The nested ownership create names no tenant: `entity_ownerships` references
 * `entities (tenant_id, id)`, so Prisma takes the tenant from the entity and
 * rejects a `tenantId` here. Typed, not `any`, so the compiler sees that.
 * Pure and dependency-free so the schema lane can run it against Postgres
 * (test/integration/schema/tenant-qualified-fk-shape.integration.test.ts).
 */
export function buildEntityCreateData(input: {
  name: string;
  entityType: string;
  tenantId: string;
  metadata: Prisma.InputJsonValue;
  creatorUserId: string;
  lifeStage?: { value: string; manualOverride: boolean };
}): Prisma.EntityUncheckedCreateInput {
  return {
    name: input.name.trim(),
    entityType: input.entityType,
    tenantId: input.tenantId,
    metadata: input.metadata,
    owners: {
      create: {
        userId: input.creatorUserId,
        role: "PRIMARY_OWNER",
        addedByUserId: input.creatorUserId,
      },
    },
    ...(input.lifeStage && {
      lifeStage: input.lifeStage.value,
      lifeStageCalculatedAt: new Date(),
      lifeStageManualOverride: input.lifeStage.manualOverride,
    }),
  };
}
