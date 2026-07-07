/**
 * Extension DTOs — minimal structural shapes of core data that extensions
 * consume.
 *
 * These are the versioned cross-repo contract between Trellis core and
 * extensions (see AR13): core asserts at compile time that its internal
 * types (Prisma models, graph result types) SATISFY these shapes
 * (`apps/api/src/lib/extension-dto-contract.ts`), and extensions type their
 * hook parameters / graph-query results against them. A core field rename
 * therefore fails core's own build (the satisfies-assertion) and, after the
 * DTO is updated, fails the extension's build — instead of breaking at
 * runtime.
 *
 * Rules for this file:
 * - STRUCTURAL and MINIMAL: only fields that are stable, public vocabulary
 *   for extensions. Core may carry more fields; extensions must not depend
 *   on anything not listed here.
 * - NO Prisma imports. This package is published; Prisma types (and the
 *   generated client) are an internal implementation detail of core.
 * - Semver applies (`@de-otio/trellis-extension-api` is public): adding a
 *   type or an optional field is a minor bump; renaming/removing/narrowing
 *   is breaking (major once 1.x; coordinate + minor while 0.x).
 */

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/** Node type in the social graph. */
export type ExtensionNodeType = "user" | "entity";

/** Circle tier (0 = inner … 3 = ambient). */
export type ExtensionCircleTier = 0 | 1 | 2 | 3;

/** How a relationship was initially created. */
export type ExtensionConnectionMethod =
  | "code"
  | "import"
  | "suggestion"
  | "discovery";

/** Cursor-based pagination wrapper used by graph queries. */
export interface ExtensionPaginatedResult<T> {
  /** The result items */
  items: T[];
  /** Cursor to fetch the next page (null if no more results) */
  cursor: string | null;
  /** Whether more results exist beyond this page */
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Core domain shapes
// ---------------------------------------------------------------------------

/**
 * The shape of a core Entity as passed to extension hooks
 * (e.g. `onEntityCreated`).
 */
export interface ExtensionEntity {
  id: string;
  /** Tenant the entity belongs to (multi-tenancy is first-class in core). */
  tenantId: string;
  name: string;
  /** Extension id this entity belongs to (e.g. "dog"); null for untyped. */
  entityType: string | null;
  /** Extension-defined metadata, validated by the extension's metadataSchema. */
  metadata: unknown;
  /** Entity lifecycle status (e.g. "ACTIVE", "MEMORIAL"). */
  status: string;
  /** Taxonomy id computed by the extension's computeLifeStage (or null). */
  lifeStage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The shape of a core Post as passed to extension hooks
 * (e.g. `onPostCreated`).
 */
export interface ExtensionPost {
  id: string;
  /** Tenant the post was written in. */
  tenantId: string;
  authorId: string;
  text: string;
  /** Primary subject entity of the post, if any. */
  primaryEntityId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Graph result shapes (returned by ExtensionGraphService queries)
// ---------------------------------------------------------------------------

/** A scored relationship between a user and a target (user or entity). */
export interface ExtensionRelationship {
  /** Source user ID */
  userId: string;
  /** Type of the target node */
  targetType: ExtensionNodeType;
  /** Target node ID */
  targetId: string;
  /** Effective score (manualScore if set, otherwise computedScore). 0.0–1.0 */
  score: number;
  /** Algorithm-computed score based on interaction signals */
  computedScore: number;
  /** User-set manual override (null if not set) */
  manualScore: number | null;
  /** Resolved circle tier based on score */
  tier: ExtensionCircleTier;
  /** Total interaction count */
  interactionCount: number;
  /** Timestamp of last interaction */
  lastInteractionAt: Date | null;
  /** How the relationship was initially created */
  connectionMethod: ExtensionConnectionMethod;
  /** Whether the target also has a relationship back (user→user only) */
  reciprocated: boolean;
  /** When the relationship was created */
  createdAt: Date;
}

/** A member (user or entity) within a circle tier. */
export interface ExtensionCircleMember {
  id: string;
  type: ExtensionNodeType;
  name: string;
  score: number;
  tier: ExtensionCircleTier;
}

/** Status of a single circle tier. */
export interface ExtensionCircleTierStatus {
  tier: ExtensionCircleTier;
  /** Tier display name (e.g. "inner", "ambient"). */
  name: string;
  /** Whether all content has been seen */
  caughtUp: boolean;
  /** Number of posts not yet seen */
  unseenCount: number;
  /** When the user last marked this tier as read */
  lastReadAt: Date | null;
}

/** Per-entity status within a circle tier. */
export interface ExtensionCircleEntityStatus {
  entityId: string;
  entityName: string;
  caughtUp: boolean;
  unseenCount: number;
  latestPostAt: Date | null;
}

/** Glance mode: one recent item per entity in the circle. */
export interface ExtensionGlanceItem {
  targetId: string;
  targetType: ExtensionNodeType;
  targetName: string;
  /** Most recent post ID (fetch content from the DB) */
  postId: string;
  postCreatedAt: Date;
}

/** One row of a visible-post-IDs query. */
export interface ExtensionVisiblePost {
  postId: string;
  createdAt: Date;
  /** Tier of the closest relationship through which this post is visible. */
  resolvedTier: ExtensionCircleTier;
}

/** A typed, unscored relationship between two entities. */
export interface ExtensionEntityRelationship {
  entityId: string;
  relatedEntityId: string;
  /** Relationship type (extension-declared vocabulary, e.g. "PACK_MATE"). */
  type: string;
  /** Confirmation status. */
  status: "PENDING" | "CONFIRMED" | "REJECTED";
  /** User who proposed the relationship */
  proposedByUserId: string;
  /** When the relationship was created/proposed */
  since: Date;
}

// ---------------------------------------------------------------------------
// Recap (year-in-review) shapes
// ---------------------------------------------------------------------------

/** The window a recap was computed over, as ISO-8601 strings. */
export interface ExtensionRecapWindow {
  from: string;
  to: string;
}

/**
 * The neutral recap payload core's `RecapService` computes for a subject
 * (own-data-only aggregation — no cross-user comparison, no leaderboard/rank,
 * no percentile). Passed to `extendRecap` so an extension can attach domain
 * aggregates computed from its own tables for the same subject and window.
 *
 * Kept structurally in sync by hand with `RecapPayload` in
 * `apps/api/src/lib/recap-service.ts` (no Prisma dependency allowed here —
 * see the file header for why).
 */
export interface ExtensionRecapPayload {
  window: ExtensionRecapWindow;
  posts: {
    count: number;
    firstAt?: string;
    mostReactedPostId?: string;
  };
  /** Sentiment counts received on the subject's own posts, by emotion. */
  sentimentsReceived: Record<string, number>;
  /** New Relationship edges involving the subject, created within the window. */
  connectionsMade: number;
  topMoments: Array<{ postId: string; at: string }>;
  /** Domain fields attached by `extendRecap`, if any extension supplied them. */
  extension?: Record<string, unknown>;
}

/** The subject + window a recap was requested for, passed to `extendRecap`. */
export interface ExtensionRecapSubject {
  subjectType: ExtensionNodeType;
  subjectId: string;
  window: ExtensionRecapWindow;
}
