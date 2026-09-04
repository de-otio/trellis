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
