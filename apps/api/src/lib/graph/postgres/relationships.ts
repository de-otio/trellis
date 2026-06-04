/**
 * RELATES_TO edge operations on Postgres (`relationships` table).
 *
 * Phase 1 · B1. PORT from neo4j-graph-service.ts (relationship methods).
 * Single-hop edge CRUD + per-user edge list + the visualization aggregation.
 */
import type { PrismaClient } from "@prisma/client";
import { getCurrentTenantId } from "@de-otio/saas-foundation/tenant";
import { GraphNotFoundError } from "../errors.js";
import {
  CONNECTION_BONUSES,
  effectiveScore,
  scoreToTier,
  TIER_THRESHOLDS,
} from "../scoring-engine.js";
import type {
  CircleTier,
  ConnectionMethod,
  CreateRelationshipInput,
  GraphData,
  GraphNode,
  GraphNodeType,
  PaginatedResult,
  PaginationInput,
  Relationship,
  TierName,
  UpdateRelationshipScoreInput,
} from "../types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Minimal shape of a `relationships` row we read back from Prisma. */
type RelationshipRow = {
  userId: string;
  targetType: string;
  targetId: string;
  computedScore: number;
  manualScore: number | null;
  interactionCount: number;
  lastInteractionAt: Date | null;
  connectionMethod: string;
  reciprocated: boolean;
  createdAt: Date;
};

/**
 * Map a `relationships` row to the Relationship DTO.
 *
 * Mirrors neo4j-graph-service.ts `recordToRelationship`: the effective `score`
 * is `effectiveScore(manualScore, computedScore)` and `tier` is derived from
 * that effective score (never read from a stored column — the persisted `tier`
 * column is advisory/denormalized only).
 */
function rowToRelationship(row: RelationshipRow): Relationship {
  const score = effectiveScore(row.manualScore, row.computedScore);
  return {
    userId: row.userId,
    targetType: row.targetType as GraphNodeType,
    targetId: row.targetId,
    score,
    computedScore: row.computedScore,
    manualScore: row.manualScore,
    tier: scoreToTier(score),
    interactionCount: row.interactionCount,
    lastInteractionAt: row.lastInteractionAt,
    connectionMethod: (row.connectionMethod ?? "discovery") as ConnectionMethod,
    reciprocated: row.reciprocated === true,
    createdAt: row.createdAt,
  };
}

const TIER_NAMES: Record<CircleTier, TierName> = {
  0: "inner",
  1: "closeFriends",
  2: "community",
  3: "ambient",
};

/** Encode a score-based pagination cursor (base64 JSON, matches neo4j). */
function encodeCursor(score: number): string {
  return Buffer.from(JSON.stringify({ score })).toString("base64");
}

/** Decode a score-based pagination cursor. Returns null if invalid. */
function decodeCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64").toString("utf8"),
    ) as unknown;
    if (parsed && typeof parsed === "object" && "score" in parsed) {
      const score = (parsed as { score: unknown }).score;
      if (typeof score === "number") return score;
    }
    return null;
  } catch {
    return null;
  }
}

export class RelationshipOps {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Create a scored relationship from a user to a target (user or entity).
   *
   * Initial score comes from the connection method (CONNECTION_BONUSES, default
   * 0.3 for `discovery`). For user→user targets, if the reverse edge already
   * exists both edges are marked `reciprocated`. Idempotent like the Neo4j
   * MERGE: a pre-existing edge is returned unchanged rather than throwing.
   */
  async createRelationship(
    input: CreateRelationshipInput,
  ): Promise<Relationship> {
    const { userId, targetType, targetId, connectionMethod = "discovery" } =
      input;
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new GraphNotFoundError(
        `No tenant context for relationship from user ${userId} to ${targetType} ${targetId}`,
      );
    }

    // Initial score by connection method (from scoring engine constants).
    const initialScore = CONNECTION_BONUSES[connectionMethod] ?? 0.3;

