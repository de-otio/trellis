/**
 * Route Registry
 *
 * Centralized route registry for the API.
 * This provides a cleaner way to organize routes and enables features like:
 * - Route versioning
 * - Middleware composition
 * - Route documentation
 * - Route testing
 *
 * Routes are organized by domain/feature in separate files and combined here.
 */

import {
  createRequestContext as createAmbientRequestContext,
  runWithRequestContext,
} from "@de-otio/saas-foundation/request-context";
import type { TrellisExtension } from "@de-otio/trellis-extension-api";

import type { Env } from "../../env.js";
import { requireScope, InsufficientScopeError } from "../auth/require.js";
import { generateRequestId } from "../logger.js";
import { corsMiddleware } from "../middleware.js";
import {
  idempotencyMiddleware,
  routeNeedsIdempotency,
} from "../middleware/idempotency.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import {
  structuredError,
  unauthorizedError,
  type ErrorRouteMeta,
} from "./errors.js";
import { actorRoutes } from "./activitypub/actor.js";
import { audienceRoutes } from "./activitypub/audiences.js";
import { collectionRoutes } from "./activitypub/collections.js";
import { friendsRoutes } from "./activitypub/friends.js";
import { groupRoutes } from "./activitypub/group.js";
import { inboxRoutes } from "./activitypub/inbox.js";
import { messageRoutes } from "./activitypub/messages.js";
import { outboxRoutes } from "./activitypub/outbox.js";
import { postRoutes as activitypubPostRoutes } from "./activitypub/post.js";
import { entityProfileRoutes } from "./activitypub/entity-profile.js";
import { webfingerRoutes } from "./activitypub/webfinger.js";
import { adminRoutes } from "./admin.js";
import { adminCostRoutes } from "./admin-costs.js";
import { appMetaRoutes } from "./app-meta.js";
import { authRoutes } from "./auth.js";
import { authDiscoverRoutes } from "./auth-discover.js";
import { badgesRoutes } from "./badges.js";
import { commentsRoutes } from "./comments.js";
import { contentDiscoveryRoutes } from "./content-discovery.js";
import { dashboardRoutes } from "./dashboard.js";
import { deletionRoutes } from "./deletion.js";
import { devicesRoutes } from "./devices.js";
import { employeesRoutes } from "./employees.js";
import { entitiesRoutes } from "./entities.js";
import { exportRoutes } from "./export.js";
import { featureFlagsRoutes } from "./feature-flags.js";
import { feedsRoutes } from "./feeds.js";
import { relationshipRoutes } from "./relationships.js";
import { blockRoutes } from "./blocks.js";
import { emailSubscriptionRoutes } from "./email-subscriptions.js";
import { curatedCollectionRoutes } from "./collections.js";
import { eventsRoutes } from "./events.js";
import { recapRoutes } from "./recap.js";
import { circleRoutes } from "./circles.js";
import { discoveryRoutes } from "./discovery.js";
import { entityRelationshipRoutes } from "./entity-relationships.js";
import { connectionCodeRoutes } from "./connection-codes.js";
import { agentSurfaceRoutes } from "./agent-surface.js";
import { healthRoutes } from "./health.js";
import { internaldocsRoutes } from "./internal-docs.js";
import { invitationsRoutes } from "./invitations.js";
import { linkReportRoutes } from "./link-reports.js";
import { reportRoutes } from "./reports.js";
import { reportCategoryAdminRoutes } from "./report-category-admin.js";
import { contentReportAdminRoutes } from "./content-report-admin.js";
import { moderationFeedbackRoutes } from "./moderation-feedback.js";
import { mapRoutes } from "./map.js";
import { mediaRoutes } from "./media.js";
import { mediaReviewRoutes } from "./media-review.js";
import { provenanceCorrectionRoutes } from "./provenance-correction.js";
import { mfaRoutes } from "./mfa.js";
import { mediaMetadataVisibilityRoutes } from "./media-metadata-visibility.js";
import { uploadSessionRoutes } from "./upload-sessions.js";
import { orphanedMediaRoutes } from "./orphaned-media.js";
import { orphanedMediaHealthRoutes } from "./orphaned-media-health.js";
import { outRoutes } from "./out.js";
import { postsRoutes } from "./posts.js";
import { privacyRoutes } from "./privacy.js";
import { productTaxonomyRoutes } from "./products.js";
import { notificationsRoutes } from "./notifications.js";
import { parentalControlRoutes } from "./parental-controls.js";
import { sentimentsRoutes } from "./sentiments.js";
import { settingsRoutes } from "./settings.js";
import { taxonomyRoutes } from "./taxonomy.js";
import { taxonomyAnalyticsRoutes } from "./taxonomy-analytics.js";
import type { Route, RoutePattern } from "./types.js";
import { tenantRoutes } from "./tenants.js";
import { tenantAuditRoutes } from "./tenant-audit.js";
import { tenantComplianceRoutes } from "./tenant-compliance.js";
import { setupStatusRoutes } from "./setup-status.js";
import { tenantDomainRoutes } from "./tenant-domains.js";
import { tenantIdpRoutes } from "./tenant-idp.js";
import { tenantMemberRoutes } from "./tenant-members.js";
import { tenantRoleMappingRoutes } from "./tenant-role-mappings.js";
import { tenantClassificationRoutes } from "./tenant-classification.js";
import { tenantDirectoryProfileRoutes } from "./tenant-directory-profile.js";
import { tenantDirectorySearchRoutes } from "./tenant-directory-search.js";
import { platformCategoryAdminRoutes } from "./platform-category-admin.js";
import { userRoutes } from "./user.js";
import { oauthRoutes } from "./oauth.js";
import { agentAuthorizeRoutes } from "./agent-authorize.js";
import { agentSessionsRoutes } from "./agent-sessions.js";

