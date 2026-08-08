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
 * - Tenant scoping: see "Tenant scoping is explicit" below. The original port
 *   filtered by the AMBIENT `getCurrentTenantId()`; that is gone.
 * - Soft-deleted posts: the synced graph only contained live posts. Postgres is
 *   the source of truth and retains soft-deleted rows, so every post query adds
 *   `deleted_at IS NULL` to avoid surfacing deleted content.
 *
 * AUDIENCE IS AUTHOR-OWNED (H1)
 * -----------------------------
 * Every query here that returns or counts POSTS used to decide visibility from
 * the VIEWER's own relationship row:
 *
 *   FROM relationships r JOIN posts p ON p.author_id = r.target_id
 *   WHERE r.user_id = <viewer>                       -- the viewer's own edge
 *     AND COALESCE(r.manual_score, r.computed_score) >= <band lower>
 *     AND radiusInt(p) >= <requested tier>
 *
 * Every input to that decision is reader-controlled. `manual_score` is written
 * by the reader on their own edge (`PATCH /api/relationships/score`,
 * `manualScore: 1.0` → `scoreToTier` → tier 0), the edge itself needs no
 * consent from the other party, and even the band boundaries came from the
 * READER's own `CircleConfig` via {@link CircleOps.loadThresholds}. Requesting
 * tier 0 admits `radiusInt >= 0`, i.e. WHISPER. So one POST /api/relationships
 * plus one PATCH made a stranger's most private posts readable through
 * `/api/circles/feed`, `/api/circles/depth` and `/api/circles/glance` — and the
 * victim could not revoke it, because their own placement was never consulted.
 *
 * This is the same inversion `lib/friend-ids.ts` fixed for the post read paths,
 * on a path that fix did not touch. The rule, stated once and applied to every
 * post-returning query in this file:
 *
 *   Who may read a post is decided by the edge its AUTHOR owns —
 *   `relationships(user_id = author, target_type = 'user', target_id = viewer)`
 *   — with `reciprocated` required, exactly as `getFriendUserIds` does.
 *
 * Two shapes implement that rule:
 *
 *   1. USER-AUTHOR paths (the author branch of `getVisiblePostIds` and of
 *      `getCircleStatus`, and the user half of `getGlanceItems`) DRIVE the query
 *      from the author's edge: `r.target_id = <viewer>`, `r.user_id` is the
 *      author, `r.reciprocated`, and the tier band is the AUTHOR's stored
 *      `r.tier`. The radius gate `radiusInt(p) >= r.tier` is then the audience
 *      decision itself.
 *   2. ENTITY-SUBJECT paths (posts ABOUT an entity the viewer follows) and
 *      `getDepthPostIds` keep the viewer's own edge as the SELECTION predicate —
 *      which entity the viewer subscribes to is the viewer's own data and leaks
 *      nothing — and add {@link authorAudienceSql}, an EXISTS over the author's
 *      edge in exactly the direction above.
 *
 * `reciprocated` means less than it sounds like, and must not be described as
 * symmetric consent: `createRelationship` sets it on BOTH rows on the mere
 * existence of a reverse edge, with no tier, score or method condition
 * (graph/postgres/relationships.ts:199-220). The effective rule is therefore
 * "the author placed you close AND you have some edge back". That is the
 * intended semantic — it is the author's placement that carries the weight.
 *
 * Consequences, deliberately accepted:
 * - The tier bands of `/api/circles/feed`, `/api/circles/status` and the user
 *   half of `/api/circles/glance` now mean "content people have chosen to share
 *   with me at this depth" rather than "content from people I filed at this
 *   depth". That is the coherent reading — `radius` is author-owned, so the
 *   tier it is compared against must be too — and it is strictly better for the
 *   author: lowering their own tier for someone now actually revokes access.
 * - A one-way follow (no reverse edge) no longer contributes to those bands,
 *   including its SHOUT posts. Public content remains on the home feed, which
 *   applies `buildPostAudienceFilter` and admits SHOUT from anyone.
 * - The author-side tier read here is the stored `relationships.tier` column
 *   (maintained by `scoreToTier` on every write path), NOT a per-user
 *   `CircleConfig` band. `scoreToTier` uses TIER_THRESHOLDS (0.7/0.4/0.15) while
 *   `CircleConfig` defaults to 0.8/0.5/0.2; that divergence predates this change
 *   and is noted here because the two now sit in the same file. Using the stored
 *   column is what keeps `CircleConfig` — a READER preference — out of the
 *   access decision, and it is the same column `getFriendUserIds` reads.
 *
 * TENANT SCOPING IS EXPLICIT
 * --------------------------
 * `tenantFilter()`/`postTenantFilter()` resolved the AMBIENT tenant and returned
 * {@link Prisma.empty} when there was none. With `TENANT_SCOPE_MODE` defaulting
 * to `off` the tenant-context middleware is never mounted (app.ts), so there was
 * never one: every query ran with no tenant predicate at all, and there is no
 * RLS backstop. An ambient filter that silently evaluates to nothing is worse
 * than no filter, because it reads as coverage. Every method that touches
 * tenant-scoped rows now takes an explicit `activeTenantId` from the caller's
 * verified JWT and REFUSES (throws) rather than querying when it is absent —
 * the pattern `FeedHandler.getPost` adopted.
 */
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
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

