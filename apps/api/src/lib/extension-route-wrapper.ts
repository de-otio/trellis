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
} from "@de-otio/trellis-extension-api";
import type { Route } from "./routes/types.js";
import { corsMiddleware, csrfMiddleware } from "./middleware.js";
import { SecurityHeaders } from "./security-headers.js";
import { SessionManager } from "./session-cookie.js";
import { getLogger, Logger } from "./logger.js";
import { createExtensionContext } from "./extension-context.js";
import type { Env } from "../env.js";

/**
 * Wrap an extension route definition with core HTTP infrastructure.
 */
export function wrapExtensionRoute(
  ext: TrellisExtension,
  routeDef: ExtensionRouteDefinition,
): Route {
  const authLevel = routeDef.auth ?? "required";

  return {
    path: `/api/ext/${ext.id}/${routeDef.path}`,
    method: routeDef.method,
    middleware: authLevel === "none"
      ? [corsMiddleware()]
      : [corsMiddleware(), csrfMiddleware()],
    description: routeDef.description,
    handler: async (request, env, { params, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // Auth check — enforced by core
      let session: any = null;
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

      const ctx = createExtensionContext(ext, env, prisma, graph);

      try {
        const result = await routeDef.handle(request, params, session, ctx);

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