/**
 * G4 MEDIUM-3: mark a whole module's routes as `publicSpec: true` — the
 * curated agent-integration surface, as opposed to every registered handler.
 *
 * Plan 034 lane G.1 makes the **per-route flag authoritative where present**:
 * a route that has already decided its own `publicSpec` (either direction)
 * keeps that decision. Before, this wrapper overwrote it, so a route module
 * could not opt *out* of a module-level mark — which is the wrong direction
 * for a flag on the path to `/api/v1`.
 *
 * `publicSpec: true` alone does **not** make a route public. See
 * {@link isPublicRoute}: publication additionally requires a `scopes`
 * declaration, so the routes this wrapper marks are "curated for the spec,
 * not yet published" until their module declares what a third-party
 * principal must hold. That is a deliberate fail-closed transitional state,
 * not an error — the mark is what puts a module inside the error-format
 * lint's discovered set (`test/unit/routes/error-format.lint.test.ts`), which
 * is exactly the work that has to happen *before* a route is published.
 */
function markPublicSpec(routes: Route[]): Route[] {
  return routes.map((r) => (r.publicSpec === undefined ? { ...r, publicSpec: true } : r));
}

/**
 * Master switch for ActivityPub federation, read once at module load (the value
 * is a deploy-time constant). When false, the federation-facing routes below are
 * never registered, so a federation-disabled deploy exposes no actor / inbox /
 * outbox / public AP-object surface — even to a request that bypasses CloudFront
 * by hitting an internet-facing ALB directly. Mirrors `env.ACTIVITYPUB_ENABLED`.
 */
const activityPubEnabled = process.env.ACTIVITYPUB_ENABLED === "true";

/**
 * Authenticated app endpoints (e.g. the `/api/messages` DM API and
 * `/api/audiences` API) live in the same route modules as the public,
 * federation-facing AP-object endpoints (`/messages/:id`, `/audiences/:id`).
 * Keep the `/api/*` endpoints always on; gate only the federation-facing ones.
 */
const appOnly = (route: Route): boolean =>
  activityPubEnabled ||
  (typeof route.path === "string" && route.path.startsWith("/api/"));

/**
 * Core routes — domain-agnostic functionality.
 * Extension routes are merged below.
 */
