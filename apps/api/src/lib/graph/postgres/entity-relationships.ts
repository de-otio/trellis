/**
 * Typed entity-to-entity edge operations on Postgres (`entity_relationships`).
 *
 * Phase 1 · B3. PORT from neo4j-graph-service.ts (entity-relationship methods).
 * Single-hop typed-edge CRUD with a PENDING→CONFIRMED/REJECTED status machine;
 * ownership checks join `entity_ownerships`.
 *
 * Ports the Neo4j authorization + status logic exactly:
 *  - createEntityRelationship: proposer must OWN the source entity; PACK_MATE
 *    with a single user holding PRIMARY_OWNER/CO_OWNER on BOTH entities
 *    auto-confirms (CARETAKER excluded) and writes the reciprocal edge.
 *  - confirm/reject: caller must OWN the TARGET (related) entity.
 *  - remove: caller must OWN EITHER entity.
 *  - getPendingEntityRelationships: PENDING edges where the caller owns the
 *    target entity.
 *
 * Tenancy (graph-db revisit 2026-06): unlike the implicitly-single-tenant
 * Neptune graph, the Postgres edge/ownership tables carry a `tenant_id`. To
 * stay consistent with the other Postgres groups (B1/B2/B4/B5) and to keep
 * tenant isolation defensible under a future audit, every read/lookup is
 * tenant-scoped via {@link EntityRelationshipOps.tenantScope}, which now
 * REFUSES rather than returning an empty filter when no ambient tenant context
 * exists (lane 7 HIGH-1 — see ./tenant-guard.ts).
 * Ownership lookups also filter `status = ACTIVE`: a removed/left owner no
 * longer holds the OWNS edge, which is the Postgres equivalent of Neptune
 * edge-absence (matches the discovery/sync groups).
 */
import type { PrismaClient } from "@prisma/client";
import { requireAmbientTenantId } from "./tenant-guard.js";
import type {
  CreateEntityRelationshipInput,
  EntityRelationship,
  EntityRelationshipStatus,
  EntityRelationshipType,
} from "../types.js";
import {
  GraphAuthorizationError,
  GraphConflictError,
  GraphNotFoundError,
} from "../errors.js";

/**
 * Symmetric relationship types — confirming A→B materializes a same-type B→A
 * edge. Mirrors SYMMETRIC_TYPES in neo4j-graph-service.confirmEntityRelationship.
 */
const SYMMETRIC_TYPES = new Set<EntityRelationshipType>([
  "PACK_MATE",
  "SIBLING",
  "PLAYMATE",
  "WALK_BUDDY",
]);

/**
 * Asymmetric pairs — confirming A→B materializes a complementary-type B→A edge.
 * Mirrors ASYMMETRIC_PAIRS in neo4j-graph-service.confirmEntityRelationship.
 */
const ASYMMETRIC_PAIRS: Partial<Record<EntityRelationshipType, EntityRelationshipType>> = {
  PARENT: "OFFSPRING",
  OFFSPRING: "PARENT",
};

export class EntityRelationshipOps {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Tenant filter for reads/lookups.
   *
   * Was: `return t ? { tenantId: t } : {}` — with no ambient tenant this
   * returned an EMPTY object, so every `{ ...scope, … }` spread below produced
   * a query with no tenant predicate at all. Ownership checks, edge lookups and
   * the `deleteMany` in {@link removeEntityRelationship} then ran across every
   * tenant, and nothing anywhere logged it (lane 7 HIGH-1).
   *
   * Now refuses. See ./tenant-guard.ts for the deployment precondition
   * (`TENANT_SCOPE_MODE` must not be `"off"`), which this class's write path
   * already required via {@link requireTenantId}.
   */
  private tenantScope(method: string): { tenantId: string } {
    return {
      tenantId: requireAmbientTenantId(`EntityRelationshipOps.${method}`),
    };
  }

