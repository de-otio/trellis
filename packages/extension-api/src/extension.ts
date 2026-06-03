/**
 * Extension API
 *
 * Defines the contract that all Trellis extensions must implement,
 * and the restricted context they receive at runtime.
 */

import type { ZodSchema } from "zod";
import type { Route } from "./route-types";

// ---------------------------------------------------------------------------
// Extension Context — the restricted runtime environment extensions receive
// ---------------------------------------------------------------------------

/**
 * Scoped Prisma access — excludes security-sensitive tables.
 *
 * Extensions can access entity, post, follow, and taxonomy tables.
 * They CANNOT access: user, securityEvent, featureToggle, mfaEnrollment,
 * encryptionKey, session, or admin tables.
 *
 * This uses `any` for the delegate types because the actual PrismaClient
 * type comes from the app's generated client. Extensions only interact
 * with this through the concrete object they receive at runtime.
 */
export interface ExtensionDb {
  entity: any;
  post: any;
  postEntity: any;
  postMedia: any;
  taxonomyTaxon: any;
  taxonomyCategory: any;
  taxonomyDimension: any;
  productTaxonomyTag: any;
  activity: any;
  // Relationship queries are available via GraphService (read-only access)
  // Extensions should not directly query relationship data from Postgres
}

/**
 * Read-only graph access for extensions.
 *
 * Extensions can query relationships, circles, entity relationships, and
 * discovery — but cannot mutate graph state (no sync, remove, score writes).
 * Write methods (syncUser, removeUser, createRelationship, etc.) are
 * reserved for core and are not exposed here.
 */
export interface ExtensionGraphService {
  // Relationships (read)
  getRelationship(
    userId: string,
    targetType: string,
    targetId: string,
  ): Promise<unknown | null>;
  getRelationships(
    userId: string,
    options?: { tier?: number; targetType?: string; pagination?: unknown },
  ): Promise<unknown>;
  getRelationshipGraph(userId: string): Promise<unknown>;

  // Circles (read)
  getCircleMembers(userId: string, tier: number): Promise<unknown[]>;
  getVisiblePostIds(
    userId: string,
    tier: number,
    since: Date,
    pagination: unknown,
  ): Promise<unknown>;
  getGlanceItems(userId: string, tier: number, limit: number): Promise<unknown[]>;
  getDepthPostIds(
    userId: string,
    targetType: string,
    targetId: string,
    since: Date,
    limit: number,
  ): Promise<string[]>;
  getCircleStatus(userId: string): Promise<unknown[]>;
  getCircleEntityStatus(userId: string, tier: number): Promise<unknown[]>;

  // Entity relationships (read)
  getEntityRelationships(
    entityId: string,
    options?: { type?: string; status?: string },
  ): Promise<unknown[]>;
  getPendingEntityRelationships(userId: string): Promise<unknown[]>;

  // Discovery
  discoverByGraph(
    userId: string,
    hops: number,
    filters?: unknown,
  ): Promise<unknown[]>;
  discoverNearby(
    userId: string,
    lat: number,
    lng: number,
    radiusMeters: number,
    filters?: unknown,
  ): Promise<unknown[]>;
  getRecommendations(userId: string, limit: number): Promise<unknown[]>;
}

/**
 * Restricted context passed to extension code.
 * Core secrets (SESSION_SECRET, DATABASE_URL, API keys) are never exposed.
 */
export interface ExtensionContext {
  /** Scoped database client — only extension-relevant tables */
  db: ExtensionDb;

  /**
   * Read-only graph access.
   * Extensions can query relationships, circles, and discovery.
   * Write operations (sync, remove, score mutation) are not available.
   */
  graphService?: ExtensionGraphService;

  /** App domain (e.g., "example.com") */
  appDomain: string;

  /** App base URL (e.g., "https://api.example.com") */
  appUrl: string;

  /** Deployment stage (dev, prod) */
  stage: string;