const coreRoutes: Route[] = [
  // Health and configuration (highest priority)
  ...healthRoutes,

  // App metadata: client version policy (unauthenticated, env-only, cacheable).
  // Already carries `publicSpec: true` in its own module.
  ...appMetaRoutes,

  // Agent discovery surface (T9b-a): /llms.txt, /openapi.json, /security.txt
  ...markPublicSpec(agentSurfaceRoutes),

  // Authentication
  ...authRoutes,

  // Sign-in discovery (pre-login, no auth required)
  ...markPublicSpec(authDiscoverRoutes),

  // MFA (multi-factor authentication)
  ...mfaRoutes,

  // User profile management
  ...userRoutes,

  // Tenant CRUD + auth switch
  ...markPublicSpec(tenantRoutes),

  // Tenant domain verification
  ...markPublicSpec(tenantDomainRoutes),

  // Tenant identity provider (OIDC)
  ...markPublicSpec(tenantIdpRoutes),

  // Tenant members (list/patch role/remove)
  ...markPublicSpec(tenantMemberRoutes),

  // Tenant role mappings (CRUD)
  ...markPublicSpec(tenantRoleMappingRoutes),

  // Tenant classification (org-category self-declaration) — T1
  ...tenantClassificationRoutes,

  // Tenant directory profile (discoverability + location precision) — T3
  ...tenantDirectoryProfileRoutes,

  // Directory search (name/category/location, triangulation-safe) — T4
  ...tenantDirectorySearchRoutes,

  // Platform category admin (SUPER_ADMIN-only taxonomy management) — T5
  ...platformCategoryAdminRoutes,

  // Tenant audit log
  ...markPublicSpec(tenantAuditRoutes),

  // Tenant compliance bundle (T9b-e)
  ...markPublicSpec(tenantComplianceRoutes),

  // Tenant setup-status (T9b-b)
  ...markPublicSpec(setupStatusRoutes),

  // OAuth device-authorization adapter (T9b-d, RFC 8628)
  ...markPublicSpec(oauthRoutes),

  // Agent-authorize page (HTML approval flow)
  ...markPublicSpec(agentAuthorizeRoutes),

  // User-facing agent sessions (list + revoke)
  ...markPublicSpec(agentSessionsRoutes),

  // Internal documentation
  ...internaldocsRoutes,

  // Orphaned media health monitoring (must be before admin wildcard routes)
  ...orphanedMediaHealthRoutes,

  // Admin routes (super-admin, feature toggles, role metadata)
  ...adminCostRoutes,
  ...adminRoutes,

  // Dashboard routes (internal dashboard, partner dashboard, user management)
  ...dashboardRoutes,

  // Badges
  ...badgesRoutes,

  // Employees
  ...employeesRoutes,

  // Invitations
  ...invitationsRoutes,

  // Map
  ...mapRoutes,

  // Entities (replaces Dogs for white-label support)
  ...entitiesRoutes,

  // Feeds
  ...feedsRoutes,

  // Posts
  ...postsRoutes,

  // Comments
  ...commentsRoutes,

  // Sentiments/Reactions
  ...sentimentsRoutes,
  // Realtime / server-blind settings sync
  ...settingsRoutes,

  // Media uploads
  ...mediaRoutes,

  // Media REVIEW-queue moderator surface (T9 — MODERATOR-only)
  ...mediaReviewRoutes,

  // Staff-reviewed provenance correction (D12 — MODERATOR-only). The only path
  // that can REDUCE a synthetic-content disclosure; the author edit path is
  // monotonic. Closes the GDPR Art. 16 gap that monotonicity alone created.
  ...provenanceCorrectionRoutes,

  // Media metadata privacy controls
  ...mediaMetadataVisibilityRoutes,

  // Upload sessions (optimistic image uploads)
  ...uploadSessionRoutes,

  // Orphaned media management
  ...orphanedMediaRoutes,

  // Privacy preferences
  ...privacyRoutes,

  // Notifications (Safer Social Design)
  ...notificationsRoutes,

  // Push device registration (T8 — see lib/doc/push-device-contract.md)
  ...devicesRoutes,

  // Parental Controls (Safer Social Design)
  ...parentalControlRoutes,

  // User export
  ...exportRoutes,

  // Account deletion
  ...deletionRoutes,

  // Relationships (circles model — replaces followers and the legacy
  // KV-backed friends endpoints, which were removed in the pre-launch
  // schema end-state pass; see lib/friend-ids.ts)
  ...relationshipRoutes,

  // User blocks (the user-side remedy — see lib/block-visibility.ts)
  ...blockRoutes,

  // Circles (content views)
  ...circleRoutes,

  // Entity Relationships (entity-to-entity)
  ...entityRelationshipRoutes,

  // Connection Codes
  ...connectionCodeRoutes,

  // Discovery
  ...discoveryRoutes,

  // Taxonomy
  ...taxonomyRoutes,

  // Content Discovery
  ...contentDiscoveryRoutes,

  // Taxonomy Analytics
  ...taxonomyAnalyticsRoutes,

  // Product Taxonomy Tags
  ...productTaxonomyRoutes,

  // Feature Flags
  ...featureFlagsRoutes,

  // Link Reports
  ...linkReportRoutes,

  // Content reports (compliance plan 08 §2.2 — Art. 16 notice path)
  ...reportRoutes,

  // Report-category admin (SUPER_ADMIN-only, data-driven category vocabulary)
  ...reportCategoryAdminRoutes,

  // CONTENT-report review queue (SUPER_ADMIN-only; the LINK queue in admin.ts
  // is deliberately separate — different state machine, different payload)
  ...contentReportAdminRoutes,

  // Moderation feedback + owner-scoped disposition (spec 07 §4 / plan 08 Phase 2)
  ...moderationFeedbackRoutes,

  // Out Redirector (public endpoint, must be before 404 handler)
  ...outRoutes,

  // ActivityPub routes (public endpoints, must be before 404 handler).
  // Note: these use /users/:username and /posts/:postId patterns (no /api prefix)
  // and are unauthenticated (inbox is signature-verified, the rest are public).
  // Registered ONLY when federation is enabled — see `activityPubEnabled` above.
  // WebFinger must be early for actor discovery.
  ...(activityPubEnabled
    ? [
        ...webfingerRoutes,
        ...actorRoutes,
        ...inboxRoutes,
        ...outboxRoutes,
        ...friendsRoutes,
        ...groupRoutes,
        ...collectionRoutes,
        ...entityProfileRoutes,
        ...activitypubPostRoutes,
      ]
    : []),

  // Direct messages: authenticated `/api/messages*` endpoints are always on;
  // the public AP-object form (`/messages/:messageId`, no auth) is gated.
  ...messageRoutes.filter(appOnly),

  // Custom audiences: authenticated `/api/audiences*` always on; the public
  // collection (`/audiences/:audienceId`) is gated.
  ...audienceRoutes.filter(appOnly),

  // H12 — open social web (all gated OFF-by-default via featureToggleMiddleware).
  ...emailSubscriptionRoutes,
  ...curatedCollectionRoutes,
  ...recapRoutes,

  // R1 — Events primitive (gated OFF-by-default via featureToggleMiddleware).
  ...eventsRoutes,
];

