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
// S5: resolve the session through the per-request memo when the request
// context carries one, so these three middleware and the handler they guard
// share one resolution instead of paying for one each. Falls back to a fresh
// resolution when there is no context (see lib/request-identity.ts).
import { resolveSession } from "./request-identity.js";
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
      return new Response(null, {
        status: 204,
        headers: CorsHandler.getCorsHeaders(request, env),
      });
    }

    const response = await next();

    // Add CORS headers to response — same origin-gated set as the preflight.
    for (const [key, value] of Object.entries(
      CorsHandler.getCorsHeaders(request, env),
    )) {
      response.headers.set(key, value);
    }

    return response;
  };
}

/**
 * Client-version backstop middleware (426 Upgrade Required).
 *
 * The forced-upgrade mechanism is primarily a CLIENT concern: the app fetches
 * `/api/app/version-policy` and blocks itself. This middleware is the server
 * backstop for the case where the client's own check did not run (an old
 * build that predates the policy code, a client with a stale cached policy).
 *
 * It is deliberately the narrowest thing that can work:
 *
 *   - it returns EITHER a 426 OR `next()` — it never produces a 2xx of its
 *     own, authenticates nothing, and can bypass nothing;
 *   - it acts only when a policy is configured AND the header is present AND
 *     the header parses AND the parsed version is strictly older than the
 *     minimum. Absent/garbage headers (curl, federation peers, health probes,
 *     agents) pass through untouched;
 *   - it NEVER intercepts `OPTIONS`: a browser whose preflight fails sees an
 *     opaque network error, so an outdated web client could never even learn
 *     that it is outdated;
 *   - exempt paths (`/api/app/version-policy`, `/.well-known/*`, the public
 *     ActivityPub object surface, `/health`) are listed in
 *     `lib/client-version.ts`.
 *
 * LOG HYGIENE: the raw header value is never logged — only the decision token
 * (`parsed` / `invalid` / …). The 426 body carries NO URL (a client must never
 * navigate to a link supplied by an error response).
 *
 * @see lib/client-version.ts for the bounded semver rule and the telemetry cap
 */
export function clientVersionMiddleware(): Middleware {
  return async (context, next) => {
    const { request, env } = context;

    const {
      evaluateClientVersionGate,
      recordClientVersionDecision,
      UPGRADE_REQUIRED_BODY,
    } = await import("./client-version.js");

    const decision = evaluateClientVersionGate({
      method: request.method,
      pathname: context.pathname,
      versionHeader: request.headers.get("X-Client-Version"),
      platformHeader: request.headers.get("X-Client-Platform"),
      env,
    });

    // Telemetry is emitted only for a strictly parsed version, with the
    // dimension re-serialized from the parsed triple (never the raw header).
    recordClientVersionDecision(decision);

    if (decision.outcome === "allow") {
      return next();
    }

    getLogger().info("[ClientVersion] Refusing request: client below minimum", {
      pathname: context.pathname,
      method: request.method,
      // Tokens only — never the raw X-Client-Version value.
      clientVersion: "parsed",
      clientPlatform: decision.platform,
    });

    // CORS headers are attached here because this middleware short-circuits
    // ahead of the per-route CORS middleware; without them a browser client
    // could not read the 426 and would show a generic network failure.
    const { CorsHandler } = await import("./cors-handler.js");
    return new Response(JSON.stringify(UPGRADE_REQUIRED_BODY), {
      status: 426,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...CorsHandler.getCorsHeaders(request, env),
      },
    });
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
      const session = await resolveSession(request, env, context.requestContext);
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

    // Phase 8 — the CSRF bypass is now derived from COOKIE PRESENCE, not from
    // the shape of the Authorization header.
    //
    // It used to skip CSRF for any `Authorization: Bearer a.b.c` — three
    // dot-separated segments, no verification. An attacker's cross-origin form
    // cannot set that header, but their *script* can, and the browser still
    // attaches the session cookie: any origin that CORS lets through could send
    // a junk Bearer, skip CSRF, and be authenticated by the cookie. The two
    // findings compounded (see the CORS fail-open fix in cors-handler.ts).
    //
    // The correct predicate is "is this request authenticated by something the
    // browser attaches automatically?" — i.e. does it carry a session cookie.
    // If it does, CSRF applies no matter what else is on the request. A pure
    // Bearer client (mobile, server-to-server) sends no cookie and still skips.
    const cookieHeader = request.headers.get("Cookie");
    const carriesSessionCookie =
      !!cookieHeader && /(?:^|;\s*)(?:trellis_session|session)=/.test(cookieHeader);

    if (!carriesSessionCookie) {
      const bearerHeader = request.headers.get("Authorization");
      if (bearerHeader?.startsWith("Bearer ")) {
        const bearerToken = bearerHeader.slice(7);
        if (bearerToken.length > 0) {
          return next();
        }
      }
    }

    // Get session secret with proper error handling
    try {
      const sessionSecret = env.SESSION_SECRET;
      if (!sessionSecret || typeof sessionSecret !== "string") {
        // If we can't get the secret, skip CSRF validation (let auth middleware handle it)
        return next();
      }
    } catch (error) {
      // If secret retrieval fails, skip CSRF validation (let auth middleware handle it)
      return next();
    }

    const authHeader = request.headers.get("Authorization");
    const session = await resolveSession(request, env, context.requestContext);

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

    try {
      if (!env.SESSION_SECRET) return next();
    } catch {
      return next();
    }

    const session = await resolveSession(request, env, context.requestContext);
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
