/**
 * Parental Controls Routes
 *
 * Routes for guardian management of linked child accounts.
 */

import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware, rateLimitMiddleware } from "../middleware.js";
import { ParentalControlHandler } from "../parental-control-handler.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { validateRequest } from "../validate-request.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";
import { z } from "zod";

const updateSettingsSchema = z.object({
  stealthMode: z.boolean().optional(),
  showOnlineStatus: z.boolean().optional(),
  showTypingIndicator: z.boolean().optional(),
  showLastSeen: z.boolean().optional(),
  locationTrackingEnabled: z.boolean().optional(),
  locationAnonymizationLevel: z.number().int().min(0).max(3).optional(),
  analyticsOptOut: z.boolean().optional(),
  profileVisibility: z.enum(["PUBLIC", "CONNECTIONS", "PRIVATE"]).optional(),
  dmAccess: z.enum(["ANYONE", "CONNECTIONS", "NOBODY"]).optional(),
});

const quietHoursSchema = z.object({
  start: z.number().int().min(0).max(1439),
  end: z.number().int().min(0).max(1439),
});

const dmAccessSchema = z.object({
  dmAccess: z.enum(["ANYONE", "CONNECTIONS", "NOBODY"]),
});

const profileVisibilitySchema = z.object({
  profileVisibility: z.enum(["PUBLIC", "CONNECTIONS", "PRIVATE"]),
});

export const parentalControlRoutes: Route[] = [
  {
    path: /^\/api\/parental\/children$/,
    method: "GET",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new ParentalControlHandler();
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
        const response = await handler.getChildren(session.userId, env);
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error listing children:", error);
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
    description: "List linked children",
  },

  {
    path: /^\/api\/parental\/children\/([^/]+)\/settings$/,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new ParentalControlHandler();
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
        const childId = pathname.match(/^\/api\/parental\/children\/([^/]+)\/settings$/)?.[1];
        if (!childId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Bad request", message: "Invalid child ID" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const response = await handler.getChildSettings(session.userId, childId, env);
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error getting child settings:", error);
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
    description: "Get child settings",
  },

  {
    path: /^\/api\/parental\/children\/([^/]+)\/settings$/,
    method: "PUT",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new ParentalControlHandler();
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
        const childId = pathname.match(/^\/api\/parental\/children\/([^/]+)\/settings$/)?.[1];
        if (!childId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Bad request", message: "Invalid child ID" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const validation = await validateRequest(request, updateSettingsSchema);
        if (!validation.success) {
          return securityHeaders.addSecurityHeaders(validation.error);
        }

        const response = await handler.updateChildSettings(
          session.userId,
          childId,
          validation.data,
          env,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error updating child settings:", error);
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
    description: "Update child settings",
  },

  {
    path: /^\/api\/parental\/children\/([^/]+)\/quiet-hours$/,
    method: "PUT",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new ParentalControlHandler();
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
        const childId = pathname.match(/^\/api\/parental\/children\/([^/]+)\/quiet-hours$/)?.[1];
        if (!childId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Bad request", message: "Invalid child ID" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const validation = await validateRequest(request, quietHoursSchema);
        if (!validation.success) {
          return securityHeaders.addSecurityHeaders(validation.error);
        }

        const response = await handler.setQuietHours(
          session.userId,
          childId,
          validation.data.start,
          validation.data.end,
          env,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error setting quiet hours:", error);
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
    description: "Set child quiet hours",
  },

  {
    path: /^\/api\/parental\/children\/([^/]+)\/dm-access$/,
    method: "PUT",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new ParentalControlHandler();
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
        const childId = pathname.match(/^\/api\/parental\/children\/([^/]+)\/dm-access$/)?.[1];
        if (!childId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Bad request", message: "Invalid child ID" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const validation = await validateRequest(request, dmAccessSchema);
        if (!validation.success) {
          return securityHeaders.addSecurityHeaders(validation.error);
        }

        const response = await handler.setDmAccess(
          session.userId,
          childId,
          validation.data.dmAccess,
          env,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error setting DM access:", error);
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
    description: "Set child DM access",
  },

  {
    path: /^\/api\/parental\/children\/([^/]+)\/profile-visibility$/,
    method: "PUT",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new ParentalControlHandler();
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
        const childId = pathname.match(/^\/api\/parental\/children\/([^/]+)\/profile-visibility$/)?.[1];
        if (!childId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Bad request", message: "Invalid child ID" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const validation = await validateRequest(request, profileVisibilitySchema);
        if (!validation.success) {
          return securityHeaders.addSecurityHeaders(validation.error);
        }

        const response = await handler.setProfileVisibility(
          session.userId,
          childId,
          validation.data.profileVisibility,
          env,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error setting profile visibility:", error);
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
    description: "Set child profile visibility",
  },

  {
    path: /^\/api\/parental\/children\/([^/]+)\/link$/,
    method: "DELETE",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new ParentalControlHandler();
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
        const childId = pathname.match(/^\/api\/parental\/children\/([^/]+)\/link$/)?.[1];
        if (!childId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Bad request", message: "Invalid child ID" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const response = await handler.removeLink(session.userId, childId, env);
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error removing parental link:", error);
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
    description: "Remove parental link",
  },
];