/**
 * getCircleStatus unseen-count window (days). A tier that was never marked
 * read used to count ALL history (lastReadAt defaulted to the epoch) — ×4
 * per status poll. The status badge only needs "is there something new",
 * so the count window is floored at now − 7d. Product/display semantic,
 * not an operational-security threshold (threshold-secrecy rule N/A).
 */
export const CIRCLE_STATUS_WINDOW_DAYS = 7;

/**
 * getCircleStatus unseen-count cap. Counts saturate at this value (the
 * client renders "99+"); the query stops enumerating past it (LIMIT inside
 * the UNION subquery) instead of counting unbounded history.
 */
export const CIRCLE_STATUS_UNSEEN_CAP = 100;

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

/** `radiusInt` of the widest radius (SHOUT) — the public band. */
const PUBLIC_RADIUS_INT = RADIUS_TO_INT.SHOUT;

/**
 * The audience predicate for a post, decided entirely on the AUTHOR's side.
 *
 * ANDs onto a query that has `posts` aliased as `p`. A viewer may read `p` when
 * any of the following holds:
 *
 *   1. they wrote it (`p.author_id = viewer`) — an author always sees their own;
 *   2. it is SHOUT (`radiusInt = 3`), the public band. This matches
 *      `buildPostAudienceFilter`, which admits SHOUT from anyone, and it is what
 *      keeps entity-subject and depth views from hiding public content;
 *   3. the AUTHOR placed the viewer at a tier the post's radius reaches, on a
 *      reciprocated edge.
 *
 * Clause 3 is the load-bearing one and its direction is the whole point:
 * `ar.user_id` is the AUTHOR and `ar.target_id` is the viewer, so `ar.tier` is
 * the tier the AUTHOR assigned. Flipping it to `ar.user_id = <viewer>` hands the
 * audience boundary back to the reader, who sets their own tier through
 * `PATCH /api/relationships/score` — that is defect H1, and V1 before it in
 * lib/friend-ids.ts.
 *
 * A missing edge is not an error: it simply fails clause 3, which is the same
 * outcome as `Relationship.tier`'s default of 3 (ambient) — a stranger reaches
 * only SHOUT.
 *
 * `reciprocated` is REQUIRED, never optional: without it an author's one-sided
 * classification of a stranger grants that stranger read access. See the module
 * doc for what the flag actually asserts (existence of a reverse edge, nothing
 * about its tier).
 *
 * `tenantId` is a bound parameter and must be a real tenant — callers guard it
 * before building any SQL (see {@link CircleOps.requireTenant}).
 */