    const created = await this.prisma.$transaction(async (tx) => {
      // Idempotent on (userId, targetType, targetId): if the edge already
      // exists, return it (mirrors the Neo4j MERGE ON MATCH behavior).
      const existing = await tx.relationship.findUnique({
        where: {
          userId_targetType_targetId: { userId, targetType, targetId },
        },
      });
      if (existing) {
        return existing;
      }

      // For user→user targets, reciprocity is determined by the presence of the
      // reverse edge (target → source).
      let reciprocated = false;
      if (targetType === "user") {
        const reverse = await tx.relationship.findUnique({
          where: {
            userId_targetType_targetId: {
              userId: targetId,
              targetType: "user",
              targetId: userId,
            },
          },
        });
        if (reverse) {
          reciprocated = true;
          // Mark the reverse edge reciprocated too (both edges flip).
          await tx.relationship.update({
            where: { id: reverse.id },
            data: { reciprocated: true },
          });
        }
      }

      return tx.relationship.create({
        data: {
          tenantId,
          userId,
          targetType,
          targetId,
          computedScore: initialScore,
          manualScore: null,
          tier: scoreToTier(initialScore),
          interactionCount: 0,
          lastInteractionAt: null,
          connectionMethod,
          reciprocated,
        },
      });
    });

    return rowToRelationship(created);
  }

  /**
   * Remove a relationship. If a reciprocated user→user edge is removed, the
   * reverse edge's `reciprocated` flag is cleared. Throws GraphNotFoundError
   * when no edge exists.
   */
  async removeRelationship(
    userId: string,
    targetType: GraphNodeType,
    targetId: string,
  ): Promise<void> {
    const tenantId = getCurrentTenantId();

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.relationship.findFirst({
        where: { userId, targetType, targetId, tenantId },
      });
      if (!existing) {
        throw new GraphNotFoundError(
          `Relationship from user ${userId} to ${targetType} ${targetId} not found`,
          "relationship",
          `${userId}->${targetId}`,
        );
      }

      // Clear the reverse reciprocated flag for user→user edges.
      if (targetType === "user") {
        await tx.relationship.updateMany({
          where: {
            userId: targetId,
            targetType: "user",
            targetId: userId,
            tenantId,
          },
          data: { reciprocated: false },
        });
      }

      await tx.relationship.delete({ where: { id: existing.id } });
    });
  }

  /**
   * Set or clear the manual score override. When `manualScore` is null the
   * computed score takes over again. The effective score / tier are derived
   * in {@link rowToRelationship}.
   */
  async updateRelationshipScore(
    input: UpdateRelationshipScoreInput,
  ): Promise<Relationship> {
    const { userId, targetType, targetId, manualScore } = input;
    const tenantId = getCurrentTenantId();

    const existing = await this.prisma.relationship.findFirst({
      where: { userId, targetType, targetId, tenantId },
    });
    if (!existing) {
      throw new GraphNotFoundError(
        `Relationship from user ${userId} to ${targetType} ${targetId} not found`,
        "relationship",
        `${userId}->${targetId}`,
      );
    }

    const newScore = effectiveScore(
      manualScore ?? null,
      existing.computedScore,
    );
    const updated = await this.prisma.relationship.update({
      where: { id: existing.id },
      data: {
        manualScore: manualScore ?? null,
        tier: scoreToTier(newScore),
      },
    });

    return rowToRelationship(updated);
  }

  /** Get a specific relationship, or null if it does not exist. */
  async getRelationship(
    userId: string,
    targetType: GraphNodeType,
    targetId: string,
  ): Promise<Relationship | null> {
    const tenantId = getCurrentTenantId();
    const row = await this.prisma.relationship.findFirst({
      where: { userId, targetType, targetId, tenantId },
    });
    return row ? rowToRelationship(row) : null;
  }

  /**
   * List a user's relationships, ordered by effective score descending, with
   * optional tier / target-type filters and score-cursor pagination.
   *
   * Ordering and the cursor are over the EFFECTIVE score (manual override wins
   * over computed). There is no stored effective-score column, so the ordering
   * key is computed as `COALESCE(manual_score, computed_score)` in SQL.
   */
  async getRelationships(
    userId: string,
    options?: {
      tier?: CircleTier;
      targetType?: GraphNodeType;
      pagination?: PaginationInput;
    },
  ): Promise<PaginatedResult<Relationship>> {
    const limit = options?.pagination?.limit ?? 50;
    const cursor = options?.pagination?.cursor ?? null;
    const cursorScore = cursor !== null ? decodeCursor(cursor) : null;
    const tenantId = getCurrentTenantId();

    const where: {
      userId: string;
      tenantId?: string;
      targetType?: GraphNodeType;
      tier?: CircleTier;
    } = { userId };
    if (tenantId !== undefined) where.tenantId = tenantId;
    if (options?.targetType !== undefined)
      where.targetType = options.targetType;
    // The persisted `tier` column is kept in sync on writes, so a tier filter
    // can use it directly (matches the Neo4j `r.tier = $tier` predicate).
    if (options?.tier !== undefined) where.tier = options.tier;

    // Fetch a page ordered by effective score. Prisma cannot order/filter by a
    // COALESCE expression, so order by (manualScore desc nulls last, computed
    // desc) is not equivalent — instead fetch the user's edges (filtered) and
    // sort/paginate on the computed effective score in-app. Edge counts per
    // user are bounded (a user's circle), so this is acceptable and exact.
    const rows = await this.prisma.relationship.findMany({ where });

    const mapped = rows
      .map(rowToRelationship)
      .sort((a, b) => b.score - a.score);

    // Score-cursor pagination: take items strictly below the cursor score.
    const afterCursor =
      cursorScore !== null
        ? mapped.filter((r) => r.score < cursorScore)
        : mapped;

    const hasMore = afterCursor.length > limit;
    const items = hasMore ? afterCursor.slice(0, limit) : afterCursor;
    const lastItem = items[items.length - 1];
    const nextCursor =
      hasMore && lastItem ? encodeCursor(lastItem.score) : null;

    return { items, cursor: nextCursor, hasMore };
  }

  /**
   * Build the relationship-graph visualization payload.
   *
   * SECURITY: raw scores are NEVER returned. Each node exposes only `tier` and
   * a coarse `closeness` value bucketed to the nearest 10 in [0, 100]
   * (`round(score * 10) * 10`). Recent-auth, rate-limiting, and audit-logging
   * are enforced by the caller; the score coarsening is applied here.
   */
  async getRelationshipGraph(userId: string): Promise<GraphData> {
    const tenantId = getCurrentTenantId();

    const rows = await this.prisma.relationship.findMany({
      where: tenantId !== undefined ? { userId, tenantId } : { userId },
    });

    // Resolve node display names from the user/entity tables by id+type.
    // targetId is polymorphic with no FK, so look each set up separately.
    const userIds = rows
      .filter((r) => r.targetType === "user")
      .map((r) => r.targetId);
    const entityIds = rows
      .filter((r) => r.targetType === "entity")
      .map((r) => r.targetId);

    const [users, entities] = await Promise.all([
      userIds.length > 0
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, handle: true, username: true },
          })
        : Promise.resolve([]),
      entityIds.length > 0
        ? this.prisma.entity.findMany({
            where: { id: { in: entityIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    // Users carry no PII in the graph; fall back to handle/username (both
    // optional) and finally empty string — matches the Neo4j `tgt.name ?? ""`.
    const userNameById = new Map<string, string>(
      users.map((u) => [u.id, u.handle ?? u.username ?? ""]),
    );
    const entityNameById = new Map<string, string>(
      entities.map((e) => [e.id, e.name ?? ""]),
    );

    const nodes: GraphNode[] = rows
      .map((row): { node: GraphNode; score: number } => {
        const score = effectiveScore(row.manualScore, row.computedScore);
        const targetType = row.targetType as GraphNodeType;
        const name =
          targetType === "user"
            ? (userNameById.get(row.targetId) ?? "")
            : (entityNameById.get(row.targetId) ?? "");
        return {
          score,
          node: {
            id: row.targetId,
            type: targetType,
            name,
            // Coarsen to nearest 10 (0-100); never expose the raw score.
            closeness: Math.round(score * 10) * 10,
            tier: scoreToTier(score),
          },
        };
      })
      // Order by score descending (matches Neo4j ORDER BY r.score DESC).
      .sort((a, b) => b.score - a.score)
      .map((x) => x.node);

    // Tier summary counts.
    const counts: Record<TierName, number> = {
      inner: 0,
      closeFriends: 0,
      community: 0,
      ambient: 0,
    };
    for (const node of nodes) {
      counts[TIER_NAMES[node.tier]]++;
    }

    const thresholdFor = (tier: CircleTier): number =>
      TIER_THRESHOLDS.find((t) => t.tier === tier)?.minScore ?? 0;

    return {
      nodes,
      tiers: {
        inner: { threshold: thresholdFor(0), count: counts.inner },
        closeFriends: {
          threshold: thresholdFor(1),
          count: counts.closeFriends,
        },
        community: { threshold: thresholdFor(2), count: counts.community },
        ambient: { threshold: thresholdFor(3), count: counts.ambient },
      },
    };
  }
}
