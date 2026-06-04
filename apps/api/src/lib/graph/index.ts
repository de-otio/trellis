/**
 * Graph Service
 *
 * Abstraction layer between API handlers and the graph backend. The graph
 * runs in Postgres (PostgresGraphService — joins + recursive CTEs on the
 * existing RDS); there is no separate graph database. (Graph-db revisit
 * 2026-06.)
 *
 * @example
 * ```typescript
 * import type { GraphService } from "./graph";
 * import { GraphConnectionError } from "./graph";
 *
 * async function handleRequest(graphService: GraphService) {
 *   try {
 *     const relationship = await graphService.createRelationship({
 *       userId: "user-123",
 *       targetType: "entity",
 *       targetId: "entity-456",
 *       connectionMethod: "discovery",
 *     });
 *   } catch (error) {
 *     if (error instanceof GraphConnectionError) {
 *       // Graph database is down — return 503
 *     }
 *   }
 * }
 * ```
 */

// Interface & connection
export type { GraphService, GraphConnection } from "./graph-service.js";

// Implementation (Postgres — the only backend; the Neo4j/Neptune service and
// the dual-write/reconciliation machinery were removed with the 2026-06
// revisit: handlers call the sync* methods directly and there is no second
// store to mirror or reconcile).
export { PostgresGraphService } from "./postgres/postgres-graph-service.js";
export {
  createGraphServiceFromEnv,
  closeSharedGraphService,
} from "./graph-factory.js";

// Types
export type {
  // Enums & constants
  ConnectionMethod,
  PostRadius,
  CircleTier,
  TierName,
  GraphNodeType,
  EntityRelationshipType,
  OwnershipRole,
  InteractionType,
  EntityRelationshipStatus,
  RecommendationReason,
  // Graph nodes
  GraphUser,
  GraphEntity,
  GraphPost,
  // Relationships
  Relationship,
  CreateRelationshipInput,
  UpdateRelationshipScoreInput,
  // Circles
  CircleMember,
  CircleTierStatus,
  CircleEntityStatus,
  GlanceItem,
  VisiblePostResult,
  // Entity relationships
  EntityRelationship,
  CreateEntityRelationshipInput,
  // Discovery
  DiscoveryFilters,
  NearbyFilters,
  DiscoveryResult,
  Recommendation,
  // Scoring
  RecordInteractionInput,
  ScoringWeights,
  ScoreUpdate,
  // Graph visualization
  GraphData,
  GraphNode,
  TierSummary,
  // Sync
  SyncUserInput,
  SyncEntityInput,
  SyncPostInput,
  SyncPostSubjectsInput,
  SyncOwnershipInput,
  // Connection & health
  GraphConnectionConfig,
  GraphAuthConfig,
  GraphPoolConfig,
  GraphHealthStatus,
  // Pagination
  PaginationInput,
  PaginatedResult,
} from "./types.js";

// Scoring engine
export {
  computeScore,
  effectiveScore,
  scoreToTier,
  computeDecay,
  computeEngagementDepth,
  computeFrequencySignal,
  connectionBonus,
  computeContentCreationSignal,
  computeOwnerProximity,
  USER_WEIGHTS,
  ENTITY_WEIGHTS,
  USER_DECAY_HALF_LIFE_DAYS,
  ENTITY_DECAY_HALF_LIFE_DAYS,
  ENGAGEMENT_SCORES,
  CONNECTION_BONUSES,
  TIER_THRESHOLDS,
  type InteractionCounts,
  type ScoringInput,
} from "./scoring-engine.js";

// Errors
export {
  GraphError,
  GraphConnectionError,
  GraphQueryError,
  GraphNotFoundError,
  GraphConflictError,
  GraphAuthorizationError,
  GraphTimeoutError,
} from "./errors.js";