function authorAudienceSql(viewerUserId: string, tenantId: string): Prisma.Sql {
  return Prisma.sql`AND (
    p.author_id = ${viewerUserId}
    OR ${RADIUS_INT_SQL} >= ${PUBLIC_RADIUS_INT}
    OR EXISTS (
      SELECT 1
      FROM relationships ar
      WHERE ar.user_id = p.author_id
        AND ar.target_type = 'user'
        AND ar.target_id = ${viewerUserId}
        AND ar.reciprocated
        AND ar.tenant_id = ${tenantId}
        AND ar.tier <= ${RADIUS_INT_SQL}
    )
  )`;
}

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
   * Refuse rather than query when the caller has no tenant.
   *
   * The predecessor of this guard was an ambient lookup that produced
   * {@link Prisma.empty} — a query with NO tenant predicate, returning every
   * tenant's rows, with no error anywhere. There is no RLS backstop, so the
   * explicit predicate these methods build is the only tenant defence there is;
   * a caller that cannot name its tenant must be refused, not served.
   *
   * Throws rather than returning empty so the failure is loud: an empty result
   * is indistinguishable from "no content" and would hide a misrouted call.
   */
  private requireTenant(method: string, tenantId: string): string {
    if (!tenantId) {
      throw new Error(
        `CircleOps.${method}: activeTenantId is required for tenant isolation`,
      );
    }
    return tenantId;
  }

  /**
   * Load per-user thresholds from CircleConfig, falling back to defaults.
   *
   * READER PREFERENCE ONLY. These bands organize the viewer's own roster (who
   * *they* filed where); they no longer influence what any viewer may READ. See
   * the module doc — routing a threshold that the reader writes into an access
   * decision is defect H1.
   */
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

  /**
   * The viewer's OWN roster for a tier. Returns no post content, so the
   * reader-controlled score band is legitimate here — this is "who did I file
   * where", the viewer's own data. Only the tenant predicate changes: it is now
   * explicit and required.
   */
  async getCircleMembers(
    userId: string,
    tier: CircleTier,
    activeTenantId: string,
  ): Promise<CircleMember[]> {
    const tenantId = this.requireTenant("getCircleMembers", activeTenantId);
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
        AND r.tenant_id = ${tenantId}
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
    activeTenantId: string,
    orgFilter?: OrgCategoryFeedFilter,
  ): Promise<PaginatedResult<VisiblePostResult>> {
    const tenantId = this.requireTenant("getVisiblePostIds", activeTenantId);
    const thresholds = await this.loadThresholds(userId);
    const bounds = getCircleTierBounds(tier, thresholds);
    const upper = bounds.upper === Infinity ? 1e9 : bounds.upper;
    const audience = authorAudienceSql(userId, tenantId);
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
    //
    // The viewer's entity edge SELECTS (which of my subscriptions is this band?)
    // and no longer AUTHORIZES: `authorAudienceSql` decides whether each post
    // may be read, from the author's edge. Without it, self-setting
    // `manualScore = 1.0` on any entity surfaced every WHISPER post tagged with
    // that entity, whoever wrote it.
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
        AND r.tenant_id = ${tenantId}
        AND p.tenant_id = ${tenantId}
        AND ${EFFECTIVE_SCORE_SQL} >= ${bounds.lower}
        AND ${EFFECTIVE_SCORE_SQL} < ${upper}
        AND p.deleted_at IS NULL
        AND p.created_at > ${since}
        AND ${RADIUS_INT_SQL} >= ${tier}
        ${audience}
        ${orgP}
        ${cursorClause}
      GROUP BY p.id, p.created_at
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${fetchLimit}
    `;

    // Branch 2 — posts BY a user who placed THIS VIEWER in this tier band.
    //
    // Inverted (H1): `r.target_id` is the viewer and `r.user_id` is the author,
    // so `r.tier` is the tier the AUTHOR assigned and `radiusInt(p) >= r.tier`
    // IS the audience decision — the author's reach measured against the
    // author's own placement. There is deliberately no second, redundant
    // audience clause here: this join is the gate.
    //
    // Restoring `r.user_id = ${userId}` reinstates H1 in full — the reader's
    // self-set score would decide again, and tier 0 admits WHISPER.
    const authorQuery = Prisma.sql`
      SELECT
        p.id AS "postId",
        p.created_at AS "createdAt",
        MIN(r.tier) AS "resolvedTier"
      FROM relationships r
      JOIN posts p ON p.author_id = r.user_id
      WHERE r.target_id = ${userId}
        AND r.target_type = 'user'
        AND r.reciprocated
        AND r.tier = ${tier}
        AND r.tenant_id = ${tenantId}
        AND p.tenant_id = ${tenantId}
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
    activeTenantId: string,
    orgFilter?: OrgCategoryFeedFilter,
  ): Promise<GlanceItem[]> {
    const tenantId = this.requireTenant("getGlanceItems", activeTenantId);
    const thresholds = await this.loadThresholds(userId);
    const bounds = getCircleTierBounds(tier, thresholds);
    const upper = bounds.upper === Infinity ? 1e9 : bounds.upper;
    const audience = authorAudienceSql(userId, tenantId);
    const orgP = orgCategoryFilterSql(orgFilter);

    // Step 1a: ENTITY members of the tier — the viewer's own subscriptions, so
    // the viewer's score band is the right selector (it authorizes nothing; the
    // posts fetched for these entities carry `authorAudienceSql`).
    const entityMembers = await this.prisma.$queryRaw<
      { targetId: string; targetName: string | null }[]
    >(Prisma.sql`
      SELECT
        r.target_id AS "targetId",
        e.name AS "targetName"
      FROM relationships r
      LEFT JOIN entities e ON e.id = r.target_id
      WHERE r.user_id = ${userId}
        AND r.target_type = 'entity'
        AND r.tenant_id = ${tenantId}
        AND ${EFFECTIVE_SCORE_SQL} >= ${bounds.lower}
        AND ${EFFECTIVE_SCORE_SQL} < ${upper}
      ORDER BY ${EFFECTIVE_SCORE_SQL} DESC
    `);

    // Step 1b: USER members of the tier — inverted (H1), and for the same reason
    // as `getVisiblePostIds` branch 2: the tier band of a person-shaped glance
    // row must be the one the AUTHOR assigned, or the badge and the feed
    // disagree about what tier N contains. `r.user_id` is the author here.
    const userMembers = await this.prisma.$queryRaw<
      { targetId: string; targetName: string | null }[]
    >(Prisma.sql`
      SELECT
        r.user_id AS "targetId",
        COALESCE(u.username, u.handle) AS "targetName"
      FROM relationships r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.target_id = ${userId}
        AND r.target_type = 'user'
        AND r.reciprocated
        AND r.tier = ${tier}
        AND r.tenant_id = ${tenantId}
      ORDER BY ${EFFECTIVE_SCORE_SQL} DESC
    `);

    const entityIds: string[] = [];
    const userIds: string[] = [];
    const memberMap = new Map<
      string,
      { targetType: "entity" | "user"; targetName: string }
    >();
    for (const m of entityMembers) {
      memberMap.set(m.targetId, {
        targetType: "entity",
        targetName: m.targetName ?? "",
      });
      entityIds.push(m.targetId);
    }
    for (const m of userMembers) {
      memberMap.set(m.targetId, {
        targetType: "user",
        targetName: m.targetName ?? "",
      });
      userIds.push(m.targetId);
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
          AND p.tenant_id = ${tenantId}
          ${audience}
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

    // Step 2b: most-recent post per user author. `userIds` are authors who
    // placed THIS VIEWER at `tier` on a reciprocated edge (step 1b), so
    // `radiusInt(p) >= tier` compares the post's reach against the AUTHOR's own
    // placement — the audience decision, not the reader's.
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
          AND p.tenant_id = ${tenantId}
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

  /**
   * Recent posts from/about one target the viewer relates to.
   *
   * This was the sharpest edge of H1: the radius gate was
   * `radiusInt(p) >= <viewer's tier with the target>`, and the viewer sets that
   * tier on their own edge. `GET /api/circles/depth?targetType=user&targetId=V`
   * after one `POST /api/relationships` + `PATCH …/score { manualScore: 1.0 }`
   * returned V's WHISPER post ids to a complete stranger.
   *
   * The viewer's edge is retained as the SELECTION predicate — depth mode is
   * "show me this one target from my circles", so a target the viewer has no
   * edge to is still not enumerable — and {@link authorAudienceSql} now makes
   * the read decision from the AUTHOR's side. SHOUT stays visible (it is public
   * and reachable through other endpoints anyway); everything narrower requires
   * the author to have placed this viewer within the post's radius on a
   * reciprocated edge.
   */
  async getDepthPostIds(
    userId: string,
    targetType: GraphNodeType,
    targetId: string,
    since: Date,
    limit: number,
    activeTenantId: string,
  ): Promise<string[]> {
    const tenantId = this.requireTenant("getDepthPostIds", activeTenantId);
    const audience = authorAudienceSql(userId, tenantId);

    if (targetType === "entity") {
      const rows = await this.prisma.$queryRaw<{ postId: string }[]>(Prisma.sql`
        SELECT p.id AS "postId"
        FROM relationships r
        JOIN post_subjects ps ON ps.entity_id = r.target_id
        JOIN posts p ON p.id = ps.post_id
        WHERE r.user_id = ${userId}
          AND r.target_type = 'entity'
          AND r.target_id = ${targetId}
          AND r.tenant_id = ${tenantId}
          AND p.tenant_id = ${tenantId}
          AND p.deleted_at IS NULL
          AND p.created_at > ${since}
          ${audience}
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
        AND r.tenant_id = ${tenantId}
        AND p.tenant_id = ${tenantId}
        AND p.deleted_at IS NULL
        AND p.created_at > ${since}
        ${audience}
      ORDER BY p.created_at DESC
      LIMIT ${limit}
    `);
    return rows.map((row) => row.postId);
  }

  // -------------------------------------------------------------------------
  // getCircleStatus
  // -------------------------------------------------------------------------

  async getCircleStatus(
    userId: string,
    activeTenantId: string,
  ): Promise<CircleTierStatus[]> {
    const tenantId = this.requireTenant("getCircleStatus", activeTenantId);
    const thresholds = await this.loadThresholds(userId);
    const readStates = await this.loadReadStates(userId);
    const audience = authorAudienceSql(userId, tenantId);
    const tiers: CircleTier[] = [0, 1, 2, 3];
    // Never-read tiers used to count from the epoch (all history). Floor the
    // window at now − CIRCLE_STATUS_WINDOW_DAYS; a fresher read watermark
    // still wins (identical rows whenever lastReadAt is inside the window).
    const windowFloor = new Date(
      Date.now() - CIRCLE_STATUS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    // Four parallel per-tier count queries. The old single-query OR-join
    // (posts joined on "subject-entity EXISTS … OR author") forced a
    // join-filter scan of every candidate post per relationship row. Rewritten
    // as a UNION of the two independently-indexable branches (entity-subject
    // path via post_subjects(entity_id), author path via
    // posts(author_id, created_at)); UNION dedupes across branches exactly
    // like COUNT(DISTINCT) did, and the LIMIT caps enumeration at
    // CIRCLE_STATUS_UNSEEN_CAP (client renders "99+").
    //
    // H1: a COUNT is a disclosure too — an unseen badge that ticks up reveals
    // that a WHISPER post exists. Both branches carry the same audience rule as
    // `getVisiblePostIds`, and must keep carrying the SAME one: a badge that
    // counts posts the feed then refuses to show is a bug in the harmless
    // direction, and a badge counting posts the feed correctly hides is a leak.
    return Promise.all(
      tiers.map(async (tier) => {
        const bounds = getCircleTierBounds(tier, thresholds);
        const upper = bounds.upper === Infinity ? 1e9 : bounds.upper;
        const readAt = readStates[tier];
        const since = readAt && readAt > windowFloor ? readAt : windowFloor;

        const rows = await this.prisma.$queryRaw<{ unseenCount: bigint }[]>(
          Prisma.sql`
          SELECT COUNT(*) AS "unseenCount" FROM (
            SELECT p.id
            FROM relationships r
            JOIN post_subjects ps ON ps.entity_id = r.target_id
            JOIN posts p ON p.id = ps.post_id
            WHERE r.user_id = ${userId}
              AND r.target_type = 'entity'
              AND r.tenant_id = ${tenantId}
              AND p.tenant_id = ${tenantId}
              AND ${EFFECTIVE_SCORE_SQL} >= ${bounds.lower}
              AND ${EFFECTIVE_SCORE_SQL} < ${upper}
              AND p.deleted_at IS NULL
              AND ${RADIUS_INT_SQL} >= ${tier}
              AND p.created_at > ${since}
              ${audience}
            UNION
            SELECT p.id
            FROM relationships r
            JOIN posts p ON p.author_id = r.user_id
            WHERE r.target_id = ${userId}
              AND r.target_type = 'user'
              AND r.reciprocated
              AND r.tier = ${tier}
              AND r.tenant_id = ${tenantId}
              AND p.tenant_id = ${tenantId}
              AND p.deleted_at IS NULL
              AND ${RADIUS_INT_SQL} >= ${tier}
              AND p.created_at > ${since}
            LIMIT ${CIRCLE_STATUS_UNSEEN_CAP}
          ) unseen
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
    activeTenantId: string,
  ): Promise<CircleEntityStatus[]> {
    const tenantId = this.requireTenant("getCircleEntityStatus", activeTenantId);
    const thresholds = await this.loadThresholds(userId);
    const readStates = await this.loadReadStates(userId);
    const bounds = getCircleTierBounds(tier, thresholds);
    const upper = bounds.upper === Infinity ? 1e9 : bounds.upper;
    const lastReadAt = readStates[tier] ?? new Date(0);
    const audience = authorAudienceSql(userId, tenantId);

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
        AND p.tenant_id = ${tenantId}
        ${audience}
      WHERE r.user_id = ${userId}
        AND r.target_type = 'entity'
        AND r.tenant_id = ${tenantId}
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