// Merge extension routes (after core, before 404)
import { getExtensions } from "../../extensions.js";
import { wrapExtensionRoutes } from "../extension-route-wrapper.js";

/**
 * The public namespace. Path, not header, deliberately: AI-generated clients
 * hardcode paths and rarely send version headers, `/v2` can coexist with `/v1`
 * during a deprecation window, and every comparable an agent has been trained
 * on versions by path.
 *
 * Not to be confused with `X-Client-Version` + `/api/app/version-policy`, which
 * is a *first-party client compatibility* mechanism and stays exactly as it is.
 */
export const PUBLIC_API_PREFIX = "/api/v1";

const UNVERSIONED_PREFIX = "/api/";
const VERSIONED_PREFIX = `${PUBLIC_API_PREFIX}/`;

/**
 * Carry an extension route's **self-description** onto the `Route` core mounts
 * for it (plan 034 lane G.1).
 *
 * `wrapExtensionRoute` builds the HTTP shell — auth, scope enforcement, body
 * validation, CORS/CSRF, security headers, the scoped `ExtensionContext` — but
 * emits a `Route` carrying none of the declaring `ExtensionRouteDefinition`'s
 * metadata. The consequence was structural: an extension route could never be
 * `publicSpec`, never appear in `/openapi.json`, and therefore never be public,
 * no matter what its author declared. An extension route is exactly the kind of
 * route a vertical wants public, so the metadata is projected here.
 *
 * The zip is index-aligned by construction: `wrapExtensionRoutes` is
 * `ext.extensionRoutes.map(...)`, so element *i* of the result is the wrapper
 * for definition *i*. Nothing filters between them.
 *
 * One wiring rule is enforced here, mirroring lane A's `auth: "none"` +
 * non-empty-`scopes` refusal: a `publicSpec` route with `auth: "none"` has no
 * principal at all, so the public mount's authenticate → scope pipeline could
 * never hold for it. Refused at boot rather than served looking gated.
 */
function describedExtensionRoutes(ext: TrellisExtension): Route[] {
  const defs = ext.extensionRoutes ?? [];
  return wrapExtensionRoutes(ext).map((route, index) => {
    const def = defs[index];
    if (!def) return route;
    if (def.publicSpec === true && (def.auth ?? "required") === "none") {
      throw new Error(
        `Extension "${ext.id}" route "${def.path}" declares publicSpec: true ` +
          `with auth: "none". A public route is mounted under ${PUBLIC_API_PREFIX} ` +
          `behind authenticate → requireScope, so it must be able to have a ` +
          `principal — set auth to "required" (or "optional"), or drop publicSpec.`,
      );
    }
    return {
      ...route,
      ...(def.scopes !== undefined ? { scopes: [...def.scopes] } : {}),
      ...(def.publicSpec !== undefined ? { publicSpec: def.publicSpec } : {}),
      ...(def.requestSchema !== undefined ? { requestSchema: def.requestSchema } : {}),
      ...(def.responseSchema !== undefined ? { responseSchema: def.responseSchema } : {}),
      ...(def.operationId !== undefined ? { operationId: def.operationId } : {}),
      ...(def.idempotent !== undefined ? { idempotent: def.idempotent } : {}),
      ...(def.stability !== undefined ? { stability: def.stability } : {}),
    };
  });
}

