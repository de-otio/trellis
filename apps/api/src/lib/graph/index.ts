/**
 * Graph Service
 *
 * Abstraction layer between API handlers and the graph database
 * (Neo4j AuraDB in dev/prod, Neo4j Community via Docker in local dev
 * and integration tests).
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

// Implementations
export { Neo4jGraphService } from "./neo4j-graph-service.js";
export {
  createGraphService,
  createGraphServiceFromEnv,
  closeSharedGraphService,
  type GraphServiceEnvConfig,
} from "./graph-factory.js";
export { initGraphSchema, verifyGraphSchema } from "./graph-schema-init.js";

// Dual-write
export type {
  DualWriteService,
  DualWriteConfig,
  DualWriteFailure,
  DualWriteOperation,
  DualWritePayload,
  DualWriteSyncResult,
  ReconciliationProgress,
  ReconciliationResult,
  ConsistencyCheckResult,
} from "./dual-write.js";
export { GraphSyncError } from "./dual-write.js";
export { DualWriteServiceImpl } from "./dual-write-service.js";
export { ReconciliationService } from "./reconciliation-service.js";

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
