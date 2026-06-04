/**
 * Tenant Domain Routes
 *
 * - POST   /api/tenants/:id/domains
 * - GET    /api/tenants/:id/domains
 * - DELETE /api/tenants/:id/domains/:domainId
 * - POST   /api/tenants/:id/domains/:domainId/verify
 */

import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { SecurityHeaders } from "../security-headers.js";
import { DomainHandler } from "../tenant/domain-handler.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

const BASE_RE = /^\/api\/tenants\/([^/]+)\/domains$/;
const MEMBER_RE = /^\/api\/tenants\/([^/]+)\/domains\/([^/]+)$/;
const VERIFY_RE = /^\/api\/tenants\/([^/]+)\/domains\/([^/]+)\/verify$/;

export const tenantDomainRoutes: Route[] = [
  // ── POST /api/tenants/:id/domains ─────────────────────────────────────────
  {
    path: BASE_RE,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = BASE_RE.exec(pathname)?.[1] ?? "";
      const handler = new DomainHandler();
      const response = await handler.handleClaim(tenantId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware(), idempotencyMiddleware()],
    description: "Claim a domain for tenant verification",
  },

  // ── GET /api/tenants/:id/domains ──────────────────────────────────────────
  {
    path: BASE_RE,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = BASE_RE.exec(pathname)?.[1] ?? "";
      const handler = new DomainHandler();
      const response = await handler.handleList(tenantId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "List tenant domains",
  },

  // ── DELETE /api/tenants/:id/domains/:domainId ──────────────────────────────
  {
    path: MEMBER_RE,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const match = MEMBER_RE.exec(pathname);
      const tenantId = match?.[1] ?? "";
      const domainId = match?.[2] ?? "";
      const handler = new DomainHandler();
      const response = await handler.handleDelete(tenantId, domainId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Remove a tenant domain",
  },

  // ── POST /api/tenants/:id/domains/:domainId/verify ─────────────────────────
  {
    path: VERIFY_RE,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const match = VERIFY_RE.exec(pathname);
      const tenantId = match?.[1] ?? "";
      const domainId = match?.[2] ?? "";
      const handler = new DomainHandler();
      const response = await handler.handleVerify(tenantId, domainId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware(), idempotencyMiddleware()],
    description: "Verify tenant domain via DNS TXT",
  },
];
