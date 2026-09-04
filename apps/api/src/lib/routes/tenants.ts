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

import { z } from "zod";

import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { SecurityHeaders } from "../security-headers.js";
import { TenantHandler } from "../tenant/tenant-handler.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

/**
 * Response body of `GET /api/users/me/tenants` — the shape
 * `TenantHandler.handleListMyTenants` actually returns.
 *
 * Declared here rather than inferred because this is the first operation
 * published under `/api/v1` (plan 034 lane G): it is emitted as JSON Schema in
 * `/openapi.json`, so it is a contract a generated client is built against,
 * not an internal type.
 */
const myTenantsResponseSchema = z.object({
  memberships: z.array(
    z.object({
      tenantId: z.string(),
      role: z.string(),
      tenant: z.object({
        id: z.string(),
        slug: z.string(),
        displayName: z.string(),
        type: z.string(),
        status: z.string(),
      }),
    }),
  ),
});

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
    // Plan 034 lane G — the first genuinely public operation. `publicSpec`
    // arrives from `markPublicSpec(tenantRoutes)` in routes/index.ts; the
    // `scopes` array here is the half that publishes it, so this route is
    // mounted at GET /api/v1/users/me/tenants behind authenticate →
    // requireScope → validate, and emitted in /openapi.json. The unversioned
    // path is untouched.
    //
    // `tenant:read` ("Read which space you are in", auth/scopes.ts) is the core
    // scope this endpoint defines: it is the whole of what the operation
    // returns, so the grant and the response are the same sentence.
    scopes: ["tenant:read"],
    operationId: "listMyTenants",
    responseSchema: myTenantsResponseSchema,
    stability: "beta",
    tags: ["tenants"],
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
