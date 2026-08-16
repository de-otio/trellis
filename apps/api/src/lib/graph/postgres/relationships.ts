/**
 * RELATES_TO edge operations on Postgres (`relationships` table).
 *
 * Phase 1 · B1. PORT from neo4j-graph-service.ts (relationship methods).
 * Single-hop edge CRUD + per-user edge list + the visualization aggregation.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { GraphConflictError, GraphNotFoundError } from "../errors.js";
import { requireAmbientTenantId } from "./tenant-guard.js";
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
 * The effective-score ordering key, as a SQL fragment. Fixed text over trusted
 * column names — no interpolation, nothing caller-derived.
 */
const EFFECTIVE_SCORE_COL = Prisma.sql`COALESCE(manual_score, computed_score)`;

/**
 * The `relationships` columns {@link rowToRelationship} needs, aliased back to
 * the camelCase property names Prisma Client would have produced. Fixed text.
 */
const RELATIONSHIP_ROW_COLUMNS = Prisma.sql`
  user_id AS "userId",
  target_type AS "targetType",
  target_id AS "targetId",
  computed_score AS "computedScore",
  manual_score AS "manualScore",
  interaction_count AS "interactionCount",
  last_interaction_at AS "lastInteractionAt",
  connection_method AS "connectionMethod",
  reciprocated,
  created_at AS "createdAt"
`;

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

/**
 * Default per-user relationship-edge cap (per tenant). A single account
 * creating unbounded edges inflates every fan-out query anchored on its
 * edge list (circle counts, feeds, recommendations) — this bounds the blast
 * radius at write time. Runtime-tunable via GRAPH_MAX_EDGES_PER_USER
 * (threshold-secrecy rule: operational caps are config, the default here is
 * just the fallback).
 */
export const DEFAULT_MAX_EDGES_PER_USER = 1000;

/**
 * Hard ceiling on a caller-supplied `pagination.limit` for the edge-list reads.
 *
 * `getRelationships` used the caller's `limit` verbatim after loading the whole
 * edge set, so a single request could ask for — and get — every edge a user
 * has. The write-side cap ({@link DEFAULT_MAX_EDGES_PER_USER}) bounded that at
 * 1000, but that is a coincidence of two unrelated numbers, not a read-path
 * bound. Clamped here and pushed into a Prisma `take` so the DATABASE, not the
 * app, decides how many rows travel.
 */
export const MAX_RELATIONSHIP_PAGE_SIZE = 100;

/** Default page size when the caller supplies none. */
export const DEFAULT_RELATIONSHIP_PAGE_SIZE = 50;

/**
 * Clamp a caller-supplied page size into `[1, MAX_RELATIONSHIP_PAGE_SIZE]`.
 * Non-finite / non-positive / absent values fall back to the default rather
 * than erroring — the caller asked for a page, not for a validation lecture,
 * and a clamp cannot be forgotten at a call site the way a validator can.
 */
export function clampRelationshipLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_RELATIONSHIP_PAGE_SIZE;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_RELATIONSHIP_PAGE_SIZE);
}

/** Resolve the per-user edge cap from env, falling back to the default. */
export function resolveMaxEdgesPerUser(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.GRAPH_MAX_EDGES_PER_USER;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_EDGES_PER_USER;
}

/**
 * Composite keyset cursor for the score ordering. A score-only cursor drops
 * every row TIED with the boundary score (strict `< score` skips them all),
 * so the cursor carries the standard (score, targetId) keyset pair: rows
 * strictly below the score, plus tied rows past the boundary targetId.
 */
interface ScoreCursor {
  score: number;
  /** Tiebreak key. Null for a legacy score-only cursor (strict-< fallback). */
  targetId: string | null;
}

/** Encode a (score, targetId) pagination cursor (base64 JSON). */
function encodeCursor(score: number, targetId: string): string {
  return Buffer.from(JSON.stringify({ score, targetId })).toString("base64");
}

