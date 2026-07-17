/**
 * Report Routes (compliance plan 08 §2.2).
 *
 *   POST /api/reports          — file a content report (auth, rate-limited, deduped)
 *   GET  /api/reports/mine     — the reporter's own notices + statuses
 *
 * Shell mirrors `routes/link-reports.ts`: SessionManager auth, per-user
 * KV rate-limit, SecurityHeaders on every response, CORS+CSRF middleware.
 */

import { getLogger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { ReportHandler } from "../report-handler.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

// Per-user rate limit for report creation (F10 protection, shared intent with
// spec 07's feedback path): 20 reports/hour/user.
const REPORT_RATE_LIMIT = 20;
const REPORT_RATE_WINDOW_SECONDS = 3600;

export const reportRoutes: Route[] = [
  {
    path: "/api/reports",
    method: "POST",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const rateLimiter = new RateLimiter();

      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env as any,
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
        "/reports",
        REPORT_RATE_LIMIT,
        REPORT_RATE_WINDOW_SECONDS,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      if (!requestContext) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request context not available" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      const handler = new ReportHandler();
      const response = await handler.handleCreate(
        request,
        session,
        env,
        requestContext,
      );
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description:
      "File a content report. Auth required, rate-limited per user, deduped " +
      "(same user + resource + category = one open report). Body: " +
      "{ categoryKey, resourceType, resourceId, reason? }.",
  },

  {
    path: "/api/reports/mine",
    method: "GET",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env as any,
      );
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      if (!requestContext) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request context not available" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const handler = new ReportHandler();
        const response = await handler.handleListMine(
          session,
          env,
          requestContext,
          new URL(request.url),
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("[Reports] /api/reports/mine failed", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "List the authenticated reporter's own reports (newest first).",
  },
];
