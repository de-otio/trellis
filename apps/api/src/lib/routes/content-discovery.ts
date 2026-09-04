/**
 * Content Discovery Routes
 *
 * Routes for taxonomy-based content discovery:
 * - Related content
 * - Trending topics
 * - Content recommendations
 */

import type { Env } from "../../env.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { ContentDiscovery } from "../content-discovery.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware } from "../middleware.js";
import { createRequestContext } from "../request-context.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

/**
 * Resolve the caller's active tenant from the JWT. Returns null when the
 * request is not authenticated or no tenant claim is present.
 */
async function getTenantId(request: Request, env: Env): Promise<string | null> {
  const auth = await authMiddleware(request, env);
  if (!auth || !auth.activeTenantId) return null;
  return auth.activeTenantId;
}

/**
 * Resolve the caller's tenant AND user id. The related-content route needs the
 * user id as well, to exclude blocked accounts in both directions (M2).
 */
async function getTenantAndUser(
  request: Request,
  env: Env,
): Promise<{ tenantId: string; userId: string } | null> {
  const auth = await authMiddleware(request, env);
  if (!auth || !auth.activeTenantId || !auth.userId) return null;
  return { tenantId: auth.activeTenantId, userId: auth.userId };
}

function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized" }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

export const contentDiscoveryRoutes: Route[] = [
  // Get related content for a post
  {
    path: "/api/posts/:postId/related",
    method: "GET",
    handler: async (request, env, { pathname }) => {
      try {
        const caller = await getTenantAndUser(request, env);
        if (!caller) return unauthorizedResponse();
        const { tenantId, userId } = caller;

        const postId = pathname.split("/api/posts/")[1].split("/related")[0];

        // Get region
        const ctx = await createRequestContext(request, env);
        const region = ctx.region || "US";

        // Parse query parameters
        const url = new URL(request.url);
        const limit = parseInt(url.searchParams.get("limit") || "10", 10);
        const minMatchingTags = parseInt(
          url.searchParams.get("minMatchingTags") || "1",
          10,
        );
        const includeSameAuthor =
          url.searchParams.get("includeSameAuthor") === "true";

        // Get related content
        const recommendations = await ContentDiscovery.getRelatedContent(
          postId,
          tenantId,
          region,
          env as any,
          request,
          {
            limit: Math.min(limit, 20),
            minMatchingTags,
            includeSameAuthor,
            viewerUserId: userId,
          },
        );

        return new Response(
          JSON.stringify({
            recommendations,
            count: recommendations.length,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      } catch (error: any) {
        getLogger().error("Error getting related content:", error);
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
    description: "Get related content for a post based on taxonomy tags",
  },

  // Get trending topics
  {
    path: "/api/taxonomy/trending",
    method: "GET",
    handler: async (request, env) => {
      try {
        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();

        // Get region
        const ctx = await createRequestContext(request, env);
        const region = ctx.region || "US";

        // Parse query parameters
        const url = new URL(request.url);
        const limit = parseInt(url.searchParams.get("limit") || "20", 10);
        const period = (url.searchParams.get("period") || "week") as
          | "day"
          | "week"
          | "month";

        // Get trending topics
        const trending = await ContentDiscovery.getTrendingTopics(
          tenantId,
          region,
          env as any,
          request,
          {
            limit: Math.min(limit, 50),
            period,
          },
        );

        return new Response(
          JSON.stringify({ topics: trending, count: trending.length }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      } catch (error: any) {
        getLogger().error("Error getting trending topics:", error);
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
    description: "Get trending topics based on taxonomy usage",
  },

  // Get content recommendations for user
  {
    path: "/api/recommendations/content",
    method: "GET",
    handler: async (request, env) => {
      try {
        const sessionManager = new SessionManager();
        const securityHeaders = new SecurityHeaders(env);
        const session = await sessionManager.getSession(
          request,
          env.SESSION_SECRET,
        );

        if (!session) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }

        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();

        // Get region
        const ctx = await createRequestContext(request, env);
        const region = ctx.region || "US";

        // Parse query parameters
        const url = new URL(request.url);
        const limit = parseInt(url.searchParams.get("limit") || "10", 10);
        const entityIds = url.searchParams.get("entityIds")
          ? url.searchParams.get("entityIds")!.split(",")
          : undefined;

        // Get content recommendations
        const recommendations =
          await ContentDiscovery.getContentRecommendations(
            session.userId,
            tenantId,
            region,
            env as any,
            request,
            {
              limit: Math.min(limit, 20),
              entityIds,
            },
          );

        return securityHeaders.createSecureResponse(
          JSON.stringify({
            recommendations,
            count: recommendations.length,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      } catch (error: any) {
        getLogger().error(
          "Error getting content recommendations:",
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
    description:
      "Get content recommendations based on user's entity taxonomy tags",
  },

  // Get creator recommendations for user
  {
    path: "/api/recommendations/creators",
    method: "GET",
    handler: async (request, env) => {
      try {
        const sessionManager = new SessionManager();
        const securityHeaders = new SecurityHeaders(env);
        const session = await sessionManager.getSession(
          request,
          env.SESSION_SECRET,
        );

        if (!session) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }

        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();

        // Get region
        const ctx = await createRequestContext(request, env);
        const region = ctx.region || "US";

        // Parse query parameters
        const url = new URL(request.url);
        const limit = parseInt(url.searchParams.get("limit") || "10", 10);
        const entityIds = url.searchParams.get("entityIds")
          ? url.searchParams.get("entityIds")!.split(",")
          : undefined;
        const minPostCount = parseInt(
          url.searchParams.get("minPostCount") || "3",
          10,
        );
        const minMatchingTags = parseInt(
          url.searchParams.get("minMatchingTags") || "1",
          10,
        );

        // Get creator recommendations
        const recommendations =
          await ContentDiscovery.getCreatorRecommendations(
            session.userId,
            tenantId,
            region,
            env as any,
            request,
            {
              limit: Math.min(limit, 20),
              entityIds,
              minPostCount,
              minMatchingTags,
            },
          );

        return securityHeaders.createSecureResponse(
          JSON.stringify({
            recommendations,
            count: recommendations.length,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      } catch (error: any) {
        getLogger().error(
          "Error getting creator recommendations:",
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
    description:
      "Get creator recommendations based on user's entity taxonomy tags",
  },
];
