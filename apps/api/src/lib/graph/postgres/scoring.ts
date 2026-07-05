/**
 * Relationship scoring operations on Postgres.
 *
 * Phase 1 · B5. PORT from neo4j-graph-service.ts (scoring methods).
 * Reuse the backend-agnostic pure formulas in scoring-engine.ts; the adapter
 * only reads/writes edge properties on the `relationships` table.
 *
 * `signals` JSON column shape — the per-interaction-type breakdown. This
 * mirrors the Neo4j edge's `i_{type}` counter properties (i_view, i_react, …)
 * and is exactly the `InteractionCounts` interface from scoring-engine.ts:
 *
 *   { view, react, comment, share, depth_mode, profile_visit, content_creation }
 *
 * Each is a non-negative integer count. A missing column / missing key reads
 * as 0 (see `zeroCounts` / `readCounts`).
 */
import type { PrismaClient } from "@prisma/client";
import { getCurrentTenantId } from "@de-otio/saas-foundation/tenant";
import type {
  ConnectionMethod,
  GraphNodeType,
  InteractionType,
  RecordInteractionInput,
  ScoreUpdate,
} from "../types.js";
import {
  InteractionEventOps,
  type InteractionEventConfig,
} from "./interaction-events.js";
import {
  computeDecay,
  computeScore,
  ENTITY_DECAY_HALF_LIFE_DAYS,
  type InteractionCounts,
  scoreToTier,
  USER_DECAY_HALF_LIFE_DAYS,
} from "../scoring-engine.js";

/** A fresh zeroed counter set (the canonical `signals` shape). */
function zeroCounts(): InteractionCounts {
  return {
    view: 0,
    react: 0,
    comment: 0,
    share: 0,
    depth_mode: 0,
    profile_visit: 0,
    content_creation: 0,
  };
}

/**
 * Coerce the `signals` JSON column into a fully-populated `InteractionCounts`.
 * Tolerates null (never recorded), partial objects, and non-numeric values.
 */
function readCounts(signals: unknown): InteractionCounts {
  const base = zeroCounts();
  if (signals && typeof signals === "object") {
    for (const key of Object.keys(base) as InteractionType[]) {
      const raw = (signals as Record<string, unknown>)[key];
      if (typeof raw === "number" && Number.isFinite(raw)) {
        base[key] = raw;
      }
    }
  }
  return base;
}

export class ScoringOps {
  private readonly events: InteractionEventOps;

  constructor(
    private readonly prisma: PrismaClient,
    // Surveillance-hardening Phase 0 (P2): InteractionEvent dual-write config.
    // Optional so existing/test call sites keep working; production threads it
    // from env via graph-factory. Defaults are conservative (see the helper).
    eventConfig?: InteractionEventConfig,
  ) {
    this.events = new InteractionEventOps(prisma, eventConfig);
  }

  /**
   * Record a single interaction on an existing relationship.
   *
   * Bumps interactionCount, refreshes lastInteractionAt, and increments the
   * per-type counter in the `signals` JSON column. No-op when no relationship
   * exists (mirrors the Neo4j MATCH, which simply matches nothing).
   *
   * Read-modify-write of the JSON column rather than an atomic counter: Prisma
   * has no JSON-path increment, and the Neo4j port has the same race window
   * (interaction recording is best-effort, scores are recomputed in batch).
   *
   * Phase 0 (P2): ALSO append an InteractionEvent (the temporal signal the
   * `signals` aggregate destroys). Done FIRST and fail-open, so it captures
   * every interaction regardless of whether a Relationship row exists to bump,
   * and never affects aggregation behavior or the user-facing path.
   */
  async recordInteraction(input: RecordInteractionInput): Promise<void> {
    // Append-only behavioral event — independent of the aggregation below.
    await this.events.record(input);

    const tenantId = getCurrentTenantId();
    if (!tenantId) return;

    const existing = await this.prisma.relationship.findUnique({
      where: {
        userId_targetType_targetId: {
          userId: input.userId,
          targetType: input.targetType,
          targetId: input.targetId,
        },
      },
      select: { id: true, tenantId: true, signals: true },
    });

    // No-op when no relationship exists or it belongs to another tenant.
    if (!existing || existing.tenantId !== tenantId) return;

    const counts = readCounts(existing.signals);
    counts[input.interactionType] += 1;

    await this.prisma.relationship.update({
      where: { id: existing.id },
      data: {
        interactionCount: { increment: 1 },
        lastInteractionAt: new Date(),
        // InteractionCounts is a plain numeric record; widen to Prisma's JSON
        // input type (its index signature doesn't structurally match ours).
        signals: { ...counts },
      },
    });
  }

