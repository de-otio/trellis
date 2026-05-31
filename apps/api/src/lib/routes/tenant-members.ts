/**
 * Tenant member routes.
 *
 *   GET    /api/tenants/:id/members
 *   PATCH  /api/tenants/:id/members/:memberId
 *   DELETE /api/tenants/:id/members/:memberId
 *
 * `POST /api/tenants/:id/transfer-ownership` is wired in routes/tenants.ts
 * and now backed by MemberHandler.handleTransferOwnership.
 */

import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { MemberHandler } from "../tenant/member-handler.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

const MEMBERS_LIST = /^\/api\/tenants\/([^/]+)\/members$/;
const MEMBER_ITEM = /^\/api\/tenants\/([^/]+)\/members\/([^/]+)$/;

export const tenantMemberRoutes: Route[] = [
  {
    path: MEMBERS_LIST,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = pathname.match(MEMBERS_LIST)?.[1] ?? "";
      const handler = new MemberHandler();
      const response = await handler.handleList(tenantId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "List tenant members (paginated)",
  },

  {
    path: MEMBER_ITEM,
    method: "PATCH",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const match = pathname.match(MEMBER_ITEM);
      const tenantId = match?.[1] ?? "";
      const memberId = match?.[2] ?? "";
      const handler = new MemberHandler();
      const response = await handler.handlePatchRole(tenantId, memberId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Change a member's role",
  },

  {
    path: MEMBER_ITEM,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const match = pathname.match(MEMBER_ITEM);
      const tenantId = match?.[1] ?? "";
      const memberId = match?.[2] ?? "";
      const handler = new MemberHandler();
      const response = await handler.handleRemove(tenantId, memberId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Remove a member (soft-delete + global sign-out)",
  },
];
