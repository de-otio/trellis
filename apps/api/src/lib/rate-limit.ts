import type { KVNamespace } from "../types/cloudflare-compat.js";
/**
 * Rate Limiting
 *
 * Token-bucket rate limiting backed by `@de-otio/saas-foundation/rate-limit`.
 *
 * Two execution paths, both token-bucket:
 *
 *  - `checkRateLimit` / `applyRateLimit` — SYNCHRONOUS, per-process in-memory
 *    path. Kept synchronous because several call sites (feeds.ts,
 *    invitation-handler.ts, database-rate-limiter.ts) consume the result
 *    inline and the foundation limiters are async-only. This path calls
 *    foundation's pure `computeConsumeResult` (capacity + fractional
 *    refill-rate) over an instance-local bucket map — the same math the
 *    async limiters run, with no algorithm duplicated here.
 *
 *  - `checkRateLimitKV` / `applyRateLimitKV` — ASYNC, distributed path. Uses a
 *    module-level foundation limiter selected from `env`:
 *      * `DynamoTokenBucketLimiter` when `RATE_LIMIT_TABLE` is configured;
 *      * `MemoryTokenBucketLimiter` otherwise (dev/test fallback).
 *    This mirrors trellis's prior "RATE_LIMIT_KV present or in-memory
 *    fallback" selection, now on the new DynamoDB-backed table.
 *
 * Semantics changed from fixed-window to token-bucket (capacity = limit,
 * refillRate = limit / windowSeconds, cost = 1/request). Bursts up to
 * `capacity` are tolerated, then the bucket refills continuously.
 *
 * ⚠️ The synchronous in-memory path is NOT distributed (per-process,
 * resets on restart). Configure `RATE_LIMIT_TABLE` and route call sites
 * through the KV path for production-grade distributed limiting.
 */

import {
  DynamoTokenBucketLimiter,
  MemoryTokenBucketLimiter,
  PostgresTokenBucketLimiter,
  computeConsumeResult,
  type BucketState,
  type TokenBucketConfig,
  type RateLimitResult,
} from "@de-otio/saas-foundation/rate-limit";
import { createDefaultDynamoClient } from "@de-otio/saas-foundation/kv";

import { resolveKvProvider, getKvSqlExecutor } from "./kv/kv-provider.js";
import { getLogger, type LoggerEnv } from "./logger.js";

interface RateLimitStore {
  [key: string]: BucketState;
}

/**
 * Environment for the async (KV/Dynamo) path.
 *
 * `RATE_LIMIT_KV` is retained for backward compatibility with call sites and
 * other consumers (e.g. user-deletion-handler-enhanced) that still reference
 * the binding directly; it is no longer used by this limiter. The new
 * token-bucket store is selected from `RATE_LIMIT_TABLE` / `RATE_LIMIT_NAMESPACE`.
 */
interface RateLimitEnv {
  RATE_LIMIT_KV?: KVNamespace;
  /** DynamoDB table backing the token-bucket limiter. When absent, an in-memory limiter is used (dev/test). */
  RATE_LIMIT_TABLE?: string;
  /** Namespace prefix for token-bucket keys within the table. Defaults to "ratelimit". */
  RATE_LIMIT_NAMESPACE?: string;
  AWS_REGION?: string;
}

/**
 * Map trellis's (limit, windowSeconds) into a foundation `TokenBucketConfig`.
 *
 * capacity   = limit          (max burst)
 * refillRate = limit / window (tokens per second, may be fractional)
 */
function windowToConfig(
  limit: number,
  windowSeconds: number,
): TokenBucketConfig {
  return {
    capacity: limit,
    // Guard against a zero/negative window producing Infinity/NaN refill.
    refillRate: windowSeconds > 0 ? limit / windowSeconds : limit,
  };
}

/**
 * Limiter type covering the subset of the foundation API this module uses.
 * Both `DynamoTokenBucketLimiter` and `MemoryTokenBucketLimiter` satisfy it.
 */
type FoundationLimiter = {
  consume(
    key: string,
    cost: number,
    config?: TokenBucketConfig,
  ): Promise<RateLimitResult>;
};

/**
 * Module-level memoized limiter for the async path. Built once per backing
 * configuration and reused across `RateLimiter` instances (route handlers
 * construct a fresh `RateLimiter` per request, so the limiter — and its
 * bucket state — must live at module scope to be shared).
 */
let cachedLimiter: FoundationLimiter | undefined;
let cachedLimiterKey: string | undefined;