  async createEntityRelationship(
    input: CreateEntityRelationshipInput,
  ): Promise<EntityRelationship> {
    const { entityId, relatedEntityId, type, proposedByUserId } = input;
    const scope = this.tenantScope("createEntityRelationship");

    // 1. Verify proposing user actively owns the source entity.
    const ownership = await this.prisma.entityOwnership.findFirst({
      where: { ...scope, entityId, userId: proposedByUserId, status: "ACTIVE" },
      select: { role: true },
    });
    if (!ownership) {
      throw new GraphAuthorizationError(
        `User ${proposedByUserId} does not own entity ${entityId}`,
      );
    }

    // 2. Verify both entity nodes exist IN THE CALLER'S TENANT.
    //
    // The old comment here read "keyed by the globally-unique cuid PK, so no
    // tenant scope is needed for an existence check" — which is true of
    // uniqueness and false of authorization (lane 7 MEDIUM-4). Two consequences
    // followed from the tenant-blind lookup:
    //
    //  - a T1 user could create a PENDING edge (stored with tenantId = T1)
    //    pointing at a T2 entity: an orphan the T2 owner never sees in any
    //    pending list, because their list is scoped to T2;
    //  - the two error paths (`GraphNotFoundError` here vs.
    //    `GraphConflictError`/success later) turned this endpoint into a
    //    cross-tenant entity-id existence oracle. cuid unguessability made that
    //    expensive, not impossible — and "expensive" is not an access control.
    //
    // Both entities are now resolved with `findFirst({ id, tenantId })`, and a
    // cross-tenant target is indistinguishable from a nonexistent one: same
    // error type, same message, which names NEITHER id.
    const [sourceEntity, targetEntity] = await Promise.all([
      this.prisma.entity.findFirst({
        where: { id: entityId, ...scope },
        select: { id: true },
      }),
      this.prisma.entity.findFirst({
        where: { id: relatedEntityId, ...scope },
        select: { id: true },
      }),
    ]);
    if (!sourceEntity || !targetEntity) {
      // Uniform, id-free message: which of the two was missing, and whether it
      // was missing or merely foreign, are both non-disclosures.
      throw new GraphNotFoundError("One or both entities not found");
    }

    // 3. Check for an existing relationship of this type (A→B).
    const existing = await this.prisma.entityRelationship.findFirst({
      where: { ...scope, entityId, relatedEntityId, type },
      select: { id: true },
    });
    if (existing) {
      throw new GraphConflictError(
        `Entity relationship of type ${type} already exists between ${entityId} and ${relatedEntityId}`,
      );
    }

    // 4. Determine if auto-confirm applies.
    // PACK_MATE where a single user holds PRIMARY_OWNER or CO_OWNER on BOTH
    // entities auto-confirms. CARETAKER is excluded per security rules.
    let status: EntityRelationshipStatus = "PENDING";

    if (type === "PACK_MATE") {
      const sourceOwners = await this.prisma.entityOwnership.findMany({
        where: { ...scope, entityId, status: "ACTIVE", role: { in: ["PRIMARY_OWNER", "CO_OWNER"] } },
        select: { userId: true },
      });
      const sourceOwnerIds = new Set(sourceOwners.map((o) => o.userId));
      if (sourceOwnerIds.size > 0) {
        const sharedOwner = await this.prisma.entityOwnership.findFirst({
          where: {
            ...scope,
            entityId: relatedEntityId,
            status: "ACTIVE",
            role: { in: ["PRIMARY_OWNER", "CO_OWNER"] },
            userId: { in: Array.from(sourceOwnerIds) },
          },
          select: { userId: true },
        });
        if (sharedOwner) {
          status = "CONFIRMED";
        }
      }
    }

    const now = new Date();
    // Same tenant the checks above ran in — `tenantScope` already refused if
    // there is none, so this cannot diverge from the authorization scope.
    const { tenantId } = scope;

    if (status === "CONFIRMED") {
      // Auto-confirmed PACK_MATE: create bidirectional edges immediately.
      await this.prisma.entityRelationship.createMany({
        data: [
          { tenantId, entityId, relatedEntityId, type, status: "CONFIRMED", proposedByUserId, since: now },
          { tenantId, entityId: relatedEntityId, relatedEntityId: entityId, type, status: "CONFIRMED", proposedByUserId, since: now },
        ],
      });
    } else {
      // Single PENDING edge from source to target.
      await this.prisma.entityRelationship.create({
        data: { tenantId, entityId, relatedEntityId, type, status: "PENDING", proposedByUserId, since: now },
      });
    }

    return { entityId, relatedEntityId, type, status, proposedByUserId, since: now };
  }