/** Decode a pagination cursor. Returns null if invalid. */
function decodeCursor(cursor: string): ScoreCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64").toString("utf8"),
    ) as unknown;
    if (parsed && typeof parsed === "object" && "score" in parsed) {
      const score = (parsed as { score: unknown }).score;
      const targetId = (parsed as { targetId?: unknown }).targetId;
      if (typeof score === "number") {
        // Legacy score-only cursors (pre-tiebreak) degrade to strict-<.
        return { score, targetId: typeof targetId === "string" ? targetId : null };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export class RelationshipOps {
  constructor(
    private readonly prisma: PrismaClient,
    /** Per-user edge cap; injectable for tests, env-resolved by default. */
    private readonly maxEdgesPerUser: number = resolveMaxEdgesPerUser(),
  ) {}

  /**
   * Create a scored relationship from a user to a target (user or entity).
   *
   * Initial score comes from the connection method (CONNECTION_BONUSES, default
   * 0.3 for `discovery`). For user→user targets, if the reverse edge already
   * exists both edges are marked `reciprocated`. Idempotent like the Neo4j
   * MERGE: a pre-existing edge is returned unchanged rather than throwing —
   * the idempotent return also bypasses the edge cap (no new edge is made).
   *
   * Enforces the per-user edge cap ({@link resolveMaxEdgesPerUser}): once the
   * user has that many edges in the tenant, new edges are rejected with a
   * GraphConflictError (handlers map it to 409). Best-effort (count+create in
   * one transaction; a concurrent burst may land a few over — the cap bounds
   * abuse, it is not an exact quota).
   */
  async createRelationship(
    input: CreateRelationshipInput,
  ): Promise<Relationship> {
    const { userId, targetType, targetId, connectionMethod = "discovery" } =
      input;
    const tenantId = requireAmbientTenantId("RelationshipOps.createRelationship");

    // Initial score by connection method (from scoring engine constants).
    const initialScore = CONNECTION_BONUSES[connectionMethod] ?? 0.3;

    const created = await this.prisma.$transaction(async (tx) => {
      // Idempotent on (tenantId, userId, targetType, targetId): if the edge
      // already exists IN THIS TENANT, return it (mirrors the Neo4j MERGE ON
      // MATCH behavior). The tenant is part of the unique key (M7) precisely so
      // that "this pair already has an edge" is a per-tenant question — the
      // tenant-blind key made an edge in tenant B suppress the create in
      // tenant A and return B's row.
      const existing = await tx.relationship.findUnique({
        where: {
          tenantId_userId_targetType_targetId: {
            tenantId,
            userId,
            targetType,
            targetId,
          },
        },
      });
      if (existing) {
        return existing;
      }

      // Per-user edge cap — checked only when a NEW edge would be created.
      const edgeCount = await tx.relationship.count({
        where: { userId, tenantId },
      });
      if (edgeCount >= this.maxEdgesPerUser) {
        throw new GraphConflictError(
          `Relationship limit reached: user ${userId} already has ${edgeCount} relationships (cap ${this.maxEdgesPerUser})`,
        );
      }

      // For user→user targets, reciprocity is determined by the presence of the
      // reverse edge (target → source) IN THE SAME TENANT.
      //
      // The tenant predicate here is the SET half of the set/clear pair, and it
      // was missing (lane 7 MEDIUM-3). `removeRelationship` clears the reverse
      // flag tenant-scoped, so an asymmetric pair leaked a permanent grant:
      // A→B in T1, then B→A in T2 flipped BOTH rows to `reciprocated = true`
      // (T1 now treats B as having consented back, with no T1 edge from B at
      // all); B then deleting B→A in T2 cleared only T2 rows, leaving A→B in T1
      // reciprocated forever with nothing to revoke. `reciprocated` is the
      // load-bearing consent bit of the audience model, so that is an
      // authorization defect, not a bookkeeping one. Set and clear must scope
      // identically or the pair cannot round-trip.
      let reciprocated = false;
      if (targetType === "user") {
        const reverse = await tx.relationship.findUnique({
          where: {
            tenantId_userId_targetType_targetId: {
              tenantId,
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
   *
   * Refuses without an ambient tenant: `tenantId: undefined` is DROPPED by
   * Prisma, so the "scoped" `findFirst` below would have matched — and then
   * DELETED — another tenant's edge. See ./tenant-guard.ts.
   */
  async removeRelationship(
    userId: string,
    targetType: GraphNodeType,
    targetId: string,
  ): Promise<void> {
    const tenantId = requireAmbientTenantId(
      "RelationshipOps.removeRelationship",
    );

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
    const tenantId = requireAmbientTenantId(
      "RelationshipOps.updateRelationshipScore",
    );

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
    const tenantId = requireAmbientTenantId("RelationshipOps.getRelationship");
    const row = await this.prisma.relationship.findFirst({
      where: { userId, targetType, targetId, tenantId },
    });
    return row ? rowToRelationship(row) : null;
  }

  /**
   * List a user's relationships, ordered by (effective score DESC, targetId
   * ASC), with optional tier / target-type filters and composite
   * (score, targetId) keyset-cursor pagination — the tiebreak keeps rows that
   * share the boundary score from being dropped between pages.
   *
   * Ordering and the cursor are over the EFFECTIVE score (manual override wins
   * over computed). There is no stored effective-score column, so the ordering
   * key is computed as `COALESCE(manual_score, computed_score)` in SQL.
   *
   * ## Why raw SQL rather than `findMany`
   *
   * This used to be `findMany({ where })` with NO `take`, sorted and
   * keyset-filtered in application memory, then sliced to a caller-supplied and
   * unclamped `limit`. Two problems: every request materialized the user's
   * entire edge set regardless of page size, and the page size itself was
   * whatever the client asked for. It happened to be survivable only because
   * the WRITE path caps edges per user ({@link DEFAULT_MAX_EDGES_PER_USER}) —
   * an unrelated number doing an unowned job.
   *
   * `COALESCE(manual_score, computed_score)` cannot be expressed in a Prisma
   * `orderBy`, and ordering must be identical to the cursor predicate or pages
   * silently drop rows — so the bound cannot be pushed down while keeping the
   * Prisma-Client query. The ordering, the keyset predicate and the `LIMIT` all
   * move into one tagged `Prisma.sql` statement instead: every user value is a
   * bound parameter, and the database returns at most
   * {@link MAX_RELATIONSHIP_PAGE_SIZE}+1 rows.
   */
  async getRelationships(
    userId: string,
    options?: {
      tier?: CircleTier;
      targetType?: GraphNodeType;
      pagination?: PaginationInput;
    },
  ): Promise<PaginatedResult<Relationship>> {
    const limit = clampRelationshipLimit(options?.pagination?.limit);
    const rawCursor = options?.pagination?.cursor ?? null;
    const cursor = rawCursor !== null ? decodeCursor(rawCursor) : null;
    const tenantId = requireAmbientTenantId("RelationshipOps.getRelationships");

    const filters: Prisma.Sql[] = [
      Prisma.sql`tenant_id = ${tenantId}`,
      Prisma.sql`user_id = ${userId}`,
    ];
    if (options?.targetType !== undefined) {
      filters.push(Prisma.sql`target_type = ${options.targetType}`);
    }
    // The persisted `tier` column is kept in sync on writes, so a tier filter
    // can use it directly (matches the Neo4j `r.tier = $tier` predicate).
    if (options?.tier !== undefined) {
      filters.push(Prisma.sql`tier = ${options.tier}`);
    }

    // Keyset pagination: strictly below the cursor score, OR tied with it and
    // past the boundary targetId. (Legacy score-only cursors carry a null
    // targetId and keep the old strict-< behavior.)
    if (cursor !== null) {
      filters.push(
        cursor.targetId !== null
          ? Prisma.sql`(${EFFECTIVE_SCORE_COL} < ${cursor.score}
              OR (${EFFECTIVE_SCORE_COL} = ${cursor.score} AND target_id > ${cursor.targetId}))`
          : Prisma.sql`${EFFECTIVE_SCORE_COL} < ${cursor.score}`,
      );
    }

    // limit + 1 is the standard has-more probe: one row past the page tells us
    // whether a next page exists without a second COUNT query.
    const rows = await this.prisma.$queryRaw<RelationshipRow[]>(Prisma.sql`
      SELECT ${RELATIONSHIP_ROW_COLUMNS}
      FROM relationships
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY ${EFFECTIVE_SCORE_COL} DESC, target_id ASC
      LIMIT ${limit + 1}
    `);

    const mapped = rows.map(rowToRelationship);
    const hasMore = mapped.length > limit;
    const items = hasMore ? mapped.slice(0, limit) : mapped;
    const lastItem = items[items.length - 1];
    const nextCursor =
      hasMore && lastItem ? encodeCursor(lastItem.score, lastItem.targetId) : null;

    return { items, cursor: nextCursor, hasMore };
  }

  /**
   * Build the relationship-graph visualization payload.
   *
   * SECURITY: raw scores are NEVER returned. Each node exposes only `tier` and
   * a coarse `closeness` value bucketed to the nearest 10 in [0, 100]
   * (`round(score * 10) * 10`). Recent-auth, rate-limiting, and audit-logging
   * are enforced by the caller; the score coarsening is applied here.
   *
   * BOUNDED: the edge fetch carries an explicit `LIMIT` at the per-user write
   * cap ({@link resolveMaxEdgesPerUser}) and orders by effective score DESC, so
   * a user whose edge set somehow exceeds the write cap (cap lowered after the
   * fact, rows imported around the API, a concurrent-burst overshoot) yields a
   * truncated graph rather than an unbounded read. Truncation drops the
   * WEAKEST edges, which is the right end to lose for a visualization. In
   * normal operation the write cap makes this a no-op.
   *
   * Refuses without an ambient tenant: the previous ternary omitted the
   * `tenantId` key entirely, returning every tenant's edges for the user.
   */
  async getRelationshipGraph(userId: string): Promise<GraphData> {
    const tenantId = requireAmbientTenantId(
      "RelationshipOps.getRelationshipGraph",
    );

    const rows = await this.prisma.$queryRaw<RelationshipRow[]>(Prisma.sql`
      SELECT ${RELATIONSHIP_ROW_COLUMNS}
      FROM relationships
      WHERE tenant_id = ${tenantId} AND user_id = ${userId}
      ORDER BY ${EFFECTIVE_SCORE_COL} DESC, target_id ASC
      LIMIT ${this.maxEdgesPerUser}
    `);

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
            // Tenant-scoped: an edge whose target is an entity in another
            // tenant must not resolve that entity's NAME into this payload.
            // The edges are already tenant-scoped, so in a consistent database
            // this changes nothing — which is the point of a backstop.
            where: { id: { in: entityIds }, tenantId },
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
