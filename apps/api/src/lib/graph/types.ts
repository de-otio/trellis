/**
 * Graph Service Types
 *
 * All input/output types for the GraphService abstraction layer.
 * These types are database-agnostic — they work for both local Neo4j
 * (Docker) and Neo4j AuraDB.
 */

// ---------------------------------------------------------------------------
// Enums & Constants
// ---------------------------------------------------------------------------

/** How a relationship was initially established */
export type ConnectionMethod = "code" | "import" | "suggestion" | "discovery";

/** Post broadcast radius — determines which circle tiers can see the post */
export type PostRadius = "WHISPER" | "NORMAL" | "LOUD" | "SHOUT";

/** Concentric circle tier (0 = innermost, 3 = outermost) */
export type CircleTier = 0 | 1 | 2 | 3;

/** Human-readable tier names */
export type TierName = "inner" | "closeFriends" | "community" | "ambient";

/** Node type in the graph */
export type GraphNodeType = "user" | "entity";

/** Typed entity-to-entity relationship kinds */
export type EntityRelationshipType =
  | "PACK_MATE"
  | "SIBLING"
  | "PLAYMATE"
  | "PARENT"
  | "OFFSPRING"
  | "WALK_BUDDY";

/** Ownership role for User-[:OWNS]->Entity edges */
export type OwnershipRole = "PRIMARY_OWNER" | "CO_OWNER" | "CARETAKER";

/** Types of user interaction used for scoring */
export type InteractionType =
  | "view"
  | "react"
  | "comment"
  | "share"
  | "depth_mode"
  | "profile_visit"
  | "content_creation";

/** Confirmation state for entity-to-entity relationships */
export type EntityRelationshipStatus = "PENDING" | "CONFIRMED" | "REJECTED";

// ---------------------------------------------------------------------------
// Graph Node Data (minimal — full profiles stay in Postgres)
// ---------------------------------------------------------------------------

/**
 * Minimal user node stored in the graph.
 *
 * SECURITY: No PII (email, name, etc.) is stored in graph nodes.
 * Only the user ID and role are needed for circle resolution and
 * permission checks. All PII lives exclusively in Postgres.
 */
export interface GraphUser {
  id: string;
  role: string;
}

/**
 * Entity node stored in the graph (properties needed for graph-side filtering).
 *
 * SECURITY: lat/lng are coarsened to 3 decimal places (~1km precision)
 * before storage to prevent triangulation attacks. See Finding 15.
 */
export interface GraphEntity {
  id: string;
  entityType: string;
  name: string;
  breed?: string;
  lifeStage?: string;
  /** Coarsened latitude (3 decimal places, ~1km precision) */
  lat?: number;
  /** Coarsened longitude (3 decimal places, ~1km precision) */
  lng?: number;
  /** Whether this entity appears in discovery queries. Default true. */
  discoverable?: boolean;
}

