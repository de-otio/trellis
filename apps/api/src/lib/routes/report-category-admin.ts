/**
 * ReportCategory Admin Routes (compliance plan 08 §2.1).
 *
 * SUPER_ADMIN-gated management of the data-driven report-category vocabulary.
 * Mirrors `routes/platform-category-admin.ts` (JWT Bearer auth via
 * authMiddleware; SUPER_ADMIN enforced inside the handler via `globalRole`).
 *
 *   GET   /api/admin/report-categories
 *   POST  /api/admin/report-categories                (upsert by key)
 *   POST  /api/admin/report-categories/:key/deactivate
 */

import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { ReportCategoryAdminHandler } from "../report-category-admin-handler.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

export const reportCategoryAdminRoutes: Route[] = [
  {
    path: "/api/admin/report-categories",
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth)
        return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const handler = new ReportCategoryAdminHandler();
      const response = await handler.handleList(auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description:
      "List all report categories (includes inactive). SUPER_ADMIN only.",
  },

  {
    path: "/api/admin/report-categories",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth)
        return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const handler = new ReportCategoryAdminHandler();
      const response = await handler.handleUpsert(request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description:
      "Create or update (upsert by `key`) a report category. SUPER_ADMIN only. " +
      "Body: { key, routingClass, labels, active?, sortOrder? }.",
  },

  {
    path: /^\/api\/admin\/report-categories\/([^/]+)\/deactivate$/,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth)
        return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const key =
        pathname.match(/^\/api\/admin\/report-categories\/([^/]+)\/deactivate$/)?.[1] ??
        "";

      const handler = new ReportCategoryAdminHandler();
      const response = await handler.handleDeactivate(
        decodeURIComponent(key),
        request,
        auth,
        env,
      );
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Deactivate a report category (active=false). SUPER_ADMIN only.",
  },
];