function getLimiter(env: RateLimitEnv): FoundationLimiter {
  const tableName = env.RATE_LIMIT_TABLE;
  const namespace = env.RATE_LIMIT_NAMESPACE || "ratelimit";
  const provider = resolveKvProvider();
  const executor = provider === "postgres" ? getKvSqlExecutor() : undefined;
  const usePostgres = provider === "postgres" && executor !== undefined;
  // Cache key distinguishes the Postgres/Dynamo backends from the memory limiter.
  const key = usePostgres
    ? `postgres:${namespace}`
    : tableName
      ? `dynamo:${tableName}:${namespace}`
      : "memory";

  if (cachedLimiter && cachedLimiterKey === key) {
    return cachedLimiter;
  }

  if (usePostgres && executor !== undefined) {
    // KV_PROVIDER=postgres: a single-row-per-key token bucket over the shared KV
    // pool. F5 fail-open is inside the limiter (§3.10). The dedicated
    // rate_limit_buckets table backs it.
    cachedLimiter = new PostgresTokenBucketLimiter(executor, {
      tableName: "rate_limit_buckets",
      namespace,
      unknownKeyStrategy: "shared-bucket",
    });
  } else if (tableName) {
    // Construct the DynamoDB client via the foundation factory only when a table
    // is configured, so dev/test never reaches for AWS.
    cachedLimiter = new DynamoTokenBucketLimiter(createDefaultDynamoClient(), {
      tableName,
      namespace,
      // Default 'shared-bucket' matches trellis's prior implicit shared
      // behavior for ':unknown' keys (IP derivation failed → one shared
      // ceiling per endpoint, available-by-default).
      unknownKeyStrategy: "shared-bucket",
    });
  } else {
    cachedLimiter = new MemoryTokenBucketLimiter({
      unknownKeyStrategy: "shared-bucket",
    });
  }
  cachedLimiterKey = key;
  return cachedLimiter;
}

/** Test seam: reset the memoized module-level limiter between tests. */
export function __resetRateLimiterForTests(): void {
  cachedLimiter = undefined;
  cachedLimiterKey = undefined;
}

/**
 * Build the canonical 429 Response. Shared by `RateLimiter` and
 * `rateLimitMiddleware` so every rate-limited surface returns the same shape
 * and headers (single source of truth after the limiter consolidation).
 */
export function buildRateLimitResponse(
  limit: number,
  retryAfter: number,
  resetAt: number,
): Response {
  return new Response(
    JSON.stringify({
      error: "Rate limit exceeded",
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "Retry-After": retryAfter.toString(),
        "X-RateLimit-Limit": limit.toString(),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": new Date(resetAt).toISOString(),
      },
    },
  );
}

/**
 * Rate Limiter class for managing rate limiting.
 *
 * Surface preserved for ~18 consumers: `checkRateLimit`, `applyRateLimit`,
 * `checkRateLimitKV`, `applyRateLimitKV`, and the `getRateLimitKey`
 * IP/user/email/endpoint composition.
 */
export class RateLimiter {
  // Per-instance in-memory token buckets (synchronous path only).
  private rateLimitStore: RateLimitStore = {};

  /**
   * Get identifier for rate limiting.
   *
   * Priority order (most privacy-preserving first):
   * 1. User ID (if provided) — most privacy-preserving for authenticated users
   * 2. Session ID (if authenticated)
   * 3. Email (for email-based endpoints like magic links)
   * 4. IP address (fallback for unauthenticated requests)
   *
   * NOTE: this composition is domain logic and is preserved verbatim from the
   * fixed-window implementation. When no identity header is present the key
   * collapses to "...:ip:unknown", which the foundation limiters treat via
   * their `unknownKeyStrategy` ('shared-bucket' here).
   */
  private getRateLimitKey(
    request: Request,
    endpoint: string,
    sessionId?: string,
    email?: string,
    userId?: string,
  ): string {
    if (userId) {
      return `ratelimit:${endpoint}:user:${userId}`;
    }

    if (sessionId) {
      return `ratelimit:${endpoint}:session:${sessionId}`;
    }

    if (email) {
      return `ratelimit:${endpoint}:email:${email.toLowerCase()}`;
    }

    // For unauthenticated requests, use IP (least privacy-preserving).
    //
    // SECURITY NOTE (G4 CRITICAL-3 / LOW-1): the IP fallback below is
    // *not* trusted-proxy-aware on purpose — most call sites pass a
    // userId/sessionId/email and never reach this branch. Routes that
    // depend on a meaningful IP partition (e.g. /agents/authorize)
    // either supply an explicit `userId` keying the bucket or apply the
    // `trustedClientIp` helper at the call site. When neither header is
    // present here the bucket collapses to "unknown", which makes the
    // limiter behave as a global ceiling for that endpoint — safe-fail
    // by design.
    const cfIp = request.headers.get("CF-Connecting-IP");
    const forwardedFor = request.headers.get("X-Forwarded-For");
    const ip =
      cfIp ||
      (forwardedFor ? forwardedFor.split(",")[0]?.trim() : null) ||
      "unknown";

    return `ratelimit:${endpoint}:ip:${ip}`;
  }

