/**
 * Taxonomy Analytics Routes
 *
 * Routes for taxonomy usage metrics and analytics.
 */

import type { Env } from "../../env.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { getWrappedDatabase } from "../database-wrapper-helper.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware } from "../middleware.js";
import { detectRegionSync } from "../region-detection.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { TaxonomyMetrics } from "../taxonomy-metrics.js";
import type { Route } from "./types.js";

/**
 * Resolve the caller's active tenant from the JWT.
 */
async function getTenantId(request: Request, env: Env): Promise<string | null> {
  const auth = await authMiddleware(request, env);
  if (!auth || !auth.activeTenantId) return null;
  return auth.activeTenantId;
}

function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized" }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

export const taxonomyAnalyticsRoutes: Route[] = [
  // Get taxonomy usage metrics
  {
    path: "/api/taxonomy/metrics",
    method: "GET",
    handler: async (request, env) => {
      try {
        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();
        const region = detectRegionSync(request, env);
        const wrappedDb = getWrappedDatabase(region, env, request);
        const metrics = new TaxonomyMetrics(wrappedDb);

        // Parse query parameters
        const url = new URL(request.url);
        const dimension = url.searchParams.get("dimension") || undefined;
        const minUsageCount = parseInt(
          url.searchParams.get("minUsageCount") || "0",
          10,
        );
        const includeUnused = url.searchParams.get("includeUnused") !== "false";

        // Get metrics
        const taxonMetrics = await metrics.getTaxonMetrics(tenantId, {
          dimension,
          minUsageCount,
          includeUnused,
        });

        return new Response(
          JSON.stringify({
            metrics: taxonMetrics,
            count: taxonMetrics.length,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      } catch (error: any) {
        getLogger().error("Error getting taxonomy metrics:", error);
        return new Response(
          JSON.stringify({ error: error.message || "Internal server error" }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get taxonomy usage metrics",
  },

  // Get pruning candidates
  {
    path: "/api/taxonomy/pruning-candidates",
    method: "GET",
    handler: async (request, env) => {
      try {
        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();
        const sessionManager = new SessionManager();
        const securityHeaders = new SecurityHeaders(env);
        const sessionSecret = env.SESSION_SECRET;
        const session = await sessionManager.getSession(
          request,
          sessionSecret,
          env,
        );

        // Require authentication for pruning candidates (admin feature)
        if (!session) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        const region = detectRegionSync(request, env);
        const wrappedDb = getWrappedDatabase(region, env, request);
        const metrics = new TaxonomyMetrics(wrappedDb);

        // Get pruning candidates
        const candidates = await metrics.checkPruningCandidates(tenantId);

        return securityHeaders.createSecureResponse(
          JSON.stringify({
            candidates,
            count: candidates.length,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      } catch (error: any) {
        getLogger().error(
          "Error getting pruning candidates:",
          error,
        );
        const securityHeaders = new SecurityHeaders(env);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: error.message || "Internal server error" }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get taxonomy pruning candidates (admin only)",
  },

  // Get popular free-form tags
  {
    path: "/api/taxonomy/free-form-tags",
    method: "GET",
    handler: async (request, env) => {
      try {
        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();
        const region = detectRegionSync(request, env);
        const wrappedDb = getWrappedDatabase(region, env, request);

        // Parse query parameters
        const url = new URL(request.url);
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);

        const metrics = new TaxonomyMetrics(wrappedDb);

        // Get popular free-form tags
        const freeFormTags = await metrics.getPopularFreeFormTags(
          tenantId,
          Math.min(limit, 500),
        );

        return new Response(
          JSON.stringify({
            tags: freeFormTags,
            count: freeFormTags.length,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      } catch (error: any) {
        getLogger().error("Error getting free-form tags:", error);
        return new Response(
          JSON.stringify({ error: error.message || "Internal server error" }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get popular free-form tags (identifies taxonomy gaps)",
  },
];
