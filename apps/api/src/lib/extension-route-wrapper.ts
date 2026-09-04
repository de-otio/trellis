/**
 * Extension Route Wrapper
 *
 * Converts ExtensionRouteDefinition → Route with core-applied:
 * - Authentication (enforced by core, not extension)
 * - Scope enforcement (`requireScope`, from the route's declared `scopes`)
 * - Request-body validation (the route's declared `requestSchema`)
 * - CORS and CSRF middleware
 * - Security headers
 * - Error handling and logging
 * - Scoped ExtensionContext (no secrets)
 *
 * **Pipeline order** (plan 034 lane A) — authenticate → scope → validate →
 * handle, asserted by `extension-route-wrapper.test.ts`. Scoping before
 * validation is the load-bearing half: validating first would tell an
 * unauthorized caller the shape of a body it may not send, and answering 400
 * where 401/403 is the truth is an information leak, not a nicety.
 *
 * Rate limiting sits *ahead* of the whole handler as route `middleware` (the
 * dispatcher runs it before `handler`), not between validation and `handle`.
 * That predates this lane and is the stricter placement: an unauthenticated
 * flood is limited before it reaches auth, rather than after.
 */

import type { TrellisExtension,
  ExtensionRouteDefinition,
  ExtensionSession,
  TenantId as ExtensionTenantId,
} from "@de-otio/trellis-extension-api";
import type { Route } from "./routes/types.js";
import { corsMiddleware, csrfMiddleware, rateLimitMiddleware } from "./middleware.js";
import { SecurityHeaders } from "./security-headers.js";
import { SessionManager, type Session } from "./session-cookie.js";
import { getLogger, Logger } from "./logger.js";
import { createExtensionContext } from "./extension-context.js";
import { mintTenantId } from "./mint-tenant-id.js";
import { CUID_RE } from "./auth/cuid.js";
import { requireScope, InsufficientScopeError } from "./auth/require.js";
import { structuredError } from "./routes/errors.js";
import type { Env } from "../env.js";
import type { PrismaClient } from "@prisma/client";

/**
 * Resolve the caller's verified active tenant for an extension route handler.
 *
 * The tenant id must be *verified* — from a Cognito-signed claim or a
 * server-side DB read — never from a client-supplied value. Two sources, in
 * order (05a §3.3):
 *   (b) `session.activeTenantId` — the verified JWT claim surfaced by
 *       `SessionManager.getSession` Strategy 1a (already CUID-validated there).
 *   (c) cookie-only fallback — a pure cookie session has no active-tenant
 *       claim, so read the user's `personalTenantId` server-side (one indexed
 *       read, only on the cookie path). The personal tenant is the correct
 *       default for cookie (web) sessions; B2B tenant-switching clients use JWTs.
 *
 * The raw id is CUID-validated then minted through the core-private
 * `mintTenantId(·, "session")`, so provenance is audited and the brand chain
 * stays core-only. Returns `undefined` when no tenant can be verified (e.g. a
 * legacy cookie whose user row is gone) — a typed, explicit absence, never a
 * throw.
 */
async function resolveTenantId(
  session: Session,
  prisma: PrismaClient,
): Promise<ExtensionTenantId | undefined> {
  let raw = session.activeTenantId; // (b) verified JWT claim
  if (!raw) {
    // (c) cookie-only fallback — server-authoritative personal tenant.
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { personalTenantId: true },
    });
    raw = user?.personalTenantId ?? undefined;
  }
  if (raw && CUID_RE.test(raw)) {
    // Mint through core's private minter (foundation brand + audited
    // provenance), then cast to the extension-api brand at this boundary — both
    // erase to `string` (extension.ts TenantId doc). This is the sole crossing.
    return mintTenantId(raw, "session") as unknown as ExtensionTenantId;
  }
  return undefined;
}

/**
 * Validate a request body against the route's declared `requestSchema`.
 *
 * Reads a **clone** of the request: `handle()` receives the original with its
 * body stream untouched, so an extension that calls `request.json()` itself
 * (all of them do) is unaffected by the wrapper having looked first.
 *
 * Returns `null` when there is nothing to reject, or the standard 400 envelope
 * — `{error, message, remediation, field?}` — when there is. `handle()` is
 * never reached in the latter case: the extension never sees an unvalidated
 * body, which is the point of declaring the schema.
 */
async function validateRequestBody(
  request: Request,
  routeDef: ExtensionRouteDefinition,
  securityHeaders: SecurityHeaders,
): Promise<Response | null> {
  const schema = routeDef.requestSchema;
  if (!schema) return null;
  // GET/HEAD carry no body by definition; a schema declared on one describes
  // nothing to validate (it still documents the operation in the spec).
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;

  let body: unknown;
  try {
    body = await request.clone().json();
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
    );
  }

  const result = schema.safeParse(body);
  if (result.success) return null;

  // Report the first issue: one actionable field beats a list a client has to
  // rank itself. `field` is the dotted path, omitted for a root-level issue
  // (e.g. "expected object, received array") where no single field is at fault.
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
  );
}

/**
 * Wrap an extension route definition with core HTTP infrastructure.
 */
