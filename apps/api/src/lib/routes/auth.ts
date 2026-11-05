/**
 * Authentication Routes
 */

import { handleAuthRoutes } from "../../worker.js";
import { getBlocklistWriter } from "../auth/revocation.js";
import { getLogger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

/**
 * M9 — server-side logout.
 *
 * Blocklists the token the caller presented (Bearer or cookie) so it stops
 * authenticating on EVERY route (both `SessionManager.getSession` and
 * `authMiddleware` read the blocklist), and clears the session cookie.
 *
 * - Requires a currently-valid session before writing: an unauthenticated
 *   caller must not be able to fill the KV with 90-day blocklist entries.
 *   Already-invalid / already-revoked ⇒ idempotent 204, no write.
 * - 204 only if the revocation persisted. A KV write failure is a 500 so the
 *   client retries rather than believing a live token was killed.
 * - Revokes only the presented token. "Every device" is
 *   `POST /api/users/me/agent-sessions/global-sign-out`.
 * - With no blocklist KV bound the cookie is still cleared, but a Bearer token
 *   cannot be revoked server-side; `SESSION_BLOCKLIST_REQUIRED=true` turns that
 *   into a 503 instead of a silent partial logout.
 */
async function handleLogout(
  request: Request,
  env: any,
): Promise<Response> {
  const sessionManager = new SessionManager();
  const securityHeaders = new SecurityHeaders(env);

  const finish = (status: number, body?: unknown): Response => {
    const response = securityHeaders.createSecureResponse(
      body === undefined ? null : JSON.stringify(body),
      {
        status,
        headers: body === undefined ? {} : { "content-type": "application/json" },
      },
    );
    return sessionManager.clearSession(response);
  };

  const session = await sessionManager.getSession(
    request,
    env.SESSION_SECRET,
    env,
  );
  if (!session) return finish(204);

  if (!getBlocklistWriter(env) && env.SESSION_BLOCKLIST_REQUIRED === "true") {
    return finish(503, { error: "logout_unavailable" });
  }

  try {
    await sessionManager.revokeSession(request, env);
  } catch (err) {
    getLogger().error("[Auth] logout: token revocation failed", err);
    return finish(500, { error: "logout_failed" });
  }
  return finish(204);
}

export const authRoutes: Route[] = [
  // Registered BEFORE the `/auth/*` and `/api/auth/*` wildcards below so the
  // specific path wins (Hono runs the first matching route).
  {
    path: "/auth/logout",
    method: "POST",
    handler: (request, env) => handleLogout(request, env),
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Log out: revoke the presented token and clear the session cookie",
  },
  {
    path: "/api/auth/logout",
    method: "POST",
    handler: (request, env) => handleLogout(request, env),
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Log out (aliased under /api/auth)",
  },
  {
    path: "/auth/*",
    method: "*",
    handler: async (request, env, { url, requestContext }) => {
      const rateLimiter = new RateLimiter();
      const securityHeaders = new SecurityHeaders(env);

      return handleAuthRoutes(
        request,
        env,
        url,
        rateLimiter,
        securityHeaders,
        requestContext,
      );
    },
    middleware: [corsMiddleware()],
    description: "Authentication routes",
  },
  {
    path: "/api/auth/*",
    method: "*",
    handler: async (request, env, { url, requestContext, pathname }) => {
      const rateLimiter = new RateLimiter();
      const securityHeaders = new SecurityHeaders(env);

      // Rewrite /api/auth/* to /auth/* for handler compatibility
      const rewrittenUrl = new URL(url);
      rewrittenUrl.pathname = pathname.replace("/api/auth", "/auth");

      // `duplex: "half"` is REQUIRED whenever a Request is constructed with a
      // streaming body. Without it undici throws
      //   TypeError: RequestInit: duplex option is required when sending a body
      // and every POST to /api/auth/* 500s while the unaliased /auth/* path
      // works — so the alias looks like a routing bug rather than a fetch-API
      // one. GET/HEAD have a null body and must NOT set it.
      // Not yet in the DOM RequestInit lib type, hence the cast.
      const hasBody = request.body !== null && request.body !== undefined;
      const rewrittenRequest = new Request(rewrittenUrl.toString(), {
        method: request.method,
        headers: request.headers,
        ...(hasBody ? { body: request.body, duplex: "half" } : {}),
      } as RequestInit);

      return handleAuthRoutes(
        rewrittenRequest,
        env,
        rewrittenUrl,
        rateLimiter,
        securityHeaders,
        requestContext,
      );
    },
    middleware: [corsMiddleware()],
    description: "API authentication routes (aliased to /auth/*)",
  },
];
