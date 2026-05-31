/**
 * Hono application (Stream 2.1 — router migration seam).
 *
 * During the migration the Hono app and the legacy regex-array router
 * (`routeRequest` in `router.ts`) coexist. `server.ts` dispatches to this
 * app first; on a *fallthrough* 404 (see `FALLTHROUGH_HEADER`) it falls back
 * to the legacy router. A route is "ported" by mounting it here — its legacy
 * registry entry can stay until the bulk legacy removal at H-final (it is
 * simply never reached at runtime once Hono owns it).
 *
 * Adapters keep each port mechanical, with NO handler/middleware-body
 * changes (parity over rewrite):
 *   - `toHono` wraps a legacy `Route.handler`.
 *   - `toHonoMiddleware` wraps a legacy `Middleware` (CORS, CSRF, …) verbatim.
 *   - `honoSecurityHeaders` reapplies `SecurityHeaders` per request (the
 *     legacy `securityHeadersMiddleware` closes over `env` at construction;
 *     Hono supplies `env` per request, so only the wiring is re-expressed —
 *     the header set is the same class).
 *   - `mount` composes `[...route.middleware, securityHeaders, handler]`,
 *     mirroring `router.ts` exactly (security headers innermost, so a CORS
 *     OPTIONS short-circuit is NOT wrapped with them — same as legacy).
 *
 * @see plans/trellis-migration/2.1-hono-migration.md (in the saas-foundation repo)
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { runWithTenantContext, tenantId } from "@de-otio/saas-foundation/tenant";

import { getExtensions } from "../extensions.js";
import { extractVerifiedTenantId } from "./auth/auth-middleware.js";
import { resolveTenantScopeMode } from "./tenant-scope.js";
import type { Env } from "../env.js";
import { wrapExtensionRoutes } from "./extension-route-wrapper.js";
import { corsMiddleware, type Middleware, type MiddlewareContext } from "./middleware.js";
import type { TrellisRequestContext } from "./request-context.js";
import { actorRoutes } from "./routes/activitypub/actor.js";
import { audienceRoutes } from "./routes/activitypub/audiences.js";
import { collectionRoutes } from "./routes/activitypub/collections.js";
import { entityProfileRoutes } from "./routes/activitypub/entity-profile.js";
import { friendsRoutes as apFriendsRoutes } from "./routes/activitypub/friends.js";
import { groupRoutes } from "./routes/activitypub/group.js";
import { inboxRoutes } from "./routes/activitypub/inbox.js";
import { messageRoutes } from "./routes/activitypub/messages.js";
import { outboxRoutes } from "./routes/activitypub/outbox.js";
import { postRoutes as apPostRoutes } from "./routes/activitypub/post.js";
import { webfingerRoutes } from "./routes/activitypub/webfinger.js";
import { adminCostRoutes } from "./routes/admin-costs.js";
import { agentAuthorizeRoutes } from "./routes/agent-authorize.js";
import { agentSessionsRoutes } from "./routes/agent-sessions.js";
import { adminRoutes } from "./routes/admin.js";
import { buildAgentSurfaceRoutes } from "./routes/agent-surface.js";
import { authRoutes } from "./routes/auth.js";
import { authDiscoverRoutes } from "./routes/auth-discover.js";
import { badgesRoutes } from "./routes/badges.js";
import { circleRoutes } from "./routes/circles.js";
import { commentsRoutes } from "./routes/comments.js";
import { connectionCodeRoutes } from "./routes/connection-codes.js";
import { contentDiscoveryRoutes } from "./routes/content-discovery.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { deletionRoutes } from "./routes/deletion.js";
import { entitiesRoutes } from "./routes/entities.js";
import { exportRoutes } from "./routes/export.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { employeesRoutes } from "./routes/employees.js";
import { entityRelationshipRoutes } from "./routes/entity-relationships.js";
import { featureFlagsRoutes } from "./routes/feature-flags.js";
import { feedsRoutes } from "./routes/feeds.js";
import { friendsRoutes } from "./routes/friends.js";
import { healthRoutes } from "./routes/health.js";
import { internaldocsRoutes } from "./routes/internal-docs.js";
import { invitationsRoutes } from "./routes/invitations.js";
import { linkReportRoutes } from "./routes/link-reports.js";
import { mapRoutes } from "./routes/map.js";
import { mediaRoutes } from "./routes/media.js";
import { mediaMetadataVisibilityRoutes } from "./routes/media-metadata-visibility.js";
import { mfaRoutes } from "./routes/mfa.js";
import { notificationsRoutes } from "./routes/notifications.js";
import { oauthRoutes } from "./routes/oauth.js";
import { orphanedMediaRoutes } from "./routes/orphaned-media.js";
import { orphanedMediaHealthRoutes } from "./routes/orphaned-media-health.js";
import { outRoutes } from "./routes/out.js";
import { parentalControlRoutes } from "./routes/parental-controls.js";
import { postsRoutes } from "./routes/posts.js";
import { privacyRoutes } from "./routes/privacy.js";
import { productTaxonomyRoutes } from "./routes/products.js";
import { relationshipRoutes } from "./routes/relationships.js";
import { sentimentsRoutes } from "./routes/sentiments.js";
import { setupStatusRoutes } from "./routes/setup-status.js";
import { taxonomyRoutes } from "./routes/taxonomy.js";
import { taxonomyAnalyticsRoutes } from "./routes/taxonomy-analytics.js";
import { tenantAuditRoutes } from "./routes/tenant-audit.js";
import { tenantComplianceRoutes } from "./routes/tenant-compliance.js";
import { tenantDomainRoutes } from "./routes/tenant-domains.js";
import { tenantIdpRoutes } from "./routes/tenant-idp.js";
import { tenantMemberRoutes } from "./routes/tenant-members.js";
import { tenantRoleMappingRoutes } from "./routes/tenant-role-mappings.js";
import { tenantRoutes } from "./routes/tenants.js";
import type { Route } from "./routes/types.js";
import { uploadSessionRoutes } from "./routes/upload-sessions.js";
import { userRoutes } from "./routes/user.js";
// The curated, `publicSpec`-flagged route aggregate (routes/index.ts applies
// `markPublicSpec` to the federation surface). Used only as the OpenAPI
// generator's data source — NOT for routing (Hono mounts PORTED_ROUTE_SETS).
import { routes as curatedRouteRegistry } from "./routes/index.js";
import { SecurityHeaders } from "./security-headers.js";

/**
 * Per-request bindings passed as the second arg to `app.fetch(req, bindings)`.
 * `server.ts` builds these once per request (mirroring the legacy
 * `RouterContext`).
 */
