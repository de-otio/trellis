/**
 * Authentication Routes
 */

import { handleAuthRoutes } from "../../worker.js";
import { corsMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import type { Route } from "./types.js";

export const authRoutes: Route[] = [
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
      const rewrittenPathname = pathname.replace("/api/auth", "/auth");
      rewrittenUrl.pathname = rewrittenPathname;
      console.error("[AUTH_ROUTE] Rewriting path", {
        original: pathname,
        rewritten: rewrittenPathname,
        url: rewrittenUrl.toString(),
      });
      const rewrittenRequest = new Request(rewrittenUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });

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
