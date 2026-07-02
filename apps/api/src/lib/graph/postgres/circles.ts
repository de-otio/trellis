/**
 * Circle (content-view) operations on Postgres.
 *
 * Phase 1 · B2. PORT from neo4j-graph-service.ts (circle methods).
 * Single-hop edge filters + counts; `getVisiblePostIds` is the dual-gated
 * visibility query (subject-entity path OR author path) — a PRIVACY CONTROL,
 * so its behavior-comparison test against the Neo4j impl is the gate that
 * matters most. Reads tier thresholds from CircleConfig and read-state from
 * CircleReadState (both already in Postgres).
 *
 * PORTING NOTES (Neo4j → Postgres)
 * --------------------------------
 * - Effective relationship score: Neo4j stored a single `r.score` property
 *   (manualScore-overrides-computedScore, maintained on write). The Postgres
 *   `relationships` table stores `computed_score` + nullable `manual_score`
 *   instead, so everywhere Neo4j used `r.score` we use
 *   `COALESCE(manual_score, computed_score)` — matching `effectiveScore()` in
 *   scoring-engine.ts.
 * - PostRadius → reachable tier: Neo4j stored a precomputed `radiusInt`; here
 *   we derive it inline from the `radius` enum via the SAME mapping
 *   (WHISPER=0, NORMAL=1, LOUD=2, SHOUT=3) and keep the `radiusInt >= tier`
 *   comparison identical.
 * - Tier thresholds: Neo4j used hard-coded CIRCLE_THRESHOLDS (0.8/0.5/0.2).
 *   Here they come per-user from CircleConfig (same defaults), loaded once per
 *   request — as circle-queries.md prescribes.
 * - getVisiblePostIds keeps the Neo4j two-branch (entity ∪ author) structure:
 *   each branch ordered + limited to (limit+1) by (createdAt DESC, postId DESC),
 *   then merged + deduped app-side keeping the MIN (closest) resolved tier. The
 *   global top-(limit+1) is a subset of the union of per-branch top-(limit+1),
 *   so merge → re-sort → truncate is exact.
 * - Tenant scoping: the graph was implicitly single-tenant, so the Neo4j circle
 *   methods carried no tenant filter. The Postgres `relationships`/`posts` rows
 *   are tenant-scoped, so we filter by `getCurrentTenantId()` when a tenant
 *   context is present; when it is absent we match the Neo4j behavior (no
 *   tenant filter). This mirrors how neo4j-graph-service.ts treats a missing
 *   tenant (it simply did not constrain on it).
 * - Soft-deleted posts: the synced graph only contained live posts. Postgres is
 *   the source of truth and retains soft-deleted rows, so every post query adds
 *   `deleted_at IS NULL` to avoid surfacing deleted content.
 */
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { getCurrentTenantId } from "@de-otio/saas-foundation/tenant";
import type { OrgCategoryFeedFilter } from "../graph-service.js";
import type {
  CircleEntityStatus,
  CircleMember,
  CircleTier,
  CircleTierStatus,
  GlanceItem,
  GraphNodeType,
  PaginatedResult,
  PaginationInput,
  PostRadius,
  TierName,
  VisiblePostResult,
} from "../types.js";

/** PostRadius → integer rank. A post is visible at tier T when radiusInt >= T. */
const RADIUS_TO_INT: Record<PostRadius, number> = {
  WHISPER: 0,
  NORMAL: 1,
  LOUD: 2,
  SHOUT: 3,
};

/** Default circle thresholds, matching CircleConfig schema defaults. */
const DEFAULT_THRESHOLDS = {
  innerThreshold: 0.8,
  closeFriendThreshold: 0.5,
  communityThreshold: 0.2,
};

interface CircleThresholds {
  innerThreshold: number;
  closeFriendThreshold: number;
  communityThreshold: number;
}

const TIER_NAMES: Record<CircleTier, TierName> = {
  0: "inner",
  1: "closeFriends",
  2: "community",
  3: "ambient",
};

