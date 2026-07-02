/**
 * Tenant Directory Profile Routes
 *
 * - POST  /api/tenants/:id/directory-profile  — create directory profile
 * - PATCH /api/tenants/:id/directory-profile  — update directory profile
 * - GET   /api/tenants/:id/directory-profile  — read directory profile
 *
 * Authentication: required for all routes (Bearer token). Unauthenticated
 * callers receive 401.
 *
 * Authorization (mutations): `directory.edit` capability (TenantRole >= ADMIN).
 * The cross-tenant isolation guard (`requireActiveTenant`) runs inside the
 * handler BEFORE the capability check — see `directory-profile-handler.ts`.
 *
 * Authorization (GET): handler calls `requireOwnTenant` (404 for cross-tenant
 * callers, to avoid existence-leak).
 *
 * Note: `apps/api/src/lib/routes/index.ts` registration is a Phase 3 step
 * deferred deliberately to avoid concurrent-edit conflicts on that shared file.
 */

import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { DirectoryProfileHandler } from "../tenant/directory-profile-handler.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

const PROFILE_RE = /^\/api\/tenants\/([^/]+)\/directory-profile$/;

export const tenantDirectoryProfileRoutes: Route[] = [
  // ── POST /api/tenants/:id/directory-profile ───────────────────────────────
  {
    path: PROFILE_RE,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = PROFILE_RE.exec(pathname)?.[1] ?? "";
      const handler = new DirectoryProfileHandler();
      const response = await handler.handleCreate(tenantId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Create a tenant's public directory profile (ADMIN+)",
  },

  // ── PATCH /api/tenants/:id/directory-profile ──────────────────────────────
  {
    path: PROFILE_RE,
    method: "PATCH",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = PROFILE_RE.exec(pathname)?.[1] ?? "";
      const handler = new DirectoryProfileHandler();
      const response = await handler.handleUpdate(tenantId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description:
      "Update a tenant's directory profile (ADMIN+). Precision and discoverability changes are individually audited.",
  },

  // ── GET /api/tenants/:id/directory-profile ────────────────────────────────
  {
    path: PROFILE_RE,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = PROFILE_RE.exec(pathname)?.[1] ?? "";
      const handler = new DirectoryProfileHandler();
      const response = await handler.handleGet(tenantId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "Read a tenant's directory profile (own-tenant members only)",
  },
];
