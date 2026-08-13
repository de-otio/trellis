// ===== dto.d.ts =====
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
/** Node type in the social graph. */
export type ExtensionNodeType = "user" | "entity";
/** Circle tier (0 = inner … 3 = ambient). */
export type ExtensionCircleTier = 0 | 1 | 2 | 3;
/** How a relationship was initially created. */
export type ExtensionConnectionMethod = "code" | "import" | "suggestion" | "discovery";
/** Cursor-based pagination wrapper used by graph queries. */
export interface ExtensionPaginatedResult<T> {
    /** The result items */
    items: T[];
    /** Cursor to fetch the next page (null if no more results) */
    cursor: string | null;
    /** Whether more results exist beyond this page */
    hasMore: boolean;
}
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
    topMoments: Array<{
        postId: string;
        at: string;
    }>;
    /** Domain fields attached by `extendRecap`, if any extension supplied them. */
    extension?: Record<string, unknown>;
}
/** The subject + window a recap was requested for, passed to `extendRecap`. */
export interface ExtensionRecapSubject {
    subjectType: ExtensionNodeType;
    subjectId: string;
    window: ExtensionRecapWindow;
}

// ===== extension.d.ts =====
/**
 * Extension API
 *
 * Defines the contract that all Trellis extensions must implement,
 * and the restricted context they receive at runtime.
 */
import type { ZodSchema } from "zod";
import type { Route } from "./route-types.js";
import type { ExtensionCircleEntityStatus, ExtensionCircleMember, ExtensionCircleTierStatus, ExtensionEntityRelationship, ExtensionGlanceItem, ExtensionPaginatedResult, ExtensionRecapPayload, ExtensionRecapSubject, ExtensionRelationship, ExtensionVisiblePost } from "./dto.js";
/**
 * Opaque tenant identifier — a branded string **minted only by core**.
 *
 * The brand is a zero-runtime-cost nominal marker (erases to a plain string).
 * There is deliberately **no constructor exported from this package**: extension
 * code receives a `TenantId` from core (e.g. via `ExtensionJobContext.tenant`)
 * and physically cannot forge one from a user-supplied string. Core mints it
 * through its private `mintTenantId(...)` and passes it across this boundary.
 *
 * (This package does not depend on `@de-otio/saas-foundation`, by design — the
 * foundation brand constructor must stay unreachable to extensions. Core casts
 * its foundation-branded value to this brand at the boundary; both erase to
 * `string`.)
 */
declare const ExtensionTenantIdBrand: unique symbol;
export type TenantId = string & {
    readonly [ExtensionTenantIdBrand]: true;
};
/**
 * A single tenant-bound model delegate on the scoped surface.
 *
 * Every operation is guaranteed tenant-bound by construction (core's scoped
 * proxy injects `tenantField = tenantId` on reads/writes and rewrites by-id ops
 * — O-1 design §5.1/§12.3). Args/returns are `unknown` at this contract layer
 * (not `any`): extensions pass the ordinary Prisma delegate argument shapes; the
 * concrete generated types are refined by core where available.
 */
export interface ScopedDelegate {
    findMany(args?: unknown): Promise<unknown[]>;
    findFirst(args?: unknown): Promise<unknown | null>;
    findUnique(args: unknown): Promise<unknown | null>;
    create(args: unknown): Promise<unknown>;
    createMany(args: unknown): Promise<{
        count: number;
    }>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{
        count: number;
    }>;
    upsert(args: unknown): Promise<unknown>;
    delete(args: unknown): Promise<unknown>;
    deleteMany(args?: unknown): Promise<{
        count: number;
    }>;
    count(args?: unknown): Promise<number>;
    aggregate(args: unknown): Promise<unknown>;
    groupBy(args: unknown): Promise<unknown[]>;
}
/**
 * The operation names the scoped surface exposes, derived from
 * {@link ScopedDelegate} so the two cannot drift. Used by {@link ScopedOf}.
 */
export type ScopedOperation = keyof ScopedDelegate;
/**
 * Narrow a generated Prisma model delegate to the scoped surface.
 *
 * `ScopedOf<Prisma.ExtDogProfileDelegate>` keeps exactly the operations the
 * proxy implements — with their real Prisma argument and result types — and
 * structurally drops everything else, `$queryRaw` included. Operations the
 * delegate does not have are simply absent rather than an error, so a Prisma
 * upgrade that renames or removes one does not break this type.
 *
 * This is how an extension gets typed access to its OWN models; see
 * {@link ScopedDb}.
 */