/**
 * Extension routes, rebuilt from the live registry on each call.
 *
 * Deliberately a function, not a module-level constant: `registerExtension` is
 * called by the consuming application *after* this module is imported, so a
 * value computed at module evaluation is empty in production. (The `routes`
 * aggregate below still evaluates it once at module load — that is the
 * pre-existing behaviour of this file and the reason `lib/app.ts` calls
 * `getExtensions()` itself at `buildHonoApp()` time rather than reading the
 * aggregate. `buildPublicV1Routes()` is callable at build time for the same
 * reason.)
 */
function buildExtensionRoutes(): Route[] {
  return [
    // Raw routes (legacy — app-side wired handlers).
    //
    // SEC M5 / TRUST MODEL: extensions are NOT sandboxed. A raw route is spliced
    // into the core table verbatim — core applies no auth, no CSRF and no
    // security headers, and the handler is invoked with the full core `Env`
    // (SESSION_SECRET, DATABASE_URL, every KV binding and queue). Registering an
    // extension is therefore a decision to trust its code at the same level as
    // core code. `validateExtensions` now REJECTS at startup any raw route with
    // no auth middleware, so the unauthenticated-with-full-Env shape can no
    // longer boot; the remaining exposure (a raw route's access to `Env`) is
    // inherent to this legacy path. Prefer `extensionRoutes` below.
    ...getExtensions().flatMap((ext) => ext.routes as Route[]),
    // Core-wrapped routes (clean pattern — extension provides handler, core wraps)
    ...getExtensions().flatMap((ext) => describedExtensionRoutes(ext)),
  ];
}

const extensionRoutes: Route[] = buildExtensionRoutes();

// ═══════════════════════════════════════════════════════════════════════════
// The public mount (plan 034 lane G)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * **In the spec ⇔ under `/api/v1` ⇔ covered by the additivity gate.**
 *
 * Three properties that must never diverge, so they are not three decisions.
 * `isPublicRoute` is the single predicate, and everything downstream reads it:
 *
 *  - `buildPublicV1Routes()` derives the `/api/v1` mount from it;
 *  - `generateOpenApiDoc` (`lib/openapi/generator.ts`) filters on exactly the
 *    same two fields, so the emitted document and the mount are the same set
 *    by construction rather than by agreement;
 *  - the additivity gate (`scripts/check-openapi-additivity.mjs`) reads that
 *    document, so gate coverage follows for free.
 *
 * A route is public iff **both**:
 *
 *  - `publicSpec === true` — its module curated it for the published surface,
 *    and (the error-format lint keys off the same flag) its 4xx bodies go
 *    through `structuredError`; and
 *  - `scopes` is an **array** — its module said what a third-party principal
 *    must hold. `[]` is a real, distinct value meaning "authenticated, no
 *    particular grant"; `undefined` means the question has not been answered.
 *
 * Neither half alone publishes anything, and both directions of a half-wired
 * route fail *closed*:
 *
 *  - `publicSpec` without `scopes` — curated but unpublished. Not an error:
 *    `markPublicSpec` puts thirteen route sets in this state today and none of
 *    them is public. It is the state a route sits in while its module does the
 *    envelope and schema work.
 *  - `scopes` without `publicSpec` — a scope declaration nothing enforces,
 *    because only this mount checks scopes on a core route. That one **is** an
 *    error and {@link assertPublicMountWiring} throws on it at startup: a route
 *    that looks gated and is not is the failure this lane exists to prevent.
 */
export function isPublicRoute(route: Route): boolean {
  return route.publicSpec === true && Array.isArray(route.scopes);
}

/**
 * Hand-written `/api/v1` paths that predate this lane and are **not** public
 * routes. The namespace is derived from `isPublicRoute`, never typed by hand,
 * so any other occurrence is a route occupying the public namespace without
 * the public enforcement — {@link assertPublicMountWiring} refuses it at boot.
 *
 * Each entry is keyed by `String(route.path)` and must carry its reason.
 */