  /** This extension's config values (populated from its configSchema keys) */
  config: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Extension Hooks — lifecycle events extensions can react to
// ---------------------------------------------------------------------------

/**
 * VERSIONED CONTRACT — any signature change to any hook in this interface
 * requires a semver bump of `@de-otio/trellis-extension-api`.
 *
 * Hooks are called by Trellis core after the named operation completes.
 * All hooks are optional; omit them if the extension has no interest in
 * the event.
 *
 * Compatibility rules:
 * - Adding a new optional hook → minor bump (e.g. 0.2.x → 0.3.0).
 * - Changing the signature of an existing hook (parameter type, order,
 *   return type) → major bump if 1.x, minor bump while still 0.x
 *   (breaking for consumers regardless — coordinate with Skybber and any
 *   other known extension authors before merging).
 * - Removing a hook → same as a signature change.
 *
 * Keep this interface in sync with `EXTENSION_API_VERSION` (below) and
 * the `version` field in `packages/extension-api/package.json`.
 */
export interface ExtensionHooks {
  /** Called after a post is created */
  onPostCreated?: (post: any, ctx: ExtensionContext) => Promise<void>;

  /** Called after an entity is created */
  onEntityCreated?: (entity: any, ctx: ExtensionContext) => Promise<void>;

  /** Called after a relationship is created between users/entities */
  onRelationshipCreated?: (
    userId: string,
    targetId: string,
    targetType: string,
    ctx: ExtensionContext,
  ) => Promise<void>;

  /** Called when relationship scores are recomputed */
  onScoreRecompute?: (
    userId: string,
    scores: Array<{ targetId: string; score: number }>,
    ctx: ExtensionContext,
  ) => Promise<void>;

  /** Called after an entity is deleted */
  onEntityDeleted?: (
    entityId: string,
    entityType: string,
    ctx: ExtensionContext,
  ) => Promise<void>;
}

/**
 * The current version of the extension API contract.
 *
 * This must match the `version` field in
 * `packages/extension-api/package.json`.  If they diverge, a release
 * has been cut without updating one of them — fix before publishing.
 *
 * Extensions may read this at startup to verify they are running against
 * the expected API version (useful during coordinated Trellis + extension
 * upgrades).
 *
 * When to update:
 *   - Bump alongside every `package.json` version change.
 *   - Never change one without changing the other.
 */
export const EXTENSION_API_VERSION = "0.2.0" as const;

// ---------------------------------------------------------------------------
// Strategy Interfaces — pluggable domain-specific behavior
// ---------------------------------------------------------------------------

/** Signal provider for domain-specific relationship scoring */
export interface RelationshipSignalProvider {
  /**
   * Compute additional score signals for a relationship.
   * Return a value 0.0-1.0 that gets blended with the base score.
   * Return null/undefined to not affect the score.
   */
  computeSignal(
    userId: string,
    targetId: string,
    targetType: "user" | "entity",
    context: RelationshipSignalContext,
  ): Promise<number | null>;
}

/** Context passed to signal providers */
export interface RelationshipSignalContext {
  /** Current computed score */
  currentScore: number;
  /** Relationship tier (0-3) */
  tier: number;
  /** Entity metadata (if targetType is "entity") */
  entityMetadata?: Record<string, unknown>;
}

/** A filterable entity property for discovery */
export interface DiscoveryFacet {
  /** Metadata field name */
  field: string;
  /** Filter type */
  type: "exact" | "range" | "geo";
  /** Human-readable label */
  label: string;
}

export interface RecommendationStrategy {
  /** Generate domain-specific product/content recommendations */
  getRecommendations(
    entityId: string,
    ctx: ExtensionContext,
  ): Promise<Recommendation[]>;
}

export interface Recommendation {
  type: string;
  title: string;
  description: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ActivityPub Extension — display-only Actor enrichment
// ---------------------------------------------------------------------------

/** Display-only Actor fields that extensions can customize */
export interface ActorEnrichment {
  /** Actor summary / bio — rendered on remote instances */
  summary?: string;
  /** Profile icon */
  icon?: { type: "Image"; url: string; mediaType?: string };
  /** Structured metadata (e.g., "Breed: Golden Retriever") */
  attachment?: Array<{
    type: "PropertyValue";
    name: string;
    value: string;
  }>;
  /**
   * Custom namespace properties merged into the Actor document.
   * Core blocks overriding: id, publicKey, inbox, outbox, endpoints,
   * @context, preferredUsername.
   */
  properties?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Taxonomy Seed Data
// ---------------------------------------------------------------------------

export interface TaxonomySeedDimension {
  code: string;
  name: string;
  description?: string;
}

export interface TaxonomySeedCategory {
  code: string;
  name: string;
  dimensionCode: string;
  description?: string;
}

export interface TaxonomySeedTaxon {
  id: string;
  name: string;
  categoryCode: string;
  description?: string;
}

export interface TaxonomySeedData {
  dimensions: TaxonomySeedDimension[];
  categories: TaxonomySeedCategory[];
  taxons: TaxonomySeedTaxon[];
}

// ---------------------------------------------------------------------------
// Extension Route Definitions — core-wrapped handler pattern
// ---------------------------------------------------------------------------

/**
 * Response from an extension route handler.
 * Core converts this to a full HTTP Response with security headers.
 */
export interface ExtensionResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Extension route handler function.
 * Receives parsed request, params, session, and scoped context.
 * Returns a data object — core handles HTTP wiring.
 */
export type ExtensionHandler = (
  request: Request,
  params: Record<string, string>,
  session: { userId: string; email: string; role: string } | null,
  ctx: ExtensionContext,
) => Promise<ExtensionResponse>;

/**
 * Route definition provided by an extension.
 * Core wraps it with auth, CORS, security headers, and error handling.
 */
export interface ExtensionRouteDefinition {
  /** Path pattern — served at /api/ext/{extensionId}/{path} */
  path: string;
  method: string | string[];
  /** Auth requirement (default: "required") */
  auth?: "required" | "optional" | "none";
  description?: string;
  handle: ExtensionHandler;
}

// ---------------------------------------------------------------------------
// TrellisExtension — the main contract
// ---------------------------------------------------------------------------

export interface TrellisExtension {
  /** Unique ID — must be lowercase alphanumeric, 2-32 chars, not a reserved word */
  id: string;

