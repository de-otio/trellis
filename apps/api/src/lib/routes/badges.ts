/**
 * Badges Routes
 */

import { addCorsHeaders } from "../../worker.js";
import { BadgeHandler } from "../badge-handler.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import type { Route } from "./types.js";

export const badgesRoutes: Route[] = [
  {
    path: /^\/api\/users\/([^\/]+)\/badges$/,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const badgeHandler = new BadgeHandler();
      const badgeMatch = pathname.match(/^\/api\/users\/([^\/]+)\/badges$/);
      if (!badgeMatch) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Invalid path" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      const userId = badgeMatch[1];
      try {
        const response = await badgeHandler.handleGetUserBadges(
          request,
          env,
          userId,
        );
        return securityHeaders.addSecurityHeaders(
          await addCorsHeaders(response, request, env),
        );
      } catch (error) {
        logger.error("Error getting user badges:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to get user badges" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "Get user badges",
  },

  {
    path: /^\/api\/users\/([^\/]+)\/badges\/display$/,
    method: "PATCH",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const badgeHandler = new BadgeHandler();
      const badgeDisplayMatch = pathname.match(
        /^\/api\/users\/([^\/]+)\/badges\/display$/,
      );
      if (!badgeDisplayMatch) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Invalid path" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      const userId = badgeDisplayMatch[1];
      try {
        const response = await badgeHandler.handleUpdateBadgeDisplay(
          request,
          env,
          userId,
        );
        return securityHeaders.addSecurityHeaders(
          await addCorsHeaders(response, request, env),
        );
      } catch (error) {
        logger.error("Error updating badge display:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to update badge display" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update badge display",
  },
];