export function wrapExtensionRoute(
  ext: TrellisExtension,
  routeDef: ExtensionRouteDefinition,
): Route {
  const authLevel = routeDef.auth ?? "required";

  // Fail closed at wiring time, not at request time. A route that can never
  // have a principal (`auth: "none"`) but declares scopes it needs held is a
  // declaration that can never be enforced — served, it would look gated and
  // be open. Boot must not get past it. (`auth: "optional"` is a legitimate
  // pairing: the scope check applies to whichever callers do authenticate.)
  if (authLevel === "none" && routeDef.scopes && routeDef.scopes.length > 0) {
    throw new Error(
      `Extension "${ext.id}" route "${routeDef.path}" declares scopes ` +
        `[${routeDef.scopes.join(", ")}] with auth: "none". An unauthenticated ` +
        `route has no principal to check them against — set auth to ` +
        `"required" (or "optional") or drop the scopes.`,
    );
  }

  // Rate-limit EVERY route of an extension that can read cross-tenant (05a
  // §4.4(7)(a)): discover() is reachable from authLevel:"none" routes, i.e.
  // unauthenticated cross-tenant scans. The limiter IP-keys anonymous callers.
  const middleware = authLevel === "none"
    ? [corsMiddleware()]
    : [corsMiddleware(), csrfMiddleware()];
  if (ext.crossTenantRead && ext.crossTenantRead.length > 0) {
    middleware.push(rateLimitMiddleware());
  }

  return {
    path: `/api/ext/${ext.id}/${routeDef.path}`,
    method: routeDef.method,
    middleware,
    description: routeDef.description,
    handler: async (request, env, { params, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // Auth check — enforced by core
      let session: Session | null = null;
      if (authLevel !== "none") {
        const sessionManager = new SessionManager();
        const secret = env.SESSION_SECRET;
        session = await sessionManager.getSession(request, secret, env);
        if (!session && authLevel === "required") {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
      }

      // Scope check — the one gate, applied before anything reads the body.
      //
      // Only consulted when a session exists: `auth` stays authoritative for
      // *authentication* (an `auth: "required"` route already returned 401
      // above; an `auth: "optional"` route has no principal to narrow). A
      // non-empty `scopes` on an `auth: "none"` route is refused at wiring
      // time, so this cannot silently pass one.
      if (session && routeDef.scopes) {
        try {
          requireScope(session, routeDef.scopes);
        } catch (error) {
          if (error instanceof InsufficientScopeError) {
            // 403, not 401 — the caller is authenticated and simply not
            // permitted. `remediation` names the missing scope literally.
            return error.toResponse(securityHeaders);
          }
          throw error;
        }
      }

      // Request-body validation — after the scope gate, before `handle()`.
      const invalidBody = await validateRequestBody(request, routeDef, securityHeaders);
      if (invalidBody) return invalidBody;

      // Build scoped context
      const { sharedDatabaseConnectionManager } = await import("./database-connection-manager.js");
      const { detectRegionSync } = await import("./region-detection.js");
      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const region = detectRegionSync(request, env);
      const managed = sharedDatabaseConnectionManager.acquireClient(region, env);
      const prisma = managed.client;
      const graph = await createGraphServiceFromEnv(env);

      // discover()'s region floor: the caller's verified data region when
      // authenticated, else the deployment primary (fail-closed to one region).
      const callerRegion = session?.dataRegion ?? env.DEFAULT_REGION ?? region;
      const ctx = createExtensionContext(ext, env, prisma, graph, callerRegion);

      try {
        // Resolve the caller's verified tenant and build the extension-facing
        // session by explicit whitelist. Never spread the internal `Session` —
        // it carries `csrfToken`/`mfaVerified`/`dataRegion`/`ageTier`/
        // `activeTenantId` that must not cross the extension boundary.
        // `tenantId` is the only path by which a handler obtains a branded
        // `TenantId`. Inside the try so a fallback DB error yields a clean 500.
        let extSession: ExtensionSession | null = null;
        if (session) {
          const tenantId = await resolveTenantId(session, prisma);
          extSession = {
            userId: session.userId,
            email: session.email,
            role: session.role ?? "END_USER",
            ...(tenantId ? { tenantId } : {}),
            // Principal (plan 034 lane A). Whitelisted, like every other field
            // here — never spread — because this object is the trust boundary
            // between core and extension code. An extension may attribute a
            // write to `clientId` and may branch on `scopes`; enforcement of
            // the route's declared scopes already happened above, in core.
            //
            // Conditional, so absent stays absent: `scopes: undefined` and
            // "no scopes key" both mean `"*"`, but only the latter keeps the
            // whitelist assertion honest about what actually crossed.
            ...(session.clientId ? { clientId: session.clientId } : {}),
            ...(session.scopes !== undefined ? { scopes: session.scopes } : {}),
          };
        }

        const result = await routeDef.handle(request, params, extSession, ctx);

        return securityHeaders.addSecurityHeaders(
          new Response(JSON.stringify(result.body), {
            status: result.status,
            headers: {
              "content-type": "application/json",
              ...result.headers,
            },
          }),
        );
      } catch (error) {
        logger.error(`Extension "${ext.id}" route error:`, error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
  };
}

/**
 * Wrap all extension routes for a given extension.
 */
export function wrapExtensionRoutes(
  ext: TrellisExtension,
): Route[] {
  if (!ext.extensionRoutes) return [];
  return ext.extensionRoutes.map((r: any) => wrapExtensionRoute(ext, r));
}
