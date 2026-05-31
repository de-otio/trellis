/**
 * Tenant role-mapping routes.
 *
 *   GET    /api/tenants/:id/role-mappings
 *   POST   /api/tenants/:id/role-mappings
 *   PATCH  /api/tenants/:id/role-mappings/:mappingId
 *   DELETE /api/tenants/:id/role-mappings/:mappingId
 */

import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { SecurityHeaders } from "../security-headers.js";
import { RoleMappingHandler } from "../tenant/role-mapping-handler.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

const MAPPINGS_LIST = /^\/api\/tenants\/([^/]+)\/role-mappings$/;
const MAPPING_ITEM = /^\/api\/tenants\/([^/]+)\/role-mappings\/([^/]+)$/;

export const tenantRoleMappingRoutes: Route[] = [
  {
    path: MAPPINGS_LIST,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = pathname.match(MAPPINGS_LIST)?.[1] ?? "";
      const handler = new RoleMappingHandler();
      const response = await handler.handleList(tenantId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "List tenant role mappings",
  },

  {
    path: MAPPINGS_LIST,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = pathname.match(MAPPINGS_LIST)?.[1] ?? "";
      const handler = new RoleMappingHandler();
      const response = await handler.handleCreate(tenantId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware(), idempotencyMiddleware()],
    description: "Create a tenant role mapping",
  },

  {
    path: MAPPING_ITEM,
    method: "PATCH",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const match = pathname.match(MAPPING_ITEM);
      const tenantId = match?.[1] ?? "";
      const mappingId = match?.[2] ?? "";
      const handler = new RoleMappingHandler();
      const response = await handler.handleUpdate(tenantId, mappingId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update a tenant role mapping",
  },

  {
    path: MAPPING_ITEM,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const match = pathname.match(MAPPING_ITEM);
      const tenantId = match?.[1] ?? "";
      const mappingId = match?.[2] ?? "";
      const handler = new RoleMappingHandler();
      const response = await handler.handleDelete(tenantId, mappingId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Delete a tenant role mapping",
  },
];
