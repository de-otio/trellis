/**
 * Deletion Routes
 */

import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { deleteAccountConfirmationSchema } from "../schemas.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { UserDeletionHandlerEnhanced } from "../user-deletion-handler-enhanced.js";
import { validateRequest } from "../validate-request.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";

export const deletionRoutes: Route[] = [
  {
    path: "/api/user/delete-account",
    method: "DELETE",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const validator = new Validator();
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

      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/user/delete-account",
        3,
        3600,
        undefined,
        undefined,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const deletionHandler = new UserDeletionHandlerEnhanced();
        const result = await deletionHandler.requestDeletion(
          session,
          env as any,
        );
        return securityHeaders.createSecureResponse(JSON.stringify(result), {
          status: result.success ? 200 : 400,
          headers: { "content-type": "application/json" },
        });
      } catch (error: any) {
        const msg = error.message || validator.sanitizeError(error);
        const isExpected =
          msg.includes("not found") || msg.includes("rate limit") || msg.includes("already");
        if (!isExpected) {
          logger.error("Error requesting account deletion:", error);
        }
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: msg }),
          {
            status: isExpected ? 400 : 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Request account deletion",
  },

  {
    path: "/api/user/delete-account/confirm",
    method: "POST",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
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
        const validation = await validateRequest(
          request,
          deleteAccountConfirmationSchema,
        );
        if (!validation.success) {
          return securityHeaders.addSecurityHeaders(validation.error);
        }
        const { confirmationCode } = validation.data;

        const deletionHandler = new UserDeletionHandlerEnhanced();
        const result = await deletionHandler.confirmDeletion(
          session.userId,
          confirmationCode,
          env as any,
        );
        return securityHeaders.createSecureResponse(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error: any) {
        logger.error("Error confirming account deletion:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({
            error: error.message || "Failed to confirm deletion",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Confirm account deletion",
  },

  {
    path: "/api/user/delete-account/cancel",
    method: "POST",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
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
        const deletionHandler = new UserDeletionHandlerEnhanced();
        const result = await deletionHandler.cancelDeletion(
          session,
          env as any,
        );
        return securityHeaders.createSecureResponse(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error: any) {
        const msg = error.message || "Failed to cancel deletion";
        // Client-state conditions cancelDeletion can throw ("No deletion
        // request found to cancel", "Grace period has expired...") are 4xx,
        // not server errors. Without these, cancelling with nothing pending
        // returns 500 (the "not found" check misses "...request found to...").
        const isExpected =
          msg.includes("not found") ||
          msg.includes("No deletion request") ||
          msg.includes("Grace period") ||
          msg.includes("rate limit");
        if (!isExpected) {
          logger.error("Error cancelling account deletion:", error);
        }
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: msg }),
          {
            status: isExpected ? 400 : 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Cancel account deletion",
  },

  {
    path: "/api/user/delete-account/status",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
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
        const { createPrisma } = await import("../../db.js");
        const db = createPrisma(env);
        const user = await db.user.findUnique({
          where: { id: session.userId },
          select: {
            deletionRequestedAt: true,
            deletionScheduledAt: true,
            deletionConfirmedAt: true,
            suspended: true,
          },
        });

        if (!user || !user.deletionRequestedAt) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ status: "none", message: "No deletion request found" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        let status: string;
        if (user.deletionConfirmedAt) {
          const now = new Date();
          status = user.deletionScheduledAt && now >= user.deletionScheduledAt
            ? "processing"
            : "confirmed";
        } else {
          status = "pending_confirmation";
        }

        return securityHeaders.createSecureResponse(
          JSON.stringify({
            status,
            requestedAt: user.deletionRequestedAt.toISOString(),
            scheduledAt: user.deletionScheduledAt?.toISOString(),
            confirmedAt: user.deletionConfirmedAt?.toISOString(),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (error: any) {
        logger.error("Error getting deletion status:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({
            error: error.message || "Failed to get deletion status",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get deletion status",
  },
];