  /**
   * Recompute computedScore + tier for ALL of a user's relationships.
   *
   * Batch-fetches the user's edges (one query per target type), recomputes via
   * the scoring engine (target-type-aware), and batch-writes the new scores in
   * a single transaction. Returns ScoreUpdate[] only for edges whose tier
   * changed. Ports neo4j-graph-service.recomputeScores.
   */
  async recomputeScores(userId: string): Promise<ScoreUpdate[]> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) return [];

    const now = new Date();
    const tierChanges: ScoreUpdate[] = [];

    const rels = await this.prisma.relationship.findMany({
      where: { tenantId, userId },
    });

    // Entity owner-proximity: average the user's score with each non-self owner
    // of the entity. Resolved with two batch queries (ownerships + the user's
    // relationships to those owners) to avoid an N+1 over entity targets.
    const entityTargetIds = rels
      .filter((r) => r.targetType === "entity")
      .map((r) => r.targetId);

    const { ownedEntityIds, ownerScoreByEntity } =
      await this.resolveEntityOwnership(tenantId, userId, entityTargetIds);

    const updates: Array<{ id: string; computedScore: number; tier: number }> =
      [];

    for (const rel of rels) {
      const targetType = rel.targetType as GraphNodeType;
      const isOwned =
        targetType === "entity" && ownedEntityIds.has(rel.targetId);

      const computedScore = computeScore({
        targetType,
        connectionMethod: (rel.connectionMethod as ConnectionMethod) ?? "discovery",
        interactionCount: rel.interactionCount,
        interactionsByType: readCounts(rel.signals),
        lastInteractionAt: rel.lastInteractionAt,
        reciprocated: targetType === "user" ? rel.reciprocated : false,
        createdAt: rel.createdAt,
        manualScore: rel.manualScore,
        isOwned,
        ownerScore:
          targetType === "entity"
            ? (ownerScoreByEntity.get(rel.targetId) ?? null)
            : null,
        now,
      });

      // Effective score for tier resolution: owned entities pin at 1.0,
      // otherwise a manual override wins, else the computed score.
      const effective = isOwned ? 1.0 : (rel.manualScore ?? computedScore);
      const newTier = scoreToTier(effective);
      const oldTier = rel.tier;

      updates.push({ id: rel.id, computedScore, tier: newTier });

      if (newTier !== oldTier) {
        tierChanges.push({
          userId,
          targetType,
          targetId: rel.targetId,
          previousScore: rel.computedScore,
          newScore: computedScore,
          previousTier: oldTier as ScoreUpdate["previousTier"],
          newTier: newTier as ScoreUpdate["newTier"],
        });
      }
    }

    await this.writeScoreUpdates(updates);
    return tierChanges;
  }

  /**
   * Apply time-based multiplicative decay to a user's relationship scores.
   *
   * - User→User: 60-day half-life
   * - User→Entity: 120-day half-life
   * - Owned entities (an active OWNS / EntityOwnership row) are EXEMPT — their
   *   score is never decayed (they auto-pin at 1.0 elsewhere).
   * - Edges with no lastInteractionAt are skipped (nothing to decay from).
   *
   * Ports neo4j-graph-service.applyDecay.
   */
  async applyDecay(userId: string): Promise<ScoreUpdate[]> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) return [];

    const now = new Date();
    const tierChanges: ScoreUpdate[] = [];

    const rels = await this.prisma.relationship.findMany({
      where: {
        tenantId,
        userId,
        lastInteractionAt: { not: null },
      },
    });

    const ownedEntityIds = await this.ownedEntityIdSet(
      tenantId,
      userId,
      rels.filter((r) => r.targetType === "entity").map((r) => r.targetId),
    );

    const updates: Array<{ id: string; computedScore: number; tier: number }> =
      [];

    for (const rel of rels) {
      const targetType = rel.targetType as GraphNodeType;

      // Owned entities are exempt from decay entirely.
      if (targetType === "entity" && ownedEntityIds.has(rel.targetId)) {
        continue;
      }

      const halfLife =
        targetType === "user"
          ? USER_DECAY_HALF_LIFE_DAYS
          : ENTITY_DECAY_HALF_LIFE_DAYS;
      const decayFactor = computeDecay(rel.lastInteractionAt, now, halfLife);
      const decayedScore = Math.max(0, rel.computedScore * (1 - decayFactor));

      const effective = rel.manualScore ?? decayedScore;
      const newTier = scoreToTier(effective);
      const oldTier = rel.tier;

      updates.push({ id: rel.id, computedScore: decayedScore, tier: newTier });

      if (newTier !== oldTier) {
        tierChanges.push({
          userId,
          targetType,
          targetId: rel.targetId,
          previousScore: rel.computedScore,
          newScore: decayedScore,
          previousTier: oldTier as ScoreUpdate["previousTier"],
          newTier: newTier as ScoreUpdate["newTier"],
        });
      }
    }

    await this.writeScoreUpdates(updates);
    return tierChanges;
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Batch-write computedScore + tier for a set of relationship rows.
   *
   * One set-based `UPDATE … FROM unnest(...)` instead of N per-row UPDATE
   * statements in a transaction — a decay/recompute sweep over a user's
   * edges is a single round trip and a single atomic statement regardless
   * of edge count. `updated_at` is bumped in SQL to match the Prisma
   * `@updatedAt` behavior the per-row updates had.
   */
  private async writeScoreUpdates(
    updates: Array<{ id: string; computedScore: number; tier: number }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    const ids = updates.map((u) => u.id);
    const scores = updates.map((u) => u.computedScore);
    const tiers = updates.map((u) => u.tier);
    await this.prisma.$executeRaw`
      UPDATE relationships AS r
      SET computed_score = u.computed_score,
          tier = u.tier,
          updated_at = now()
      FROM unnest(${ids}::text[], ${scores}::float8[], ${tiers}::int[])
        AS u(id, computed_score, tier)
      WHERE r.id = u.id
    `;
  }

  /** The set of entity ids (from the given candidates) the user actively owns. */
  private async ownedEntityIdSet(
    tenantId: string,
    userId: string,
    entityIds: string[],
  ): Promise<Set<string>> {
    if (entityIds.length === 0) return new Set();
    const owned = await this.prisma.entityOwnership.findMany({
      where: {
        tenantId,
        userId,
        status: "ACTIVE",
        entityId: { in: entityIds },
      },
      select: { entityId: true },
    });
    return new Set(owned.map((o) => o.entityId));
  }

  /**
   * Resolve, for the user's entity targets:
   *  - which the user owns (decay exemption / auto-pin), and
   *  - the owner-proximity score per entity = the average of the user's
   *    computedScore with each *other* active owner of that entity.
   */
  private async resolveEntityOwnership(
    tenantId: string,
    userId: string,
    entityIds: string[],
  ): Promise<{
    ownedEntityIds: Set<string>;
    ownerScoreByEntity: Map<string, number>;
  }> {
    const ownerScoreByEntity = new Map<string, number>();
    if (entityIds.length === 0) {
      return { ownedEntityIds: new Set(), ownerScoreByEntity };
    }

    const ownerships = await this.prisma.entityOwnership.findMany({
      where: {
        tenantId,
        status: "ACTIVE",
        entityId: { in: entityIds },
      },
      select: { entityId: true, userId: true },
    });

    const ownedEntityIds = new Set<string>();
    // entityId -> set of *other* owner user ids
    const ownersByEntity = new Map<string, Set<string>>();
    for (const o of ownerships) {
      if (o.userId === userId) {
        ownedEntityIds.add(o.entityId);
        continue;
      }
      let set = ownersByEntity.get(o.entityId);
      if (!set) {
        set = new Set();
        ownersByEntity.set(o.entityId, set);
      }
      set.add(o.userId);
    }

    // The user's relationship score with each owner (one batch query).
    const allOwnerIds = [
      ...new Set(
        [...ownersByEntity.values()].flatMap((s) => [...s]),
      ),
    ];
    if (allOwnerIds.length > 0) {
      const ownerRels = await this.prisma.relationship.findMany({
        where: {
          tenantId,
          userId,
          targetType: "user",
          targetId: { in: allOwnerIds },
        },
        select: { targetId: true, computedScore: true },
      });
      const scoreByOwner = new Map(
        ownerRels.map((r) => [r.targetId, r.computedScore]),
      );

      for (const [entityId, owners] of ownersByEntity) {
        const scores = [...owners]
          .map((ownerId) => scoreByOwner.get(ownerId))
          .filter((s): s is number => s !== undefined);
        if (scores.length > 0) {
          ownerScoreByEntity.set(
            entityId,
            scores.reduce((a, b) => a + b, 0) / scores.length,
          );
        }
      }
    }

    return { ownedEntityIds, ownerScoreByEntity };
  }
}