const LEGACY_UNENFORCED_V1_PATHS: ReadonlySet<string> = new Set<string>([
  // routes/sentiments.ts — `GET /api/v1/posts/:id/sentiments/users` was written
  // with a `/api/v1` literal before any versioning rule existed (the handler
  // even re-parses the path with that prefix). It is a first-party,
  // session-authenticated route: not `publicSpec`, no `scopes`, absent from
  // `/openapi.json`. Recorded 2026-09-04 for owner follow-up — the fix is to
  // rename it to `/api/posts/:id/sentiments/users` (routes/sentiments.ts is not
  // this lane's file, and nothing is live, so the rename is cheap and deferred).
  String(/^\/api\/v1\/posts\/([^/]+)\/sentiments\/users$/),
]);

/**
 * The `/api/v1` path a route is published at: its own path with the leading
 * `/api/` replaced by `/api/v1/`. `/api/users/me/tenants` becomes
 * `/api/v1/users/me/tenants` — not `/api/v1/api/...`.
 *
 * The result is always a **string** path, even for a regex route, because the
 * two consumers disagree about regexes and a string satisfies both: the Hono
 * router (`lib/app.ts` `regexToHonoPath`) translates only *unnamed* `([^/]+)`
 * captures, while the OpenAPI generator *requires* named ones on a public
 * route. A route whose named captures are rewritten here to `:name` segments
 * mounts under Hono and emits `{name}` in the spec.
 *
 * Returns `null` for anything that cannot be published: a path outside `/api/`
 * (the root-level well-known documents — `/llms.txt`, `/security.txt`,
 * `/openapi.json` — are unversioned by their own conventions and are not API
 * operations), a wildcard, an unanchored regex, or a regex with an unnamed
 * capture or any surviving metacharacter.
 */