  /**
   * Check rate limit (synchronous, in-memory token bucket).
   *
   * @param request Request object
   * @param endpoint Endpoint identifier (e.g., '/auth/authorize')
   * @param limit Maximum requests (token-bucket capacity)
   * @param windowSeconds Time window in seconds (sets refillRate = limit/window)
   * @param sessionId Optional session ID for authenticated users
   * @param email Optional email for email-based endpoints
   * @param userId Optional user ID (preferred key)
   * @returns Rate limit result
   */
  checkRateLimit(
    request: Request,
    endpoint: string,
    limit: number,
    windowSeconds: number,
    sessionId?: string,
    email?: string,
    userId?: string,
  ): { allowed: boolean; remaining: number; resetAt: number; retryAfter?: number } {
    const key = this.getRateLimitKey(
      request,
      endpoint,
      sessionId,
      email,
      userId,
    );
    const now = Date.now();
    const config = windowToConfig(limit, windowSeconds);

    const { newState, result } = computeConsumeResult(
      this.rateLimitStore[key] ?? null,
      now,
      1,
      config,
    );
    // Persist refilled state on both allow and deny so refill progress is
    // not lost (matches foundation's behavior).
    this.rateLimitStore[key] = newState;

    return {
      allowed: result.allowed,
      remaining: result.remaining,
      resetAt: result.resetAt,
      retryAfter: result.retryAfter,
    };
  }

  /**
   * Apply rate limiting to a response (synchronous, in-memory).
   * Returns a 429 Response if the limit is exceeded, else null.
   */
  applyRateLimit(
    request: Request,
    endpoint: string,
    limit: number,
    windowSeconds: number,
    sessionId?: string,
    email?: string,
    userId?: string,
  ): Response | null {
    const result = this.checkRateLimit(
      request,
      endpoint,
      limit,
      windowSeconds,
      sessionId,
      email,
      userId,
    );

    if (!result.allowed) {
      // Token-bucket `retryAfter` (seconds until the next token is available)
      // is the correct delay — NOT `resetAt`, which is time-to-full-refill.
      const retryAfter =
        result.retryAfter ??
        Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));

      return buildRateLimitResponse(limit, retryAfter, result.resetAt);
    }

    return null;
  }

  /**
   * Check rate limit using the distributed token-bucket store (async).
   *
   * Selects a `DynamoTokenBucketLimiter` when `RATE_LIMIT_TABLE` is configured,
   * otherwise a `MemoryTokenBucketLimiter` (dev/test). On limiter failure it
   * falls back to the synchronous in-memory path (graceful degradation).
   */
  async checkRateLimitKV(
    env: RateLimitEnv,
    request: Request,
    endpoint: string,
    limit: number,
    windowSeconds: number,
    sessionId?: string,
    email?: string,
    userId?: string,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number; retryAfter?: number }> {
    try {
      return await this.checkRateLimitKVStrict(
        env,
        request,
        endpoint,
        limit,
        windowSeconds,
        sessionId,
        email,
        userId,
      );
    } catch (error) {
      // Graceful degradation: fall back to the synchronous in-memory path.
      getLogger().error(
        "Token-bucket rate limit check failed, falling back to in-memory:",
        error,
      );
      return this.checkRateLimit(
        request,
        endpoint,
        limit,
        windowSeconds,
        sessionId,
        email,
        userId,
      );
    }
  }

  /**
   * Distributed token-bucket check that **propagates** limiter errors instead
   * of degrading to the in-memory path. For callers that implement their own
   * failure policy — e.g. `rateLimitMiddleware`, which fails CLOSED on
   * sensitive routes (S4.2) and OPEN elsewhere when the limiter is unreachable.
   */
  async checkRateLimitKVStrict(
    env: RateLimitEnv,
    request: Request,
    endpoint: string,
    limit: number,
    windowSeconds: number,
    sessionId?: string,
    email?: string,
    userId?: string,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number; retryAfter?: number }> {
    const key = this.getRateLimitKey(
      request,
      endpoint,
      sessionId,
      email,
      userId,
    );
    const config = windowToConfig(limit, windowSeconds);
    const result = await getLimiter(env).consume(key, 1, config);
    return {
      allowed: result.allowed,
      remaining: result.remaining,
      resetAt: result.resetAt,
      retryAfter: result.retryAfter,
    };
  }

  /**
   * Apply rate limiting with the distributed store (async).
   * Returns a 429 Response if the limit is exceeded, else null.
   */
  async applyRateLimitKV(
    env: RateLimitEnv & LoggerEnv,
    request: Request,
    endpoint: string,
    limit: number,
    windowSeconds: number,
    sessionId?: string,
    email?: string,
    userId?: string,
  ): Promise<Response | null> {
    const result = await this.checkRateLimitKV(
      env,
      request,
      endpoint,
      limit,
      windowSeconds,
      sessionId,
      email,
      userId,
    );

    if (!result.allowed) {
      const retryAfter =
        result.retryAfter ??
        Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));

      // Log rate limit violation for telemetry/monitoring (fields preserved).
      const logger = getLogger();
      logger.warn("[RateLimit] Rate limit exceeded", {
        endpoint,
        limit,
        windowSeconds,
        userId,
        sessionId,
        email,
        retryAfter,
        ipAddress:
          request.headers.get("CF-Connecting-IP") ||
          request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
          "unknown",
      });

      return buildRateLimitResponse(limit, retryAfter, result.resetAt);
    }

    return null;
  }
}