export type ScopedOf<TDelegate> = Pick<TDelegate, Extract<keyof TDelegate, ScopedOperation>>;
/**
 * Constraint for the extension-owned half of {@link ScopedDb}: model name to
 * delegate type.
 *
 * `object` rather than `ScopedDelegate` on purpose — the whole point is to
 * accept a *generated* Prisma delegate, whose method signatures are far more
 * precise than the erased contract shape and are not assignable to it. It is
 * still narrow enough to reject a map whose values are plainly not delegates.
 */
export type ExtensionModelMap = Record<string, object>;
/**
 * The permissive default for {@link ScopedDb} — any model name resolves to an
 * erased {@link ScopedDelegate}.
 *
 * This is what core itself uses, because core's registry holds extensions
 * whose model sets it cannot know statically. It is also the default for
 * extensions that have not declared their models, which keeps this whole
 * change additive — but it means a misspelled model name typechecks. Declare
 * a model map to close that.
 */
export interface OpenScopedModels {
    [model: string]: ScopedDelegate;
}
/** The 9 core models every extension sees on the scoped surface. */
export interface CoreScopedModels {
    entity: ScopedDelegate;
    post: ScopedDelegate;
    postEntity: ScopedDelegate;
    postMedia: ScopedDelegate;
    taxonomyTaxon: ScopedDelegate;
    taxonomyCategory: ScopedDelegate;
    taxonomyDimension: ScopedDelegate;
    productTaxonomyTag: ScopedDelegate;
    activity: ScopedDelegate;
}
/**
 * Tenant-scoped database surface — the ONLY way to touch data in request
 * context (O-1 design §5.1). Every delegate here is bound to the `TenantId`
 * passed to `ExtensionDb.tenant(tid)`; `findMany({})` returns only that tenant's
 * rows by construction. `queryRaw`/`executeRaw` are deliberately absent.
 *
 * Exposes the 9 core delegates ({@link CoreScopedModels}) plus this
 * extension's own (`ext_*`) models, keyed by camelCase model name.
 *
 * `TModels` is how an extension replaces `unknown` args and results on its own
 * models with its generated Prisma types. Declare the map once and thread it
 * through {@link TrellisExtension}:
 *
 * ```ts
 * import type { Prisma } from "@prisma/client";
 * import type { ScopedOf, TrellisExtension } from "@de-otio/trellis-extension-api";
 *
 * type DogModels = {
 *   extDogProfile: ScopedOf<Prisma.ExtDogProfileDelegate>;
 *   extDogWalk: ScopedOf<Prisma.ExtDogWalkDelegate>;
 * };
 *
 * export const dogExtension: TrellisExtension<DogModels> = { ... };
 * ```
 *
 * Inside a handler, `ctx.db.tenant(tid).extDogProfile.findMany({ where: … })`
 * is then fully typed, and `extDogProfiles` (a typo) is a compile error rather
 * than a runtime `undefined`.
 *
 * Omitting `TModels` keeps the previous behaviour exactly — see
 * {@link OpenScopedModels} for what that costs.
 */
export type ScopedDb<TModels extends ExtensionModelMap = OpenScopedModels> = CoreScopedModels & TModels;
/**
 * Scoped Prisma access for extensions (O-1 design §5.1 / §5.3).
 *
 * The **only** way to touch data: `tenant(tenantId)` returns a {@link ScopedDb}
 * whose every operation is tenant-bound by construction. There is deliberately
 * no raw delegate bag — the pre-launch unscoped-delegate wiring
 * (`extension-context.ts:57-67`) is not shipped at all (greenfield, §5.3): the
 * existing isolation hole is closed by construction, not migrated away from.
 * `queryRaw`/`executeRaw` are structurally absent from the scoped surface.
 *
 * Relationship data is available read-only via `ExtensionContext.graphService`;
 * extensions never query the social graph tables directly.
 */