  /** Display terminology */
  terminology: {
    entity: string; // "dog"
    entityPlural: string; // "dogs"
  };

  /** Routes to register — cannot use reserved prefixes */
  routes: Route[];

  /** Zod schema for Entity.metadata when entityType matches this extension */
  metadataSchema: ZodSchema;

  /** Taxonomy seed data */
  taxonomySeed?: TaxonomySeedData;

  /** Lifecycle hooks — core calls these after operations complete */
  hooks?: ExtensionHooks;

  /**
   * Domain-specific relationship scoring signals.
   * Extensions can boost or adjust relationship scores based on
   * domain-specific signals (e.g., breed similarity for dogs).
   */
  relationshipSignalProvider?: RelationshipSignalProvider;

  /**
   * Entity-to-entity relationship types this extension declares.
   * These are registered globally and available for all entities of this type.
   * Example: ["PACK_MATE", "WALK_BUDDY"] for a dog extension.
   */
  entityRelationshipTypes?: string[];

  /**
   * Searchable entity properties for discovery filtering.
   * Extensions declare which metadata fields are filterable.
   */
  discoveryFacets?: DiscoveryFacet[];

  /** Product recommendation strategy */
  recommendationStrategy?: RecommendationStrategy;

  /** Core-wrapped extension routes — preferred over raw `routes` */
  extensionRoutes?: ExtensionRouteDefinition[];

  /** Zod schema declaring required env var keys — validated against scoped values only */
  configSchema?: ZodSchema;

  /** ActivityPub actor enrichment */
  activityPub?: {
    /**
     * Return display-only Actor properties for this entity type.
     * Core owns id, publicKey, inbox, outbox, endpoints, @context —
     * extensions cannot override these.
     */
    enrichActor?: (entity: any) => ActorEnrichment;
  };

  /**
   * Compute a life-stage (or equivalent) value from entity metadata.
   * Core calls this during entity create/update — the result is persisted
   * as Entity.lifeStage. Return null if not applicable.
   */
  computeLifeStage?: (
    metadata: any,
    manualOverride: boolean,
    existingLifeStage: string | null,
  ) => string | null;

  /** Called once at startup with the extension's scoped context */
  init?: (ctx: ExtensionContext) => Promise<void>;

  /** Called on server shutdown (SIGTERM/SIGINT) */
  shutdown?: () => Promise<void>;
}