export interface HonoBindings {
  trellisEnv: Env;
  requestContext?: TrellisRequestContext;
}

type AppEnv = { Bindings: HonoBindings };

/** Build a legacy `MiddlewareContext` from a Hono `Context`. */
function legacyContext(c: Context<AppEnv>): MiddlewareContext {
  const url = new URL(c.req.url);
  return {
    request: c.req.raw,
    env: c.env.trellisEnv,
    requestContext: c.env.requestContext,
    url,
    pathname: url.pathname,
    method: c.req.method,
  };
}

/**
 * Adapt a legacy `Route.handler` to a Hono handler. The body is unchanged:
 * it still receives `(request, env, { url, pathname, params, requestContext })`.
 */
function toHono(handler: Route["handler"]) {
  return (c: Context<AppEnv>): Promise<Response> => {
    const url = new URL(c.req.url);
    return handler(c.req.raw, c.env.trellisEnv, {
      url,
      pathname: url.pathname,
      params: c.req.param() as Record<string, string>,
      requestContext: c.env.requestContext,
    });
  };
}

/**
 * Adapt a legacy `Middleware` (`(ctx, next) => Promise<Response>`) to a Hono
 * middleware, reusing the legacy implementation verbatim. The legacy `next()`
 * returns the downstream `Response`; we bridge it to Hono's `next()` (which
 * sets `c.res`) and hand the legacy middleware a mutable copy so in-place
 * header mutation (e.g. CORS) is safe against an immutable `c.res`.
 */
