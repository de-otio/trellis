/**
 * Comments Routes
 */

import { CommentHandler } from "../comment-handler.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { paginationSchema } from "../schemas.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { validateQueryParams } from "../validate-request.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";

export const commentsRoutes: Route[] = [
  {
    path: /^\/api\/posts\/([^/]+)\/comments$/,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const commentHandler = new CommentHandler();
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

      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
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

        const postId = pathname.split("/api/posts/")[1].split("/comments")[0];
        const response = await commentHandler.createComment(
          postId,
          request,
          session,
          env as any,
          requestContext,
          auth.activeTenantId,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error creating comment:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Create comment",
  },

  {
    path: /^\/api\/posts\/([^/]+)\/comments$/,
    method: "GET",
    handler: async (request, env, { pathname, url, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const commentHandler = new CommentHandler();
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

      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
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

        const postId = pathname.split("/api/posts/")[1].split("/comments")[0];
        const queryValidation = validateQueryParams(url, paginationSchema);
        if (!queryValidation.success) {
          return securityHeaders.addSecurityHeaders(queryValidation.error);
        }
        const { limit, cursor } = queryValidation.data;

        const response = await commentHandler.getComments(
          postId,
          request,
          session,
          { limit, cursor },
          env as any,
          requestContext,
          auth.activeTenantId,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error getting comments:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get comments",
  },

  {
    path: /^\/api\/comments\/([^/]+)\/hide$/,
    method: "PATCH",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const commentHandler = new CommentHandler();
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

      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
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

        const commentId = pathname.split("/api/comments/")[1].split("/hide")[0];
        const response = await commentHandler.hideComment(
          commentId,
          request,
          session,
          env as any,
          requestContext,
          auth.activeTenantId,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error hiding comment:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Hide comment",
  },

  {
    path: /^\/api\/comments\/([^/]+)\/unhide$/,
    method: "PATCH",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const commentHandler = new CommentHandler();
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

      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
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
          .split("/unhide")[0];
        const response = await commentHandler.unhideComment(
          commentId,
          request,
          session,
          env as any,
          requestContext,
          auth.activeTenantId,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error unhiding comment:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Unhide comment",
  },

  {
    path: /^\/api\/comments\/([^/]+)$/,
    method: "PATCH",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const commentHandler = new CommentHandler();
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

      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
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

        const commentId = pathname.split("/api/comments/")[1];
        const response = await commentHandler.editComment(
          commentId,
          request,
          session,
          env as any,
          requestContext,
          auth.activeTenantId,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error editing comment:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Edit comment",
  },

  {
    path: /^\/api\/comments\/([^/]+)$/,
    method: "DELETE",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const commentHandler = new CommentHandler();
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

      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
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

        const commentId = pathname.split("/api/comments/")[1];
        const response = await commentHandler.deleteComment(
          commentId,
          request,
          session,
          env as any,
          requestContext,
          auth.activeTenantId,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error deleting comment:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Delete comment",
  },

  {
    path: /^\/api\/comments\/([^/]+)\/replies$/,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const commentHandler = new CommentHandler();
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

      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
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

        const parentCommentId = pathname.split("/api/comments/")[1].split("/replies")[0];
        const response = await commentHandler.createReply(
          parentCommentId,
          request,
          session,
          env as any,
          requestContext,
          auth.activeTenantId,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error creating reply:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Create reply to comment",
  },
];
