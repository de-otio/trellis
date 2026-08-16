/**
 * Sync-group operations on Postgres.
 *
 * Phase 1 · B6. In the Neo4j world these `sync*` methods MIRRORED Postgres data
 * into a separate graph store (dual-write). Now the graph IS Postgres, so the
 * group splits three ways:
 *
 *  - Node syncs (syncUser / syncEntity / syncPost) — the user/entity/post rows
 *    already live in their own Postgres tables, written by the create/update
 *    handlers, so the node mirror is a NO-OP. EXCEPTION: `syncEntity` still
 *    owns the PostGIS location write — `entity_location` has exactly one
 *    writer in the codebase (this method, ported from Neo4j), so SyncOps IS
 *    constructed with the geoLookup (see postgres-graph-service.ts) and
 *    syncEntity/removeEntity keep the geo row in sync.
 *
 *  - Node removals (removeUser / removeEntity / removePost) — Neo4j's
 *    `DETACH DELETE` cascade-deleted every connected edge. In Postgres some
 *    edge tables FK-cascade off the user/entity/post row and some do NOT, so
 *    the non-cascading ones (`relationships`, `entity_relationships`) must be
 *    deleted in app code to reproduce the exact `DETACH DELETE` scope.
 *
 *  - Edge syncs (syncPostSubjects / syncOwnership / removeOwnership) — the
 *    `post_subjects` / `entity_ownerships` rows ARE the graph now. In the
 *    current call paths (entity-handler, post-handler) NOTHING else writes
 *    these tables — the handlers call db.entity.create()/db.post.create() then
 *    delegate the edge write to the graph service. So these methods are the
 *    real (and only) writers and must persist the rows. `syncOwnership` also
 *    auto-pins the owner→entity RELATES_TO at score 1.0 per the GraphService
 *    contract; `removeOwnership` un-pins it.
 *
 * PORT/REVIEW from neo4j-graph-service.ts (sync methods) + graph-service.ts
 * contracts. See the report for the cascade scope and the several "is there
 * another writer?" uncertainties flagged for human confirmation.
 */
import type { PrismaClient } from "@prisma/client";
import { getCurrentTenantId } from "@de-otio/saas-foundation/tenant";
import { requireAmbientTenantId } from "./tenant-guard.js";
import type { EntityGeoLookup } from "../../geo/entity-geo-repository.js";
import { scoreToTier } from "../scoring-engine.js";
import type {
  SyncEntityInput,
  SyncOwnershipInput,
  SyncPostInput,
  SyncPostSubjectsInput,
  SyncUserInput,
} from "../types.js";

/** Auto-pin score for owned entities — owners are always inner-circle (tier 0). */
const OWNERSHIP_PIN_SCORE = 1.0;

