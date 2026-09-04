/**
 * CONTENT-report admin routes (compliance plan 08 §2.2).
 *
 *   GET  /api/admin/content-reports
 *   POST /api/admin/content-reports/:id/decision
 *
 * SUPER_ADMIN-gated, mirroring `routes/report-category-admin.ts` (JWT Bearer via
 * authMiddleware; the role check lives in the handler). Deliberately separate
 * from `/api/admin/reports`, which is the LINK queue — see the handler's module
 * header for why the two are not merged.
 */

import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { ContentReportAdminHandler } from "../content-report-admin-handler.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

const DECISION_PATH = /^\/api\/admin\/content-reports\/([^/]+)\/decision$/;

export const contentReportAdminRoutes: Route[] = [
  {
    path: "/api/admin/content-reports",
    method: "GET",
    handler: async (request, env, { requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth)
        return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const region = requestContext?.region || env.DEFAULT_REGION || "EU";
      const handler = new ContentReportAdminHandler();
      const response = await handler.handleList(
        auth,
        env,
        new URL(request.url),
        region,
      );
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description:
      "List CONTENT reports for review (oldest first). SUPER_ADMIN only. " +
      "Query: status, categoryKey, routingClass, limit, cursor.",
  },

  {
    path: DECISION_PATH,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth)
        return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const reportId = pathname.match(DECISION_PATH)?.[1] ?? "";
      const region = requestContext?.region || env.DEFAULT_REGION || "EU";

      const handler = new ContentReportAdminHandler();
      const response = await handler.handleDecision(
        decodeURIComponent(reportId),
        request,
        auth,
        env,
        region,
      );
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description:
      "Acknowledge or decide a CONTENT report. SUPER_ADMIN only. Body: " +
      "{ status: 'acknowledged' } | { status: 'decided', resolution: " +
      "'actioned' | 'rejected' }. Deciding sends the reporter the Art. 16(5) " +
      "decision notice.",
  },
];
