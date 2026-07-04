/**
 * Middleware
 *
 * Provides middleware functionality for the route abstraction layer.
 * Middleware can modify requests, responses, or short-circuit the request.
 */

import type { Env } from "../env.js";
import type { TrellisRequestContext } from "./request-context.js";

import { getLogger } from "./logger.js";
import { RateLimiter, buildRateLimitResponse } from "./rate-limit.js";
export interface MiddlewareContext {
  request: Request;
  env: Env;
  requestContext?: TrellisRequestContext;
  url: URL;
  pathname: string;
  method: string;
}

export type Middleware = (
  context: MiddlewareContext,
  next: () => Promise<Response>,
) => Promise<Response>;

/**
 * Compose multiple middleware functions
 */
export function composeMiddleware(middlewares: Middleware[]): Middleware {
  return async (context: MiddlewareContext, next: () => Promise<Response>) => {
    let index = -1;

    async function dispatch(i: number): Promise<Response> {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;

      if (i === middlewares.length) {
        return next();
      }

      const middleware = middlewares[i];
      return middleware(context, () => dispatch(i + 1));
    }

    return dispatch(0);
  };
}

/**
 * CORS middleware
 */
export function corsMiddleware(): Middleware {
  return async (context, next) => {
    const { request, env } = context;
    const { CorsHandler } = await import("./cors-handler.js");

    // Handle OPTIONS requests
    if (request.method === "OPTIONS") {
      const allowedOrigin = CorsHandler.getAllowedOrigin(request, env);
      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-CSRF-Token, X-Retry-Count",
        "Access-Control-Allow-Credentials": "true",
      };

      if (allowedOrigin) {
        headers["Access-Control-Allow-Origin"] = allowedOrigin;
      }

      return new Response(null, {
        status: 204,
        headers,
      });
    }

    const response = await next();

    // Add CORS headers to response
    const allowedOrigin = CorsHandler.getAllowedOrigin(request, env);
    if (allowedOrigin) {
      response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
    }
    response.headers.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    );
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-CSRF-Token, X-Retry-Count",
    );
    response.headers.set("Access-Control-Allow-Credentials", "true");

    return response;
  };
}

/**
 * Security headers middleware
 */
export function securityHeadersMiddleware(env: Env): Middleware {
  return async (context, next) => {
    const { SecurityHeaders } = await import("./security-headers.js");
    const securityHeaders = new SecurityHeaders(env);

    const response = await next();
    return securityHeaders.addSecurityHeaders(response);
  };
}

/**
 * Rate limiting middleware
 *
 * Limits requests per caller within a window, backed by the **foundation
 * token-bucket** limiter (`RateLimiter` in `rate-limit.ts`) — the same limiter
 * the auth path uses. Consolidated from the former fixed-window-over-KV
 * implementation: one algorithm (token-bucket), one store (the
 * `RATE_LIMIT_TABLE` DynamoDB limiter, or an in-memory limiter in dev/test),
 * one 429 shape.
 *
 * `{maxRequests, windowMs}` map to `capacity = maxRequests`,
 * `refillRate = maxRequests / windowSeconds` (bursts up to `maxRequests`, then
 * continuous refill). The caller is keyed by the authenticated `userId` when
 * present, else by request IP (handled inside `RateLimiter.getRateLimitKey`).
 *
 * Failure policy (S4.2) is preserved: if the distributed limiter is
 * unreachable, fail CLOSED (503) on `/api/admin` and `/api/auth`, fail OPEN
 * elsewhere.
 *
 * @param options.maxRequests - Token-bucket capacity / window limit (default: 20)
 * @param options.windowMs - Window in ms; sets the refill rate (default: 60000)
 */