function toHonoMiddleware(mw: Middleware): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ctx = legacyContext(c);
    const legacyNext = async (): Promise<Response> => {
      await next();
      const r = c.res;
      return new Response(r.body, {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
      });
    };
    c.res = await mw(ctx, legacyNext);
  };
}

/**
 * Hono middleware applying `SecurityHeaders` to the response, reading env per
 * request. Mirrors the legacy `securityHeadersMiddleware(env)`.
 */
function honoSecurityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.res = new SecurityHeaders(c.env.trellisEnv).addSecurityHeaders(c.res);
  };
}

function normalizeMethods(method: Route["method"]): string[] {
  if (method === undefined || method === "*") return ["ALL"];
  return Array.isArray(method) ? method : [method];
}

/**
 * Translate a legacy anchored RegExp route path to an equivalent Hono path
 * string. Handles the common single-segment capture `([^/]+)` → `:pN`.
 *
 * Returns `null` for anything it cannot translate *safely* (unanchored, or
 * containing regex metacharacters beyond the `([^/]+)` captures) — the caller
 * then defers that route rather than risk a mis-translation. Handlers that
 * re-parse `pathname` (the trellis regex routes all do, via
 * `pathname.match(SOME_RE)`) keep working unchanged: toHono passes the real
 * `url.pathname`, so the param NAME here is irrelevant to them.
 */