  async confirmEntityRelationship(
    entityId: string,
    relatedEntityId: string,
    confirmingUserId: string,
  ): Promise<EntityRelationship> {
    const scope = this.tenantScope("confirmEntityRelationship");

    // 1. Verify confirming user actively owns the target (related) entity.
    const ownership = await this.prisma.entityOwnership.findFirst({
      where: { ...scope, entityId: relatedEntityId, userId: confirmingUserId, status: "ACTIVE" },
      select: { role: true },
    });
    if (!ownership) {
      throw new GraphAuthorizationError(
        `User ${confirmingUserId} does not own entity ${relatedEntityId}`,
      );
    }

    // 2. Find the relationship (A→B).
    const rel = await this.prisma.entityRelationship.findFirst({
      where: { ...scope, entityId, relatedEntityId },
      select: { id: true, type: true, status: true, proposedByUserId: true, since: true, tenantId: true },
    });
    if (!rel) {
      throw new GraphNotFoundError(
        `Entity relationship not found between ${entityId} and ${relatedEntityId}`,
      );
    }

    if (rel.status !== "PENDING") {
      throw new GraphConflictError(
        `Entity relationship is already ${rel.status}`,
      );
    }

    const relType = rel.type as EntityRelationshipType;
    const { proposedByUserId, since, tenantId } = rel;

    // 3. Confirm the existing edge.
    await this.prisma.entityRelationship.update({
      where: { id: rel.id },
      data: { status: "CONFIRMED" },
    });

    // 4. Create or confirm the reciprocal edge based on relationship symmetry.
    const reciprocalType = SYMMETRIC_TYPES.has(relType)
      ? relType
      : ASYMMETRIC_PAIRS[relType];

    if (reciprocalType) {
      const reverse = await this.prisma.entityRelationship.findFirst({
        where: { ...scope, entityId: relatedEntityId, relatedEntityId: entityId, type: reciprocalType },
        select: { id: true },
      });
      if (reverse) {
        await this.prisma.entityRelationship.update({
          where: { id: reverse.id },
          data: { status: "CONFIRMED" },
        });
      } else {
        await this.prisma.entityRelationship.create({
          data: {
            tenantId,
            entityId: relatedEntityId,
            relatedEntityId: entityId,
            type: reciprocalType,
            status: "CONFIRMED",
            proposedByUserId,
            since,
          },
        });
      }
    }

    return {
      entityId,
      relatedEntityId,
      type: relType,
      status: "CONFIRMED",
      proposedByUserId,
      since,
    };
  }

  async rejectEntityRelationship(
    entityId: string,
    relatedEntityId: string,
    rejectingUserId: string,
  ): Promise<void> {
    const scope = this.tenantScope("rejectEntityRelationship");

    // 1. Verify rejecting user actively owns the target (related) entity.
    const ownership = await this.prisma.entityOwnership.findFirst({
      where: { ...scope, entityId: relatedEntityId, userId: rejectingUserId, status: "ACTIVE" },
      select: { role: true },
    });
    if (!ownership) {
      throw new GraphAuthorizationError(
        `User ${rejectingUserId} does not own entity ${relatedEntityId}`,
      );
    }

    // 2. Find the relationship (A→B).
    const rel = await this.prisma.entityRelationship.findFirst({
      where: { ...scope, entityId, relatedEntityId },
      select: { id: true },
    });
    if (!rel) {
      throw new GraphNotFoundError(
        `Entity relationship not found between ${entityId} and ${relatedEntityId}`,
      );
    }

    // 3. Set status to REJECTED.
    await this.prisma.entityRelationship.update({
      where: { id: rel.id },
      data: { status: "REJECTED" },
    });
  }

