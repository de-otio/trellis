/**
 * Feature Toggle Rate Limiting Middleware
 *
 * Rate limiting middleware specifically for feature toggle API endpoints.
 * Uses the existing RateLimiter class with Cloudflare KV for distributed state.
 *
 * Strategy:
 * - Public API: 100 requests/minute per IP (complemented by Cloudflare edge rules)
 * - Admin API: 1000 requests/minute per user (requires authentication)
 *
 * Note: Cloudflare Rate Limiting Rules should be configured at the edge level
 * for IP-based protection. This middleware provides per-user limits and
 * rate limit headers for API consumers.
 */

import type { Env } from "../../env.js";
import { RateLimiter } from "../rate-limit.js";
import { getLogger, Logger } from "../logger.js";

/**
 * Rate limit configuration for feature toggle endpoints
 */
const RATE_LIMIT_CONFIG = {
  // Public API limits (per IP)
  public: {
    limit: 100, // requests
    windowSeconds: 60, // 1 minute
  },
  // Admin API limits (per user)
  admin: {
    limit: 1000, // requests
    windowSeconds: 60, // 1 minute
  },
} as const;

/**
 * Rate limit result with headers
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  headers: Record<string, string>;
}

/**
 * Rate limit the public feature toggle API
 *
 * Limits: 100 requests/minute per IP address
 *
 * @param request - Request object
 * @param env - Environment variables
 * @returns Rate limit result with headers, or null if rate limit exceeded
 */
export async function rateLimitFeatureToggleAPI(
  request: Request,
  env: Env,
): Promise<RateLimitResult | null> {
  const rateLimiter = new RateLimiter();
  const endpoint = "/api/feature-toggles";

  // Get IP address from Cloudflare headers
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0] ||
    "unknown";

  // Check rate limit using KV (distributed)
  const result = await rateLimiter.checkRateLimitKV(
    env,
    request,
    endpoint,
    RATE_LIMIT_CONFIG.public.limit,
    RATE_LIMIT_CONFIG.public.windowSeconds,
    undefined, // sessionId
    undefined, // email
    undefined, // userId (using IP for public API)
  );

  // Build rate limit headers
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": RATE_LIMIT_CONFIG.public.limit.toString(),
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset": new Date(result.resetAt).toISOString(),
  };

  if (!result.allowed) {
    // Rate limit exceeded - return result with headers for error response
    return {
      allowed: false,
      remaining: 0,
      resetAt: result.resetAt,
      headers: {
        ...headers,
        "Retry-After": Math.ceil(
          (result.resetAt - Date.now()) / 1000,
        ).toString(),
      },
    };
  }

  return {
    allowed: true,
    remaining: result.remaining,
    resetAt: result.resetAt,
    headers,
  };
}

/**
 * Rate limit the admin feature toggle API
 *
 * Limits: 1000 requests/minute per authenticated user
 *
 * @param request - Request object
 * @param env - Environment variables
 * @param userId - Authenticated user ID (required for admin API)
 * @returns Rate limit result with headers, or null if rate limit exceeded
 */
export async function rateLimitAdminFeatureToggleAPI(
  request: Request,
  env: Env,
  userId: string,
): Promise<RateLimitResult | null> {
  // Validate userId is a non-empty string
  if (!userId || typeof userId !== "string" || userId.length === 0) {
    getLogger().error(
      `[RateLimit] Invalid userId provided: ${typeof userId}`,
      userId,
    );
    // Return null to allow request (graceful degradation)
    return null;
  }

  const rateLimiter = new RateLimiter();
  const endpoint = "/api/admin/feature-toggles";

  // Check rate limit using KV (distributed) - per user
  const result = await rateLimiter.checkRateLimitKV(
    env,
    request,
    endpoint,
    RATE_LIMIT_CONFIG.admin.limit,
    RATE_LIMIT_CONFIG.admin.windowSeconds,
    undefined, // sessionId
    undefined, // email
    userId, // userId (per-user rate limiting)
  );

  // If result is null or undefined, allow the request (graceful degradation)
  if (!result) {
    return {
      allowed: true,
      remaining: RATE_LIMIT_CONFIG.admin.limit,
      resetAt: Date.now() + RATE_LIMIT_CONFIG.admin.windowSeconds * 1000,
      headers: {
        "X-RateLimit-Limit": RATE_LIMIT_CONFIG.admin.limit.toString(),
        "X-RateLimit-Remaining": RATE_LIMIT_CONFIG.admin.limit.toString(),
        "X-RateLimit-Reset": new Date(
          Date.now() + RATE_LIMIT_CONFIG.admin.windowSeconds * 1000,
        ).toISOString(),
      },
    };
  }

  // Build rate limit headers
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": RATE_LIMIT_CONFIG.admin.limit.toString(),
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset": new Date(result.resetAt).toISOString(),
  };

  if (!result.allowed) {
    // Rate limit exceeded - return result with headers for error response
    return {
      allowed: false,
      remaining: 0,
      resetAt: result.resetAt,
      headers: {
        ...headers,
        "Retry-After": Math.ceil(
          (result.resetAt - Date.now()) / 1000,
        ).toString(),
      },
    };
  }

  return {
    allowed: true,
    remaining: result.remaining,
    resetAt: result.resetAt,
    headers,
  };
}

/**
 * Create rate limit error response
 *
 * @param rateLimitResult - Rate limit result with headers
 * @returns HTTP 429 response with rate limit information
 */
export function createRateLimitErrorResponse(
  rateLimitResult: RateLimitResult,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Rate limit exceeded. Please try again later.",
        retryAfter: Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000),
      },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        ...rateLimitResult.headers,
      },
    },
  );
}
