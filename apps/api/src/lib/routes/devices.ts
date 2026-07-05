/**
 * Push Device Routes (T8)
 *
 * Device-token registration for push wakeups. Frozen contract:
 * apps/api/src/lib/doc/push-device-contract.md §2. All routes require an
 * authenticated session; identity is the server-resolved session userId,
 * never a client claim. The raw token is never echoed back or logged.
 */

import { z } from "zod";
import { authMiddleware } from "../auth/auth-middleware.js";
import { getLogger } from "../logger.js";
import {
  corsMiddleware,
  csrfMiddleware,
  rateLimitMiddleware,
} from "../middleware.js";
import { PushDeviceHandler } from "../push/push-device-handler.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { validateRequest } from "../validate-request.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";

const registerDeviceSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(["apns", "fcm", "web"]),
});

export const devicesRoutes: Route[] = [
  // POST /api/devices/register — register/refresh a push device token
  {
    path: /^\/api\/devices\/register$/,
    method: "POST",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new PushDeviceHandler();
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

      const validation = await validateRequest(request, registerDeviceSchema);
      if (!validation.success) {
        return securityHeaders.addSecurityHeaders(validation.error);
      }

      try {
        const device = await handler.registerDevice(
          session.userId,
          validation.data.token,
          validation.data.platform,
          env,
        );

        return securityHeaders.addSecurityHeaders(
          new Response(JSON.stringify({ device }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        );
      } catch (error) {
        logger.error("Error registering push device:", error);
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
    description: "Register push device token",
  },

  // DELETE /api/devices/:id — delete one of the caller's registered devices
  {
    path: /^\/api\/devices\/([^/]+)$/,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const handler = new PushDeviceHandler();
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
        const deviceId = pathname.match(/^\/api\/devices\/([^/]+)$/)?.[1];
        if (!deviceId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Device not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        // Owner-scoped delete: a foreign or unknown id is indistinguishable
        // (404, no existence oracle — contract §2.2).
        const deleted = await handler.deleteDevice(
          session.userId,
          deviceId,
          env,
        );
        if (!deleted) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Device not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        return securityHeaders.addSecurityHeaders(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      } catch (error) {
        logger.error("Error deleting push device:", error);
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
    description: "Delete push device",
  },
];