  async removeEntityRelationship(
    entityId: string,
    relatedEntityId: string,
    removingUserId: string,
  ): Promise<void> {
    const scope = this.tenantScope("removeEntityRelationship");

    // 1. Verify removing user actively owns either entity.
    const ownership = await this.prisma.entityOwnership.findFirst({
      where: {
        ...scope,
        userId: removingUserId,
        status: "ACTIVE",
        entityId: { in: [entityId, relatedEntityId] },
      },
      select: { entityId: true },
    });
    if (!ownership) {
      throw new GraphAuthorizationError(
        `User ${removingUserId} does not own either entity ${entityId} or ${relatedEntityId}`,
      );
    }

    // 2. Check the relationship exists (A→B direction).
    const rel = await this.prisma.entityRelationship.findFirst({
      where: { ...scope, entityId, relatedEntityId },
      select: { id: true },
    });
    if (!rel) {
      throw new GraphNotFoundError(
        `Entity relationship not found between ${entityId} and ${relatedEntityId}`,
      );
    }

    // 3. Delete A→B edge(s) and reciprocal B→A edge(s) if any.
    await this.prisma.entityRelationship.deleteMany({
      where: { ...scope, entityId, relatedEntityId },
    });
    await this.prisma.entityRelationship.deleteMany({
      where: { ...scope, entityId: relatedEntityId, relatedEntityId: entityId },
    });
  }

  async getEntityRelationships(
    entityId: string,
    options?: { type?: string; status?: EntityRelationshipStatus },
  ): Promise<EntityRelationship[]> {
    const rows = await this.prisma.entityRelationship.findMany({
      where: {
        ...this.tenantScope("getEntityRelationships"),
        entityId,
        ...(options?.type ? { type: options.type as EntityRelationshipType } : {}),
        ...(options?.status ? { status: options.status } : {}),
      },
      select: {
        relatedEntityId: true,
        type: true,
        status: true,
        proposedByUserId: true,
        since: true,
      },
      orderBy: { since: "desc" },
    });

    return rows.map((r) => ({
      entityId,
      relatedEntityId: r.relatedEntityId,
      type: r.type as EntityRelationshipType,
      status: r.status as EntityRelationshipStatus,
      proposedByUserId: r.proposedByUserId,
      since: r.since,
    }));
  }

  async getPendingEntityRelationships(
    userId: string,
  ): Promise<EntityRelationship[]> {
    const scope = this.tenantScope("getPendingEntityRelationships");

    // Edges that are PENDING and whose TARGET (related) entity is actively
    // owned by the user.
    const owned = await this.prisma.entityOwnership.findMany({
      where: { ...scope, userId, status: "ACTIVE" },
      select: { entityId: true },
    });
    const ownedEntityIds = owned.map((o) => o.entityId);
    if (ownedEntityIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.entityRelationship.findMany({
      where: {
        ...scope,
        status: "PENDING",
        relatedEntityId: { in: ownedEntityIds },
      },
      select: {
        entityId: true,
        relatedEntityId: true,
        type: true,
        proposedByUserId: true,
        since: true,
      },
      orderBy: { since: "desc" },
    });

    return rows.map((r) => ({
      entityId: r.entityId,
      relatedEntityId: r.relatedEntityId,
      type: r.type as EntityRelationshipType,
      status: "PENDING" as EntityRelationshipStatus,
      proposedByUserId: r.proposedByUserId,
      since: r.since,
    }));
  }

}
