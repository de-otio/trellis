/**
 * Block Routes
 *
 * The user-side remedy surface: block, unblock, list-my-blocks.
 *
 * Shaped after `relationships.ts` (the closest existing user-relationship
 * surface): dependencies constructed inside the handler, session checked before
 * anything else, `{ error: "Unauthorized" }` 401, `corsMiddleware()` on every
 * route plus `csrfMiddleware()` on the state-changing ones, and every response
 * passed through `securityHeaders.addSecurityHeaders`.
 *
 * The tenant comes from the JWT via `authMiddleware`, not from the session
 * cookie and never from the body: `blocked_users` is tenant-scoped by its unique
 * key, so a caller who could name the tenant could write a block into a tenant
 * it does not belong to.
 *
 * Rate limiting uses `rateLimitMiddleware()` with its DEFAULTS. A tighter,
 * hard-coded number here would be a published threshold — the npm tarball is
 * public (CLAUDE.md, threshold-secrecy rule) — and per-route limits belong in
 * runtime config, not in this file.
 */

import { authMiddleware } from "../auth/auth-middleware.js";
import { BlockHandler } from "../block-handler.js";
import {
  corsMiddleware,
  csrfMiddleware,
  rateLimitMiddleware,
} from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

const BLOCK_ID_PATH = /^\/api\/blocks\/([^/]+)$/;

export const blockRoutes: Route[] = [
  {
    path: "/api/blocks",
    method: "POST",
    handler: async (request, env, { requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const session = await new SessionManager().getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const response = await new BlockHandler().handleBlockUser(
        request,
        session,
        env,
        requestContext!,
        auth.activeTenantId,
      );
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware(), rateLimitMiddleware()],
    description: "Block a user",
  },

  {
    path: "/api/blocks",
    method: "GET",
    handler: async (request, env, { requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const session = await new SessionManager().getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const response = await new BlockHandler().handleListBlocks(
        request,
        session,
        env,
        requestContext!,
        auth.activeTenantId,
      );
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "List the caller's blocked users",
  },

  {
    path: "/api/blocks/:userId",
    method: "DELETE",
    handler: async (request, env, { pathname, params, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const session = await new SessionManager().getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      // `params` when the Hono router matched; the pathname re-parse is the
      // fallback the legacy regex router leaves in place (the other regex
      // routes in this directory all re-parse `pathname` for the same reason).
      const blockedId = decodeURIComponent(
        params?.userId ?? pathname.match(BLOCK_ID_PATH)?.[1] ?? "",
      );
      const response = await new BlockHandler().handleUnblockUser(
        blockedId,
        request,
        session,
        env,
        requestContext!,
        auth.activeTenantId,
      );
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware(), rateLimitMiddleware()],
    description: "Unblock a user",
  },
];