export function toPublicPath(pattern: RoutePattern): string | null {
  if (typeof pattern === "string") {
    if (!pattern.startsWith(UNVERSIONED_PREFIX) || pattern.includes("*")) return null;
    return VERSIONED_PREFIX + pattern.slice(UNVERSIONED_PREFIX.length);
  }

  let src = pattern.source;
  if (!src.startsWith("^") || !src.endsWith("$")) return null;
  src = src.slice(1, -1).replace(/\\\//g, "/");
  if (!src.startsWith(UNVERSIONED_PREFIX)) return null;
  // Named single-segment captures become Hono/OpenAPI params. Unnamed ones are
  // left in place on purpose so the metacharacter guard below rejects them.
  src = src.replace(/\(\?<([A-Za-z_$][\w$]*)>\[\^\/\]\+\)/g, ":$1");
  if (/[\\^$.*+?()[\]{}|]/.test(src)) return null;
  return VERSIONED_PREFIX + src.slice(UNVERSIONED_PREFIX.length);
}

/** Map a `/api/v1/...` pathname back to the unversioned path handlers parse. */
function toUnversionedPathname(pathname: string): string {
  return pathname.startsWith(VERSIONED_PREFIX)
    ? UNVERSIONED_PREFIX + pathname.slice(VERSIONED_PREFIX.length)
    : pathname;
}

/** True for a route path that already sits in the public namespace. */
function occupiesPublicNamespace(pattern: RoutePattern): boolean {
  const raw =
    typeof pattern === "string" ? pattern : pattern.source.replace(/\\\//g, "/");
  return raw.startsWith(VERSIONED_PREFIX) || raw.startsWith(`^${VERSIONED_PREFIX}`);
}

/**
 * Startup guard for the three-way rule. Throws — a boot failure is the correct
 * outcome for every case below, because each one is a route whose declared
 * authorization is not the authorization it would actually get.
 */
export function assertPublicMountWiring(source: readonly Route[]): void {
  for (const route of source) {
    const label = `${String(route.method ?? "GET")} ${String(route.path)}`;

    if (occupiesPublicNamespace(route.path)) {
      if (LEGACY_UNENFORCED_V1_PATHS.has(String(route.path))) continue;
      throw new Error(
        `Route ${label} declares a path inside the public namespace ` +
          `${PUBLIC_API_PREFIX}, but that namespace is derived from ` +
          `isPublicRoute() and is never written by hand. A hand-written ` +
          `${PUBLIC_API_PREFIX} path is served without the public mount's ` +
          `authenticate → requireScope → validate pipeline. Declare the route ` +
          `at its unversioned "/api/..." path and set publicSpec + scopes.`,
      );
    }

    // Sweep C6 — the rule below rests on "only the public mount checks
    // scopes", which is true of every hand-written core route and false of an
    // extension route: `wrapExtensionRoute` runs `requireScope` inside the
    // handler it emits, on the unversioned `/api/ext/...` path. Applying the
    // rule to those made a *private* scoped extension route unbootable, so the
    // published contract's "non-empty — every listed scope required" could
    // only be exercised by also publishing the route. The exemption is the
    // route's own declaration of where its gate lives, not a path-prefix guess.
    if (
      route.scopesEnforcedBy !== "extension-wrapper" &&
      route.scopes !== undefined &&
      route.scopes.length > 0 &&
      route.publicSpec !== true
    ) {
      throw new Error(
        `Route ${label} declares scopes [${route.scopes.join(", ")}] without ` +
          `publicSpec: true. Only the ${PUBLIC_API_PREFIX} mount checks a core ` +
          `route's scopes, so this declaration is never enforced anywhere — the ` +
          `route looks gated and is open. Set publicSpec: true to publish it, or ` +
          `drop the scopes.`,
      );
    }

    if (isPublicRoute(route) && toPublicPath(route.path) === null) {
      throw new Error(
        `Route ${label} is public (publicSpec + scopes) but its path cannot be ` +
          `published under ${PUBLIC_API_PREFIX}. A public path must start with ` +
          `"/api/", carry no wildcard, and — if it is a RegExp — be anchored ` +
          `with named single-segment captures only (e.g. "(?<tenantId>[^/]+)").`,
      );
    }
  }
}

/**
 * The dispatcher for a public route. Runs, in order:
 *
 *   authenticate → requireScope → validate `requestSchema` → idempotency → handle
 *
 * matching the order lane A asserts for extension routes, and for the same
 * reason: scoping before validation, because telling an unauthorized caller the
 * shape of a body it may not send — answering 400 where 403 is the truth — is
 * an information leak.
 *
 * **Rate limiting stays ahead of all of this**, as the route's own `middleware`
 * (the dispatcher runs middleware before `handler`). That predates this lane
 * and is the stricter placement — an unauthenticated flood is limited before it
 * reaches authentication rather than after — so lane G keeps lane A's decision
 * rather than moving the limiter inward to match the prose order.
 *
 * **Authentication is required for every public route**, whether `scopes` is
 * `[]` or non-empty: `[]` means "authenticated, no particular grant", so both
 * values presuppose a principal. `requireScope` deliberately does *not* check
 * authentication (an absent `scopes` reads as first-party `"*"` and passes
 * everything), so an anonymous caller reaching it would sail through a
 * non-empty requirement. That is the `auth: "optional"` hole lane A handed
 * over, and the core answer is to fail closed here, before the gate.
 *
 * The handler is invoked with the **unversioned** request: `/api/v1/x` is an
 * alias mount of `/api/x` with enforcement added, so every handler that
 * re-parses `pathname` with its own regex keeps working untouched, and the
 * unversioned route it mirrors stays byte-identical for the first-party client.
 *
 * The whole thing runs inside a `RequestContext` scope so that the `request_id`
 * in an error envelope (`routes/errors.ts`) is the same id the request's logs
 * carry — nothing else in the trellis HTTP entrypoint enters that scope yet, so
 * this is where a public request gets one.
 */
function dispatchPublicRoute(
  route: Route,
  request: Request,
  env: Env,
  context: Parameters<Route["handler"]>[2],
): Promise<Response> {
  const requestId = generateRequestId();
  return runWithRequestContext(
    createAmbientRequestContext({ requestId }),
    async (): Promise<Response> => {
      const securityHeaders = new SecurityHeaders(env);
      const meta: ErrorRouteMeta = {
        publicSpec: true,
        ...(route.operationId ? { operationId: route.operationId } : {}),
      };

      // 1. authenticate
      const session = await new SessionManager().getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      if (!session) return unauthorizedError(securityHeaders, meta);

      // 2. requireScope
      try {
        requireScope(session, route.scopes ?? []);
      } catch (error) {
        if (error instanceof InsufficientScopeError) {
          // Rendered through `structuredError` rather than `error.toResponse()`
          // so the envelope also carries `docs_url` for this operation.
          return structuredError(error.status, error.body, securityHeaders, meta);
        }
        throw error;
      }

      // The unversioned twin of this request, built once and shared by
      // validation, the idempotency key's body hash, and the handler.
      const versionedUrl = context.url ?? new URL(request.url);
      const innerUrl = new URL(versionedUrl.toString());
      innerUrl.pathname = toUnversionedPathname(versionedUrl.pathname);
      const method = request.method.toUpperCase();
      const bodyText =
        method === "GET" || method === "HEAD" ? undefined : await request.text();
      const innerRequest = new Request(innerUrl.toString(), {
        method: request.method,
        headers: request.headers,
        ...(bodyText ? { body: bodyText } : {}),
      });

      // 3. validate requestSchema
      const invalid = validatePublicRequestBody(route, method, bodyText, securityHeaders, meta);
      if (invalid) return invalid;

      const invoke = (): Promise<Response> =>
        route.handler(innerRequest, env, {
          ...context,
          url: innerUrl,
          pathname: innerUrl.pathname,
        });

      // 4. idempotency — lane C owns the rule, this is its core call site.
      if (!routeNeedsIdempotency(route)) return invoke();
      return idempotencyMiddleware()(
        {
          request: innerRequest,
          env,
          ...(context.requestContext ? { requestContext: context.requestContext } : {}),
          url: innerUrl,
          pathname: innerUrl.pathname,
          method: innerRequest.method,
        },
        invoke,
      );
    },
  );
}

/**
 * Validate the request body against the route's declared `requestSchema`.
 * Returns the standard 400 envelope, or `null` when there is nothing to
 * reject. Mirrors the extension wrapper's `validateRequestBody`, including
 * that a schema declared on a GET/HEAD documents the operation and validates
 * nothing.
 */
function validatePublicRequestBody(
  route: Route,
  method: string,
  bodyText: string | undefined,
  securityHeaders: SecurityHeaders,
  meta: ErrorRouteMeta,
): Response | null {
  const schema = route.requestSchema;
  if (!schema || method === "GET" || method === "HEAD") return null;

  let body: unknown;
  try {
    body = JSON.parse(bodyText ?? "");
  } catch {
    return structuredError(
      400,
      {
        error: "INVALID_REQUEST_BODY",
        message: "Request body is not valid JSON.",
        remediation:
          "Send a JSON body with `content-type: application/json` matching this operation's request schema.",
      },
      securityHeaders,
      meta,
    );
  }

  const result = schema.safeParse(body);
  if (result.success) return null;

  const issue = result.error.issues[0];
  const field = issue?.path.join(".") ?? "";
  return structuredError(
    400,
    {
      error: "VALIDATION_FAILED",
      message: issue?.message ?? "Request body failed validation.",
      remediation: field
        ? `Correct the \`${field}\` field and retry.`
        : "Correct the request body to match this operation's request schema and retry.",
      ...(field ? { field } : {}),
    },
    securityHeaders,
    meta,
  );
}

/** The `/api/v1` alias of one public route, enforcement attached. */
function toPublicV1Route(route: Route): Route {
  const path = toPublicPath(route.path);
  if (path === null) {
    // assertPublicMountWiring has already refused this; belt and braces so the
    // function is total for any caller that skipped the guard.
    throw new Error(`Route ${String(route.path)} cannot be published under ${PUBLIC_API_PREFIX}.`);
  }
  return {
    ...route,
    path,
    version: "v1",
    handler: (request, env, context) => dispatchPublicRoute(route, request, env, context),
  };
}

/**
 * Every public route, mounted under `/api/v1`. The one place the mount rule is
 * applied — `lib/app.ts` calls this at `buildHonoApp()` time (so extensions
 * registered after import are included) and the `routes` aggregate below calls
 * it at module load, which is where the OpenAPI generator and the route-mount
 * parity guard read it.
 *
 * @param source route table to derive from; defaults to everything core and
 *   the extensions registered *right now*.
 */
export function buildPublicV1Routes(
  source: readonly Route[] = [...coreRoutes, ...buildExtensionRoutes()],
): Route[] {
  assertPublicMountWiring(source);
  return source.filter(isPublicRoute).map(toPublicV1Route);
}

/**
 * The unversioned twin of a public route keeps serving the first-party client
 * byte-for-byte, and is deliberately **dropped from the published document**:
 * the public contract is the `/api/v1` form, and emitting both would put a
 * path in the spec that carries none of the mount's enforcement — the exact
 * divergence this lane exists to prevent.
 */
function demotePublicTwin(route: Route): Route {
  return isPublicRoute(route) ? { ...route, publicSpec: false } : route;
}

export const routes: Route[] = [
  ...[...coreRoutes, ...extensionRoutes].map(demotePublicTwin),

  // The public mount — every route that is `publicSpec` *and* scope-declaring,
  // aliased under /api/v1 behind the dispatcher. Registered after the
  // unversioned table so an unversioned path can never be shadowed.
  ...buildPublicV1Routes([...coreRoutes, ...extensionRoutes]),

  // 404 handler - must be last
  {
    path: "*",
    method: "*",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      return securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    },
    middleware: [corsMiddleware()],
    description: "404 Not Found",
  },
];

// Re-export types
export type { Route } from "./types.js";
