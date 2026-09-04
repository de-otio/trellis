/**
 * Report Routes (compliance plan 08 §2.2).
 *
 *   POST /api/reports          — file a content report (auth, rate-limited, deduped)
 *   GET  /api/reports/mine     — the reporter's own notices + statuses
 *   GET  /api/reports/:id      — status poll for one of the reporter's reports
 *                                (receipt, decision, statement, remedies)
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

/** Single-report status poll. Must stay a plain capture group — see app.ts's
 *  `regexToHonoPath`, which refuses to translate anything with lookaheads. */
const STATUS_PATH = /^\/api\/reports\/([^/]+)$/;

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

  {
    path: STATUS_PATH,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
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

      const reportId = decodeURIComponent(pathname.match(STATUS_PATH)?.[1] ?? "");

      try {
        const handler = new ReportHandler();
        // `/api/reports/mine` is a sibling of this pattern, and which of the two
        // a router prefers is a router-internal tie-break. Resolving it here
        // makes the behaviour independent of that: "mine" is never a report id.
        const response =
          reportId === "mine"
            ? await handler.handleListMine(
                session,
                env,
                requestContext,
                new URL(request.url),
              )
            : await handler.handleStatus(reportId, session, env, requestContext);
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("[Reports] /api/reports/:id failed", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware()],
    description:
      "Status poll for one of the authenticated reporter's own reports: the " +
      "Art. 16(4) receipt, the Art. 16(5) decision, the statement of reasons " +
      "(suppressed ones excluded) and the redress information. 404 for a " +
      "report belonging to anyone else.",
  },
];
