/**
 * @de-otio/trellis-extension-api
 *
 * Public types for building Trellis extensions.
 */

export type {
  TrellisExtension,
  ExtensionContext,
  ExtensionGraphService,
  ExtensionDb,
  ScopedDb,
  ScopedDelegate,
  TenantId,
  ExtensionHooks,
  ExtensionJobDecl,
  ExtensionJobContext,
  ExtensionJobSchedule,
  CrossTenantReadDelegate,
  ExtensionRouteDefinition,
  ExtensionHandler,
  ExtensionSession,
  ExtensionResponse,
  DiscoverDb,
  RelationshipSignalProvider,
  RelationshipSignalContext,
  DiscoveryFacet,
  RecommendationStrategy,
  Recommendation,
  ActorEnrichment,
  TaxonomySeedData,
  TaxonomySeedDimension,
  TaxonomySeedCategory,
  TaxonomySeedTaxon,
} from "./extension.js";

export { EXTENSION_API_VERSION } from "./extension.js";

export type {
  Route,
  RoutePattern,
  Middleware,
  MiddlewareContext,
} from "./route-types.js";

// Structural DTOs — the versioned shapes of core data that extensions
// consume (hook payloads, graph query results). Core asserts it satisfies
// these at compile time; extensions type against them.
export type {
  ExtensionNodeType,
  ExtensionCircleTier,
  ExtensionConnectionMethod,
  ExtensionPaginatedResult,
  ExtensionEntity,
  ExtensionPost,
  ExtensionRelationship,
  ExtensionCircleMember,
  ExtensionCircleTierStatus,
  ExtensionCircleEntityStatus,
  ExtensionGlanceItem,
  ExtensionVisiblePost,
  ExtensionEntityRelationship,
  ExtensionRecapWindow,
  ExtensionRecapPayload,
  ExtensionRecapSubject,
} from "./dto.js";
