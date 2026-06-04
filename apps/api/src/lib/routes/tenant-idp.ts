/**
 * Tenant identity-provider routes (T5).
 *
 *   POST   /api/tenants/:id/identity-provider
 *   GET    /api/tenants/:id/identity-provider
 *   PATCH  /api/tenants/:id/identity-provider
 *   DELETE /api/tenants/:id/identity-provider?confirm=true
 *
 * The PATCH route serves both config edits (clientSecret rotation,
 * attribute mapping, defaultRole, scopes) and status toggle
 * (`{status: ACTIVE|DISABLED}`); the handler picks based on body shape.
 */
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { SecurityHeaders } from "../security-headers.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { IdpHandler } from "../tenant/idp-handler.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

const IDP_RE = /^\/api\/tenants\/([^/]+)\/identity-provider$/;

export const tenantIdpRoutes: Route[] = [
  {
    path: IDP_RE,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);
      const tenantId = pathname.match(IDP_RE)?.[1] ?? "";
      const handler = new IdpHandler();
      const response = await handler.handleCreate(tenantId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware(), idempotencyMiddleware()],
    description: "Connect a tenant identity provider (OIDC)",
  },
  {
    path: IDP_RE,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);
      const tenantId = pathname.match(IDP_RE)?.[1] ?? "";
      const handler = new IdpHandler();
      const response = await handler.handleGet(tenantId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "Read a tenant identity provider",
  },
  {
    path: IDP_RE,
    method: "PATCH",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);
      const tenantId = pathname.match(IDP_RE)?.[1] ?? "";
      const handler = new IdpHandler();
      const response = await handler.handlePatch(tenantId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update or toggle a tenant identity provider",
  },
  {
    path: IDP_RE,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);
      const tenantId = pathname.match(IDP_RE)?.[1] ?? "";
      const handler = new IdpHandler();
      const response = await handler.handleDelete(tenantId, new URL(request.url), auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Disconnect a tenant identity provider",
  },
];
