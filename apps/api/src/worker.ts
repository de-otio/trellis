/**
 * Compatibility shim — re-exports CorsHandler and AuthHandler helpers for
 * route files that were written against the old Cloudflare Workers entry point.
 *
 * In the AWS architecture the entry point is server.ts (Node.js HTTP server).
 * This file exists solely to avoid touching 17+ route files.
 */

import { AuthHandler } from "./lib/auth-handler.js";
import { CorsHandler } from "./lib/cors-handler.js";
import type { Env } from "./env.js";
import type { RateLimiter } from "./lib/rate-limit.js";
import type { SecurityHeaders } from "./lib/security-headers.js";
import type { TrellisRequestContext } from "./lib/request-context.js";

export const addCorsHeaders = (
  response: Response,
  request: Request,
  env: Env,
  requestContext?: TrellisRequestContext,
) => CorsHandler.addCorsHeaders(response, request, env, requestContext);
export const getAllowedOrigin = (request: Request, env: Env) => CorsHandler.getAllowedOrigin(request, env);
export const getCorsHeaders = (request: Request, env: Env) => CorsHandler.getCorsHeaders(request, env);

export const handleAuthRoutes = (
  request: Request,
  env: Env,
  url: URL,
  rateLimiter: RateLimiter,
  securityHeaders: SecurityHeaders,
  requestContext?: TrellisRequestContext,
) => AuthHandler.handleAuthRoutes(request, env, url, rateLimiter, securityHeaders, requestContext);
