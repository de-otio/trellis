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
  ExtensionHooks,
  ExtensionRouteDefinition,
  ExtensionHandler,
  ExtensionResponse,
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
} from "./extension";

export { EXTENSION_API_VERSION } from "./extension";

export type {
  Route,
  RoutePattern,
  Middleware,
  MiddlewareContext,
} from "./route-types";

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
} from "./dto";
