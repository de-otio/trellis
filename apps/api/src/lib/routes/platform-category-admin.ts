/**
 * PlatformCategory Admin Routes
 *
 * Platform-level taxonomy administration, restricted to SUPER_ADMIN users.
 * These routes manage the shared `PlatformCategory` vocabulary that every
 * tenant's classification and every directory search draw from.
 *
 * NOTE: authentication here is the same JWT Bearer pattern as all tenant
 * routes. SUPER_ADMIN gating is enforced inside the handler via `auth.globalRole`
 * (not a tenant capability — this is platform-level, not tenant-level).
 *
 * Routes (intentionally NOT registered in routes/index.ts yet — Phase 3
 * integration barrier wires them in to avoid concurrent-edit conflicts):
 *
 *   POST  /api/admin/platform-categories
 *   POST  /api/admin/platform-categories/:id/deactivate
 *   POST  /api/admin/platform-categories/:id/reparent
 */

import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { PlatformCategoryAdminHandler } from "../tenant/platform-category-admin-handler.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

export const platformCategoryAdminRoutes: Route[] = [
  // ── POST /api/admin/platform-categories ────────────────────────────────────
  // Create a new PlatformCategory node. SUPER_ADMIN only.
  {
    path: "/api/admin/platform-categories",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const handler = new PlatformCategoryAdminHandler();
      const response = await handler.handleCreate(request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description:
      "Create a platform category node. SUPER_ADMIN only. " +
      "Requires a unique `code` (lowercase alphanumeric with hyphens/colons) and `displayName`. " +
      "Optionally supply `parentCategoryId` to place the node under an existing active category.",
  },

  // ── POST /api/admin/platform-categories/:id/deactivate ────────────────────
  // Deactivate a PlatformCategory node (and all its descendants).
  // If any TenantClassification rows depend on the subtree, a `reassignTo`
  // target must be supplied and will be validated before the transaction commits.
  {
    path: /^\/api\/admin\/platform-categories\/([^/]+)\/deactivate$/,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const categoryId =
        pathname.match(/^\/api\/admin\/platform-categories\/([^/]+)\/deactivate$/)?.[1] ?? "";

      const handler = new PlatformCategoryAdminHandler();
      const response = await handler.handleDeactivate(categoryId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description:
      "Deactivate a platform category and its descendants. SUPER_ADMIN only. " +
      "When active TenantClassification rows depend on the subtree, supply " +
      "`reassignTo` (an active category outside the subtree) to bulk-reassign them " +
      "in the same transaction. Without `reassignTo` the request is rejected with 422.",
  },

  // ── POST /api/admin/platform-categories/:id/reparent ─────────────────────
  // Move a PlatformCategory to a new parent.
  // Pass `newParentCategoryId: null` to promote a node to a root.
  // Rejects with 422 if the new parent is a descendant (cycle prevention).
  {
    path: /^\/api\/admin\/platform-categories\/([^/]+)\/reparent$/,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const categoryId =
        pathname.match(/^\/api\/admin\/platform-categories\/([^/]+)\/reparent$/)?.[1] ?? "";

      const handler = new PlatformCategoryAdminHandler();
      const response = await handler.handleReparent(categoryId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description:
      "Move a platform category to a new parent. SUPER_ADMIN only. " +
      "Pass `newParentCategoryId: null` to make the node a root. " +
      "Rejected with 422 if the new parent is a descendant of the node (cycle guard).",
  },
];