/** Score-band bounds for a single tier (matches circle-queries.md getTierBounds). */
function getCircleTierBounds(
  tier: CircleTier,
  t: CircleThresholds,
): { lower: number; upper: number } {
  switch (tier) {
    case 0:
      return { lower: t.innerThreshold, upper: Infinity };
    case 1:
      return { lower: t.closeFriendThreshold, upper: t.innerThreshold };
    case 2:
      return { lower: t.communityThreshold, upper: t.closeFriendThreshold };
    case 3:
      return { lower: 0.001, upper: t.communityThreshold };
  }
}

interface CircleCursor {
  createdAt: string;
  postId: string;
}

function decodeCircleCursor(cursor?: string): CircleCursor | null {
  if (!cursor) return null;
  try {
    const d = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
    if (d.createdAt && d.postId) return d as CircleCursor;
    return null;
  } catch {
    return null;
  }
}

function encodeCircleCursor(createdAt: string, postId: string): string {
  return Buffer.from(JSON.stringify({ createdAt, postId })).toString("base64");
}

/**
 * SQL `CASE` fragment that maps an effective relationship score to a tier
 * (0..3) using the per-user thresholds. Mirrors the Neo4j
 * `MIN(CASE WHEN relScore >= … )` expression. `scoreCol` is a trusted column
 * reference, the thresholds are bound parameters.
 */
function tierCaseSql(scoreCol: Prisma.Sql, t: CircleThresholds): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN ${scoreCol} >= ${t.innerThreshold} THEN 0
    WHEN ${scoreCol} >= ${t.closeFriendThreshold} THEN 1
    WHEN ${scoreCol} >= ${t.communityThreshold} THEN 2
    ELSE 3
  END`;
}

/**
 * SQL `CASE` fragment mapping the `radius` enum column to its integer rank.
 * Mirrors the Neo4j `radiusInt` precompute exactly.
 */
const RADIUS_INT_SQL = Prisma.sql`CASE p.radius
  WHEN 'WHISPER' THEN 0
  WHEN 'NORMAL' THEN 1
  WHEN 'LOUD' THEN 2
  WHEN 'SHOUT' THEN 3