/** Minimal post node stored in the graph (content stays in Postgres) */
export interface GraphPost {
  id: string;
  authorId: string;
  radius: PostRadius;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Relationship Types
// ---------------------------------------------------------------------------

/** A scored relationship between a user and a target (user or entity) */
export interface Relationship {
  /** Source user ID */
  userId: string;
  /** Type of the target node */
  targetType: GraphNodeType;
  /** Target node ID */
  targetId: string;
  /**
   * Effective score (manualScore if set, otherwise computedScore).
   * Range: 0.0 to 1.0
   */
  score: number;
  /** Algorithm-computed score based on interaction signals */
  computedScore: number;
  /** User-set manual override (null if not set) */
  manualScore: number | null;
  /** Resolved circle tier based on score */
  tier: CircleTier;
  /** Total interaction count */
  interactionCount: number;
  /** Timestamp of last interaction */
  lastInteractionAt: Date | null;
  /** How the relationship was initially created */
  connectionMethod: ConnectionMethod;
  /** Whether the target also has a relationship back (user->user only) */
  reciprocated: boolean;
  /** When the relationship was created */
  createdAt: Date;
}

/** Input for creating a new relationship */
export interface CreateRelationshipInput {
  userId: string;
  targetType: GraphNodeType;
  targetId: string;
  connectionMethod?: ConnectionMethod;
}

/** Input for updating a relationship's manual score */
export interface UpdateRelationshipScoreInput {
  userId: string;
  targetType: GraphNodeType;
  targetId: string;
  /** Set to a number to override, or null to clear the override */
  manualScore: number | null;
}

// ---------------------------------------------------------------------------
// Circle Types
// ---------------------------------------------------------------------------

/** A member (user or entity) within a circle tier */
export interface CircleMember {
  /** Node ID */
  id: string;
  /** Whether this is a user or entity */
  type: GraphNodeType;
  /** Display name (from graph node) */
  name: string;
  /** Relationship score */
  score: number;
  /** Resolved tier */
  tier: CircleTier;
}

/** Status of a single circle tier */
export interface CircleTierStatus {
  tier: CircleTier;
  name: TierName;
  /** Whether all content has been seen */
  caughtUp: boolean;
  /** Number of posts not yet seen */
  unseenCount: number;
  /** When the user last marked this tier as read */
  lastReadAt: Date | null;
}

/** Per-entity status within a circle tier */
export interface CircleEntityStatus {
  entityId: string;
  entityName: string;
  /** Whether all content about this entity has been seen */
  caughtUp: boolean;
  /** Number of unseen posts about this entity */
  unseenCount: number;
  /** Most recent post timestamp for this entity */
  latestPostAt: Date | null;
}

/** Glance mode: one recent item per entity in the circle */
export interface GlanceItem {
  /** Entity or user ID this item is about */
  targetId: string;
  targetType: GraphNodeType;
  targetName: string;
  /** Most recent post ID (fetch content from Postgres) */
  postId: string;
  postCreatedAt: Date;
}

/** Result of a visible-post-IDs query */
export interface VisiblePostResult {
  /** Post ID (fetch content from Postgres) */
  postId: string;
  /** When the post was created */
  createdAt: Date;
  /**
   * Tier of the closest relationship through which this post is visible.
   * For multi-entity posts, this is the minimum tier across all matching subjects.
   */
  resolvedTier: CircleTier;
}

// ---------------------------------------------------------------------------
// Entity Relationship Types
// ---------------------------------------------------------------------------

/** A typed, unscored relationship between two entities */
export interface EntityRelationship {
  /** Source entity ID */
  entityId: string;
  /** Target entity ID */
  relatedEntityId: string;
  /** Relationship type (PACK_MATE, SIBLING, etc.) */
  type: EntityRelationshipType;
  /** Confirmation status (requires both owners to confirm) */
  status: EntityRelationshipStatus;
  /** User who proposed the relationship */
  proposedByUserId: string;
  /** When the relationship was created/proposed */
  since: Date;
}

/** Input for creating an entity-to-entity relationship */
export interface CreateEntityRelationshipInput {
  entityId: string;
  relatedEntityId: string;
  type: EntityRelationshipType;
  /** User proposing the relationship (must own entityId) */
  proposedByUserId: string;
}

// ---------------------------------------------------------------------------
// Discovery Types
// ---------------------------------------------------------------------------

/**
 * Filters for multi-hop entity discovery.
 *
 * SECURITY: Discovery is rate-limited to 5 requests/minute/user.
 * Hop count is hard-capped at 2 to prevent graph traversal DoS
 * (3-hop traversals can visit 100^3 nodes on popular entities).
 */
export interface DiscoveryFilters {
  /** Filter by entity type (e.g., "dog") */
  entityType?: string;
  /** Filter by breed */
  breed?: string;
  /** Filter by life stage */
  lifeStage?: string;
  /**
   * Number of relationship hops to traverse. Hard-capped at 2.
   * Server rejects values > 2. Default: 2.
   */
  hops?: 1 | 2;
  /** Maximum number of results */
  limit?: number;
}

/** Filters for spatial (nearby) discovery */
export interface NearbyFilters {
  /** Filter by entity type */
  entityType?: string;
  /** Filter by breed */
  breed?: string;
  /** Maximum number of results */
  limit?: number;
}

/** A discovered entity with distance metadata */
export interface DiscoveryResult {
  /** Entity ID (fetch full profile from Postgres) */
  entityId: string;
  /** Entity name (from graph node) */
  name: string;
  /** Entity type */
  entityType: string;
  /** Breed (if available) */
  breed?: string;
  /**
   * Coarse distance band for spatial queries. Exact distance in meters
   * is only provided when the viewer has an existing relationship (tier 0-2)
   * with the entity. For unrelated viewers, only the band is returned
   * to prevent location triangulation.
   */
  distanceBand?: "< 500m" | "500m-1km" | "1-2km" | "2-5km" | "> 5km";
  /**
   * Exact distance in meters. Only populated when the viewer has an
   * existing relationship with the entity (tier 0-2). Null for
   * unrelated viewers (use distanceBand instead).
   */
  distanceMeters?: number;
  /**
   * How this entity was discovered.
   * For multi-hop: number of hops from the user's entities.
   * For spatial: undefined.
   */
  hops?: number;
}

/** Recommendation based on graph analysis */
export interface Recommendation {
  /** Recommended entity ID */
  entityId: string;
  /** Entity name */
  name: string;
  /** Entity type */
  entityType: string;
  /** Why this entity was recommended */
  reason: RecommendationReason;
  /** Confidence score (0.0 to 1.0) */
  confidence: number;
}

/**
 * Reason why an entity was recommended (client-facing).
 *
 * SECURITY: `owner_proximity` is intentionally excluded. Exposing it
 * as a client-facing reason would leak graph topology information
 * (the viewer could infer that they have a close relationship with the
 * entity's owner, even if that relationship is not explicitly visible).
 * Owner proximity is used internally for scoring but mapped to
 * "shared_connections" in the client-facing response.
 */
export type RecommendationReason =
  | "shared_connections"
  | "same_breed"
  | "nearby"
  | "popular_in_circle";

// ---------------------------------------------------------------------------
// Scoring Types
// ---------------------------------------------------------------------------

/** Input for recording a user interaction */
export interface RecordInteractionInput {
  userId: string;
  targetType: GraphNodeType;
  targetId: string;
  interactionType: InteractionType;
  /** Optional metadata (e.g., post ID that triggered the interaction) */
  metadata?: Record<string, string>;
}

/** Scoring weights configuration (target-type-aware) */
export interface ScoringWeights {
  /** Engagement depth weight (entity relationships only) */
  engagement: number;
  /** Interaction frequency weight */
  frequency: number;
  /** Owner proximity weight (entity relationships only) */
  ownerProximity: number;
  /** Content creation weight (entity relationships only) */
  contentCreation: number;
  /** Connection method initial bonus weight */
  connection: number;
  /** Decay penalty weight */
  decay: number;
  /** Reciprocity weight (user-to-user relationships only) */
  reciprocity: number;
}

/** Result of a score recomputation */
export interface ScoreUpdate {
  userId: string;
  targetType: GraphNodeType;
  targetId: string;
  previousScore: number;
  newScore: number;
  previousTier: CircleTier;
  newTier: CircleTier;
}

// ---------------------------------------------------------------------------
// Graph Visualization Types
// ---------------------------------------------------------------------------

/** Full relationship graph data for the visualization UI */
export interface GraphData {
  /** All relationship targets as graph nodes */
  nodes: GraphNode[];
  /** Tier summary statistics */
  tiers: TierSummary;
}

/**
 * A node in the relationship graph visualization.
 *
 * SECURITY: Raw scores are not exposed to the client. Only the tier
 * and a coarse closeness indicator (0-100 integer) are returned.
 * This prevents exact score extraction that could be used to infer
 * the underlying graph topology.
 */
export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  /**
   * Coarse closeness indicator (0-100 integer, bucketed to nearest 10).
   * NOT the raw relationship score. Used for visual sizing/positioning
   * in the graph UI without exposing exact scoring internals.
   */
  closeness: number;
  tier: CircleTier;
}