export class SyncOps {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly geoLookup?: EntityGeoLookup,
  ) {}

  // ---- Node syncs: NO-OP (the row already lives in its Postgres table) ------

  /**
   * NO-OP. The `users` row is written by the user create/update path; there is
   * no second store to mirror now that the graph lives in Postgres. The Neo4j
   * method only MERGEd the User node (id + role) — both already persisted in
   * `users`, so nothing to do here.
   */
  async syncUser(_input: SyncUserInput): Promise<void> {
    // Intentionally empty — see method doc.
  }

  /**
   * The `entities` row itself is written by the entity create/update path (no
   * node mirror needed). BUT the PostGIS location write IS this method's job:
   * `entity_location` has exactly one writer in the codebase —
   * neo4j-graph-service.ts `syncEntity` (verified by grep). Dropping it would
   * silently break `discoverNearby`, so the geo dual-write is ported here
   * verbatim (full precision; exposure coarsening is a read-time policy).
   * Tenant comes from the input or ambient context; without it the location
   * row can't be scoped, so the geo write is skipped (matching Neo4j).
   */
  async syncEntity(input: SyncEntityInput): Promise<void> {
    if (!this.geoLookup) return;
    const tenantId = input.tenantId ?? getCurrentTenantId();
    if (input.lat != null && input.lng != null) {
      if (tenantId) {
        await this.geoLookup.upsertLocation(input.id, tenantId, input.lat, input.lng);
      }
    } else {
      // Location absent/cleared — drop any stored point (idempotent).
      await this.geoLookup.removeLocation(input.id);
    }
  }

  /**
   * NO-OP. The `posts` row (including author + radius + createdAt) is written by
   * the post create path. The Neo4j method MERGEd the Post node and the
   * AUTHORED edge for visibility queries; on Postgres those are columns/joins on
   * the existing `posts` row, so there is nothing to mirror.
   */
  async syncPost(_input: SyncPostInput): Promise<void> {
    // Intentionally empty — see method doc.
  }

  // ---- Node removals: reproduce Neo4j DETACH DELETE edge cascade ------------

  /**
   * Remove a user's graph edges that do NOT FK-cascade off the `users` row.
   *
   * Neo4j `DETACH DELETE (u:User)` removed every edge touching the node — both
   * the user's own RELATES_TO/OWNS and any incoming RELATES_TO. In Postgres:
   *  - `entity_ownerships.userId` FK-cascades on user delete → handled by FK.
   *  - `relationships` has NO FK on `userId` or the polymorphic target, so both
   *    directions must be deleted here: edges FROM the user (`userId = X`) and
   *    edges pointing AT the user (`targetType='user' AND targetId = X`).
   *
   * Tenant-scoped, and REFUSES without an ambient tenant.
   *
   * This previously fell back to an UNSCOPED `deleteMany` "so a hard user
   * delete still fully detaches" — a `deleteMany` with no tenant predicate, on
   * a polymorphic `targetId` with no FK, reachable whenever `TENANT_SCOPE_MODE`
   * is off (lane 7 HIGH-1). A cross-tenant mass delete is a worse failure than
   * an incomplete detach, and the incomplete-detach case is recoverable
   * (re-run with the tenant set) while the delete is not. Fail closed; if a
   * genuine cross-tenant purge is ever needed it must be an explicit,
   * separately-authorized operation, not a fallback nobody can see.
   */
  async removeUser(userId: string): Promise<void> {
    const tenantId = requireAmbientTenantId("SyncOps.removeUser");
    await this.prisma.relationship.deleteMany({
      where: {
        tenantId,
        OR: [
          { userId },
          { targetType: "user", targetId: userId },
        ],
      },
    });
  }

  /**
   * Remove an entity's graph edges that do NOT FK-cascade off the `entities` row.
   *
   * Neo4j `DETACH DELETE (e:Entity)` removed every connected edge. In Postgres:
   *  - `entity_ownerships.entityId` (OWNS) and `post_subjects.entityId` (ABOUT)
   *    both FK-cascade on entity delete → handled by FK.
   *  - `relationships` pointing at the entity (`targetType='entity' AND
   *    targetId = X`) has NO FK → deleted here.
   *  - `entity_relationships` (typed entity↔entity edges) has NO FK on either
   *    `entityId` or `relatedEntityId` → both sides deleted here.
   *
   * (An entity is never a RELATES_TO source — only users are — so there is no
   * `userId = X` branch, matching the Neo4j model.)
   */
  async removeEntity(entityId: string): Promise<void> {
    // Refuses without an ambient tenant — same reasoning as removeUser: the
    // previous `{}` fallback made this a cross-tenant `deleteMany`.
    const tenantId = requireAmbientTenantId("SyncOps.removeEntity");
    await this.prisma.$transaction([
      this.prisma.relationship.deleteMany({
        where: { tenantId, targetType: "entity", targetId: entityId },
      }),
      this.prisma.entityRelationship.deleteMany({
        where: {
          tenantId,
          OR: [{ entityId }, { relatedEntityId: entityId }],
        },
      }),
    ]);
    // Drop the PostGIS location row too. Neo4j relied on node deletion to
    // exclude the entity from discovery; here we remove it explicitly so no
    // orphan location lingers (idempotent).
    if (this.geoLookup) {
      await this.geoLookup.removeLocation(entityId);
    }
  }

  /**
   * NO-OP for edge cleanup. Neo4j `DETACH DELETE (p:Post)` removed the post's
   * ABOUT edges; in Postgres `post_subjects.postId` FK-cascades on post delete,
   * so deleting the `posts` row already removes them. There are no other
   * non-cascading post edges to clean up here.
   *
   * @see uncertainty (2) in the report — this assumes the post delete path
   *   deletes the `posts` row (triggering the cascade); this method does not
   *   delete the post itself.
   */
  async removePost(_postId: string): Promise<void> {
    // Intentionally empty — post_subjects FK-cascades; see method doc.
  }

  // ---- Edge syncs: the real writers (post_subjects / entity_ownerships) -----

  /**
   * Replace the ABOUT edge set for a post (`post_subjects`).
   *
   * Idempotent "set" semantics, matching the Neo4j method (delete all existing
   * ABOUT edges for the post, then recreate from `entityIds`, marking
   * `isPrimary` for the primary entity). Implemented as a delete-then-insert
   * inside a transaction.
   *
   * @see uncertainty (3) in the report — in the current post-creation flow this
   *   appears to be the ONLY writer of `post_subjects`; if a Prisma nested
   *   write / handler also creates these rows, this becomes a redundant
   *   re-write and the set-replace should move to the handler.
   */
  async syncPostSubjects(input: SyncPostSubjectsInput): Promise<void> {
    const tenantId = getCurrentTenantId();
    const { postId, entityIds, primaryEntityId } = input;

    await this.prisma.$transaction(async (tx) => {
      await tx.postSubject.deleteMany({ where: { postId } });
      if (entityIds.length === 0) return;
      // Dedupe to respect the @@unique([postId, entityId]) constraint.
      const uniqueEntityIds = [...new Set(entityIds)];
      await tx.postSubject.createMany({
        data: uniqueEntityIds.map((entityId) => ({
          postId,
          entityId,
          isPrimary: primaryEntityId != null && entityId === primaryEntityId,
        })),
        skipDuplicates: true,
      });
      // post_subjects has no tenantId column in the schema, so `tenantId` from
      // the ambient context is intentionally not persisted here.
      void tenantId;
    });
  }

  /**
   * Create/update the OWNS edge (`entity_ownerships`) AND auto-pin the owner's
   * RELATES_TO to the entity at score 1.0 (tier 0).
   *
   * The Neo4j method only MERGEd the OWNS edge; the auto-pin is mandated by the
   * GraphService contract ("Also ensures the user has a RELATES_TO edge to the
   * entity at score 1.0 (auto-pinned to inner circle)") and was MISSING from
   * the Neo4j implementation — see uncertainty (5). The pin is stored as a
   * `manualScore` override of 1.0 so that {@link removeOwnership} can clear it
   * and let the computed score take over.
   *
   * @see uncertainty (4) in the report — `SyncOwnershipInput` carries no
   *   `addedByUserId`; the schema requires it with no default. Defaulted to
   *   `userId` (self-added). Confirm the DTO/schema should carry it explicitly.
   */
  async syncOwnership(input: SyncOwnershipInput): Promise<void> {
    const { entityId, userId, role } = input;
    // Record the actual granting actor when supplied; default to self-added.
    const addedByUserId = input.addedByUserId ?? userId;
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      // entity_ownerships.tenantId is required; without an ambient tenant we
      // cannot tenant-scope the row. Skip rather than write a mis-scoped edge
      // (mirrors syncEntity's geo-skip-without-tenant behavior).
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // OWNS edge — upsert on the unique (entityId, userId).
      await tx.entityOwnership.upsert({
        where: { entityId_userId: { entityId, userId } },
        update: { role, status: "ACTIVE", removedAt: null },
        create: {
          tenantId,
          entityId,
          userId,
          role,
          addedByUserId,
          status: "ACTIVE",
        },
      });

      // Auto-pin RELATES_TO (user → entity) at 1.0 via manualScore override.
      await tx.relationship.upsert({
        where: {
          // Tenant is part of the unique key (M7): the auto-pin must upsert
          // THIS tenant's edge, not collide with a same-pair edge in another.
          tenantId_userId_targetType_targetId: {
            tenantId,
            userId,
            targetType: "entity",
            targetId: entityId,
          },
        },
        update: {
          manualScore: OWNERSHIP_PIN_SCORE,
          tier: scoreToTier(OWNERSHIP_PIN_SCORE),
        },
        create: {
          tenantId,
          userId,
          targetType: "entity",
          targetId: entityId,
          computedScore: 0,
          manualScore: OWNERSHIP_PIN_SCORE,
          tier: scoreToTier(OWNERSHIP_PIN_SCORE),
          interactionCount: 0,
          connectionMethod: "import",
          reciprocated: false,
        },
      });
    });
  }

  /**
   * Remove the OWNS edge and un-pin the RELATES_TO.
   *
   * Per the contract: the RELATES_TO edge is NOT removed (the user may still
   * follow the entity) — only the score-1.0 auto-pin is cleared by setting
   * `manualScore` back to null, so the computed score takes over and the tier
   * is recomputed from it. The OWNS row is hard-deleted to match the Neo4j
   * `DELETE r` (not a status flip).
   */
  async removeOwnership(entityId: string, userId: string): Promise<void> {
    // Refuses without an ambient tenant — the `{}` fallback made both the OWNS
    // delete and the un-pin cross-tenant (lane 7 HIGH-1). `syncOwnership`, the
    // matching write, already returned early without a tenant, so the pair was
    // asymmetric as well as unscoped.
    const tenantId = requireAmbientTenantId("SyncOps.removeOwnership");

    await this.prisma.$transaction(async (tx) => {
      // Remove the OWNS edge (idempotent — deleteMany no-ops when absent).
      await tx.entityOwnership.deleteMany({
        where: { tenantId, entityId, userId },
      });

      // Un-pin: clear the manualScore override if a RELATES_TO row exists, and
      // recompute the advisory tier from the computed score. Keep the edge.
      const existing = await tx.relationship.findFirst({
        where: { tenantId, userId, targetType: "entity", targetId: entityId },
      });
      if (existing && existing.manualScore !== null) {
        await tx.relationship.update({
          where: { id: existing.id },
          data: {
            manualScore: null,
            tier: scoreToTier(existing.computedScore),
          },
        });
      }
    });
  }
}
