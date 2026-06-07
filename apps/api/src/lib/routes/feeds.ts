/**
 * Feeds Routes
 */

import { addCorsHeaders } from "../../worker.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { FeedHandler } from "../feed-handler.js";
import { getLogger, Logger } from "../logger.js";
import { ageGateMiddleware } from "../age-gate-middleware.js";
import { corsMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { feedQuerySchema, paginationSchema } from "../schemas.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { validateQueryParams } from "../validate-request.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";

export const feedsRoutes: Route[] = [
  {
    path: "/api/feeds/entity/*",
    method: "GET",
    handler: async (request, env, { pathname, url, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const feedHandler = new FeedHandler();
      const sessionSecret = env.SESSION_SECRET;
      const session = await sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      const rateLimiter = new RateLimiter();
      const rateLimitResponse = rateLimiter.applyRateLimit(
        request,
        "/api/feeds/entity",
        30,
        60,
        undefined,
        undefined,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const entityRef = decodeURIComponent(pathname.split("/api/feeds/entity/")[1]);
        const queryValidation = validateQueryParams(url, paginationSchema);
        if (!queryValidation.success) {
          return securityHeaders.addSecurityHeaders(queryValidation.error);
        }
        const { limit, cursor } = queryValidation.data;

        const response = await feedHandler.getEntityFeed(
          session,
          entityRef,
          env as any,
          { limit, cursor },
          requestContext,
          auth.activeTenantId,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error getting entity feed:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), ageGateMiddleware()],
    description: "Get entity feed",
  },

  {
    path: "/api/feeds/home",
    method: "GET",
    handler: async (request, env, { url, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const feedHandler = new FeedHandler();
      const sessionSecret = env.SESSION_SECRET;
      const session = await sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );

      if (!session) {
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return await addCorsHeaders(response, request, env);
      }

      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return await addCorsHeaders(response, request, env);
      }

      const rateLimiter = new RateLimiter();
      const rateLimitResponse = rateLimiter.applyRateLimit(
        request,
        "/api/feeds/home",
        30,
        60,
        undefined,
        undefined,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        if (!requestContext) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
          return await addCorsHeaders(errorResponse, request, env);
        }

        const queryValidation = validateQueryParams(url, feedQuerySchema);
        if (!queryValidation.success) {
          const securedResponse = securityHeaders.addSecurityHeaders(
            queryValidation.error,
          );
          return await addCorsHeaders(securedResponse, request, env);
        }
        const {
          limit,
          cursor,
          entityRef,
          entityRefs,
          taxonomyTags,
          personalized,
          personalizationEntityIds,
        } = queryValidation.data;

        const response = await feedHandler.getHomeFeed(
          session,
          request,
          env as any,
          {
            limit,
            cursor,
            entityRef,
            entityRefs,
            taxonomyTags,
            personalized,
            personalizationEntityIds,
          },
          requestContext,
          auth.activeTenantId,
        );
        const securedResponse = securityHeaders.addSecurityHeaders(response);
        return await addCorsHeaders(securedResponse, request, env);
      } catch (error: any) {
        logger.error("Error getting home feed (outer catch):", error);
        logger.error("Error stack:", error.stack);
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: validator.sanitizeError(error),
            message: error.message,
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return await addCorsHeaders(response, request, env);
      }
    },
    middleware: [corsMiddleware(), ageGateMiddleware()],
    description: "Get home feed",
  },

  {
    path: "/xrpc/app.bsky.feed.getFeedSkeleton",
    method: "GET",
    handler: async (request, env, { url }) => {
      const securityHeaders = new SecurityHeaders(env);
      const queryValidation = validateQueryParams(url, paginationSchema);
      if (!queryValidation.success) {
        return securityHeaders.addSecurityHeaders(queryValidation.error);
      }

      return securityHeaders.createSecureResponse(
        JSON.stringify({ feed: [], cursor: null, error: "Not implemented" }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
    },
    middleware: [corsMiddleware(), ageGateMiddleware()],
    description: "ATProto feed generator endpoint",
  },
];