/** Summary of tier thresholds and member counts */
export interface TierSummary {
  inner: { threshold: number; count: number };
  closeFriends: { threshold: number; count: number };
  community: { threshold: number; count: number };
  ambient: { threshold: number; count: number };
}

// ---------------------------------------------------------------------------
// Sync Types (Dual-Write)
// ---------------------------------------------------------------------------

/**
 * Data to sync a User node to the graph.
 *
 * SECURITY: No PII is synced to the graph database. Only the user ID
 * and role are needed for graph queries. Email, name, and other PII
 * stay in Postgres.
 */
export interface SyncUserInput {
  id: string;
  role: string;
}

/** Data to sync an Entity node to the graph */
export interface SyncEntityInput {
  id: string;
  entityType: string;
  name: string;
  breed?: string;
  lifeStage?: string;
  lat?: number;
  lng?: number;
  /**
   * Tenant that owns the entity. Required to tenant-scope the entity's location
   * row in Postgres/PostGIS (the graph no longer stores lat/lng, C7). Optional
   * because request-path callers may instead rely on the ambient tenant context
   * (`getCurrentTenantId()`); background callers (reconciliation) must pass it
   * explicitly. When neither is available, the geo write is skipped.
   */
  tenantId?: string;
}

/** Data to sync a Post node to the graph */
export interface SyncPostInput {
  id: string;
  authorId: string;
  radius: PostRadius;
  createdAt: Date;
}