END`;

/** Effective score column: COALESCE(manual_score, computed_score). */
const EFFECTIVE_SCORE_SQL = Prisma.sql`COALESCE(r.manual_score, r.computed_score)`;

/**
 * Org-category feed-declutter predicate over the denormalized
 * `posts.author_org_root_category_code` column. Returns a SQL fragment that
 * ANDs cleanly onto an existing `WHERE`/tier filter (or {@link Prisma.empty}
 * when there is nothing to filter). All codes are bound parameters via
 * {@link Prisma.join} — never interpolated as raw SQL.
 *
 * Null-code handling matches {@link OrgCategoryFeedFilter}'s documented
 * semantics: an `exclude` list keeps null-code posts (a null is not "one of"
 * the excluded categories), while an `include` whitelist drops them (a null
 * post belongs to no listed org category — `NULL IN (...)` is never true).
 */
function orgCategoryFilterSql(filter?: OrgCategoryFeedFilter): Prisma.Sql {
  if (!filter) return Prisma.empty;
  const clauses: Prisma.Sql[] = [];
  if (filter.exclude && filter.exclude.length > 0) {
    clauses.push(
      Prisma.sql`AND (p.author_org_root_category_code IS NULL
        OR p.author_org_root_category_code NOT IN (${Prisma.join(filter.exclude)}))`,
    );
  }
  if (filter.include && filter.include.length > 0) {
    clauses.push(
      Prisma.sql`AND p.author_org_root_category_code IN (${Prisma.join(filter.include)})`,
    );
  }
  if (clauses.length === 0) return Prisma.empty;
  return Prisma.join(clauses, " ");
}

export class CircleOps {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Tenant filter for the `relationships` alias `r`. Present only when an
   * ambient tenant context exists; absent → no filter (matches Neo4j, which
   * never constrained on tenant). Returns a SQL fragment that ANDs cleanly.
   */
  private tenantFilter(): Prisma.Sql {
    const tenantId = getCurrentTenantId();
    return tenantId ? Prisma.sql`AND r.tenant_id = ${tenantId}` : Prisma.empty;
  }

  /** Same as {@link tenantFilter} but for the `posts` alias `p`. */
  private postTenantFilter(): Prisma.Sql {
    const tenantId = getCurrentTenantId();
    return tenantId ? Prisma.sql`AND p.tenant_id = ${tenantId}` : Prisma.empty;
  }

  /** Load per-user thresholds from CircleConfig, falling back to defaults. */
  private async loadThresholds(userId: string): Promise<CircleThresholds> {
    const config = await this.prisma.circleConfig.findUnique({
      where: { userId },
      select: {
        innerThreshold: true,
        closeFriendThreshold: true,
        communityThreshold: true,
      },
    });
    if (!config) return { ...DEFAULT_THRESHOLDS };
    return {
      innerThreshold: config.innerThreshold,
      closeFriendThreshold: config.closeFriendThreshold,
      communityThreshold: config.communityThreshold,
    };
  }

  /** Load last-read timestamps for all four tiers from CircleReadState. */
  private async loadReadStates(
    userId: string,
  ): Promise<Record<CircleTier, Date | null>> {
    const rows = await this.prisma.circleReadState.findMany({
      where: { userId },
      select: { tier: true, lastReadAt: true },
    });
    const result: Record<CircleTier, Date | null> = {
      0: null,
      1: null,
      2: null,
      3: null,
    };
    for (const row of rows) {
      if (row.tier >= 0 && row.tier <= 3) {
        result[row.tier as CircleTier] = row.lastReadAt;
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // getCircleMembers
  // -------------------------------------------------------------------------

  async getCircleMembers(
    userId: string,
    tier: CircleTier,
  ): Promise<CircleMember[]> {
    const thresholds = await this.loadThresholds(userId);
    const bounds = getCircleTierBounds(tier, thresholds);
    const upper = bounds.upper === Infinity ? 1e9 : bounds.upper;

    const rows = await this.prisma.$queryRaw<
      { id: string; type: string; name: string | null; score: number }[]
    >(Prisma.sql`
      SELECT
        r.target_id AS id,
        r.target_type AS type,
        CASE WHEN r.target_type = 'entity' THEN e.name ELSE COALESCE(u.username, u.handle) END AS name,
        ${EFFECTIVE_SCORE_SQL} AS score
      FROM relationships r
      LEFT JOIN entities e ON r.target_type = 'entity' AND e.id = r.target_id
      LEFT JOIN users u ON r.target_type = 'user' AND u.id = r.target_id
      WHERE r.user_id = ${userId}
        ${this.tenantFilter()}
        AND ${EFFECTIVE_SCORE_SQL} >= ${bounds.lower}
        AND ${EFFECTIVE_SCORE_SQL} < ${upper}
      ORDER BY score DESC
    `);

    return rows.map((row) => ({
      id: row.id,
      type: row.type === "entity" ? ("entity" as const) : ("user" as const),
      name: row.name ?? "",
      score: row.score,
      tier,
    }));
  }

  // -------------------------------------------------------------------------
  // getVisiblePostIds — DUAL-GATED PRIVACY CONTROL
  // -------------------------------------------------------------------------

  async getVisiblePostIds(
    userId: string,
    tier: CircleTier,
    since: Date,
    pagination: PaginationInput,
    orgFilter?: OrgCategoryFeedFilter,
  ): Promise<PaginatedResult<VisiblePostResult>> {
    const thresholds = await this.loadThresholds(userId);
    const bounds = getCircleTierBounds(tier, thresholds);
    const upper = bounds.upper === Infinity ? 1e9 : bounds.upper;
    const tenantR = this.tenantFilter();
    const tenantP = this.postTenantFilter();
    const orgP = orgCategoryFilterSql(orgFilter);
    const cursor = decodeCircleCursor(pagination.cursor ?? undefined);
    const tierExpr = tierCaseSql(EFFECTIVE_SCORE_SQL, thresholds);
    // Fetch (limit+1) per branch to detect hasMore after the app-side merge.
    const fetchLimit = pagination.limit + 1;

    const cursorClause = cursor
      ? Prisma.sql`AND (p.created_at < ${new Date(cursor.createdAt)}
            OR (p.created_at = ${new Date(cursor.createdAt)} AND p.id < ${cursor.postId}))`
      : Prisma.empty;

    // Branch 1 — posts ABOUT an entity the viewer relates to in this tier band.
    // MIN(resolvedTier) over matching subjects = closest tier wins (multi-entity).
    const entityQuery = Prisma.sql`
      SELECT
        p.id AS "postId",
        p.created_at AS "createdAt",
        MIN(${tierExpr}) AS "resolvedTier"
      FROM relationships r
      JOIN post_subjects ps ON ps.entity_id = r.target_id
      JOIN posts p ON p.id = ps.post_id
      WHERE r.user_id = ${userId}
        AND r.target_type = 'entity'
        ${tenantR}
        ${tenantP}
        AND ${EFFECTIVE_SCORE_SQL} >= ${bounds.lower}
        AND ${EFFECTIVE_SCORE_SQL} < ${upper}
        AND p.deleted_at IS NULL
        AND p.created_at > ${since}
        AND ${RADIUS_INT_SQL} >= ${tier}
        ${orgP}
        ${cursorClause}
      GROUP BY p.id, p.created_at
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${fetchLimit}
    `;

    // Branch 2 — posts BY a user the viewer relates to in this tier band.
    const authorQuery = Prisma.sql`
      SELECT
        p.id AS "postId",
        p.created_at AS "createdAt",
        MIN(${tierExpr}) AS "resolvedTier"
      FROM relationships r
      JOIN posts p ON p.author_id = r.target_id
      WHERE r.user_id = ${userId}
        AND r.target_type = 'user'
        ${tenantR}
        ${tenantP}
        AND ${EFFECTIVE_SCORE_SQL} >= ${bounds.lower}
        AND ${EFFECTIVE_SCORE_SQL} < ${upper}
        AND p.deleted_at IS NULL
        AND p.created_at > ${since}
        AND ${RADIUS_INT_SQL} >= ${tier}
        ${orgP}
        ${cursorClause}
      GROUP BY p.id, p.created_at
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${fetchLimit}
    `;

    const [entityRows, authorRows] = await Promise.all([
      this.prisma.$queryRaw<
        { postId: string; createdAt: Date; resolvedTier: number }[]
      >(entityQuery),
      this.prisma.$queryRaw<
        { postId: string; createdAt: Date; resolvedTier: number }[]
      >(authorQuery),
    ]);

    // Merge + dedupe by postId, keeping the closest (min) resolved tier.
    const byId = new Map<string, VisiblePostResult>();
    for (const row of [...entityRows, ...authorRows]) {
      const createdAt =
        row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
      const resolvedTier = Number(row.resolvedTier) as CircleTier;
      const existing = byId.get(row.postId);
      if (!existing || resolvedTier < existing.resolvedTier) {
        byId.set(row.postId, { postId: row.postId, createdAt, resolvedTier });
      }
    }

    // Sort createdAt DESC, then postId DESC — matches the cursor tiebreak.
    const merged = Array.from(byId.values()).sort((a, b) => {
      const d = b.createdAt.getTime() - a.createdAt.getTime();
      if (d !== 0) return d;
      return a.postId < b.postId ? 1 : a.postId > b.postId ? -1 : 0;
    });

    const items = merged.slice(0, pagination.limit);
    const hasMore = merged.length > pagination.limit;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCircleCursor(last.createdAt.toISOString(), last.postId)
        : null;
    return { items, cursor: nextCursor, hasMore };
  }

  // -------------------------------------------------------------------------
  // getGlanceItems
  // -------------------------------------------------------------------------

  async getGlanceItems(
    userId: string,
    tier: CircleTier,
    limit: number,
    orgFilter?: OrgCategoryFeedFilter,
  ): Promise<GlanceItem[]> {
    const thresholds = await this.loadThresholds(userId);
    const bounds = getCircleTierBounds(tier, thresholds);
    const upper = bounds.upper === Infinity ? 1e9 : bounds.upper;
    const tenantR = this.tenantFilter();
    const tenantP = this.postTenantFilter();
    const orgP = orgCategoryFilterSql(orgFilter);

    // Step 1: tier members (matches circle-queries.md two-step variant).
    const members = await this.prisma.$queryRaw<
      { targetId: string; targetType: string; targetName: string | null }[]
    >(Prisma.sql`
      SELECT
        r.target_id AS "targetId",
        r.target_type AS "targetType",
        CASE WHEN r.target_type = 'entity' THEN e.name ELSE COALESCE(u.username, u.handle) END AS "targetName"
      FROM relationships r
      LEFT JOIN entities e ON r.target_type = 'entity' AND e.id = r.target_id
      LEFT JOIN users u ON r.target_type = 'user' AND u.id = r.target_id
      WHERE r.user_id = ${userId}
        ${tenantR}
        AND ${EFFECTIVE_SCORE_SQL} >= ${bounds.lower}
        AND ${EFFECTIVE_SCORE_SQL} < ${upper}
      ORDER BY ${EFFECTIVE_SCORE_SQL} DESC
    `);

    const entityIds: string[] = [];
    const userIds: string[] = [];
    const memberMap = new Map<
      string,
      { targetType: "entity" | "user"; targetName: string }
    >();
    for (const m of members) {
      const tt =
        m.targetType === "entity" ? ("entity" as const) : ("user" as const);
      memberMap.set(m.targetId, {
        targetType: tt,
        targetName: m.targetName ?? "",
      });
      if (tt === "entity") entityIds.push(m.targetId);
      else userIds.push(m.targetId);
    }

    const glanceItems: GlanceItem[] = [];

    // Step 2a: most-recent post per entity (DISTINCT ON, newest first).
    if (entityIds.length > 0) {
      const rows = await this.prisma.$queryRaw<
        { targetId: string; postId: string; postCreatedAt: Date }[]
      >(Prisma.sql`
        SELECT DISTINCT ON (ps.entity_id)
          ps.entity_id AS "targetId",
          p.id AS "postId",
          p.created_at AS "postCreatedAt"
        FROM post_subjects ps
        JOIN posts p ON p.id = ps.post_id
        WHERE ps.entity_id IN (${Prisma.join(entityIds)})
          AND p.deleted_at IS NULL
          AND ${RADIUS_INT_SQL} >= ${tier}
          ${tenantP}
          ${orgP}
        ORDER BY ps.entity_id, p.created_at DESC, p.id DESC
      `);
      for (const row of rows) {
        const m = memberMap.get(row.targetId);
        if (!m) continue;
        glanceItems.push({
          targetId: row.targetId,
          targetType: "entity",
          targetName: m.targetName,
          postId: row.postId,
          postCreatedAt:
            row.postCreatedAt instanceof Date
              ? row.postCreatedAt
              : new Date(row.postCreatedAt),
        });
      }
    }

    // Step 2b: most-recent post per user author.
    if (userIds.length > 0) {
      const rows = await this.prisma.$queryRaw<
        { targetId: string; postId: string; postCreatedAt: Date }[]
      >(Prisma.sql`
        SELECT DISTINCT ON (p.author_id)
          p.author_id AS "targetId",
          p.id AS "postId",
          p.created_at AS "postCreatedAt"
        FROM posts p
        WHERE p.author_id IN (${Prisma.join(userIds)})
          AND p.deleted_at IS NULL
          AND ${RADIUS_INT_SQL} >= ${tier}
          ${tenantP}
          ${orgP}
        ORDER BY p.author_id, p.created_at DESC, p.id DESC
      `);
      for (const row of rows) {
        const m = memberMap.get(row.targetId);
        if (!m) continue;
        glanceItems.push({
          targetId: row.targetId,
          targetType: "user",
          targetName: m.targetName,
          postId: row.postId,
          postCreatedAt:
            row.postCreatedAt instanceof Date
              ? row.postCreatedAt
              : new Date(row.postCreatedAt),
        });
      }
    }

    glanceItems.sort(
      (a, b) => b.postCreatedAt.getTime() - a.postCreatedAt.getTime(),
    );
    return glanceItems.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // getDepthPostIds
  // -------------------------------------------------------------------------

  async getDepthPostIds(
    userId: string,
    targetType: GraphNodeType,
    targetId: string,
    since: Date,
    limit: number,
  ): Promise<string[]> {
    const thresholds = await this.loadThresholds(userId);
    const tenantR = this.tenantFilter();
    const tenantP = this.postTenantFilter();
    // Per-viewer dynamic radius gate: the viewer's tier with THIS target
    // (derived from the effective score) sets the minimum radius required.
    const viewerTierExpr = tierCaseSql(EFFECTIVE_SCORE_SQL, thresholds);

    if (targetType === "entity") {
      const rows = await this.prisma.$queryRaw<{ postId: string }[]>(Prisma.sql`
        SELECT p.id AS "postId"
        FROM relationships r
        JOIN post_subjects ps ON ps.entity_id = r.target_id
        JOIN posts p ON p.id = ps.post_id
        WHERE r.user_id = ${userId}
          AND r.target_type = 'entity'
          AND r.target_id = ${targetId}
          ${tenantR}
          ${tenantP}
          AND p.deleted_at IS NULL
          AND p.created_at > ${since}
          AND ${RADIUS_INT_SQL} >= (${viewerTierExpr})
        ORDER BY p.created_at DESC
        LIMIT ${limit}
      `);
      return rows.map((row) => row.postId);
    }

    const rows = await this.prisma.$queryRaw<{ postId: string }[]>(Prisma.sql`
      SELECT p.id AS "postId"
      FROM relationships r
      JOIN posts p ON p.author_id = r.target_id
      WHERE r.user_id = ${userId}
        AND r.target_type = 'user'
        AND r.target_id = ${targetId}
        ${tenantR}
        ${tenantP}
        AND p.deleted_at IS NULL
        AND p.created_at > ${since}
        AND ${RADIUS_INT_SQL} >= (${viewerTierExpr})
      ORDER BY p.created_at DESC
      LIMIT ${limit}
    `);
    return rows.map((row) => row.postId);
  }

  // -------------------------------------------------------------------------
  // getCircleStatus
  // -------------------------------------------------------------------------

  async getCircleStatus(userId: string): Promise<CircleTierStatus[]> {
    const thresholds = await this.loadThresholds(userId);
    const readStates = await this.loadReadStates(userId);
    const epoch = new Date(0);
    const tenantR = this.tenantFilter();
    const tenantP = this.postTenantFilter();
    const tiers: CircleTier[] = [0, 1, 2, 3];

    // Four parallel per-tier count queries (circle-queries.md recommended
    // variant). Each counts distinct unseen posts reachable through this tier's
    // relationships (entity-subject path OR author path).
    return Promise.all(
      tiers.map(async (tier) => {
        const bounds = getCircleTierBounds(tier, thresholds);
        const upper = bounds.upper === Infinity ? 1e9 : bounds.upper;
        const lastReadAt = readStates[tier] ?? epoch;

        const rows = await this.prisma.$queryRaw<{ unseenCount: bigint }[]>(
          Prisma.sql`
          SELECT COUNT(DISTINCT p.id) AS "unseenCount"
          FROM relationships r
          JOIN posts p ON (
            (r.target_type = 'entity' AND EXISTS (
              SELECT 1 FROM post_subjects ps
              WHERE ps.post_id = p.id AND ps.entity_id = r.target_id
            ))
            OR (r.target_type = 'user' AND p.author_id = r.target_id)
          )
          WHERE r.user_id = ${userId}
            ${tenantR}
            ${tenantP}
            AND ${EFFECTIVE_SCORE_SQL} >= ${bounds.lower}
            AND ${EFFECTIVE_SCORE_SQL} < ${upper}
            AND p.deleted_at IS NULL
            AND ${RADIUS_INT_SQL} >= ${tier}
            AND p.created_at > ${lastReadAt}
        `,
        );

        const unseenCount =
          rows.length > 0 ? Number(rows[0].unseenCount) : 0;
        return {
          tier,
          name: TIER_NAMES[tier],
          caughtUp: unseenCount === 0,
          unseenCount,
          lastReadAt: readStates[tier],
        } satisfies CircleTierStatus;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // getCircleEntityStatus
  // -------------------------------------------------------------------------

  async getCircleEntityStatus(
    userId: string,
    tier: CircleTier,
  ): Promise<CircleEntityStatus[]> {
    const thresholds = await this.loadThresholds(userId);
    const readStates = await this.loadReadStates(userId);
    const bounds = getCircleTierBounds(tier, thresholds);
    const upper = bounds.upper === Infinity ? 1e9 : bounds.upper;
    const lastReadAt = readStates[tier] ?? new Date(0);
    const tenantR = this.tenantFilter();
    const tenantP = this.postTenantFilter();

    // Entity members in the tier; LEFT JOIN to unseen posts (matches the Neo4j
    // OPTIONAL MATCH so entities with zero unseen posts still appear).
    const rows = await this.prisma.$queryRaw<
      {
        entityId: string;
        entityName: string | null;
        unseenCount: bigint;
        latestPostAt: Date | null;
      }[]
    >(Prisma.sql`
      SELECT
        r.target_id AS "entityId",
        e.name AS "entityName",
        COUNT(p.id) AS "unseenCount",
        MAX(p.created_at) AS "latestPostAt"
      FROM relationships r
      LEFT JOIN entities e ON e.id = r.target_id
      LEFT JOIN post_subjects ps ON ps.entity_id = r.target_id
      LEFT JOIN posts p ON p.id = ps.post_id
        AND p.deleted_at IS NULL
        AND ${RADIUS_INT_SQL} >= ${tier}
        AND p.created_at > ${lastReadAt}
        ${tenantP}
      WHERE r.user_id = ${userId}
        AND r.target_type = 'entity'
        ${tenantR}
        AND ${EFFECTIVE_SCORE_SQL} >= ${bounds.lower}
        AND ${EFFECTIVE_SCORE_SQL} < ${upper}
      GROUP BY r.target_id, e.name
      ORDER BY "unseenCount" DESC, "latestPostAt" DESC
    `);

    return rows.map((row) => {
      const unseenCount = Number(row.unseenCount);
      return {
        entityId: row.entityId,
        entityName: row.entityName ?? "",
        caughtUp: unseenCount === 0,
        unseenCount,
        latestPostAt: row.latestPostAt
          ? row.latestPostAt instanceof Date
            ? row.latestPostAt
            : new Date(row.latestPostAt)
          : null,
      };
    });
  }

  // -------------------------------------------------------------------------
  // markCircleRead
  // -------------------------------------------------------------------------

  async markCircleRead(
    userId: string,
    tier: CircleTier,
    readAt?: Date,
  ): Promise<void> {
    // Canonical read state lives in Postgres (CircleReadState). Upsert the
    // per-user/per-tier row. (Neo4j stored a graph-side fallback on the User
    // node; in Postgres this row IS the source of truth, so no graph write.)
    const timestamp = readAt ?? new Date();
    await this.prisma.circleReadState.upsert({
      where: { userId_tier: { userId, tier } },
      update: { lastReadAt: timestamp, caughtUp: true },
      create: { userId, tier, lastReadAt: timestamp, caughtUp: true },
    });
  }
}
