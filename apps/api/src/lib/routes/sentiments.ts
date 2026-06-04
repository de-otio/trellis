/**
 * Sentiments Routes
 */

import { ageGateMiddleware } from "../age-gate-middleware.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware, rateLimitMiddleware } from "../middleware.js";
import { ReactionHandler } from "../reaction-handler.js";
import { getSentimentUsersSchema, sentimentSchema } from "../schemas.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { validateRequest } from "../validate-request.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";

export const sentimentsRoutes: Route[] = [
  {
    path: /^\/api\/posts\/([^/]+)\/sentiment$/,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const reactionHandler = new ReactionHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const postId = pathname.split("/api/posts/")[1].split("/sentiment")[0];
        const validation = await validateRequest(request, sentimentSchema);
        if (!validation.success) {
          return securityHeaders.addSecurityHeaders(validation.error);
        }
        const { sentiment } = validation.data;

        const response = await reactionHandler.addPostSentiment(
          postId,
          sentiment,
          session,
          env as any,
          requestContext,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error adding post sentiment:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      rateLimitMiddleware({ maxRequests: 20, windowMs: 60000 }),
    ],
    description: "Add post sentiment",
  },

  {
    path: /^\/api\/posts\/([^/]+)\/sentiment$/,
    method: "DELETE",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const reactionHandler = new ReactionHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const postId = pathname.split("/api/posts/")[1].split("/sentiment")[0];
        const response = await reactionHandler.removePostSentiment(
          postId,
          session,
          env as any,
          requestContext,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error removing post sentiment:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      rateLimitMiddleware({ maxRequests: 20, windowMs: 60000 }),
    ],
    description: "Remove post sentiment",
  },

  {
    path: /^\/api\/posts\/([^/]+)\/sentiments$/,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const reactionHandler = new ReactionHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const postId = pathname.split("/api/posts/")[1].split("/sentiments")[0];
        const response = await reactionHandler.getPostSentiments(
          postId,
          session || null,
          env as any,
          requestContext,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error getting post sentiments:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get post sentiments",
  },

  {
    path: /^\/api\/v1\/posts\/([^/]+)\/sentiments\/users$/,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const reactionHandler = new ReactionHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      // Safer Social Design: Age-gate sentiment user list
      if (session?.ageTier === "CHILD") {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "FORBIDDEN", message: "This feature is not available for your account" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const postId = pathname.split("/api/v1/posts/")[1].split("/sentiments/users")[0];

        // Parse query parameters
        const url = new URL(request.url);
        const sentiment = url.searchParams.get("sentiment");
        const limit = url.searchParams.get("limit") || "20";
        const cursor = url.searchParams.get("cursor");

        // Validate parameters
        const validation = getSentimentUsersSchema.safeParse({
          postId,
          sentiment: sentiment || undefined,
          limit: parseInt(limit, 10),
          cursor: cursor || undefined,
        });

        if (!validation.success) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({
              type: "https://api.example.com/errors/validation-failed",
              title: "Validation Failed",
              status: 400,
              detail: "Invalid request parameters",
              instance: pathname,
              traceId: Math.random().toString(36).substring(7),
              errors: validation.error.issues.map((err) => ({
                path: err.path.join("."),
                message: err.message,
              })),
            }),
            { status: 400, headers: { "content-type": "application/problem+json" } },
          );
        }

        const response = await reactionHandler.getPostSentimentUsers(
          postId,
          sentiment,
          validation.data.limit,
          cursor,
          session || null,
          env as any,
          requestContext,
        );

        // Safer Social Design: TEEN users see sentiment types only, no user identities
        if (session?.ageTier === "TEEN") {
          const responseBody = await response.json() as any;
          // Strip user identities, keep only sentiment types
          const sentimentTypes = [...new Set(
            (responseBody.users || responseBody.data || []).map((u: any) => u.sentiment).filter(Boolean)
          )];
          const teenResponse = new Response(
            JSON.stringify({ sentimentTypes, total: sentimentTypes.length }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
          return securityHeaders.addSecurityHeaders(teenResponse);
        }

        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error getting sentiment users:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      ageGateMiddleware(),
      rateLimitMiddleware({ maxRequests: 60, windowMs: 60000 }),
    ],
    description: "Get users who reacted to a post (v1)",
  },

  {
    path: /^\/api\/comments\/([^/]+)\/sentiment$/,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const reactionHandler = new ReactionHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const commentId = pathname
          .split("/api/comments/")[1]
          .split("/sentiment")[0];
        const validation = await validateRequest(request, sentimentSchema);
        if (!validation.success) {
          return securityHeaders.addSecurityHeaders(validation.error);
        }
        const { sentiment } = validation.data;

        const response = await reactionHandler.addCommentSentiment(
          commentId,
          sentiment,
          session,
          env as any,
          requestContext,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error adding comment sentiment:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      rateLimitMiddleware({ maxRequests: 20, windowMs: 60000 }),
    ],
    description: "Add comment sentiment",
  },

  {
    path: /^\/api\/comments\/([^/]+)\/sentiment$/,
    method: "DELETE",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const reactionHandler = new ReactionHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const commentId = pathname
          .split("/api/comments/")[1]
          .split("/sentiment")[0];
        const response = await reactionHandler.removeCommentSentiment(
          commentId,
          session,
          env as any,
          requestContext,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error removing comment sentiment:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      rateLimitMiddleware({ maxRequests: 20, windowMs: 60000 }),
    ],
    description: "Remove comment sentiment",
  },

  {
    path: /^\/api\/comments\/([^/]+)\/sentiments$/,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const reactionHandler = new ReactionHandler();

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const commentId = pathname
          .split("/comments/")[1]
          .split("/sentiments")[0];
        const response = await reactionHandler.getCommentSentiments(
          commentId,
          env as any,
          requestContext,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error getting comment sentiments:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get comment sentiments",
  },
];