export function regexToHonoPath(re: RegExp): string | null {
  let src = re.source;
  if (!src.startsWith("^") || !src.endsWith("$")) return null;
  src = src.slice(1, -1).replace(/\\\//g, "/");

  // Protect escaped literals (e.g. `\.json`) so the metachar guard below
  // doesn't reject them, then restore after. The sentinel delimiter is a
  // Unicode private-use code point (U+E000): it can never appear in a real
  // URL path, so the round-trip is collision-proof \u2014 and unlike a NUL
  // delimiter it keeps this source valid UTF-8 text (a NUL makes grep/diff
  // treat the whole file as binary). Written as an escape, so the file
  // itself stays plain ASCII.
  src = src.replace(/\\\./g, "\uE000DOT\uE000").replace(/\\-/g, "\uE000DASH\uE000");

  // Replace each single-segment capture with a positional :pN param. Both
  // `([^/]+)` and the (sloppier) greedy `(.+)` are treated as one segment:
  // real IDs never contain slashes, and during coexistence a hypothetical
  // multi-segment path simply falls through to the legacy router (which still
  // holds the original regex). The handler re-parses `pathname` with its own
  // regex, so the param name is irrelevant.
  let i = 0;
  src = src.replace(/\(\[\^\/\]\+\)|\(\.\+\)/g, () => `:p${i++}`);

  // Anything still containing regex metacharacters (incl. a bare `.` meaning
  // any-char) is not a plain path — defer it rather than mis-translate.
  if (/[\\^$.*+?()[\]{}|]/.test(src)) return null;

  src = src.replace(/\uE000DOT\uE000/g, ".").replace(/\uE000DASH\uE000/g, "-");
  return src;
}

/**
 * Mount a legacy `Route` onto the Hono app, composing its middleware exactly
 * as `router.ts` does: `[...route.middleware, securityHeaders]` with the
 * handler last. Security headers are innermost, so a CORS OPTIONS
 * short-circuit returns 204 WITHOUT them — identical to the legacy router.
 *
 * Only string paths are supported here (H0/H1 routes). RegExp / wildcard
 * patterns are translated in later batches; mounting one throws so it can't
 * be silently mis-ported.
 */
function mount(app: Hono<AppEnv>, route: Route): void {
  const honoPath =
    typeof route.path === "string" ? route.path : regexToHonoPath(route.path);
  if (honoPath === null) {
    throw new Error(
      `mount: cannot translate route path to Hono (${String(route.path)})`,
    );
  }
  const middlewares: MiddlewareHandler<AppEnv>[] = (route.middleware ?? []).map(
    toHonoMiddleware,
  );
  middlewares.push(honoSecurityHeaders());
  // The handler is the terminal of the chain; structurally it satisfies
  // MiddlewareHandler (it ignores `next` and returns a Response).
  const chain: MiddlewareHandler<AppEnv>[] = [
    ...middlewares,
    toHono(route.handler) as unknown as MiddlewareHandler<AppEnv>,
  ];

  // Hono's variadic `.on`/`.all` generics don't accept a spread of a typed
  // MiddlewareHandler[]; cast to a simple variadic signature at this boundary
  // (the element types are already checked by toHono/toHonoMiddleware).
  const on = app.on as (
    method: string,
    path: string,
    ...handlers: MiddlewareHandler<AppEnv>[]
  ) => void;
  const all = app.all as (
    path: string,
    ...handlers: MiddlewareHandler<AppEnv>[]
  ) => void;

  for (const method of normalizeMethods(route.method)) {
    if (method === "ALL") {
      all(honoPath, ...chain);
    } else {
      on(method, honoPath, ...chain);
    }
  }
}

/** Re-exported so tests can exercise the middleware adapter in isolation. */
export { toHonoMiddleware };
export { corsMiddleware };

/**
 * Route files fully ported to Hono. Porting a file = add its exported
 * `Route[]` here (after translating any non-string paths). Each set's legacy
 * registry entry can remain until H-final; Hono owns these at runtime.
 *
 * H0/H1/H2: `healthRoutes` (/health, /api/config, /api/csrf-token).
 * H3/H4: exact-string route files (routing pattern already proven by
 * health.ts; the only new surface is registration, asserted via `app.routes`
 * in tests).
 */
/**
 * Agent-surface routes (`/llms.txt`, `/openapi.json`, `/security.txt`) wired so
 * `/openapi.json` generates from the curated, `publicSpec`-flagged registry
 * rather than the empty static export. The getter is deferred (`() => …`) so the
 * fully-initialised aggregate is read on the first request, not at module-eval
 * time — which also sidesteps any import-order concern. The generator emits only
 * `publicSpec: true` routes, so this publishes the federation/discovery surface
 * (schemas stay minimal until the zod-openapi work).
 */
const wiredAgentSurfaceRoutes: Route[] = buildAgentSurfaceRoutes(
  () => curatedRouteRegistry,
);

const PORTED_ROUTE_SETS: ReadonlyArray<ReadonlyArray<Route>> = [
  healthRoutes,
  // H3
  connectionCodeRoutes,
  deletionRoutes,
  discoveryRoutes,
  employeesRoutes,
  featureFlagsRoutes,
  mapRoutes,
  mfaRoutes,
  privacyRoutes,
  userRoutes,
  // H4
  agentAuthorizeRoutes,
  circleRoutes,
  entityRelationshipRoutes,
  friendsRoutes,
  outRoutes,
  relationshipRoutes,
  taxonomyAnalyticsRoutes,
  // H5 — activitypub federation surface (all :param string paths)
  actorRoutes,
  audienceRoutes,
  collectionRoutes,
  entityProfileRoutes,
  apFriendsRoutes,
  groupRoutes,
  inboxRoutes,
  messageRoutes,
  outboxRoutes,
  apPostRoutes,
  webfingerRoutes,
  // H6 — remaining string-path files (media/taxonomy/discovery/admin-exacts)
  mediaRoutes,
  mediaMetadataVisibilityRoutes,
  uploadSessionRoutes,
  taxonomyRoutes,
  contentDiscoveryRoutes,
  orphanedMediaRoutes,
  orphanedMediaHealthRoutes,
  adminCostRoutes,
  wiredAgentSurfaceRoutes,
  // H7 — first regex-path file; mount() auto-translates ([^/]+) → :pN.
  // The revoke handler re-parses pathname via REVOKE_RE, so it is unchanged.
  agentSessionsRoutes,
  // H8 — regex-path files whose captures are all ([^/]+) (mount auto-
  // translates). Deferred: dashboard/export/invitations (greedy (.+)) and
  // tenant-compliance (escaped \. literal) — need wildcard / dot handling.
  badgesRoutes,
  commentsRoutes,
  entitiesRoutes,
  linkReportRoutes,
  notificationsRoutes,
  oauthRoutes,
  parentalControlRoutes,
  postsRoutes,
  productTaxonomyRoutes,
  sentimentsRoutes,
  setupStatusRoutes,
  tenantRoutes,
  tenantAuditRoutes,
  tenantDomainRoutes,
  tenantIdpRoutes,
  tenantMemberRoutes,
  tenantRoleMappingRoutes,
  // H9 — files unlocked by regexToHonoPath handling (.+) and \. literals.
  dashboardRoutes,
  exportRoutes,
  invitationsRoutes,
  tenantComplianceRoutes,
  // H10 — wildcard files. Hono runs matching handlers in REGISTRATION ORDER
  // (first to return a Response wins) — NOT by path specificity. So the
  // specific authDiscoverRoutes (POST /api/auth/discover) MUST be registered
  // BEFORE the auth wildcard to win. Legacy registered the wildcard first and
  // handleAuthRoutes has no /discover handling, so legacy 404'd discover — a
  // latent bug. Ordering discover first here serves it from the dedicated
  // timing-safe handler and routes everything else /api/auth/* to the wildcard
  // — the cleaner, intended behavior (nothing is live; safe to fix).
  authDiscoverRoutes,
  authRoutes,
  // feeds/internal-docs are isolated wildcards; admin has no broad /api/admin/*
  // catch-all (only the narrow /api/admin/super-admin/*).
  feedsRoutes,
  internaldocsRoutes,
  adminRoutes,
];

/**
 * Paths now owned by Hono — derived from the ported sets. Informational
 * (tests / progress tracking); the runtime owner is decided by Hono matching
 * first.
 */
export const HONO_PORTED_PATHS: ReadonlyArray<string> = PORTED_ROUTE_SETS.flatMap(
  (set) => set.map((r) => r.path).filter((p): p is string => typeof p === "string"),
);

/**
 * Build the Hono app. Stateless: env + per-request context arrive via
 * `app.fetch(request, bindings)`, so a single instance is reused across
 * requests.
 */
export function buildHonoApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // WS1 (multi-tenancy, doc/14): when tenant scoping is enabled, establish the
  // ambient tenant for the entire downstream via `runWithTenantContext`. `run()`
  // propagates the tenant through every `await` in the request — unlike setting
  // it inside the per-handler `authMiddleware`, whose `enterWith` does not
  // survive the `await` back to the handler. Gated on the scope mode, so there
  // is zero verification cost on the default ("off") path.
  if (resolveTenantScopeMode() !== "off") {
    app.use("*", async (c, next) => {
      const tid = await extractVerifiedTenantId(c.req.raw, c.env.trellisEnv);
      if (!tid) return next();
      return runWithTenantContext(tenantId(tid), () => next());
    });
  }

  // Mount every ported route file. `mount` reuses each legacy handler +
  // middleware unchanged and composes security headers innermost.
  for (const set of PORTED_ROUTE_SETS) {
    for (const route of set) mount(app, route);
  }

  // H-ext — extension routes (dynamic; extensions are registered before the
  // server starts, mirroring the legacy registry in routes/index.ts). Raw
  // app-wired routes plus core-wrapped routes. Empty in tests / when no
  // extensions are registered.
  const extensions = getExtensions();
  for (const ext of extensions) {
    for (const route of ext.routes as Route[]) mount(app, route);
    for (const route of wrapExtensionRoutes(ext)) mount(app, route);
  }

  // Hono is the sole router (the legacy routeRequest fallback was removed in
  // H-final). Unmatched → the real 404, matching the legacy 404 handler
  // (security headers + { error: "Not found" }).
  app.notFound((c) =>
    new SecurityHeaders(c.env.trellisEnv).createSecureResponse(
      JSON.stringify({ error: "Not found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    ),
  );

  return app;
}
