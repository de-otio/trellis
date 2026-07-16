/**
 * Extension Route Wrapper
 *
 * Converts ExtensionRouteDefinition → Route with core-applied:
 * - Authentication (enforced by core, not extension)
 * - CORS and CSRF middleware
 * - Security headers
 * - Error handling and logging
 * - Scoped ExtensionContext (no secrets)
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
 * Wrap an extension route definition with core HTTP infrastructure.
 */
export function wrapExtensionRoute(
  ext: TrellisExtension,
  routeDef: ExtensionRouteDefinition,
): Route {
  const authLevel = routeDef.auth ?? "required";

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
