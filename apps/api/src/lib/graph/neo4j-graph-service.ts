/**
 * Neo4j GraphService Implementation
 *
 * Implements the GraphService interface using the Neo4j JavaScript driver.
 * Used for local development and the AuraDB production/dev instances —
 * same Cypher dialect.
 *
 * Connection management, schema initialization, and health checks are fully
 * implemented. Business methods are stubbed (Phase 2).
 *
 * SECURITY: All queries use parameterized queries ($paramName) — never
 * string concatenation.
 *
 * @see /analysis/redesign/07-graph-database/04-graph-schema.md
 */

import neo4j, {
  type AuthToken,
  type AuthTokenManager,
  type Driver,
  type QueryResult,
  type Session,
} from "neo4j-driver";
import { createNeptuneAuthTokenManager, parseBoltEndpoint } from "./neptune-auth.js";

import type { GraphConnection, GraphService } from "./graph-service.js";
import {
  GraphConnectionError,
  GraphNotFoundError,
  GraphQueryError,
} from "./errors.js";
import { initGraphSchema } from "./graph-schema-init.js";
import { CONNECTION_BONUSES, scoreToTier, TIER_THRESHOLDS } from "./scoring-engine.js";
import type {
  CircleEntityStatus,
  CircleMember,
  CircleTier,
  CircleTierStatus,
  ConnectionMethod,
  CreateEntityRelationshipInput,
  CreateRelationshipInput,
  DiscoveryFilters,
  DiscoveryResult,
  EntityRelationship,
  EntityRelationshipStatus,
  GlanceItem,
  GraphConnectionConfig,
  GraphData,
  GraphHealthStatus,
  GraphNodeType,
  NearbyFilters,
  PaginatedResult,
  PaginationInput,
  PostRadius,
  Recommendation,
  RecordInteractionInput,
  Relationship,
  ScoreUpdate,
  SyncEntityInput,
  SyncOwnershipInput,
  SyncPostInput,
  SyncPostSubjectsInput,
  SyncUserInput,
  UpdateRelationshipScoreInput,
  VisiblePostResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Post-radius → integer rank persisted as `Post.radiusInt`. A post is visible
 * at circle tier T when `radiusInt >= T` (see circle-queries.md). Kept in sync
 * with the `PostRadius` union; read queries depend on this exact mapping.
 */
const RADIUS_TO_INT: Record<PostRadius, number> = {
  WHISPER: 0,
  NORMAL: 1,
  LOUD: 2,
  SHOUT: 3,
};

export class Neo4jGraphService implements GraphService, GraphConnection {
  private driver: Driver | null = null;
  private connected = false;
  private schemaInitialized = false;

  // =========================================================================
  // Connection Management (GraphConnection)
  // =========================================================================

  async connect(config: GraphConnectionConfig): Promise<void> {
    if (this.connected && this.driver) {
      return; // Idempotent
    }

    try {
      // Resolve authentication
      let auth: AuthToken | AuthTokenManager | undefined;
      // Neptune speaks bolt:// (no +s scheme), so TLS is enabled via config and
      // trusts the system CA (Amazon-issued cert). Left empty for Neo4j/AuraDB,
      // which carry TLS in the URI scheme (neo4j+s:// / bolt+s://).
      const tlsConfig: { encrypted?: "ENCRYPTION_ON"; trust?: "TRUST_SYSTEM_CA_SIGNED_CERTIFICATES" } = {};
      if (config.auth.type === "basic") {
        auth = neo4j.auth.basic(config.auth.username, config.auth.password);
      } else if (config.auth.type === "iam") {
        // Neptune IAM: a SigV4 auth-token manager that re-signs before the
        // ~5-minute signature expiry (see neptune-auth.ts).
        const { host, port } = parseBoltEndpoint(config.endpoint);
        auth = createNeptuneAuthTokenManager({ host, port, region: config.auth.region });
        tlsConfig.encrypted = "ENCRYPTION_ON";
        tlsConfig.trust = "TRUST_SYSTEM_CA_SIGNED_CERTIFICATES";
      }
      // "none" auth type: no auth object passed to driver

      // Create driver with pool configuration
      this.driver = neo4j.driver(config.endpoint, auth, {
        maxConnectionPoolSize: config.pool?.maxConnectionPoolSize ?? 100,
        connectionAcquisitionTimeout: config.pool?.connectionAcquisitionTimeout ?? 60_000,
        maxConnectionLifetime: config.pool?.maxConnectionLifetime ?? 3_600_000,
        ...(config.pool?.connectionLivenessCheckTimeout !== undefined && {
          connectionLivenessCheckTimeout: config.pool.connectionLivenessCheckTimeout,
        }),
        ...tlsConfig,
        disableLosslessIntegers: true, // Return native JS numbers instead of Neo4j Integer
      });

      // Verify connectivity
      await this.driver.verifyConnectivity();
      this.connected = true;

      // Initialize schema (constraints + indexes) on first connect
      if (!this.schemaInitialized) {
        await this.initializeSchema();
      }
    } catch (error) {
      this.connected = false;
      this.driver = null;
      throw new GraphConnectionError(
        `Failed to connect to Neo4j at ${config.endpoint}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // =========================================================================
  // Health Check
  // =========================================================================

  async healthCheck(): Promise<GraphHealthStatus> {
    if (!this.driver || !this.connected) {
      return {
        healthy: false,
        latencyMs: 0,
        error: "Not connected",
        backend: "neo4j",
      };
    }

    const session = this.driver.session();
    const start = Date.now();

    try {
      await session.run("RETURN 1 AS health");
      const latencyMs = Date.now() - start;

      return {
        healthy: true,
        latencyMs,
        backend: "neo4j",
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      this.connected = false;

      return {
        healthy: false,
        latencyMs,
        error: error instanceof Error ? error.message : String(error),
        backend: "neo4j",
      };
    } finally {
      await session.close();
    }
  }

  // =========================================================================
  // Relationships
  // =========================================================================

  async createRelationship(input: CreateRelationshipInput): Promise<Relationship> {
    const { userId, targetType, targetId, connectionMethod = "discovery" } = input;

    // Initial score by connection method (from scoring engine constants)
    const initialScore = CONNECTION_BONUSES[connectionMethod] ?? 0.3;
    const tier = scoreToTier(initialScore);
    const now = new Date().toISOString();

    // Target label is capitalized: "user" -> "User", "entity" -> "Entity"
    const targetLabel = targetType === "user" ? "User" : "Entity";

    // MERGE the relationship (idempotent on the edge; we want conflict detection so
    // we use MATCH first and fail if it already exists, then CREATE).
    // We verify the target node exists, then create the edge.
    const result = await this.executeQuery(
      `
      MATCH (src:User {id: $userId})
      MATCH (tgt:${targetLabel} {id: $targetId})
      MERGE (src)-[r:RELATES_TO]->(tgt)
      ON CREATE SET
        r.computedScore      = $initialScore,
        r.manualScore        = null,
        r.score              = $initialScore,
        r.tier               = $tier,
        r.interactionCount   = 0,
        r.lastInteractionAt  = null,
        r.connectionMethod   = $connectionMethod,
        r.reciprocated       = false,
        r.createdAt          = $now
      ON MATCH SET
        r._alreadyExisted = true
      WITH src, tgt, r
      // Handle reciprocity for user->user edges
      OPTIONAL MATCH (tgt)-[rev:RELATES_TO]->(src)
      WITH r, rev, (tgt:User) AS isUserTarget
      SET r.reciprocated = (isUserTarget AND rev IS NOT NULL)
      WITH r, rev, isUserTarget
      // Mark the reverse edge reciprocated for user→user. SET on a null rev (no
      // reverse edge) is a no-op, so no FOREACH/subquery guard is needed — Neptune
      // supports neither (graph-db-neptune-serverless audit F5).
      SET rev.reciprocated = CASE WHEN isUserTarget AND rev IS NOT NULL THEN true ELSE rev.reciprocated END
      RETURN r
      `,
      { userId, targetId, initialScore, tier, connectionMethod, now },
    );

    if (result.records.length === 0) {
      throw new GraphNotFoundError(
        `Source user ${userId} or target ${targetType} ${targetId} not found in graph`,
      );
    }

    const rel = result.records[0].get("r").properties;
    return recordToRelationship(rel, userId, targetType, targetId);
  }

  async removeRelationship(
    userId: string,
    targetType: GraphNodeType,
    targetId: string,
  ): Promise<void> {
    const targetLabel = targetType === "user" ? "User" : "Entity";

    const result = await this.executeQuery(
      `
      OPTIONAL MATCH (src:User {id: $userId})-[r:RELATES_TO]->(tgt:${targetLabel} {id: $targetId})
      WITH r, src, tgt, (tgt:User) AS isUserTarget, (r IS NOT NULL) AS found
      // If reciprocated user-user edge, clear the reverse reciprocated flag
      OPTIONAL MATCH (tgt)-[rev:RELATES_TO]->(src)
      WITH r, rev, isUserTarget, found
      // Clear the reverse reciprocated flag (SET on a null rev is a no-op).
      SET rev.reciprocated = CASE WHEN isUserTarget AND rev IS NOT NULL THEN false ELSE rev.reciprocated END
      WITH r, found
      // DELETE on a null r (edge not found) is a no-op — no FOREACH guard needed.
      DELETE r
      RETURN found
      `,
      { userId, targetId },
    );

    // If no relationship was matched and deleted, throw not found
    const found = result.records[0]?.get("found") ?? false;
    if (!found) {
      throw new GraphNotFoundError(
        `Relationship from user ${userId} to ${targetType} ${targetId} not found`,
        "relationship",
        `${userId}->${targetId}`,
      );
    }
  }

  async updateRelationshipScore(
    input: UpdateRelationshipScoreInput,
  ): Promise<Relationship> {
    const { userId, targetType, targetId, manualScore } = input;
    const targetLabel = targetType === "user" ? "User" : "Entity";

    const result = await this.executeQuery(
      `
      MATCH (src:User {id: $userId})-[r:RELATES_TO]->(tgt:${targetLabel} {id: $targetId})
      SET r.manualScore = $manualScore,
          r.score       = CASE WHEN $manualScore IS NOT NULL THEN $manualScore ELSE r.computedScore END
      RETURN r
      `,
      {
        userId,
        targetId,
        manualScore: manualScore ?? null,
      },
    );

    if (result.records.length === 0) {
      throw new GraphNotFoundError(
        `Relationship from user ${userId} to ${targetType} ${targetId} not found`,
        "relationship",
        `${userId}->${targetId}`,
      );
    }

    // The query updates r.score in the DB; derive tier from the effective score.
    const rel = result.records[0].get("r").properties;
    const effectiveScore = typeof rel.score === "number" ? rel.score : 0;
    rel.tier = scoreToTier(effectiveScore);

    return recordToRelationship(rel, userId, targetType, targetId);
  }

  async getRelationship(
    userId: string,
    targetType: GraphNodeType,
    targetId: string,
  ): Promise<Relationship | null> {
    const targetLabel = targetType === "user" ? "User" : "Entity";

    const result = await this.executeQuery(
      `
      MATCH (src:User {id: $userId})-[r:RELATES_TO]->(tgt:${targetLabel} {id: $targetId})
      RETURN r
      `,
      { userId, targetId },
    );

    if (result.records.length === 0) {
      return null;
    }

    const rel = result.records[0].get("r").properties;
    return recordToRelationship(rel, userId, targetType, targetId);
  }

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

    // Build tier filter
    const tierFilter = options?.tier !== undefined ? "AND r.tier = $tier" : "";

    // Build target label constraint
    let targetMatch = "(tgt)";
    if (options?.targetType === "user") {
      targetMatch = "(tgt:User)";
    } else if (options?.targetType === "entity") {
      targetMatch = "(tgt:Entity)";
    }

    // Cursor encodes the score of the last item (score-based cursor pagination)
    const cursorScore = cursor !== null ? decodeCursor(cursor) : null;
    const cursorFilter =
      cursorScore !== null ? "AND r.score < $cursorScore" : "";

    const result = await this.executeQuery(
      `
      MATCH (src:User {id: $userId})-[r:RELATES_TO]->${targetMatch}
      WHERE 1=1 ${tierFilter} ${cursorFilter}
      RETURN r, tgt.id AS targetId,
             CASE WHEN tgt:User THEN 'user' ELSE 'entity' END AS targetType
      ORDER BY r.score DESC
      LIMIT $fetchLimit
      `,
      {
        userId,
        tier: options?.tier ?? null,
        cursorScore: cursorScore ?? null,
        fetchLimit: neo4j.int(limit + 1), // fetch one extra to detect hasMore (int for Neptune LIMIT)
      },
    );

    const records = result.records;
    const hasMore = records.length > limit;
    const items = (hasMore ? records.slice(0, limit) : records).map((rec) => {
      const rel = rec.get("r").properties;
      const tId = rec.get("targetId") as string;
      const tType = rec.get("targetType") as GraphNodeType;
      return recordToRelationship(rel, userId, tType, tId);
    });

    const lastItem = items[items.length - 1];
    const nextCursor =
      hasMore && lastItem ? encodeCursor(lastItem.score) : null;

    return { items, cursor: nextCursor, hasMore };
  }

  async getRelationshipGraph(userId: string): Promise<GraphData> {
    const result = await this.executeQuery(
      `
      MATCH (viewer:User {id: $userId})-[r:RELATES_TO]->(tgt)
      RETURN tgt.id AS targetId,
             CASE WHEN tgt:User THEN 'user' ELSE 'entity' END AS targetType,
             tgt.name AS name,
             r.score AS score,
             r.tier AS tier
      ORDER BY r.score DESC
      `,
      { userId },
    );

    const nodes = result.records.map((rec) => {
      const rawScore = rec.get("score") as number;
      const tier = rec.get("tier") as CircleTier;
      return {
        id: rec.get("targetId") as string,
        type: rec.get("targetType") as GraphNodeType,
        name: (rec.get("name") as string | null) ?? "",
        // Coarsen to nearest 10 (0-100), no raw score exposed
        closeness: Math.round(rawScore * 10) * 10,
        tier,
      };
    });

    // Build tier summaries
    const counts = { inner: 0, closeFriends: 0, community: 0, ambient: 0 };
    for (const node of nodes) {
      const tierName = tierToName(node.tier);
      counts[tierName]++;
    }

    // Use canonical thresholds from the scoring engine
    const thresholdFor = (tier: 0 | 1 | 2 | 3): number =>
      TIER_THRESHOLDS.find((t) => t.tier === tier)?.minScore ?? 0;

    const tiers = {
      inner: { threshold: thresholdFor(0), count: counts.inner },
      closeFriends: { threshold: thresholdFor(1), count: counts.closeFriends },
      community: { threshold: thresholdFor(2), count: counts.community },
      ambient: { threshold: thresholdFor(3), count: counts.ambient },
    };

    return { nodes, tiers };
  }

  // =========================================================================
  // Circles (Stubbed — Phase 2)
  // =========================================================================

  // --- Circle Resolution helpers (P2.2) ---

  /** Default circle config thresholds from circle-queries.md. */
  static readonly CIRCLE_THRESHOLDS = {
    innerThreshold: 0.8,
    closeFriendThreshold: 0.5,
    communityThreshold: 0.2,
  };

  private static readonly TIER_NAMES: Record<
    CircleTier,
    import("./types.js").TierName
  > = { 0: "inner", 1: "closeFriends", 2: "community", 3: "ambient" };

  /** Score threshold bounds for a tier (from circle-queries.md). */
  getCircleTierBounds(
    tier: CircleTier,
    thresholds = Neo4jGraphService.CIRCLE_THRESHOLDS,
  ): { lower: number; upper: number } {
    switch (tier) {
      case 0: return { lower: thresholds.innerThreshold, upper: Infinity };
      case 1: return { lower: thresholds.closeFriendThreshold, upper: thresholds.innerThreshold };
      case 2: return { lower: thresholds.communityThreshold, upper: thresholds.closeFriendThreshold };
      case 3: return { lower: 0.001, upper: thresholds.communityThreshold };
    }
  }

  private decodeCircleCursor(cursor?: string): { createdAt: string; postId: string } | null {
    if (!cursor) return null;
    try {
      const d = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
      if (d.createdAt && d.postId) return d;
      return null;
    } catch { return null; }
  }

  encodeCircleCursor(createdAt: string, postId: string): string {
    return Buffer.from(JSON.stringify({ createdAt, postId })).toString("base64");
  }

  // --- Circle Resolution methods (P2.2) ---

  async getCircleMembers(userId: string, tier: CircleTier): Promise<CircleMember[]> {
    const bounds = this.getCircleTierBounds(tier);
    const result = await this.executeQuery(
      `MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(target)
       WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold
       RETURN target.id AS id, labels(target)[0] AS type, target.name AS name, r.score AS score
       ORDER BY r.score DESC`,
      { viewerId: userId, lowerThreshold: bounds.lower, upperThreshold: bounds.upper === Infinity ? 1e9 : bounds.upper },
    );
    return result.records.map((rec) => ({
      id: rec.get("id") as string,
      type: (rec.get("type") as string).toLowerCase() === "entity" ? ("entity" as const) : ("user" as const),
      name: rec.get("name") as string,
      score: rec.get("score") as number,
      tier,
    }));
  }

  async getVisiblePostIds(
    userId: string, tier: CircleTier, since: Date, pagination: PaginationInput,
  ): Promise<PaginatedResult<VisiblePostResult>> {
    const bounds = this.getCircleTierBounds(tier);
    const t = Neo4jGraphService.CIRCLE_THRESHOLDS;
    const cursor = this.decodeCircleCursor(pagination.cursor ?? undefined);
    const cursorClause = cursor
      ? `AND (post.createdAt < datetime($cursorCreatedAt) OR (post.createdAt = datetime($cursorCreatedAt) AND post.id < $cursorPostId))`
      : "";

    // Neptune does not support CALL{} subqueries (audit F4), which the prior
    // implementation used to apply a single ORDER BY/LIMIT across the
    // entity-branch ∪ author-branch UNION. Instead, run the two branches as
    // separate queries — each ordered + limited to (limit+1) by (createdAt,id)
    // — and merge app-side. The global top-(limit+1) is always a subset of the
    // union of the per-branch top-(limit+1), so merge → re-sort → truncate is
    // exact. Posts visible via both branches are deduped, keeping the closest
    // (min) resolved tier.
    const tierExpr =
      `MIN(CASE WHEN relScore >= $innerThreshold THEN 0 WHEN relScore >= $closeFriendThreshold THEN 1 WHEN relScore >= $communityThreshold THEN 2 ELSE 3 END)`;
    const entityQuery = `
      MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(entity:Entity)
      WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold
      WITH entity, r.score AS relScore
      MATCH (post:Post)-[:ABOUT]->(entity)
      WHERE post.createdAt > datetime($since) AND post.radiusInt >= $tierInt ${cursorClause}
      WITH post, ${tierExpr} AS resolvedTier
      RETURN post.id AS postId, toString(post.createdAt) AS createdAt, resolvedTier
      ORDER BY post.createdAt DESC, post.id DESC
      LIMIT $limit`;
    const authorQuery = `
      MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(author:User)
      WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold
      WITH author, r.score AS relScore
      MATCH (post:Post)
      WHERE post.authorId = author.id AND post.createdAt > datetime($since) AND post.radiusInt >= $tierInt ${cursorClause}
      WITH post, ${tierExpr} AS resolvedTier
      RETURN post.id AS postId, toString(post.createdAt) AS createdAt, resolvedTier
      ORDER BY post.createdAt DESC, post.id DESC
      LIMIT $limit`;

    const params: Record<string, unknown> = {
      viewerId: userId, lowerThreshold: bounds.lower,
      upperThreshold: bounds.upper === Infinity ? 1e9 : bounds.upper,
      since: since.toISOString(), tierInt: tier,
      innerThreshold: t.innerThreshold, closeFriendThreshold: t.closeFriendThreshold,
      communityThreshold: t.communityThreshold, limit: neo4j.int(pagination.limit + 1),
    };
    if (cursor) { params.cursorCreatedAt = cursor.createdAt; params.cursorPostId = cursor.postId; }

    const [entityRes, authorRes] = await Promise.all([
      this.executeQuery(entityQuery, params),
      this.executeQuery(authorQuery, params),
    ]);

    // Merge + dedupe by postId (keep the closest/min resolved tier).
    const byId = new Map<string, VisiblePostResult>();
    for (const rec of [...entityRes.records, ...authorRes.records]) {
      const postId = rec.get("postId") as string;
      const ca = rec.get("createdAt");
      const createdAt = ca instanceof Date ? ca : new Date(String(ca));
      const resolvedTier = rec.get("resolvedTier") as CircleTier;
      const existing = byId.get(postId);
      if (!existing || resolvedTier < existing.resolvedTier) {
        byId.set(postId, { postId, createdAt, resolvedTier });
      }
    }
    // Sort createdAt DESC, then postId DESC — matches the cursor's tiebreak.
    const merged = Array.from(byId.values()).sort((a, b) => {
      const d = b.createdAt.getTime() - a.createdAt.getTime();
      if (d !== 0) return d;
      return a.postId < b.postId ? 1 : a.postId > b.postId ? -1 : 0;
    });

    const items = merged.slice(0, pagination.limit);
    const hasMore = merged.length > pagination.limit;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? this.encodeCircleCursor(last.createdAt.toISOString(), last.postId) : null;
    return { items, cursor: nextCursor, hasMore };
  }

  async getGlanceItems(userId: string, tier: CircleTier, limit: number): Promise<GlanceItem[]> {
    const bounds = this.getCircleTierBounds(tier);
    // Step 1: get tier members
    const membersResult = await this.executeQuery(
      `MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(target)
       WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold
       RETURN target.id AS targetId, labels(target)[0] AS targetType, target.name AS targetName, r.score AS score
       ORDER BY r.score DESC`,
      { viewerId: userId, lowerThreshold: bounds.lower, upperThreshold: bounds.upper === Infinity ? 1e9 : bounds.upper },
    );

    const entityIds: string[] = [];
    const userIds: string[] = [];
    const memberMap = new Map<string, { targetType: "entity" | "user"; targetName: string }>();
    for (const rec of membersResult.records) {
      const tid = rec.get("targetId") as string;
      const rawType = (rec.get("targetType") as string).toLowerCase();
      const tt = rawType === "entity" ? ("entity" as const) : ("user" as const);
      memberMap.set(tid, { targetType: tt, targetName: rec.get("targetName") as string });
      if (tt === "entity") entityIds.push(tid); else userIds.push(tid);
    }

    const glanceItems: GlanceItem[] = [];

    // Step 2a: entity posts
    if (entityIds.length > 0) {
      const er = await this.executeQuery(
        `UNWIND $entityIds AS entityId
         MATCH (entity:Entity {id: entityId})<-[:ABOUT]-(post:Post)
         WHERE post.radiusInt >= $tierInt
         WITH entityId, post ORDER BY post.createdAt DESC
         WITH entityId, COLLECT(post)[0] AS latestPost
         WHERE latestPost IS NOT NULL
         RETURN entityId AS targetId, latestPost.id AS postId, latestPost.createdAt AS postCreatedAt`,
        { entityIds, tierInt: tier },
      );
      for (const rec of er.records) {
        const tid = rec.get("targetId") as string;
        const m = memberMap.get(tid); if (!m) continue;
        const pca = rec.get("postCreatedAt");
        glanceItems.push({ targetId: tid, targetType: "entity", targetName: m.targetName, postId: rec.get("postId") as string, postCreatedAt: pca instanceof Date ? pca : new Date(String(pca)) });
      }
    }

    // Step 2b: user posts
    if (userIds.length > 0) {
      const ur = await this.executeQuery(
        `UNWIND $userIds AS uId
         MATCH (post:Post) WHERE post.authorId = uId AND post.radiusInt >= $tierInt
         WITH uId, post ORDER BY post.createdAt DESC
         With uId, COLLECT(post)[0] AS latestPost
         WHERE latestPost IS NOT NULL
         RETURN uId AS targetId, latestPost.id AS postId, latestPost.createdAt AS postCreatedAt`,
        { userIds, tierInt: tier },
      );
      for (const rec of ur.records) {
        const tid = rec.get("targetId") as string;
        const m = memberMap.get(tid); if (!m) continue;
        const pca = rec.get("postCreatedAt");
        glanceItems.push({ targetId: tid, targetType: "user", targetName: m.targetName, postId: rec.get("postId") as string, postCreatedAt: pca instanceof Date ? pca : new Date(String(pca)) });
      }
    }

    glanceItems.sort((a, b) => b.postCreatedAt.getTime() - a.postCreatedAt.getTime());
    return glanceItems.slice(0, limit);
  }

  async getDepthPostIds(
    userId: string, targetType: GraphNodeType, targetId: string, since: Date, limit: number,
  ): Promise<string[]> {
    const t = Neo4jGraphService.CIRCLE_THRESHOLDS;
    const commonParams = {
      viewerId: userId, targetId, since: since.toISOString(),
      innerThreshold: t.innerThreshold, closeFriendThreshold: t.closeFriendThreshold,
      communityThreshold: t.communityThreshold, limit: neo4j.int(limit),
    };

    if (targetType === "entity") {
      const result = await this.executeQuery(
        `MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(entity:Entity {id: $targetId})
         MATCH (post:Post)-[:ABOUT]->(entity)
         WHERE post.createdAt > datetime($since)
           AND post.radiusInt >= CASE WHEN r.score >= $innerThreshold THEN 0 WHEN r.score >= $closeFriendThreshold THEN 1 WHEN r.score >= $communityThreshold THEN 2 ELSE 3 END
         RETURN post.id AS postId ORDER BY post.createdAt DESC LIMIT $limit`,
        commonParams,
      );
      return result.records.map((r) => r.get("postId") as string);
    }

    const result = await this.executeQuery(
      `MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(author:User {id: $targetId})
       MATCH (post:Post)
       WHERE post.authorId = author.id AND post.createdAt > datetime($since)
         AND post.radiusInt >= CASE WHEN r.score >= $innerThreshold THEN 0 WHEN r.score >= $closeFriendThreshold THEN 1 WHEN r.score >= $communityThreshold THEN 2 ELSE 3 END
       RETURN post.id AS postId ORDER BY post.createdAt DESC LIMIT $limit`,
      commonParams,
    );
    return result.records.map((r) => r.get("postId") as string);
  }

  /**
   * Get circle status for all tiers. Uses four parallel count queries
   * (recommended by circle-queries.md). lastReadTimestamps come from
   * Postgres CircleReadState.
   */
  async getCircleStatus(
    userId: string, lastReadTimestamps?: Record<CircleTier, Date | null>,
  ): Promise<CircleTierStatus[]> {
    const thresholds = Neo4jGraphService.CIRCLE_THRESHOLDS;
    const defaultLR = new Date(0);
    const lr: Record<CircleTier, Date> = {
      0: lastReadTimestamps?.[0] ?? defaultLR, 1: lastReadTimestamps?.[1] ?? defaultLR,
      2: lastReadTimestamps?.[2] ?? defaultLR, 3: lastReadTimestamps?.[3] ?? defaultLR,
    };

    const tiers: CircleTier[] = [0, 1, 2, 3];
    return Promise.all(tiers.map(async (tier) => {
      const bounds = this.getCircleTierBounds(tier, thresholds);
      const result = await this.executeQuery(
        `MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(target)
         WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold
         MATCH (post:Post)
         WHERE ((target:Entity AND (post)-[:ABOUT]->(target)) OR (target:User AND post.authorId = target.id))
           AND post.radiusInt >= $tierInt AND post.createdAt > datetime($lastReadAt)
         RETURN COUNT(DISTINCT post.id) AS unseenCount`,
        { viewerId: userId, lowerThreshold: bounds.lower, upperThreshold: bounds.upper === Infinity ? 1e9 : bounds.upper, tierInt: tier, lastReadAt: lr[tier].toISOString() },
      );
      const unseenCount = result.records.length > 0 ? (result.records[0].get("unseenCount") as number) : 0;
      return { tier, name: Neo4jGraphService.TIER_NAMES[tier], caughtUp: unseenCount === 0, unseenCount, lastReadAt: lastReadTimestamps?.[tier] ?? null } satisfies CircleTierStatus;
    }));
  }

  /**
   * Get per-entity unseen counts within a tier. Uses circle-queries.md Query 5.
   * lastReadAt comes from Postgres CircleReadState.
   */
  async getCircleEntityStatus(
    userId: string, tier: CircleTier, lastReadAt?: Date,
  ): Promise<CircleEntityStatus[]> {
    const bounds = this.getCircleTierBounds(tier);
    const effectiveLR = lastReadAt ?? new Date(0);
    const result = await this.executeQuery(
      `MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(entity:Entity)
       WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold
       OPTIONAL MATCH (post:Post)-[:ABOUT]->(entity)
       WHERE post.radiusInt >= $tierInt AND post.createdAt > datetime($lastReadAt)
       WITH entity, COUNT(post) AS unseenCount, MAX(post.createdAt) AS latestPostAt
       RETURN entity.id AS entityId, entity.name AS entityName, unseenCount = 0 AS caughtUp, unseenCount, latestPostAt
       ORDER BY unseenCount DESC, latestPostAt DESC`,
      { viewerId: userId, lowerThreshold: bounds.lower, upperThreshold: bounds.upper === Infinity ? 1e9 : bounds.upper, tierInt: tier, lastReadAt: effectiveLR.toISOString() },
    );
    return result.records.map((rec) => {
      const lpa = rec.get("latestPostAt");
      return {
        entityId: rec.get("entityId") as string, entityName: rec.get("entityName") as string,
        caughtUp: rec.get("caughtUp") as boolean, unseenCount: rec.get("unseenCount") as number,
        latestPostAt: lpa ? (lpa instanceof Date ? lpa : new Date(String(lpa))) : null,
      };
    });
  }

  /**
   * Mark a circle tier as read. The canonical read state lives in Postgres
   * (CircleReadState). This stores it on the User node as graph-side fallback.
   */
  async markCircleRead(userId: string, tier: CircleTier, readAt?: Date): Promise<void> {
    const timestamp = readAt ?? new Date();
    const prop = `lastReadTier${tier}`;
    await this.executeQuery(
      `MATCH (u:User {id: $userId}) SET u.${prop} = datetime($readAt)`,
      { userId, readAt: timestamp.toISOString() },
    );
  }

  // =========================================================================
  // Entity Relationships
  // =========================================================================

  async createEntityRelationship(
    input: CreateEntityRelationshipInput,
  ): Promise<EntityRelationship> {
    const { entityId, relatedEntityId, type, proposedByUserId } = input;

    // 1. Verify proposing user owns the source entity
    const ownershipCheck = await this.executeQuery(
      `MATCH (u:User {id: $userId})-[o:OWNS]->(e:Entity {id: $entityId})
       RETURN o.role AS role`,
      { userId: proposedByUserId, entityId },
    );

    if (ownershipCheck.records.length === 0) {
      const { GraphAuthorizationError } = await import("./errors.js");
      throw new GraphAuthorizationError(
        `User ${proposedByUserId} does not own entity ${entityId}`,
      );
    }

    // 2. Verify both entity nodes exist
    const entityCheck = await this.executeQuery(
      `MATCH (a:Entity {id: $entityId})
       MATCH (b:Entity {id: $relatedEntityId})
       RETURN a.id AS aId, b.id AS bId`,
      { entityId, relatedEntityId },
    );

    if (entityCheck.records.length === 0) {
      const { GraphNotFoundError } = await import("./errors.js");
      throw new GraphNotFoundError(
        `One or both entities not found: ${entityId}, ${relatedEntityId}`,
      );
    }

    // 3. Check for existing relationship of this type
    const existingCheck = await this.executeQuery(
      `MATCH (a:Entity {id: $entityId})-[r:ENTITY_RELATES {type: $type}]->(b:Entity {id: $relatedEntityId})
       RETURN r.status AS status`,
      { entityId, relatedEntityId, type },
    );

    if (existingCheck.records.length > 0) {
      const { GraphConflictError } = await import("./errors.js");
      throw new GraphConflictError(
        `Entity relationship of type ${type} already exists between ${entityId} and ${relatedEntityId}`,
      );
    }

    // 4. Determine if auto-confirm applies.
    // PACK_MATE between entities where a single user holds PRIMARY_OWNER or CO_OWNER
    // on BOTH entities auto-confirms. CARETAKER is excluded per security rules.
    let status: EntityRelationshipStatus = "PENDING";

    if (type === "PACK_MATE") {
      const sharedOwnerCheck = await this.executeQuery(
        `MATCH (u:User)-[o1:OWNS]->(a:Entity {id: $entityId})
         MATCH (u)-[o2:OWNS]->(b:Entity {id: $relatedEntityId})
         WHERE o1.role IN ['PRIMARY_OWNER', 'CO_OWNER']
           AND o2.role IN ['PRIMARY_OWNER', 'CO_OWNER']
         RETURN u.id AS userId
         LIMIT 1`,
        { entityId, relatedEntityId },
      );

      if (sharedOwnerCheck.records.length > 0) {
        status = "CONFIRMED";
      }
    }

    const now = new Date();
    const since = now.toISOString();

    if (status === "CONFIRMED") {
      // Auto-confirmed PACK_MATE: create bidirectional edges immediately
      await this.executeQuery(
        `MATCH (a:Entity {id: $entityId}), (b:Entity {id: $relatedEntityId})
         CREATE (a)-[:ENTITY_RELATES {
           type: $type,
           status: 'CONFIRMED',
           proposedByUserId: $proposedByUserId,
           since: $since
         }]->(b)
         CREATE (b)-[:ENTITY_RELATES {
           type: $type,
           status: 'CONFIRMED',
           proposedByUserId: $proposedByUserId,
           since: $since
         }]->(a)`,
        { entityId, relatedEntityId, type, proposedByUserId, since },
      );
    } else {
      // Create single PENDING edge from source to target
      await this.executeQuery(
        `MATCH (a:Entity {id: $entityId}), (b:Entity {id: $relatedEntityId})
         CREATE (a)-[:ENTITY_RELATES {
           type: $type,
           status: 'PENDING',
           proposedByUserId: $proposedByUserId,
           since: $since
         }]->(b)`,
        { entityId, relatedEntityId, type, proposedByUserId, since },
      );
    }

    return {
      entityId,
      relatedEntityId,
      type,
      status,
      proposedByUserId,
      since: now,
    };
  }

  async confirmEntityRelationship(
    entityId: string,
    relatedEntityId: string,
    confirmingUserId: string,
  ): Promise<EntityRelationship> {
    // 1. Verify confirming user owns the target (related) entity
    const ownershipCheck = await this.executeQuery(
      `MATCH (u:User {id: $userId})-[o:OWNS]->(e:Entity {id: $relatedEntityId})
       RETURN o.role AS role`,
      { userId: confirmingUserId, relatedEntityId },
    );

    if (ownershipCheck.records.length === 0) {
      const { GraphAuthorizationError } = await import("./errors.js");
      throw new GraphAuthorizationError(
        `User ${confirmingUserId} does not own entity ${relatedEntityId}`,
      );
    }

    // 2. Find the pending relationship
    const relCheck = await this.executeQuery(
      `MATCH (a:Entity {id: $entityId})-[r:ENTITY_RELATES]->(b:Entity {id: $relatedEntityId})
       RETURN r.type AS type, r.status AS status, r.proposedByUserId AS proposedByUserId, r.since AS since`,
      { entityId, relatedEntityId },
    );

    if (relCheck.records.length === 0) {
      const { GraphNotFoundError } = await import("./errors.js");
      throw new GraphNotFoundError(
        `Entity relationship not found between ${entityId} and ${relatedEntityId}`,
      );
    }

    const record = relCheck.records[0];
    const currentStatus = record.get("status") as string;
    const relType = record.get("type") as string;
    const proposedByUserId = record.get("proposedByUserId") as string;
    const since = record.get("since") as string;

    if (currentStatus !== "PENDING") {
      const { GraphConflictError } = await import("./errors.js");
      throw new GraphConflictError(
        `Entity relationship is already ${currentStatus}`,
      );
    }

    // 3. Update the existing edge to CONFIRMED
    await this.executeQuery(
      `MATCH (a:Entity {id: $entityId})-[r:ENTITY_RELATES]->(b:Entity {id: $relatedEntityId})
       SET r.status = 'CONFIRMED'`,
      { entityId, relatedEntityId },
    );

    // 4. Create or confirm reciprocal edge based on relationship symmetry
    const SYMMETRIC_TYPES = new Set(["PACK_MATE", "SIBLING", "PLAYMATE", "WALK_BUDDY"]);
    const ASYMMETRIC_PAIRS: Record<string, string> = {
      PARENT: "OFFSPRING",
      OFFSPRING: "PARENT",
    };

    if (SYMMETRIC_TYPES.has(relType)) {
      // Symmetric: B→A edge gets the same type
      const reverseCheck = await this.executeQuery(
        `MATCH (b:Entity {id: $relatedEntityId})-[r:ENTITY_RELATES {type: $type}]->(a:Entity {id: $entityId})
         RETURN r.status AS status`,
        { entityId, relatedEntityId, type: relType },
      );

      if (reverseCheck.records.length === 0) {
        await this.executeQuery(
          `MATCH (a:Entity {id: $entityId}), (b:Entity {id: $relatedEntityId})
           CREATE (b)-[:ENTITY_RELATES {
             type: $type,
             status: 'CONFIRMED',
             proposedByUserId: $proposedByUserId,
             since: $since
           }]->(a)`,
          { entityId, relatedEntityId, type: relType, proposedByUserId, since },
        );
      } else {
        await this.executeQuery(
          `MATCH (b:Entity {id: $relatedEntityId})-[r:ENTITY_RELATES {type: $type}]->(a:Entity {id: $entityId})
           SET r.status = 'CONFIRMED'`,
          { entityId, relatedEntityId, type: relType },
        );
      }
    } else if (ASYMMETRIC_PAIRS[relType]) {
      // Asymmetric: B→A edge gets the complementary type (PARENT↔OFFSPRING)
      const inverseType = ASYMMETRIC_PAIRS[relType];
      const reverseCheck = await this.executeQuery(
        `MATCH (b:Entity {id: $relatedEntityId})-[r:ENTITY_RELATES {type: $inverseType}]->(a:Entity {id: $entityId})
         RETURN r.status AS status`,
        { entityId, relatedEntityId, inverseType },
      );

      if (reverseCheck.records.length === 0) {
        await this.executeQuery(
          `MATCH (a:Entity {id: $entityId}), (b:Entity {id: $relatedEntityId})
           CREATE (b)-[:ENTITY_RELATES {
             type: $inverseType,
             status: 'CONFIRMED',
             proposedByUserId: $proposedByUserId,
             since: $since
           }]->(a)`,
          { entityId, relatedEntityId, inverseType, proposedByUserId, since },
        );
      } else {
        await this.executeQuery(
          `MATCH (b:Entity {id: $relatedEntityId})-[r:ENTITY_RELATES {type: $inverseType}]->(a:Entity {id: $entityId})
           SET r.status = 'CONFIRMED'`,
          { entityId, relatedEntityId, inverseType },
        );
      }
    }

    return {
      entityId,
      relatedEntityId,
      type: relType as EntityRelationship["type"],
      status: "CONFIRMED",
      proposedByUserId,
      since: new Date(since),
    };
  }

  async rejectEntityRelationship(
    entityId: string,
    relatedEntityId: string,
    rejectingUserId: string,
  ): Promise<void> {
    // 1. Verify rejecting user owns the target (related) entity
    const ownershipCheck = await this.executeQuery(
      `MATCH (u:User {id: $userId})-[o:OWNS]->(e:Entity {id: $relatedEntityId})
       RETURN o.role AS role`,
      { userId: rejectingUserId, relatedEntityId },
    );

    if (ownershipCheck.records.length === 0) {
      const { GraphAuthorizationError } = await import("./errors.js");
      throw new GraphAuthorizationError(
        `User ${rejectingUserId} does not own entity ${relatedEntityId}`,
      );
    }

    // 2. Find the relationship
    const relCheck = await this.executeQuery(
      `MATCH (a:Entity {id: $entityId})-[r:ENTITY_RELATES]->(b:Entity {id: $relatedEntityId})
       RETURN r.status AS status`,
      { entityId, relatedEntityId },
    );

    if (relCheck.records.length === 0) {
      const { GraphNotFoundError } = await import("./errors.js");
      throw new GraphNotFoundError(
        `Entity relationship not found between ${entityId} and ${relatedEntityId}`,
      );
    }

    // 3. Set status to REJECTED
    await this.executeQuery(
      `MATCH (a:Entity {id: $entityId})-[r:ENTITY_RELATES]->(b:Entity {id: $relatedEntityId})
       SET r.status = 'REJECTED'`,
      { entityId, relatedEntityId },
    );
  }

  async removeEntityRelationship(
    entityId: string,
    relatedEntityId: string,
    removingUserId: string,
  ): Promise<void> {
    // 1. Verify removing user owns either entity
    const ownershipCheck = await this.executeQuery(
      `MATCH (u:User {id: $userId})-[o:OWNS]->(e:Entity)
       WHERE e.id = $entityId OR e.id = $relatedEntityId
       RETURN e.id AS ownedEntityId
       LIMIT 1`,
      { userId: removingUserId, entityId, relatedEntityId },
    );

    if (ownershipCheck.records.length === 0) {
      const { GraphAuthorizationError } = await import("./errors.js");
      throw new GraphAuthorizationError(
        `User ${removingUserId} does not own either entity ${entityId} or ${relatedEntityId}`,
      );
    }

    // 2. Check relationship exists (in the A→B direction)
    const relCheck = await this.executeQuery(
      `MATCH (a:Entity {id: $entityId})-[r:ENTITY_RELATES]->(b:Entity {id: $relatedEntityId})
       RETURN r.type AS type`,
      { entityId, relatedEntityId },
    );

    if (relCheck.records.length === 0) {
      const { GraphNotFoundError } = await import("./errors.js");
      throw new GraphNotFoundError(
        `Entity relationship not found between ${entityId} and ${relatedEntityId}`,
      );
    }

    // 3. Delete A→B edge and reciprocal B→A edge if it exists
    await this.executeQuery(
      `MATCH (a:Entity {id: $entityId})-[r:ENTITY_RELATES]->(b:Entity {id: $relatedEntityId})
       DELETE r`,
      { entityId, relatedEntityId },
    );

    await this.executeQuery(
      `OPTIONAL MATCH (b:Entity {id: $relatedEntityId})-[r:ENTITY_RELATES]->(a:Entity {id: $entityId})
       DELETE r`,
      { entityId, relatedEntityId },
    );
  }

  async getEntityRelationships(
    entityId: string,
    options?: {
      type?: string;
      status?: EntityRelationshipStatus;
    },
  ): Promise<EntityRelationship[]> {
    let query = `MATCH (a:Entity {id: $entityId})-[r:ENTITY_RELATES]->(b:Entity)
                 WHERE 1=1`;
    const params: Record<string, unknown> = { entityId };

    if (options?.type) {
      query += ` AND r.type = $type`;
      params.type = options.type;
    }

    if (options?.status) {
      query += ` AND r.status = $status`;
      params.status = options.status;
    }

    query += ` RETURN b.id AS relatedEntityId, r.type AS type, r.status AS status,
                       r.proposedByUserId AS proposedByUserId, r.since AS since
               ORDER BY r.since DESC`;

    const result = await this.executeQuery(query, params);

    return result.records.map((record) => ({
      entityId,
      relatedEntityId: record.get("relatedEntityId") as string,
      type: record.get("type") as EntityRelationship["type"],
      status: record.get("status") as EntityRelationshipStatus,
      proposedByUserId: record.get("proposedByUserId") as string,
      since: new Date(record.get("since") as string),
    }));
  }

  async getPendingEntityRelationships(
    userId: string,
  ): Promise<EntityRelationship[]> {
    // Return relationships where the user owns the TARGET entity and the edge is PENDING.
    // The relationship direction is A→B (source→target), and user owns B.
    const result = await this.executeQuery(
      `MATCH (u:User {id: $userId})-[:OWNS]->(b:Entity)
       MATCH (a:Entity)-[r:ENTITY_RELATES {status: 'PENDING'}]->(b)
       RETURN a.id AS entityId, b.id AS relatedEntityId, r.type AS type,
              r.proposedByUserId AS proposedByUserId, r.since AS since
       ORDER BY r.since DESC`,
      { userId },
    );

    return result.records.map((record) => ({
      entityId: record.get("entityId") as string,
      relatedEntityId: record.get("relatedEntityId") as string,
      type: record.get("type") as EntityRelationship["type"],
      status: "PENDING" as EntityRelationshipStatus,
      proposedByUserId: record.get("proposedByUserId") as string,
      since: new Date(record.get("since") as string),
    }));
  }

  // =========================================================================
  // Discovery
  //
  // RATE LIMITING NOTE: All discovery endpoints should be rate-limited at
  // 5 requests/minute/user. Enforcement is at the handler/route layer.
  // Hop count is hard-capped at 2 in discoverByGraph.
  // =========================================================================

  /**
   * Discover entities through multi-hop entity-to-entity relationship traversal.
   *
   * Traverses PLAYMATE|PACK_MATE|SIBLING|PARENT|OFFSPRING|WALK_BUDDY edges
   * starting from the user's owned entities. Returns only entities the user
   * does NOT already have a relationship with, and where discoverable != false.
   *
   * SECURITY: Hops are hard-capped at 2 regardless of input. 3-hop traversals
   * can visit 100^3 nodes on popular entities (graph DoS vector). All query
   * values are parameterized — the hop range is a safe numeric literal derived
   * from server-side clamped input, never user-supplied string data.
   */
  async discoverByGraph(
    userId: string,
    hops: number,
    filters?: DiscoveryFilters,
  ): Promise<DiscoveryResult[]> {
    // Hard-cap at 2 regardless of what the caller passes
    const safeHops: 1 | 2 = hops <= 1 ? 1 : 2;
    const limit = filters?.limit ?? 20;

    const filterClauses: string[] = [
      "NOT (me)-[:RELATES_TO]->(discovered)",
      "(discovered.discoverable IS NULL OR discovered.discoverable = true)",
    ];
    if (filters?.entityType) filterClauses.push("discovered.entityType = $entityType");
    if (filters?.breed) filterClauses.push("discovered.breed = $breed");
    if (filters?.lifeStage) filterClauses.push("discovered.lifeStage = $lifeStage");

    const whereClause = filterClauses.join("\n      AND ");
    // safeHops is 1 or 2 — a numeric literal in the template, not user input.
    const hopRange = safeHops === 1 ? "1" : "1..2";

    const query = `
      MATCH (me:User {id: $userId})-[:OWNS]->(myEntity:Entity),
            (myEntity)-[:PLAYMATE|PACK_MATE|SIBLING|PARENT|OFFSPRING|WALK_BUDDY*${hopRange}]-(discovered:Entity)
      WHERE ${whereClause}
      RETURN DISTINCT
             discovered.id        AS entityId,
             discovered.name      AS name,
             discovered.entityType AS entityType,
             discovered.breed     AS breed,
             ${safeHops}          AS hops
      ORDER BY discovered.name ASC
      LIMIT $limit
    `;

    const params: Record<string, unknown> = { userId, limit: neo4j.int(limit) };
    if (filters?.entityType) params.entityType = filters.entityType;
    if (filters?.breed) params.breed = filters.breed;
    if (filters?.lifeStage) params.lifeStage = filters.lifeStage;

    const result = await this.executeQuery(query, params);

    return result.records.map((record) => {
      const entityId = record.get("entityId") as string;
      const name = record.get("name") as string;
      const entityType = record.get("entityType") as string;
      const breed = record.get("breed") as string | null;
      const hopCount = record.get("hops") as number;

      const discovery: DiscoveryResult = { entityId, name, entityType, hops: hopCount };
      if (breed) discovery.breed = breed;
      return discovery;
    });
  }

  /**
   * Discover entities by geographic proximity using point.distance().
   *
   * Only returns entities where discoverable is not false, and entities the
   * user does NOT already have a relationship with.
   *
   * SECURITY: Exact distances are withheld for all results — only a coarse
   * distance band is returned to prevent location triangulation (security
   * review Finding 15). Coordinates are pre-coarsened to ~1km precision at
   * sync time for additional protection. Entities with existing relationships
   * are excluded so exact distance is never needed here.
   */
  async discoverNearby(
    userId: string,
    lat: number,
    lng: number,
    radiusMeters: number,
    filters?: NearbyFilters,
  ): Promise<DiscoveryResult[]> {
    const limit = filters?.limit ?? 20;

    // These clauses are safe because the filter values come from $params
    const entityTypeFilter = filters?.entityType ? "AND entity.entityType = $entityType" : "";
    const breedFilter = filters?.breed ? "AND entity.breed = $breed" : "";

    const query = `
      MATCH (entity:Entity)
      WHERE (entity.discoverable IS NULL OR entity.discoverable = true)
        AND entity.lat IS NOT NULL
        AND entity.lng IS NOT NULL
        ${entityTypeFilter}
        ${breedFilter}
        AND point.distance(
          point({latitude: entity.lat, longitude: entity.lng}),
          point({latitude: $lat, longitude: $lng})
        ) < $radiusMeters
      WITH entity,
           point.distance(
             point({latitude: entity.lat, longitude: entity.lng}),
             point({latitude: $lat, longitude: $lng})
           ) AS distanceMeters
      OPTIONAL MATCH (me:User {id: $userId})-[rel:RELATES_TO]->(entity)
      WITH entity, distanceMeters, rel
      WHERE rel IS NULL
      RETURN entity.id        AS entityId,
             entity.name      AS name,
             entity.entityType AS entityType,
             entity.breed     AS breed,
             distanceMeters
      ORDER BY distanceMeters ASC
      LIMIT $limit
    `;

    const params: Record<string, unknown> = { userId, lat, lng, radiusMeters, limit: neo4j.int(limit) };
    if (filters?.entityType) params.entityType = filters.entityType;
    if (filters?.breed) params.breed = filters.breed;

    const result = await this.executeQuery(query, params);

    return result.records.map((record) => {
      const entityId = record.get("entityId") as string;
      const name = record.get("name") as string;
      const entityType = record.get("entityType") as string;
      const breed = record.get("breed") as string | null;
      const distMeters = record.get("distanceMeters") as number;

      const discovery: DiscoveryResult = {
        entityId,
        name,
        entityType,
        // SECURITY: Coarse band only — never exact distance for unrelated entities
        distanceBand: Neo4jGraphService.toDistanceBand(distMeters),
      };
      if (breed) discovery.breed = breed;
      return discovery;
    });
  }

  /**
   * Get entity recommendations based on shared connections, breed similarity,
   * and geographic proximity.
   *
   * Runs three parallel queries (signals) and merges results, deduplicated by
   * entity ID, keeping the highest-scoring reason per entity.
   *
   * SECURITY: `owner_proximity` is never exposed as a RecommendationReason.
   * Exposing it would allow the viewer to infer a close relationship with the
   * entity's owner from a visible recommendation, leaking graph topology.
   * Owner proximity is used internally to boost shared-connection scoring but
   * always surfaced as "shared_connections" in the response.
   */
  async getRecommendations(
    userId: string,
    limit: number,
  ): Promise<Recommendation[]> {
    const params: Record<string, unknown> = { userId, limit: neo4j.int(limit) };

    // Signal 1: Shared connections (also folds in owner proximity internally)
    const sharedConnectionsQuery = `
      MATCH (me:User {id: $userId})-[:OWNS|RELATES_TO]->(myEntity:Entity)
            -[:PLAYMATE|PACK_MATE|SIBLING|PARENT|OFFSPRING|WALK_BUDDY*1..2]-(candidate:Entity)
      WHERE NOT (me)-[:RELATES_TO]->(candidate)
        AND NOT (me)-[:OWNS]->(candidate)
        AND (candidate.discoverable IS NULL OR candidate.discoverable = true)
        AND candidate.id <> myEntity.id
      WITH candidate, count(DISTINCT myEntity) AS sharedCount
      RETURN candidate.id        AS entityId,
             candidate.name      AS name,
             candidate.entityType AS entityType,
             toFloat(sharedCount) / 10.0 AS score,
             'shared_connections'         AS reason
      ORDER BY score DESC
      LIMIT $limit
    `;

    // Signal 2: Same breed as user's owned entities
    const sameBreedQuery = `
      MATCH (me:User {id: $userId})-[:OWNS]->(myDog:Entity)
      WHERE myDog.breed IS NOT NULL
      WITH me, collect(DISTINCT myDog.breed) AS myBreeds
      MATCH (candidate:Entity)
      WHERE candidate.breed IN myBreeds
        AND NOT (me)-[:RELATES_TO]->(candidate)
        AND NOT (me)-[:OWNS]->(candidate)
        AND (candidate.discoverable IS NULL OR candidate.discoverable = true)
      RETURN candidate.id        AS entityId,
             candidate.name      AS name,
             candidate.entityType AS entityType,
             0.6                  AS score,
             'same_breed'         AS reason
      LIMIT $limit
    `;

    // Signal 3: Geographic proximity to user's owned entities
    const nearbyQuery = `
      MATCH (me:User {id: $userId})-[:OWNS]->(myEntity:Entity)
      WHERE myEntity.lat IS NOT NULL AND myEntity.lng IS NOT NULL
      WITH me, collect(myEntity) AS myEntities
      MATCH (candidate:Entity)
      WHERE candidate.lat IS NOT NULL
        AND candidate.lng IS NOT NULL
        AND NOT (me)-[:RELATES_TO]->(candidate)
        AND NOT (me)-[:OWNS]->(candidate)
        AND (candidate.discoverable IS NULL OR candidate.discoverable = true)
      WITH candidate, myEntities,
           reduce(minD = 999999999.0, e IN myEntities |
             CASE
               WHEN point.distance(
                 point({latitude: candidate.lat, longitude: candidate.lng}),
                 point({latitude: e.lat, longitude: e.lng})
               ) < minD
               THEN point.distance(
                 point({latitude: candidate.lat, longitude: candidate.lng}),
                 point({latitude: e.lat, longitude: e.lng})
               )
               ELSE minD
             END
           ) AS minDist
      WHERE minDist < 5000
      RETURN candidate.id        AS entityId,
             candidate.name      AS name,
             candidate.entityType AS entityType,
             (1.0 - (minDist / 10000.0)) * 0.5 AS score,
             'nearby'             AS reason
      ORDER BY minDist ASC
      LIMIT $limit
    `;

    const [sharedResult, breedResult, nearbyResult] = await Promise.all([
      this.executeQuery(sharedConnectionsQuery, params),
      this.executeQuery(sameBreedQuery, params),
      this.executeQuery(nearbyQuery, params),
    ]);

    // Merge and deduplicate: keep highest-scoring entry per entity
    const candidateMap = new Map<
      string,
      { entityId: string; name: string; entityType: string; score: number; reason: string }
    >();

    for (const queryResult of [sharedResult, breedResult, nearbyResult]) {
      for (const record of queryResult.records) {
        const entityId = record.get("entityId") as string;
        const existing = candidateMap.get(entityId);
        const score = record.get("score") as number;
        if (!existing || score > existing.score) {
          candidateMap.set(entityId, {
            entityId,
            name: record.get("name") as string,
            entityType: record.get("entityType") as string,
            score,
            reason: record.get("reason") as string,
          });
        }
      }
    }

    return Array.from(candidateMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((c) => ({
        entityId: c.entityId,
        name: c.name,
        entityType: c.entityType,
        reason: c.reason as import("./types.js").RecommendationReason,
        confidence: Math.min(1.0, Math.max(0.0, c.score)),
      }));
  }

  // =========================================================================
  // Private Static Helpers
  // =========================================================================

  /**
   * Convert an exact distance in meters to a coarse distance band string.
   *
   * SECURITY: Used by discoverNearby() to prevent location triangulation.
   * Values match the DiscoveryResult.distanceBand union type exactly.
   */
  private static toDistanceBand(
    meters: number,
  ): "< 500m" | "500m-1km" | "1-2km" | "2-5km" | "> 5km" {
    if (meters < 500) return "< 500m";
    if (meters < 1000) return "500m-1km";
    if (meters < 2000) return "1-2km";
    if (meters < 5000) return "2-5km";
    return "> 5km";
  }

  // =========================================================================
  // Scoring (Phase 2 — P2.4)
  // =========================================================================

  /**
   * Record a user interaction on a RELATES_TO edge.
   *
   * Updates interaction count, last interaction timestamp, and per-type
   * interaction counters. No-op if the relationship does not exist.
   *
   * SECURITY: All queries parameterized.
   */
  async recordInteraction(input: RecordInteractionInput): Promise<void> {
    const targetLabel = input.targetType === "user" ? "User" : "Entity";

    // Increment total count, set lastInteractionAt, and increment per-type counter.
    // The per-type counter property is named i_{type} (e.g., i_view, i_comment).
    // Note: property name is safe — interactionType comes from the InteractionType union.
    const counterProperty = `i_${input.interactionType}`;

    await this.executeQuery(
      `
      MATCH (u:User {id: $userId})-[r:RELATES_TO]->(t:${targetLabel} {id: $targetId})
      SET r.interactionCount = coalesce(r.interactionCount, 0) + 1,
          r.lastInteractionAt = datetime($now),
          r.${counterProperty} = coalesce(r.${counterProperty}, 0) + 1
      `,
      {
        userId: input.userId,
        targetId: input.targetId,
        now: new Date().toISOString(),
      },
    );
  }

  /**
   * Recompute scores for ALL relationships of a user.
   *
   * Batch-processes all RELATES_TO edges in a single query pass per target type,
   * avoiding N+1 patterns. Returns only relationships where the tier changed.
   *
   * SECURITY: All queries parameterized.
   */
  async recomputeScores(userId: string): Promise<ScoreUpdate[]> {
    const { computeScore, scoreToTier } = await import("./scoring-engine.js");

    const tierChanges: ScoreUpdate[] = [];
    const now = new Date();

    // --- User targets ---
    // Batch fetch all user relationships with their reciprocity status
    const userRels = await this.executeQuery(
      `
      MATCH (u:User {id: $userId})-[r:RELATES_TO]->(t:User)
      OPTIONAL MATCH (t)-[rev:RELATES_TO]->(u)
      RETURN t.id AS targetId,
             r.computedScore AS oldScore,
             r.tier AS oldTier,
             r.connectionMethod AS connectionMethod,
             r.interactionCount AS interactionCount,
             r.lastInteractionAt AS lastInteractionAt,
             r.createdAt AS createdAt,
             r.manualScore AS manualScore,
             coalesce(r.i_view, 0) AS i_view,
             coalesce(r.i_react, 0) AS i_react,
             coalesce(r.i_comment, 0) AS i_comment,
             coalesce(r.i_share, 0) AS i_share,
             coalesce(r.i_depth_mode, 0) AS i_depth_mode,
             coalesce(r.i_profile_visit, 0) AS i_profile_visit,
             coalesce(r.i_content_creation, 0) AS i_content_creation,
             rev IS NOT NULL AS reciprocated
      `,
      { userId },
    );

    // Compute new scores and collect updates
    const userUpdates: Array<{
      targetId: string;
      newScore: number;
      newTier: number;
    }> = [];

    for (const record of userRels.records) {
      const targetId = record.get("targetId") as string;
      const oldScore = (record.get("oldScore") as number) ?? 0;
      const oldTier = (record.get("oldTier") as CircleTier) ?? 3;
      const lastInteractionRaw = record.get("lastInteractionAt");
      const createdAtRaw = record.get("createdAt");

      const newComputedScore = computeScore({
        targetType: "user",
        connectionMethod:
          (record.get("connectionMethod") as ConnectionMethod) ?? "discovery",
        interactionCount: (record.get("interactionCount") as number) ?? 0,
        interactionsByType: {
          view: record.get("i_view") as number,
          react: record.get("i_react") as number,
          comment: record.get("i_comment") as number,
          share: record.get("i_share") as number,
          depth_mode: record.get("i_depth_mode") as number,
          profile_visit: record.get("i_profile_visit") as number,
          content_creation: record.get("i_content_creation") as number,
        },
        lastInteractionAt: lastInteractionRaw
          ? new Date(lastInteractionRaw)
          : null,
        reciprocated: record.get("reciprocated") as boolean,
        createdAt: createdAtRaw ? new Date(createdAtRaw) : now,
        manualScore: (record.get("manualScore") as number | null) ?? null,
        isOwned: false,
        ownerScore: null,
        now,
      });

      const manualScore =
        (record.get("manualScore") as number | null) ?? null;
      const effectiveNewScore = manualScore ?? newComputedScore;
      const newTier = scoreToTier(effectiveNewScore);

      userUpdates.push({
        targetId,
        newScore: newComputedScore,
        newTier,
      });

      if (newTier !== oldTier) {
        tierChanges.push({
          userId,
          targetType: "user",
          targetId,
          previousScore: oldScore,
          newScore: newComputedScore,
          previousTier: oldTier,
          newTier,
        });
      }
    }

    // Batch-write user relationship scores
    if (userUpdates.length > 0) {
      await this.executeQuery(
        `
        UNWIND $updates AS upd
        MATCH (u:User {id: $userId})-[r:RELATES_TO]->(t:User {id: upd.targetId})
        SET r.computedScore = upd.newScore,
            r.tier = upd.newTier
        `,
        { userId, updates: userUpdates },
      );
    }

    // --- Entity targets ---
    // Batch fetch all entity relationships with ownership and owner scores
    const entityRels = await this.executeQuery(
      `
      MATCH (u:User {id: $userId})-[r:RELATES_TO]->(t:Entity)
      OPTIONAL MATCH (u)-[:OWNS]->(t)
      WITH u, r, t, EXISTS((u)-[:OWNS]->(t)) AS isOwned
      OPTIONAL MATCH (owner:User)-[:OWNS]->(t)
      WHERE owner.id <> $userId
      OPTIONAL MATCH (u)-[ownerRel:RELATES_TO]->(owner)
      WITH u, r, t, isOwned,
           collect(ownerRel.computedScore) AS ownerScores
      RETURN t.id AS targetId,
             r.computedScore AS oldScore,
             r.tier AS oldTier,
             r.connectionMethod AS connectionMethod,
             r.interactionCount AS interactionCount,
             r.lastInteractionAt AS lastInteractionAt,
             r.createdAt AS createdAt,
             r.manualScore AS manualScore,
             coalesce(r.i_view, 0) AS i_view,
             coalesce(r.i_react, 0) AS i_react,
             coalesce(r.i_comment, 0) AS i_comment,
             coalesce(r.i_share, 0) AS i_share,
             coalesce(r.i_depth_mode, 0) AS i_depth_mode,
             coalesce(r.i_profile_visit, 0) AS i_profile_visit,
             coalesce(r.i_content_creation, 0) AS i_content_creation,
             isOwned,
             ownerScores
      `,
      { userId },
    );

    const entityUpdates: Array<{
      targetId: string;
      newScore: number;
      newTier: number;
    }> = [];

    for (const record of entityRels.records) {
      const targetId = record.get("targetId") as string;
      const oldScore = (record.get("oldScore") as number) ?? 0;
      const oldTier = (record.get("oldTier") as CircleTier) ?? 3;
      const isOwned = record.get("isOwned") as boolean;
      const lastInteractionRaw = record.get("lastInteractionAt");
      const createdAtRaw = record.get("createdAt");

      // Average the owner scores for the owner proximity signal
      const ownerScores = (record.get("ownerScores") as number[]) ?? [];
      const validOwnerScores = ownerScores.filter(
        (s) => s !== null && s !== undefined,
      );
      const avgOwnerScore =
        validOwnerScores.length > 0
          ? validOwnerScores.reduce((a, b) => a + b, 0) /
            validOwnerScores.length
          : null;

      const newComputedScore = computeScore({
        targetType: "entity",
        connectionMethod:
          (record.get("connectionMethod") as ConnectionMethod) ?? "discovery",
        interactionCount: (record.get("interactionCount") as number) ?? 0,
        interactionsByType: {
          view: record.get("i_view") as number,
          react: record.get("i_react") as number,
          comment: record.get("i_comment") as number,
          share: record.get("i_share") as number,
          depth_mode: record.get("i_depth_mode") as number,
          profile_visit: record.get("i_profile_visit") as number,
          content_creation: record.get("i_content_creation") as number,
        },
        lastInteractionAt: lastInteractionRaw
          ? new Date(lastInteractionRaw)
          : null,
        reciprocated: false, // Not applicable for entities
        createdAt: createdAtRaw ? new Date(createdAtRaw) : now,
        manualScore: (record.get("manualScore") as number | null) ?? null,
        isOwned,
        ownerScore: avgOwnerScore,
        now,
      });

      const manualScore =
        (record.get("manualScore") as number | null) ?? null;
      const effectiveNewScore = isOwned
        ? 1.0
        : (manualScore ?? newComputedScore);
      const newTier = scoreToTier(effectiveNewScore);

      entityUpdates.push({
        targetId,
        newScore: newComputedScore,
        newTier,
      });

      if (newTier !== oldTier) {
        tierChanges.push({
          userId,
          targetType: "entity",
          targetId,
          previousScore: oldScore,
          newScore: newComputedScore,
          previousTier: oldTier,
          newTier,
        });
      }
    }

    // Batch-write entity relationship scores
    if (entityUpdates.length > 0) {
      await this.executeQuery(
        `
        UNWIND $updates AS upd
        MATCH (u:User {id: $userId})-[r:RELATES_TO]->(t:Entity {id: upd.targetId})
        SET r.computedScore = upd.newScore,
            r.tier = upd.newTier
        `,
        { userId, updates: entityUpdates },
      );
    }

    return tierChanges;
  }

  /**
   * Apply time-based decay to all of a user's relationship scores.
   *
   * - User->User: 50% decay after 60 days of no interaction
   * - User->Entity: 50% decay after 120 days of no interaction
   * - Owned entities (:OWNS edge) are exempt — always pinned at 1.0
   *
   * SECURITY: All queries parameterized.
   */
  async applyDecay(userId: string): Promise<ScoreUpdate[]> {
    const {
      computeDecay,
      scoreToTier,
      USER_DECAY_HALF_LIFE_DAYS,
      ENTITY_DECAY_HALF_LIFE_DAYS,
    } = await import("./scoring-engine.js");

    const tierChanges: ScoreUpdate[] = [];
    const now = new Date();

    // --- User targets: apply decay ---
    const userRels = await this.executeQuery(
      `
      MATCH (u:User {id: $userId})-[r:RELATES_TO]->(t:User)
      WHERE r.lastInteractionAt IS NOT NULL
      RETURN t.id AS targetId,
             r.computedScore AS currentScore,
             r.tier AS currentTier,
             r.manualScore AS manualScore,
             r.lastInteractionAt AS lastInteractionAt
      `,
      { userId },
    );

    const userDecayUpdates: Array<{
      targetId: string;
      newScore: number;
      newTier: number;
    }> = [];

    for (const record of userRels.records) {
      const targetId = record.get("targetId") as string;
      const currentScore = (record.get("currentScore") as number) ?? 0;
      const currentTier = (record.get("currentTier") as CircleTier) ?? 3;
      const manualScore =
        (record.get("manualScore") as number | null) ?? null;
      const lastInteractionAt = new Date(
        record.get("lastInteractionAt") as string,
      );

      const decayFactor = computeDecay(
        lastInteractionAt,
        now,
        USER_DECAY_HALF_LIFE_DAYS,
      );

      // Apply multiplicative decay: score * (1 - decayFactor)
      const decayedScore = Math.max(0, currentScore * (1 - decayFactor));
      const effective = manualScore ?? decayedScore;
      const newTier = scoreToTier(effective);

      userDecayUpdates.push({
        targetId,
        newScore: decayedScore,
        newTier,
      });

      if (newTier !== currentTier) {
        tierChanges.push({
          userId,
          targetType: "user",
          targetId,
          previousScore: currentScore,
          newScore: decayedScore,
          previousTier: currentTier,
          newTier,
        });
      }
    }

    if (userDecayUpdates.length > 0) {
      await this.executeQuery(
        `
        UNWIND $updates AS upd
        MATCH (u:User {id: $userId})-[r:RELATES_TO]->(t:User {id: upd.targetId})
        SET r.computedScore = upd.newScore,
            r.tier = upd.newTier
        `,
        { userId, updates: userDecayUpdates },
      );
    }

    // --- Entity targets: apply decay (skip owned) ---
    const entityRels = await this.executeQuery(
      `
      MATCH (u:User {id: $userId})-[r:RELATES_TO]->(t:Entity)
      WHERE r.lastInteractionAt IS NOT NULL
        AND NOT EXISTS((u)-[:OWNS]->(t))
      RETURN t.id AS targetId,
             r.computedScore AS currentScore,
             r.tier AS currentTier,
             r.manualScore AS manualScore,
             r.lastInteractionAt AS lastInteractionAt
      `,
      { userId },
    );

    const entityDecayUpdates: Array<{
      targetId: string;
      newScore: number;
      newTier: number;
    }> = [];

    for (const record of entityRels.records) {
      const targetId = record.get("targetId") as string;
      const currentScore = (record.get("currentScore") as number) ?? 0;
      const currentTier = (record.get("currentTier") as CircleTier) ?? 3;
      const manualScore =
        (record.get("manualScore") as number | null) ?? null;
      const lastInteractionAt = new Date(
        record.get("lastInteractionAt") as string,
      );

      const decayFactor = computeDecay(
        lastInteractionAt,
        now,
        ENTITY_DECAY_HALF_LIFE_DAYS,
      );

      const decayedScore = Math.max(0, currentScore * (1 - decayFactor));
      const effective = manualScore ?? decayedScore;
      const newTier = scoreToTier(effective);

      entityDecayUpdates.push({
        targetId,
        newScore: decayedScore,
        newTier,
      });

      if (newTier !== currentTier) {
        tierChanges.push({
          userId,
          targetType: "entity",
          targetId,
          previousScore: currentScore,
          newScore: decayedScore,
          previousTier: currentTier,
          newTier,
        });
      }
    }

    if (entityDecayUpdates.length > 0) {
      await this.executeQuery(
        `
        UNWIND $updates AS upd
        MATCH (u:User {id: $userId})-[r:RELATES_TO]->(t:Entity {id: upd.targetId})
        SET r.computedScore = upd.newScore,
            r.tier = upd.newTier
        `,
        { userId, updates: entityDecayUpdates },
      );
    }

    return tierChanges;
  }

  // =========================================================================
  // Sync — Dual-Write from Postgres
  // =========================================================================

  async syncUser(input: SyncUserInput): Promise<void> {
    await this.executeQuery(
      `
      MERGE (u:User {id: $id})
      ON CREATE SET u.role = $role
      ON MATCH SET  u.role = $role
      `,
      { id: input.id, role: input.role },
    );
  }

  async removeUser(userId: string): Promise<void> {
    await this.executeQuery(
      `MATCH (u:User {id: $id}) DETACH DELETE u`,
      { id: userId },
    );
  }

  async syncEntity(input: SyncEntityInput): Promise<void> {
    await this.executeQuery(
      `
      MERGE (e:Entity {id: $id})
      ON CREATE SET
        e.entityType = $entityType,
        e.name       = $name,
        e.breed      = $breed,
        e.lifeStage  = $lifeStage,
        e.lat        = $lat,
        e.lng        = $lng
      ON MATCH SET
        e.entityType = $entityType,
        e.name       = $name,
        e.breed      = $breed,
        e.lifeStage  = $lifeStage,
        e.lat        = $lat,
        e.lng        = $lng
      `,
      {
        id: input.id,
        entityType: input.entityType,
        name: input.name,
        breed: input.breed ?? null,
        lifeStage: input.lifeStage ?? null,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
      },
    );
  }

  async removeEntity(entityId: string): Promise<void> {
    await this.executeQuery(
      `MATCH (e:Entity {id: $id}) DETACH DELETE e`,
      { id: entityId },
    );
  }

  async syncPost(input: SyncPostInput): Promise<void> {
    // Read queries filter on the integer `radiusInt` (WHISPER 0 … SHOUT 3) and
    // treat `createdAt` as a Neo4j datetime (`post.createdAt > datetime($since)`,
    // ORDER BY post.createdAt). Persist both in those shapes — storing radius as
    // a bare string (no radiusInt) or createdAt as an ISO string silently makes
    // every circle/discovery query return nothing on Neo4j 5.
    const radiusInt = RADIUS_TO_INT[input.radius];
    await this.executeQuery(
      `
      MERGE (u:User {id: $authorId})
      MERGE (p:Post {id: $id})
      ON CREATE SET
        p.authorId  = $authorId,
        p.radius    = $radius,
        p.radiusInt = toInteger($radiusInt),
        p.createdAt = datetime($createdAt)
      ON MATCH SET
        p.authorId  = $authorId,
        p.radius    = $radius,
        p.radiusInt = toInteger($radiusInt),
        p.createdAt = datetime($createdAt)
      MERGE (u)-[:AUTHORED]->(p)
      `,
      {
        id: input.id,
        authorId: input.authorId,
        radius: input.radius,
        radiusInt,
        createdAt: input.createdAt.toISOString(),
      },
    );
  }

  async removePost(postId: string): Promise<void> {
    await this.executeQuery(
      `MATCH (p:Post {id: $id}) DETACH DELETE p`,
      { id: postId },
    );
  }

  async syncPostSubjects(input: SyncPostSubjectsInput): Promise<void> {
    // Delete all existing ABOUT edges from the post, then recreate
    await this.executeQuery(
      `
      MATCH (p:Post {id: $postId})
      OPTIONAL MATCH (p)-[r:ABOUT]->()
      DELETE r
      WITH p
      UNWIND $entityIds AS eId
      MATCH (e:Entity {id: eId})
      MERGE (p)-[rel:ABOUT]->(e)
      SET rel.isPrimary = (eId = $primaryEntityId)
      `,
      {
        postId: input.postId,
        entityIds: input.entityIds,
        primaryEntityId: input.primaryEntityId ?? null,
      },
    );
  }

  async syncOwnership(input: SyncOwnershipInput): Promise<void> {
    await this.executeQuery(
      `
      MATCH (u:User {id: $userId})
      MATCH (e:Entity {id: $entityId})
      MERGE (u)-[r:OWNS]->(e)
      ON CREATE SET r.role = $role
      ON MATCH SET  r.role = $role
      `,
      {
        userId: input.userId,
        entityId: input.entityId,
        role: input.role,
      },
    );
  }

  async removeOwnership(entityId: string, userId: string): Promise<void> {
    await this.executeQuery(
      `
      MATCH (u:User {id: $userId})-[r:OWNS]->(e:Entity {id: $entityId})
      DELETE r
      `,
      { userId, entityId },
    );
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  /**
   * Get a new session from the driver. Throws if not connected.
   * Callers are responsible for closing the session.
   */
  getSession(): Session {
    if (!this.driver || !this.connected) {
      throw new GraphConnectionError("Not connected to Neo4j");
    }
    return this.driver.session();
  }

  /**
   * Execute a parameterized Cypher query and return the result.
   * Sessions are opened and closed automatically.
   *
   * SECURITY: Always use parameters — never interpolate values into the query.
   */
  async executeQuery(
    query: string,
    parameters?: Record<string, unknown>,
  ): Promise<QueryResult> {
    const session = this.getSession();
    try {
      return await session.run(query, parameters);
    } catch (error) {
      throw new GraphQueryError(
        `Query failed: ${error instanceof Error ? error.message : String(error)}`,
        query,
        { cause: error instanceof Error ? error : undefined },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Initialize the graph schema (constraints and indexes).
   * Called once on first connect.
   */
  private async initializeSchema(): Promise<void> {
    const session = this.getSession();
    try {
      await initGraphSchema(session);
      this.schemaInitialized = true;
    } catch (error) {
      throw new GraphConnectionError(
        `Schema initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    } finally {
      await session.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (module-private)
// ---------------------------------------------------------------------------

/** Map a tier number to its TierSummary key. */
function tierToName(tier: CircleTier): "inner" | "closeFriends" | "community" | "ambient" {
  switch (tier) {
    case 0: return "inner";
    case 1: return "closeFriends";
    case 2: return "community";
    default: return "ambient";
  }
}

/**
 * Encode a score-based pagination cursor.
 * The cursor is a base64-encoded JSON object with the score.
 */
function encodeCursor(score: number): string {
  return Buffer.from(JSON.stringify({ score })).toString("base64");
}

/**
 * Decode a score-based pagination cursor.
 * Returns null if the cursor is invalid.
 */
function decodeCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && "score" in parsed) {
      const score = (parsed as { score: unknown }).score;
      if (typeof score === "number") return score;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Map a raw Neo4j relationship property map to a Relationship object.
 * All edge properties are stored as-is (numbers, strings, null).
 */
function recordToRelationship(
  rel: Record<string, unknown>,
  userId: string,
  targetType: GraphNodeType,
  targetId: string,
): Relationship {
  const computedScore = typeof rel.computedScore === "number" ? rel.computedScore : 0;
  const manualScore = typeof rel.manualScore === "number" ? rel.manualScore : null;
  const score = typeof rel.score === "number" ? rel.score : computedScore;

  return {
    userId,
    targetType,
    targetId,
    score,
    computedScore,
    manualScore,
    tier: scoreToTier(score),
    interactionCount: typeof rel.interactionCount === "number" ? rel.interactionCount : 0,
    lastInteractionAt:
      rel.lastInteractionAt != null ? new Date(rel.lastInteractionAt as string) : null,
    connectionMethod: (rel.connectionMethod as string ?? "discovery") as Relationship["connectionMethod"],
    reciprocated: rel.reciprocated === true,
    createdAt: rel.createdAt != null ? new Date(rel.createdAt as string) : new Date(),
  };
}