export function rateLimitMiddleware(options?: {
  maxRequests?: number;
  windowMs?: number;
}): Middleware {
  const maxRequests = options?.maxRequests ?? 20;
  const windowMs = options?.windowMs ?? 60000; // 1 minute default
  const windowSeconds = Math.max(1, Math.round(windowMs / 1000));

  return async (context, next) => {
    const { request, env } = context;

    // Identify the caller: prefer the authenticated userId; RateLimiter falls
    // back to the request IP internally when no identity is supplied.
    let userId: string | undefined;
    try {
      const { SessionManager } = await import("./session-cookie.js");
      const session = await new SessionManager().getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      userId = session?.userId ?? undefined;
    } catch {
      // ignore — fall back to IP keying inside RateLimiter
    }

    const limiter = new RateLimiter();
    let result: { allowed: boolean; remaining: number; resetAt: number; retryAfter?: number };
    try {
      // Strict path: a limiter (infra) failure throws so we can apply the S4.2
      // fail-closed/open policy below, rather than silently degrading.
      result = await limiter.checkRateLimitKVStrict(
        env,
        request,
        context.pathname,
        maxRequests,
        windowSeconds,
        undefined,
        undefined,
        userId,
      );
    } catch (error) {
      if (
        context.pathname.startsWith("/api/admin") ||
        context.pathname.startsWith("/api/auth")
      ) {
        getLogger().error(
          "[Rate Limit] Rate limiting error on sensitive route, denying request",
          error,
        );
        return new Response(
          JSON.stringify({ error: "Service temporarily unavailable" }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      getLogger().error(
        "[Rate Limit] Rate limiting error, allowing request",
        error,
      );
      return next();
    }

    if (!result.allowed) {
      const retryAfter =
        result.retryAfter ??
        Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      getLogger().warn("[Rate Limit] Request rate limit exceeded", {
        pathname: context.pathname,
        maxRequests,
        retryAfter,
      });
      return buildRateLimitResponse(maxRequests, retryAfter, result.resetAt);
    }

    const response = await next();
    response.headers.set("X-RateLimit-Limit", maxRequests.toString());
    response.headers.set(
      "X-RateLimit-Remaining",
      Math.max(0, result.remaining).toString(),
    );
    response.headers.set(
      "X-RateLimit-Reset",
      new Date(result.resetAt).toISOString(),
    );
    return response;
  };
}

/**
 * CSRF protection middleware
 *
 * Validates CSRF tokens for state-changing operations (POST, PUT, DELETE, PATCH).
 * Uses Double Submit Cookie pattern: token stored in session cookie, validated against header.
 * Skips validation for safe methods (GET, HEAD, OPTIONS).
 *
 * Requires:
 * - Valid session (user must be authenticated)
 * - X-CSRF-Token header with valid token
 * - CSRF token in session (or KV fallback if configured)
 */
export function csrfMiddleware(): Middleware {
  return async (context, next) => {
    const { request, env } = context;

    // Skip for safe methods
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      return next();
    }

    // Skip CSRF for JWT-authenticated requests (Bearer token with 3 dot-separated parts).
    // CSRF protection is only needed for cookie-based auth where the browser auto-sends cookies.
    // JWT in Authorization header is not vulnerable to CSRF since the attacker cannot set headers.
    // SECURITY INVARIANT: This bypass is safe because all state-changing routes
    // require authentication and reject unauthenticated requests BEFORE performing
    // any side effects. An invalid JWT (e.g., "a.b.c") will pass CSRF but fail auth.
    const bearerHeader = request.headers.get("Authorization");
    if (bearerHeader?.startsWith("Bearer ")) {
      const bearerToken = bearerHeader.slice(7);
      if (bearerToken.split(".").length === 3) {
        return next();
      }
    }

    // Get session
    const { SessionManager } = await import("./session-cookie.js");
    const sessionManager = new SessionManager();

    // Get session secret with proper error handling
    let sessionSecret: string;
    try {
      sessionSecret = env.SESSION_SECRET;
      if (!sessionSecret || typeof sessionSecret !== "string") {
        // If we can't get the secret, skip CSRF validation (let auth middleware handle it)
        return next();
      }
    } catch (error) {
      // If secret retrieval fails, skip CSRF validation (let auth middleware handle it)
      return next();
    }

    const authHeader = request.headers.get("Authorization");
    const session = await sessionManager.getSession(
      request,
      sessionSecret,
      env,
    );

    // If no session, let authentication middleware handle it
    // CSRF protection only applies to authenticated requests
    if (!session) {
      getLogger().debug(
        "[CSRF Middleware] No session found, skipping CSRF check",
        {
          pathname: context.pathname,
          hasCookie: !!request.headers.get("Cookie"),
          hasAuthHeader: !!authHeader,
        },
      );
      return next();
    }

    // Validate CSRF token
    const token = request.headers.get("X-CSRF-Token");
    if (!token) {
      getLogger().warn(
        "[CSRF Middleware] CSRF token required but missing",
        {
          pathname: context.pathname,
          userId: session.userId,
          hasCookie: !!request.headers.get("Cookie"),
          hasAuthHeader: !!authHeader,
        },
      );
      return new Response(JSON.stringify({ error: "CSRF token required" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }

    const { CSRFProtection } = await import("./csrf.js");
    const isValid = await CSRFProtection.validateToken(token, session, env);

    if (!isValid) {
      getLogger().warn(
        "[CSRF Middleware] Token validation failed",
        {
          pathname: context.pathname,
          method: request.method,
          userId: session.userId,
          hasTokenInHeader: !!token,
          hasTokenInSession: !!session.csrfToken,
          tokenPreview: token?.substring(0, 8) + "...",
          sessionTokenPreview: session.csrfToken?.substring(0, 8) + "...",
        },
      );
      return new Response(JSON.stringify({ error: "Invalid CSRF token" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }

    return next();
  };
}

/**
 * MFA enforcement middleware (AUTH-1)
 *
 * Checks if the authenticated user has a role that requires MFA
 * and whether their session has been MFA-verified. If MFA is
 * required but not verified, returns 403 with an mfa_required error.
 *
 * This middleware should be placed AFTER authentication middleware
 * on admin/sensitive routes.
 */
export function mfaMiddleware(): Middleware {
  return async (context, next) => {
    const { request, env } = context;

    const { SessionManager } = await import("./session-cookie.js");
    const sessionManager = new SessionManager();

    let sessionSecret: string;
    try {
      sessionSecret = env.SESSION_SECRET;
      if (!sessionSecret) return next();
    } catch {
      return next();
    }

    const session = await sessionManager.getSession(
      request,
      sessionSecret,
      env,
    );
    if (!session) return next(); // Let auth middleware handle missing session

    // Check if the user's role requires MFA
    const MFA_REQUIRED_ROLES = ["SUPER_ADMIN", "PARTNER_ADMIN"];
    if (!session.role || !MFA_REQUIRED_ROLES.includes(session.role)) {
      return next(); // MFA not required for this role
    }

    // Check if session is MFA-verified
    if (session.mfaVerified) {
      return next();
    }

    // MFA required but not verified
    getLogger().warn(
      "[MFA Middleware] MFA required but not verified",
      {
        pathname: context.pathname,
        userId: session.userId,
        role: session.role,
      },
    );

    return new Response(
      JSON.stringify({
        error: "MFA verification required",
        code: "mfa_required",
      }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      },
    );
  };
}