/** Data to sync PostSubject edges to the graph */
export interface SyncPostSubjectsInput {
  postId: string;
  /** All entity IDs that this post is about */
  entityIds: string[];
  /** The primary entity ID (if any) */
  primaryEntityId?: string;
}

/** Data to sync an EntityOwnership edge to the graph */
export interface SyncOwnershipInput {
  entityId: string;
  userId: string;
  role: OwnershipRole;
}

// ---------------------------------------------------------------------------
// Connection & Health Types
// ---------------------------------------------------------------------------

/** Graph database connection configuration */
export interface GraphConnectionConfig {
  /**
   * Connection endpoint.
   * - Local (Neo4j Docker): bolt://localhost:7687
   * - AuraDB: bolt+s://<dbid>.databases.neo4j.io
   */
  endpoint: string;
  /** Authentication mode */
  auth: GraphAuthConfig;
  /** Connection pool settings */
  pool?: GraphPoolConfig;
  /**
   * Per-query timeout in milliseconds. Queries exceeding this limit are
   * aborted to prevent graph traversal DoS. Default: 5000 (5 seconds).
   * Discovery queries may use a lower value (e.g., 3000).
   */
  queryTimeoutMs?: number;
  /**
   * Circuit breaker configuration. When the failure rate exceeds the
   * threshold within the evaluation window, the circuit opens and all
   * graph queries fail fast (returning cached results or Postgres
   * fallback) until the recovery period elapses.
   */
  circuitBreaker?: GraphCircuitBreakerConfig;
}

/** Circuit breaker configuration for graph database queries */
export interface GraphCircuitBreakerConfig {
  /** Failure rate threshold (0.0-1.0) to trip the circuit. Default: 0.5 (50%). */
  failureRateThreshold?: number;
  /** Number of requests in the evaluation window. Default: 10. */
  evaluationWindowSize?: number;
  /** How long the circuit stays open before allowing a probe request, in ms. Default: 30000 (30s). */
  recoveryPeriodMs?: number;
  /** Number of successful probe requests needed to close the circuit. Default: 3. */
  successThreshold?: number;
}

/** Authentication configuration */
export type GraphAuthConfig =
  | { type: "none" }
  | { type: "basic"; username: string; password: string }
  | { type: "iam"; region: string };

/** Connection pool configuration */
export interface GraphPoolConfig {
  /** Driver option: maxConnectionPoolSize. Default 100 (driver). */
  maxConnectionPoolSize?: number;
  /** Driver option: connectionAcquisitionTimeout. Default 60_000 ms (driver). */
  connectionAcquisitionTimeout?: number;
  /** Driver option: maxConnectionLifetime. Default 3_600_000 ms (driver). */
  maxConnectionLifetime?: number;
  /** Driver option: connectionLivenessCheckTimeout. Default undefined (disabled). */
  connectionLivenessCheckTimeout?: number;
}

/** Health check result */
export interface GraphHealthStatus {
  /** Whether the graph database is reachable and accepting queries */
  healthy: boolean;
  /** Round-trip latency of the health check query in milliseconds */
  latencyMs: number;
  /** Error message if unhealthy */
  error?: string;
  /** Backend type detected */
  backend: "neo4j" | "unknown";
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Cursor-based pagination input */
export interface PaginationInput {
  /** Maximum number of results to return */
  limit: number;
  /** Opaque cursor from a previous response (omit for first page) */
  cursor?: string;
}

/** Cursor-based pagination output */
export interface PaginatedResult<T> {
  /** The result items */
  items: T[];
  /** Cursor to fetch the next page (null if no more results) */
  cursor: string | null;
  /** Whether more results exist beyond this page */
  hasMore: boolean;
}