export interface ExtensionDb<TModels extends ExtensionModelMap = OpenScopedModels> {
    /** The sanctioned, tenant-bound data surface (O-1 design §5.1). */
    tenant(tenantId: TenantId): ScopedDb<TModels>;
    /**
     * Cross-tenant READ-ONLY access to the models declared in
     * {@link TrellisExtension.crossTenantRead} (05a Part B). Every call runs
     * inside core's `runUnscoped` audit with reason `ext:<extensionId>:<reason>`,
     * results carry a mandatory per-model visibility floor (public/SHOUT content,
     * caller region), relation `where`/`include` traversal to non-declared models
     * is rejected, and columns are restricted to a per-model allow-list.
     *
     * Use for social/catalog discovery that is cross-tenant by construction (a
     * caller's feed candidates live in other users' personal tenants). For
     * anything owned or writable, use {@link tenant}.
     *
     * @param reason short machine-greppable slug, `/^[a-z0-9][a-z0-9-]{2,63}$/`.
     */
    discover(reason: string): DiscoverDb;
}
/**
 * Cross-tenant READ-ONLY surface (05a Part B). Keyed by model name; contains
 * exactly the models the extension declared in
 * {@link TrellisExtension.crossTenantRead}. Undeclared models resolve to a
 * fail-closed delegate that throws. Same read-only method set as the job
 * facade ({@link CrossTenantReadDelegate}) — no write op is reachable, at
 * runtime, not just in the type.
 */
export interface DiscoverDb {
    readonly [model: string]: CrossTenantReadDelegate;
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
    getRelationship(userId: string, targetType: string, targetId: string): Promise<ExtensionRelationship | null>;
    getRelationships(userId: string, options?: {
        tier?: number;
        targetType?: string;
        pagination?: unknown;
    }): Promise<ExtensionPaginatedResult<ExtensionRelationship>>;
    getRelationshipGraph(userId: string): Promise<unknown>;
    getCircleMembers(userId: string, tier: number): Promise<ExtensionCircleMember[]>;
    getVisiblePostIds(userId: string, tier: number, since: Date, pagination: unknown): Promise<ExtensionPaginatedResult<ExtensionVisiblePost>>;
    getGlanceItems(userId: string, tier: number, limit: number): Promise<ExtensionGlanceItem[]>;
    getDepthPostIds(userId: string, targetType: string, targetId: string, since: Date, limit: number): Promise<string[]>;
    getCircleStatus(userId: string): Promise<ExtensionCircleTierStatus[]>;
    getCircleEntityStatus(userId: string, tier: number): Promise<ExtensionCircleEntityStatus[]>;
    getEntityRelationships(entityId: string, options?: {
        type?: string;
        status?: string;
    }): Promise<ExtensionEntityRelationship[]>;
    getPendingEntityRelationships(userId: string): Promise<ExtensionEntityRelationship[]>;
    discoverByGraph(userId: string, hops: number, filters?: unknown): Promise<unknown[]>;
    discoverNearby(userId: string, lat: number, lng: number, radiusMeters: number, filters?: unknown): Promise<unknown[]>;
    getRecommendations(userId: string, limit: number): Promise<unknown[]>;
}
/**
 * Restricted context passed to extension code.
 * Core secrets (SESSION_SECRET, DATABASE_URL, API keys) are never exposed.
 */
