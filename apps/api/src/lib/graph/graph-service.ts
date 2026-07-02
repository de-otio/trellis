/**
 * GraphService Interface
 *
 * The abstraction layer between API handlers and the social graph.
 * The only shipped implementation is PostgresGraphService, which serves the
 * graph from relational edge tables in the same PostgreSQL database using SQL
 * joins and recursive CTEs. (An earlier dedicated graph backend was removed;
 * GRAPH_BACKEND=neo4j now throws "no longer supported". The interface is kept
 * so a dedicated backend could be reintroduced behind it.)
 *
 * Handlers never execute raw graph queries. They call GraphService methods
 * that return IDs, which are then used to fetch content from Postgres via Prisma.
 */

import type {
  CircleEntityStatus,
  CircleMember,
  CircleTier,
  CircleTierStatus,
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
// GraphConnection — abstract connection management
// ---------------------------------------------------------------------------

/**
 * Abstract connection to the graph database.
 *
 * Implementations manage driver lifecycle, connection pooling, and
 * authentication. The connection is created once at application startup
 * and shared across all requests.
 */
export interface GraphConnection {
  /**
   * Initialize the connection (create driver, verify reachability).
   * Must be called before any queries. Idempotent — calling multiple
   * times is safe.
   *
   * @param config - Connection configuration (endpoint, auth, pool settings)
   * @throws GraphConnectionError if the database is unreachable
   */
  connect(config: GraphConnectionConfig): Promise<void>;

  /**
   * Gracefully close the connection and release all pooled resources.
   * Should be called on application shutdown.
   */
  close(): Promise<void>;

  /**
   * Check whether the connection is currently open and healthy.
   */
  isConnected(): boolean;
}

// ---------------------------------------------------------------------------
// Feed org-category declutter filter
// ---------------------------------------------------------------------------

/**
 * Optional feed-declutter filter over a post's denormalized
 * `Post.authorOrgRootCategoryCode` (the `PlatformCategory.code` of the root
 * ancestor of the authoring tenant's classification, stamped at post-creation
 * time — see `DataRouter.createPost`).
 *
 * Semantics (a post's code may be `null` when the authoring tenant has no
 * classification — the common case for a personal tenant):
 *   - `exclude`: blacklist. A post is omitted when its code is one of these
 *     values. Posts with a `null` code are KEPT (they are not "one of" the
 *     excluded org categories).
 *   - `include`: whitelist. When non-empty, ONLY posts whose code is one of
 *     these values appear; posts with a `null` code are omitted (they belong to
 *     no listed org category).
 *
 * Both may be combined (a post must survive the exclude blacklist AND match the
 * include whitelist). An absent/empty filter changes nothing.
 */
export interface OrgCategoryFeedFilter {
  /** Root category codes to exclude from the feed (blacklist). */
  exclude?: string[];
  /** Root category codes to restrict the feed to (whitelist). */
  include?: string[];
}

// ---------------------------------------------------------------------------
// GraphService — the main interface
// ---------------------------------------------------------------------------

/**
 * High-level graph operations for the Trellis API.
 *
 * All methods are async (graph operations are I/O-bound).
 * All methods throw GraphError subclasses on failure.
 *
 * Handlers consume this interface — they never know which backend
 * implementation (currently Postgres) is being used.
 */
export interface GraphService {
  // =========================================================================
  // Connection & Health
  // =========================================================================

  /**
   * Check graph database health.
   *
   * Executes a lightweight query (e.g., `RETURN 1`) and measures latency.
   * Used by the /health endpoint and readiness probes.
   *
   * @returns Health status including latency and backend type
   */
  healthCheck(): Promise<GraphHealthStatus>;

  // =========================================================================
  // Relationships (User -> User | Entity, scored)
  // =========================================================================

  /**
   * Create a new scored relationship from a user to a target (user or entity).
   *
   * The initial score is determined by the connection method:
   * - "code": 0.7 (close friends tier)
   * - "import": 0.5 (close friends tier)
   * - "suggestion": 0.3 (community tier)
   * - "discovery": 0.3 (community tier)
   *
   * If the target already has a relationship back to this user (user->user),
   * both edges are marked as reciprocated.
   *
   * @param input - Relationship creation parameters
   * @returns The newly created relationship
   * @throws GraphNotFoundError if the target node does not exist in the graph
   * @throws GraphConflictError if the relationship already exists
   */
  createRelationship(input: CreateRelationshipInput): Promise<Relationship>;

  /**
   * Remove a relationship.
   *
   * Deletes the RELATES_TO edge. If the relationship was reciprocated
   * (user->user), the reverse edge's `reciprocated` flag is set to false.
   *
   * @param userId - Source user ID
   * @param targetType - Type of the target node
   * @param targetId - Target node ID
   * @throws GraphNotFoundError if the relationship does not exist
   */
  removeRelationship(
    userId: string,
    targetType: GraphNodeType,
    targetId: string,
  ): Promise<void>;

  /**
   * Update the manual score override on a relationship.
   *
   * When manualScore is set, it overrides the computed score for tier
   * resolution. When cleared (set to null), the computed score is used again.
   *
   * @param input - Score update parameters
   * @returns The updated relationship
   * @throws GraphNotFoundError if the relationship does not exist
   */
  updateRelationshipScore(
    input: UpdateRelationshipScoreInput,
  ): Promise<Relationship>;

  /**
   * Get a specific relationship by source user and target.
   *
   * @param userId - Source user ID
   * @param targetType - Type of the target node
   * @param targetId - Target node ID
   * @returns The relationship, or null if it does not exist
   */
  getRelationship(
    userId: string,
    targetType: GraphNodeType,
    targetId: string,
  ): Promise<Relationship | null>;

  /**
   * List all relationships for a user, with optional filtering and pagination.
   *
   * Results are ordered by score descending (closest relationships first).
   *
   * @param userId - Source user ID
   * @param options - Optional filters and pagination
   * @returns Paginated list of relationships
   */
  getRelationships(
    userId: string,
    options?: {
      /** Filter to a specific tier */
      tier?: CircleTier;
      /** Filter to user or entity targets */
      targetType?: GraphNodeType;
      /** Pagination */
      pagination?: PaginationInput;
    },
  ): Promise<PaginatedResult<Relationship>>;

  /**
   * Get the full relationship graph for visualization.
   *
   * Returns all relationship targets as nodes with coarse closeness
   * indicators and tiers, plus tier summary statistics. This is a heavier
   * query intended for the graph view UI, not for feed queries.
   *
   * SECURITY: This endpoint requires recent authentication (session age
   * < 15 minutes). Raw scores are NOT returned — only tier and a coarse
   * closeness value (0-100, bucketed to nearest 10). All access is
   * audit-logged. Rate limit: 10 requests/minute.
   *
   * @param userId - The viewer's user ID
   * @returns Graph data with nodes (coarse closeness, no raw scores) and tier summaries
   */
  getRelationshipGraph(userId: string): Promise<GraphData>;

  // =========================================================================
  // Circles (Content Views)
  // =========================================================================

  /**
   * Get members (users and entities) in a specific circle tier.
   *
   * Members are sorted by score descending within the tier. Owned entities
   * are always included at tier 0 (auto-pinned at score 1.0).
   *
   * @param userId - The viewer's user ID
   * @param tier - Circle tier (0-3)
   * @returns List of circle members in the tier
   */
  getCircleMembers(userId: string, tier: CircleTier): Promise<CircleMember[]>;

  /**
   * Get post IDs visible to the user in a specific circle tier.
   *
   * Uses dual-gated visibility:
   * 1. Posts where the viewer has a relationship with ANY subject entity,
   *    and the closest such relationship falls within the post's radius
   * 2. Posts where the viewer has a relationship with the author,
   *    and the author's posting radius reaches the viewer's tier
   *
   * For multi-entity posts, the resolved tier is the minimum (closest)
   * tier across all matching subject entity relationships.
   *
   * @param userId - The viewer's user ID
   * @param tier - Circle tier to query
   * @param since - Only return posts created after this timestamp
   * @param pagination - Pagination parameters
   * @param orgFilter - Optional org-category feed-declutter filter (see
   *   {@link OrgCategoryFeedFilter}). Omitted/undefined = no org filtering.
   * @returns Paginated post IDs with creation timestamps and resolved tiers
   */
  getVisiblePostIds(
    userId: string,
    tier: CircleTier,
    since: Date,
    pagination: PaginationInput,
    orgFilter?: OrgCategoryFeedFilter,
  ): Promise<PaginatedResult<VisiblePostResult>>;

  /**
   * Get glance mode data for a circle tier.
   *
   * Returns one recent item per entity/user in the tier, prioritized by
   * recency. This provides a finite, entity-organized snapshot instead
   * of a chronological feed.
   *
   * @param userId - The viewer's user ID
   * @param tier - Circle tier
   * @param limit - Maximum number of glance items (one per entity/user)
   * @param orgFilter - Optional org-category feed-declutter filter (see
   *   {@link OrgCategoryFeedFilter}). Omitted/undefined = no org filtering.
   * @returns List of glance items, one per member with new content
   */
  getGlanceItems(
    userId: string,
    tier: CircleTier,
    limit: number,
    orgFilter?: OrgCategoryFeedFilter,
  ): Promise<GlanceItem[]>;

  /**
   * Get depth mode data: recent post IDs from/about a specific target.
   *
   * Used when a user taps on a specific entity or user in their circle
   * to see that target's recent content.
   *
   * @param userId - The viewer's user ID
   * @param targetType - Whether the target is a user or entity
   * @param targetId - The target user or entity ID
   * @param since - Only return posts created after this timestamp
   * @param limit - Maximum number of post IDs to return
   * @returns Post IDs ordered by creation time descending
   */
  getDepthPostIds(
    userId: string,
    targetType: GraphNodeType,
    targetId: string,
    since: Date,
    limit: number,
  ): Promise<string[]>;

  /**
   * Get the read status for all circle tiers.
   *
   * Returns whether each tier is "caught up" (no unseen content),
   * the count of unseen posts, and the last-read timestamp.
   *
   * @param userId - The viewer's user ID
   * @returns Status for all four tiers
   */
  getCircleStatus(userId: string): Promise<CircleTierStatus[]>;

  /**
   * Get per-entity status within a circle tier.
   *
   * Shows which entities have new content and how many unseen posts each has.
   * Used for the entity-level "caught up" indicators in the circle view.
   *
   * @param userId - The viewer's user ID
   * @param tier - Circle tier
   * @returns Per-entity status list, sorted by unseen count descending
   */
  getCircleEntityStatus(
    userId: string,
    tier: CircleTier,
  ): Promise<CircleEntityStatus[]>;

  /**
   * Mark a circle tier as read up to the current time.
   *
   * Updates the lastReadAt timestamp used for "caught up" computation.
   * After this call, `getCircleStatus` will reflect the updated read state.
   *
   * @param userId - The viewer's user ID
   * @param tier - Circle tier to mark as read
   * @param readAt - Timestamp to mark as read up to (defaults to now)
   */
  markCircleRead(
    userId: string,
    tier: CircleTier,
    readAt?: Date,
  ): Promise<void>;

  // =========================================================================
  // Entity Relationships (Entity -> Entity, typed, unscored)
  // =========================================================================

  /**
   * Create a typed relationship between two entities.
   *
   * The relationship starts in PENDING status. It must be confirmed by an
   * owner of the related entity before it becomes CONFIRMED and visible
   * in the graph.
   *
   * @param input - Entity relationship creation parameters
   * @returns The newly created entity relationship
   * @throws GraphNotFoundError if either entity does not exist in the graph
   * @throws GraphConflictError if the relationship already exists
   * @throws GraphAuthorizationError if the proposing user does not own the source entity
   */
  createEntityRelationship(
    input: CreateEntityRelationshipInput,
  ): Promise<EntityRelationship>;

  /**
   * Confirm a pending entity relationship.
   *
   * Only an owner of the target entity can confirm. Once confirmed, the
   * relationship edge becomes visible for traversal queries (discovery,
   * recommendations).
   *
   * @param entityId - Source entity ID
   * @param relatedEntityId - Target entity ID
   * @param confirmingUserId - User confirming (must own relatedEntityId)
   * @returns The confirmed entity relationship
   * @throws GraphNotFoundError if the relationship does not exist
   * @throws GraphConflictError if already confirmed or rejected
   * @throws GraphAuthorizationError if the user does not own the target entity
   */
  confirmEntityRelationship(
    entityId: string,
    relatedEntityId: string,
    confirmingUserId: string,
  ): Promise<EntityRelationship>;

  /**
   * Reject a pending entity relationship.
   *
   * @param entityId - Source entity ID
   * @param relatedEntityId - Target entity ID
   * @param rejectingUserId - User rejecting (must own relatedEntityId)
   * @throws GraphNotFoundError if the relationship does not exist
   * @throws GraphAuthorizationError if the user does not own the target entity
   */
  rejectEntityRelationship(
    entityId: string,
    relatedEntityId: string,
    rejectingUserId: string,
  ): Promise<void>;

  /**
   * Remove an entity relationship.
   *
   * Either owner (of source or target entity) can remove the relationship.
   *
   * @param entityId - Source entity ID
   * @param relatedEntityId - Target entity ID
   * @param removingUserId - User removing (must own either entity)
   * @throws GraphNotFoundError if the relationship does not exist
   * @throws GraphAuthorizationError if the user does not own either entity
   */
  removeEntityRelationship(
    entityId: string,
    relatedEntityId: string,
    removingUserId: string,
  ): Promise<void>;

  /**
   * Get all relationships for an entity, optionally filtered by type and status.
   *
   * @param entityId - Entity ID
   * @param options - Optional filters
   * @returns List of entity relationships
   */
  getEntityRelationships(
    entityId: string,
    options?: {
      type?: string;
      status?: EntityRelationshipStatus;
    },
  ): Promise<EntityRelationship[]>;

  /**
   * Get pending entity relationship requests that need confirmation.
   *
   * Returns relationships where the given user owns the target entity
   * and the relationship is in PENDING status.
   *
   * @param userId - User who owns target entities
   * @returns List of pending entity relationships
   */
  getPendingEntityRelationships(userId: string): Promise<EntityRelationship[]>;

  // =========================================================================
  // Discovery
  // =========================================================================

  /**
   * Discover entities through multi-hop graph traversal.
   *
   * Starts from the user's owned entities and traverses entity-to-entity
   * relationships (PLAYMATE, PACK_MATE, SIBLING, etc.) up to the specified
   * number of hops. Only returns entities the user does NOT already have
   * a relationship with.
   *
   * @param userId - The discovering user's ID
   * @param hops - Maximum traversal depth (1-3, clamped)
   * @param filters - Optional filters (entity type, breed, life stage)
   * @returns List of discovered entities
   */
  discoverByGraph(
    userId: string,
    hops: number,
    filters?: DiscoveryFilters,
  ): Promise<DiscoveryResult[]>;

  /**
   * Discover entities by geographic proximity.
   *
   * Uses spatial indexing to find entities near the given coordinates.
   * Only returns entities the user does NOT already have a relationship with.
   *
   * @param userId - The discovering user's ID (to exclude existing relationships)
   * @param lat - Latitude
   * @param lng - Longitude
   * @param radiusMeters - Search radius in meters
   * @param filters - Optional filters (entity type, breed)
   * @returns List of discovered entities, sorted by distance ascending
   */
  discoverNearby(
    userId: string,
    lat: number,
    lng: number,
    radiusMeters: number,
    filters?: NearbyFilters,
  ): Promise<DiscoveryResult[]>;

  /**
   * Get entity recommendations based on graph analysis.
   *
   * Combines multiple signals: shared connections, breed similarity,
   * geographic proximity, and owner proximity to generate a ranked
   * list of entities the user might want to follow.
   *
   * @param userId - The user to generate recommendations for
   * @param limit - Maximum number of recommendations
   * @returns Ranked list of recommendations with reasons
   */
  getRecommendations(
    userId: string,
    limit: number,
  ): Promise<Recommendation[]>;

  // =========================================================================
  // Scoring
  // =========================================================================

  /**
   * Record a user interaction for relationship scoring.
   *
   * Updates the interaction count, recency, and engagement depth signals
   * on the RELATES_TO edge. Does NOT immediately recompute the score —
   * that happens in `recomputeScores`.
   *
   * If no relationship exists between the user and target, this is a no-op
   * (interactions only affect existing relationships).
   *
   * @param input - Interaction details
   */
  recordInteraction(input: RecordInteractionInput): Promise<void>;

  /**
   * Recompute scores for all of a user's relationships.
   *
   * Applies the scoring formula (target-type-aware: reciprocity-weighted
   * for user targets, engagement-depth-weighted for entity targets) and
   * updates the computedScore and tier on each RELATES_TO edge.
   *
   * This is typically run as a background job, not inline with requests.
   *
   * @param userId - User whose relationship scores to recompute
   * @returns List of relationships where the tier changed
   */
  recomputeScores(userId: string): Promise<ScoreUpdate[]>;

  /**
   * Apply time-based decay to all of a user's relationship scores.
   *
   * Decay rates differ by target type:
   * - User->User: 50% decay after 60 days of no interaction
   * - User->Entity: 50% decay after 120 days of no interaction
   *
   * Owned entities (OWNS edges) are exempt from decay — they are always
   * pinned at score 1.0 in tier 0.
   *
   * This is typically run as a scheduled job (e.g., daily cron).
   *
   * @param userId - User whose relationships to apply decay to
   * @returns List of relationships where the tier changed due to decay
   */
  applyDecay(userId: string): Promise<ScoreUpdate[]>;

  // =========================================================================
  // Sync (maintain graph-derived tables)
  // =========================================================================

  /**
   * Sync a User node to the graph.
   *
   * Creates the node if it doesn't exist, or updates properties if it does.
   * Called after Postgres user create/update.
   *
   * @param input - User data to sync
   */
  syncUser(input: SyncUserInput): Promise<void>;

  /**
   * Remove a User node and all its edges from the graph.
   *
   * Called after Postgres user deletion. Removes the User node and all
   * connected RELATES_TO, OWNS, and reverse RELATES_TO edges.
   *
   * @param userId - User ID to remove
   */
  removeUser(userId: string): Promise<void>;

  /**
   * Sync an Entity node to the graph.
   *
   * Creates the node if it doesn't exist, or updates properties if it does.
   * Called after Postgres entity create/update.
   *
   * @param input - Entity data to sync
   */
  syncEntity(input: SyncEntityInput): Promise<void>;

  /**
   * Remove an Entity node and all its edges from the graph.
   *
   * Called after Postgres entity deletion. Removes the Entity node and all
   * connected edges (RELATES_TO pointing to it, OWNS, ABOUT, and
   * entity-to-entity relationships).
   *
   * @param entityId - Entity ID to remove
   */
  removeEntity(entityId: string): Promise<void>;

  /**
   * Sync a Post node to the graph.
   *
   * Creates the node if it doesn't exist. Post nodes are reference-only —
   * content stays in Postgres. The graph uses post nodes for visibility
   * queries (matching post radius against viewer tier).
   *
   * @param input - Post data to sync
   */
  syncPost(input: SyncPostInput): Promise<void>;

  /**
   * Remove a Post node and its ABOUT edges from the graph.
   *
   * Called after Postgres post deletion.
   *
   * @param postId - Post ID to remove
   */
  removePost(postId: string): Promise<void>;

  /**
   * Sync PostSubject edges (Post -[:ABOUT]-> Entity).
   *
   * Replaces all existing ABOUT edges for the post with the given set.
   * This is an idempotent "set" operation, not an incremental add.
   *
   * @param input - Post subject data to sync
   */
  syncPostSubjects(input: SyncPostSubjectsInput): Promise<void>;

  /**
   * Sync an EntityOwnership edge (User -[:OWNS]-> Entity).
   *
   * Creates or updates the OWNS edge with the given role.
   * Also ensures the user has a RELATES_TO edge to the entity at score 1.0
   * (auto-pinned to inner circle), since owned entities are always tier 0.
   *
   * @param input - Ownership data to sync
   */
  syncOwnership(input: SyncOwnershipInput): Promise<void>;

  /**
   * Remove an EntityOwnership edge.
   *
   * Called when ownership is revoked. Removes the OWNS edge but does NOT
   * remove the RELATES_TO edge — the user may still want to follow the entity.
   * The auto-pin at score 1.0 is removed; the computed score takes over.
   *
   * @param entityId - Entity ID
   * @param userId - User ID
   */
  removeOwnership(entityId: string, userId: string): Promise<void>;
}
