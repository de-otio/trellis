/**
 * Tenant Routes
 *
 * - POST /api/tenants
 * - GET  /api/tenants/:id
 * - PATCH /api/tenants/:id
 * - POST /api/tenants/:id/transfer-ownership
 * - GET  /api/users/me/tenants
 * - POST /api/auth/switch-tenant
 */

import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { SecurityHeaders } from "../security-headers.js";
import { TenantHandler } from "../tenant/tenant-handler.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

export const tenantRoutes: Route[] = [
  // ── POST /api/tenants ─────────────────────────────────────────────────────
  {
    path: "/api/tenants",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const handler = new TenantHandler();
      const response = await handler.handleCreate(request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware(), idempotencyMiddleware()],
    description: "Create organization tenant",
  },

  // ── GET /api/tenants/:id ──────────────────────────────────────────────────
  {
    path: /^\/api\/tenants\/([^/]+)$/,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const tenantId = pathname.match(/^\/api\/tenants\/([^/]+)$/)?.[1] ?? "";
      const handler = new TenantHandler();
      const response = await handler.handleGet(tenantId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "Get tenant by ID",
  },

  // ── PATCH /api/tenants/:id ────────────────────────────────────────────────
  {
    path: /^\/api\/tenants\/([^/]+)$/,
    method: "PATCH",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const tenantId = pathname.match(/^\/api\/tenants\/([^/]+)$/)?.[1] ?? "";
      const handler = new TenantHandler();
      const response = await handler.handleUpdate(tenantId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update tenant displayName",
  },

  // ── POST /api/tenants/:id/transfer-ownership ──────────────────────────────
  {
    path: /^\/api\/tenants\/([^/]+)\/transfer-ownership$/,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const tenantId =
        pathname.match(/^\/api\/tenants\/([^/]+)\/transfer-ownership$/)?.[1] ?? "";
      const handler = new TenantHandler();
      const response = await handler.handleTransferOwnership(tenantId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Transfer tenant ownership",
  },

  // ── GET /api/users/me/tenants ─────────────────────────────────────────────
  {
    path: "/api/users/me/tenants",
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const handler = new TenantHandler();
      const response = await handler.handleListMyTenants(auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "List caller's tenant memberships",
  },

  // ── POST /api/auth/switch-tenant ──────────────────────────────────────────
  {
    path: "/api/auth/switch-tenant",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const handler = new TenantHandler();
      const response = await handler.handleSwitchTenant(request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Switch active tenant",
  },
];