export interface ExtensionContext<TModels extends ExtensionModelMap = OpenScopedModels> {
    /** Scoped database client — only extension-relevant tables */
    db: ExtensionDb<TModels>;
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
/**
 * Cadence at which a declared job runs.
 *
 * O-1 v1 ships the two coarse presets the lane-02 reminder sweep needs; the
 * deferred integration fabric (06) widens this union to minute-level presets.
 * Keep it a named alias so widening it is a non-breaking additive change.
 */
export type ExtensionJobSchedule = "hourly" | "daily";
/**
 * A single tenant-bound model delegate exposing READ operations only —
 * the shape of each entry in {@link ExtensionJobContext.read}.
 *
 * These reads are intentionally cross-tenant (a job scans across tenants, e.g.
 * a due-date sweep), so results are NOT tenant-filtered. Exposure is restricted
 * BY CONSTRUCTION to the models the job named in `crossTenantRead` — no write
 * ops, no core-model access here (core models are reachable only via
 * {@link ExtensionJobContext.tenant}).
 */
export interface CrossTenantReadDelegate {
    findMany(args?: unknown): Promise<unknown[]>;
    findFirst(args?: unknown): Promise<unknown | null>;
    count(args?: unknown): Promise<number>;
    aggregate(args: unknown): Promise<unknown>;
    groupBy(args: unknown): Promise<unknown[]>;
}
/**
 * The restricted context a declared job receives when it runs.
 *
 * Two capabilities, both auditable from the manifest (design §5.2):
 * - `read` — cross-tenant READ on the job's own declared models only.
 * - `tenant(tid)` — a fully tenant-scoped {@link ScopedDb} for per-row work,
 *   once a scanned row identifies its tenant. This is the only path to core
 *   models and to any write.
 */
export interface ExtensionJobContext<TModels extends ExtensionModelMap = OpenScopedModels> {
    /**
     * Cross-tenant read access, keyed by model name. Contains exactly the models
     * the job declared in `crossTenantRead` — nothing else is present.
     */
    read: Record<string, CrossTenantReadDelegate>;
    /** Bind a tenant for correctly-scoped per-row work (core + own models). */
    tenant(tenantId: TenantId): ScopedDb<TModels>;
    /** Deployment stage (dev, prod) — for logging/metrics. */
    stage: string;
    /**
     * Aborts when the runner's job timeout fires.
     *
     * The runner cannot interrupt a running job body; it can only stop waiting
     * on it. A long job should therefore check `signal.aborted` between batches
     * (and forward `signal` to any fetch/query that accepts one) so a timed-out
     * job stops doing work instead of running on unobserved.
     *
     * Always supplied by core. It was previously present at runtime but absent
     * from this type, so cooperative cancellation required a cast.
     */
    readonly signal: AbortSignal;
}
/**
 * An extension-declared scheduled job (O-1 design §5.2).
 *
 * The runner is in-process in the API container (NOT the worker Lambdas, which
 * load no extensions); cluster-wide single-flight is enforced by a DynamoDB
 * conditional-put lock keyed by job id. The manifest is the audit surface: the
 * only cross-tenant reads a job may perform are the models listed in
 * `crossTenantRead`.
 */
export interface ExtensionJobDecl<TModels extends ExtensionModelMap = OpenScopedModels> {
    /** Stable job id, unique within the extension (e.g. "reminder-sweep"). */
    id: string;
    /** How often the job runs. */
    schedule: ExtensionJobSchedule;
    /**
     * The extension's OWN models this job may scan cross-tenant. Never core
     * models. Enforced by construction when the job context is built.
     */
    crossTenantRead: string[];
    /** The job body. Receives the restricted {@link ExtensionJobContext}. */
    run(jobCtx: ExtensionJobContext<TModels>): Promise<void>;
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
 * The sanctioned way to do that is to assign it to
 * {@link TrellisExtension.extensionApiVersion} — core then performs the
 * compatibility check itself at boot and fails startup on an incompatible
 * pairing, instead of every extension hand-rolling the comparison.
 *
 * When to update:
 *   - Bump alongside every `package.json` version change.
 *   - Never change one without changing the other.
 */
export declare const EXTENSION_API_VERSION: "0.9.1";
/** Display-only Actor fields that extensions can customize */
export interface ActorEnrichment {
    /** Actor summary / bio — rendered on remote instances */
    summary?: string;
    /** Profile icon */
    icon?: {
        type: "Image";
        url: string;
        mediaType?: string;
    };
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
 * The authenticated caller, as seen by an extension route handler.
 *
 * Core builds this by whitelist (never by spreading its internal session), so
 * only these fields cross the boundary — `csrfToken`, `mfaVerified`,
 * `dataRegion`, `ageTier`, etc. stay core-private.
 */
export interface ExtensionSession {
    userId: string;
    email: string;
    role: string;
    /**
     * The caller's verified active tenant, minted by core with `"session"`
     * provenance. Populated from a verified Cognito JWT claim, or (for pure
     * cookie sessions) from the caller's personal tenant read server-side.
     * Absent when the session has no verifiable tenant. This is the ONLY way a
     * route handler obtains a `TenantId` — pass it to `ctx.db.tenant(tid)`.
     */
    tenantId?: TenantId;
}
/**
 * Extension route handler function.
 * Receives parsed request, params, session, and scoped context.
 * Returns a data object — core handles HTTP wiring.
 */
export type ExtensionHandler<TModels extends ExtensionModelMap = OpenScopedModels> = (request: Request, params: Record<string, string>, session: ExtensionSession | null, ctx: ExtensionContext<TModels>) => Promise<ExtensionResponse>;
/**
 * Route definition provided by an extension.
 * Core wraps it with auth, CORS, security headers, and error handling.
 */
export interface ExtensionRouteDefinition<TModels extends ExtensionModelMap = OpenScopedModels> {
    /** Path pattern — served at /api/ext/{extensionId}/{path} */
    path: string;
    method: string | string[];
    /** Auth requirement (default: "required") */
    auth?: "required" | "optional" | "none";
    description?: string;
    /**
     * Declared as a METHOD, not as a `handle: ExtensionHandler<TModels>`
     * property, and the difference is load-bearing.
     *
     * Under `strictFunctionTypes` a function-typed property compares its
     * parameters contravariantly, so a route whose handler takes
     * `ExtensionContext<DogModels>` would not be assignable to the
     * `ExtensionContext<OpenScopedModels>` core's registry holds — which would
     * make declaring a model map impossible for exactly the extensions that
     * want one. TypeScript compares method parameters bivariantly, so this
     * declaration form is what lets a typed extension register with untyped
     * core. Verified in `extension-api-generic-scoped-db.test-d.ts`.
     *
     * The soundness this gives up is theoretical here: core supplies the
     * context, and it supplies the same proxy either way.
     */
    handle(request: Request, params: Record<string, string>, session: ExtensionSession | null, ctx: ExtensionContext<TModels>): Promise<ExtensionResponse>;
}
/**
 * The main contract.
 *
 * `TModels` optionally declares this extension's OWN Prisma models so that
 * `ctx.db.tenant(tid).myModel` is typed rather than `unknown` — see
 * {@link ScopedDb} for the recipe and {@link ScopedOf} for the per-model
 * helper. Omitting it is fully supported and changes nothing.
 */
export interface TrellisExtension<TModels extends ExtensionModelMap = OpenScopedModels> {
    /** Unique ID — must be lowercase alphanumeric, 2-32 chars, not a reserved word */
    id: string;
    /**
     * The semver of `@de-otio/trellis-extension-api` this extension was **built
     * against** — normally `EXTENSION_API_VERSION` imported from this package,
     * so a rebuild keeps it truthful automatically:
     *
     * ```ts
     * import { EXTENSION_API_VERSION } from "@de-otio/trellis-extension-api";
     * export const dogExtension: TrellisExtension = {
     *   id: "dog",
     *   extensionApiVersion: EXTENSION_API_VERSION,
     *   // …
     * };
     * ```
     *
     * Core checks this at startup, before serving:
     * - **Absent** → core logs one warning at boot and continues. Declaring it
     *   is strongly recommended (an undeclared extension gets no protection
     *   against a silently incompatible core), but it is never fatal — existing
     *   extensions keep working across an upgrade.
     * - **Declared and incompatible** → core **fails startup**, naming both
     *   versions. Incompatible means a differing major, or (while the extension
     *   API is still `0.x`, where minors are breaking) a differing minor.
     * - **Declared and merely drifted** (same compatibility window, different
     *   patch — or different minor once the API reaches `1.x`) → core logs;
     *   rebuild at your convenience.
     * - **Declared but unparseable** → core fails startup with a validation
     *   error naming the offending value.
     *
     * Format: `<major>.<minor>.<patch>`, each part 1–4 digits, with an optional
     * `-`/`+` suffix that is ignored for comparison (e.g. `"0.8.0"`,
     * `"0.8.0-alpha.1"`). Values longer than 64 characters are rejected.
     *
     * Optional and additive — omitting it is valid.
     */
    extensionApiVersion?: string;
    /** Display terminology */
    terminology: {
        entity: string;
        entityPlural: string;
    };
    /** Routes to register — cannot use reserved prefixes */
    routes: Route[];
    /** Zod schema for Entity.metadata when entityType matches this extension */
    metadataSchema: ZodSchema;
    /**
     * Scheduled jobs this extension declares (O-1 design §5.2).
     * Run in-process in the API container with cluster-wide single-flight.
     * Additive/optional — omit if the extension has no scheduled work.
     */
    jobs?: ExtensionJobDecl<TModels>[];
    /**
     * Models this extension may read cross-tenant from routes, hooks, and
     * strategies via `ctx.db.discover(reason)` (05a Part B). Validated at
     * registration against the core discover allow-list ∪ this extension's own
     * (`ext_*`) models; an undeclarable model FAILS STARTUP. Jobs keep their own
     * per-job `crossTenantRead` (own-models-only) — this is the route/strategy
     * surface. Omit if the extension performs no cross-tenant reads.
     */
    crossTenantRead?: string[];
    /** Core-wrapped extension routes — preferred over raw `routes` */
    extensionRoutes?: ExtensionRouteDefinition<TModels>[];
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
    computeLifeStage?: (metadata: any, manualOverride: boolean, existingLifeStage: string | null) => string | null;
    /**
     * Attach domain-specific aggregates to a year-in-review recap.
     *
     * Called by core's `RecapService` after it computes the neutral
     * `ExtensionRecapPayload` for a subject (own-data-only: posts, sentiments
     * received, connections made — no cross-user comparison, no leaderboard).
     * The extension may compute additional aggregates from ITS OWN tables
     * (e.g. a dogs extension: walks logged, pack-mates met) for the same
     * subject and window, and return them as a flat object. Core merges the
     * result under `payload.extension` — core itself never emits domain
     * vocabulary.
     *
     * Mirrors `activityPub.enrichActor`: display-only enrichment, no writes.
     * Optional — omit if the extension has no recap aggregates to attach.
     */
    extendRecap?(payload: ExtensionRecapPayload, subject: ExtensionRecapSubject, ctx: ExtensionContext<TModels>): Promise<Record<string, unknown>>;
    /** Called on server shutdown (SIGTERM/SIGINT) */
    shutdown?: () => Promise<void>;
}
export {};

// ===== index.d.ts =====
/**
 * @de-otio/trellis-extension-api
 *
 * Public types for building Trellis extensions.
 */
export type { TrellisExtension, ExtensionContext, ExtensionGraphService, ExtensionDb, ScopedDb, ScopedDelegate, ScopedOperation, ScopedOf, ExtensionModelMap, OpenScopedModels, CoreScopedModels, TenantId, ExtensionJobDecl, ExtensionJobContext, ExtensionJobSchedule, CrossTenantReadDelegate, ExtensionRouteDefinition, ExtensionHandler, ExtensionSession, ExtensionResponse, DiscoverDb, ActorEnrichment, } from "./extension.js";
export { EXTENSION_API_VERSION } from "./extension.js";
export type { Route, RoutePattern, Middleware, MiddlewareContext } from "./route-types.js";
export type { ExtensionNodeType, ExtensionCircleTier, ExtensionConnectionMethod, ExtensionPaginatedResult, ExtensionEntity, ExtensionPost, ExtensionRelationship, ExtensionCircleMember, ExtensionCircleTierStatus, ExtensionCircleEntityStatus, ExtensionGlanceItem, ExtensionVisiblePost, ExtensionEntityRelationship, ExtensionRecapWindow, ExtensionRecapPayload, ExtensionRecapSubject, } from "./dto.js";

// ===== route-types.d.ts =====
/**
 * Route Types
 *
 * Shared types for route definitions used by both core and extensions.
 */
/** Route pattern — exact path, prefix with *, or regex */
export type RoutePattern = string | RegExp;
/** Middleware context passed to middleware functions */
export interface MiddlewareContext {
    request: Request;
    url: URL;
    pathname: string;
    method: string;
    requestContext?: unknown;
}
/** Middleware function — wraps a handler with pre/post processing */
export type Middleware = (context: MiddlewareContext, next: () => Promise<Response>) => Promise<Response>;
/** Route definition */
export interface Route {
    /**
     * Route pattern (exact path, prefix with *, or regex)
     * Examples:
     * - '/health' (exact)
     * - '/auth/*' (prefix)
     * - '/api/users/:id' (with parameter)
     * - /^\/api\/posts\/(\d+)$/ (regex)
     */
    path: RoutePattern;
    /** HTTP method(s) - '*' for all methods, or specific method(s) */
    method?: string | string[];
    /** Route handler function */
    handler: (request: Request, env: unknown, context: {
        url: URL;
        pathname: string;
        params: Record<string, string>;
        requestContext?: unknown;
    }) => Promise<Response>;
    /** Middleware to apply (executed in order) */
    middleware?: Middleware[];
    /** Route description (for documentation) */
    description?: string;
    /** API version (for versioning support) */
    version?: string;
}
