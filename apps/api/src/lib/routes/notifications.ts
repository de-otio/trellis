/**
 * Notifications Routes
 *
 * Routes for notification management: list, read, unread count, and preferences.
 * All routes require authentication.
 */

import { ageGateMiddleware } from "../age-gate-middleware.js";
import { resolveSessionAgeTier } from "../age-gate.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { getLogger, Logger } from "../logger.js";
import {
  corsMiddleware,
  csrfMiddleware,
  rateLimitMiddleware,
} from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { Validator } from "../validation.js";
import { NotificationHandler, NotificationNotFoundError } from "../notification-handler.js";
import { NotificationPreferencesHandler } from "../notification-preferences-handler.js";
import type { Route } from "./types.js";

export const notificationsRoutes: Route[] = [
  // GET /api/notifications — list notifications (cursor-paginated)
  {
    path: /^\/api\/notifications$/,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new NotificationHandler();
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
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor") || null;
        const limit = parseInt(url.searchParams.get("limit") || "20", 10);

        const result = await handler.getNotifications(
          session.userId,
          cursor,
          limit,
          env,
          auth.activeTenantId,
        );

        return securityHeaders.addSecurityHeaders(
          new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      } catch (error) {
        logger.error("Error listing notifications:", error);
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
    description: "List notifications",
  },

  // POST /api/notifications/:id/read — mark single notification as read
  {
    path: /^\/api\/notifications\/([^/]+)\/read$/,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new NotificationHandler();
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
        const notificationId = pathname
          .split("/api/notifications/")[1]
          .split("/read")[0];

        await handler.markRead(session.userId, notificationId, env, auth.activeTenantId);

        return securityHeaders.addSecurityHeaders(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      } catch (error) {
        if (error instanceof NotificationNotFoundError) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Notification not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        logger.error("Error marking notification as read:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      rateLimitMiddleware({ maxRequests: 30, windowMs: 60000 }),
    ],
    description: "Mark notification as read",
  },

  // POST /api/notifications/read-all — mark all notifications as read
  {
    path: /^\/api\/notifications\/read-all$/,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new NotificationHandler();
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
        await handler.markAllRead(session.userId, env, auth.activeTenantId);

        return securityHeaders.addSecurityHeaders(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      } catch (error) {
        logger.error("Error marking all notifications as read:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 }),
    ],
    description: "Mark all notifications as read",
  },

  // GET /api/notifications/unread-count — get unread count
  {
    path: /^\/api\/notifications\/unread-count$/,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new NotificationHandler();
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
        // Unread counts are redacted to a boolean for minors. The tier
        // resolves to ADULT for every session (age-gate.ts
        // MINOR_TIERS_SUPPORTED), so the exact count is always returned —
        // by construction, not because the claim happens to be absent.
        const ageTier = resolveSessionAgeTier(session.ageTier);
        const result = await handler.getUnreadCount(
          session.userId,
          ageTier,
          env,
          auth.activeTenantId,
        );

        return securityHeaders.addSecurityHeaders(
          new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      } catch (error) {
        logger.error("Error getting unread count:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      ageGateMiddleware(),
      rateLimitMiddleware({ maxRequests: 120, windowMs: 60000 }),
    ],
    description: "Get unread notification count",
  },

  // GET /api/notifications/preferences — get notification preferences
  {
    path: /^\/api\/notifications\/preferences$/,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const prefsHandler = new NotificationPreferencesHandler();
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
        const response = await prefsHandler.getPreferences(
          session.userId,
          env,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error getting notification preferences:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      rateLimitMiddleware({ maxRequests: 30, windowMs: 60000 }),
    ],
    description: "Get notification preferences",
  },

  // PUT /api/notifications/preferences — update notification preferences
  {
    path: /^\/api\/notifications\/preferences$/,
    method: "PUT",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const prefsHandler = new NotificationPreferencesHandler();
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
        const body = await request.json();
        // Notification preferences are locked for CHILD accounts. The tier
        // resolves to ADULT for every session (age-gate.ts
        // MINOR_TIERS_SUPPORTED), so the lock never engages.
        const ageTier = resolveSessionAgeTier(session.ageTier);

        const response = await prefsHandler.updatePreferences(
          session.userId,
          ageTier,
          body as any,
          env,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        if (error instanceof SyntaxError) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "VALIDATION_ERROR",
              message: "Invalid JSON body",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        logger.error("Error updating notification preferences:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 }),
    ],
    description: "Update notification preferences",
  },
];
