import type { KVNamespace, R2Bucket, CloudflareQueue } from "../types/cloudflare-compat.js";
/**
 * Database Rate Limiter
 *
 * Rate limits database operations to prevent abuse and DoS attacks.
 *
 * Features:
 * - Per-user rate limiting
 * - Per-operation rate limiting
 * - Configurable limits
 * - KV-backed distributed rate limiting
 */

import { RateLimiter } from "./rate-limit.js";


export interface DatabaseRateLimiterEnv {
  RATE_LIMIT_KV?: KVNamespace;
}

export interface DatabaseRateLimitConfig {
  // Per-user limits (requests per window)
  userLimit: number;
  userWindowMs: number;

  // Per-operation limits (requests per window)
  operationLimit: number;
  operationWindowMs: number;

  // Global limits (requests per window)
  globalLimit: number;
  globalWindowMs: number;
}

export class DatabaseRateLimiter {
  private rateLimiter: RateLimiter;
  private config: DatabaseRateLimitConfig;
  private env: DatabaseRateLimiterEnv;

  constructor(
    env: DatabaseRateLimiterEnv,
    config?: Partial<DatabaseRateLimitConfig>,
  ) {
    this.env = env;
    this.rateLimiter = new RateLimiter();
    this.config = {
      userLimit: config?.userLimit ?? 100, // 100 queries per user per window
      userWindowMs: config?.userWindowMs ?? 60000, // 1 minute
      operationLimit: config?.operationLimit ?? 50, // 50 queries per operation per window
      operationWindowMs: config?.operationWindowMs ?? 60000, // 1 minute
      globalLimit: config?.globalLimit ?? 1000, // 1000 queries globally per window
      globalWindowMs: config?.globalWindowMs ?? 60000, // 1 minute
    };
  }

  /**
   * Check if database operation is allowed
   *
   * @param request - Request object (for rate limit key generation)
   * @param userId - User ID (optional)
   * @param operation - Database operation name (e.g., 'findMany', 'create')
   * @returns True if allowed, false if rate limited
   */
  async checkLimit(
    request: Request,
    userId?: string,
    operation?: string,
  ): Promise<{ allowed: boolean; retryAfter?: number }> {
    // Check global limit
    const globalResult = this.rateLimiter.checkRateLimit(
      request,
      "db:global",
      this.config.globalLimit,
      Math.floor(this.config.globalWindowMs / 1000),
      undefined,
      undefined,
      userId,
    );

    if (!globalResult.allowed) {
      const retryAfter =
        Math.ceil((globalResult.resetAt - Date.now()) / 1000) * 1000;
      return {
        allowed: false,
        retryAfter,
      };
    }

    // Check per-user limit
    if (userId) {
      const userResult = this.rateLimiter.checkRateLimit(
        request,
        `db:user:${userId}`,
        this.config.userLimit,
        Math.floor(this.config.userWindowMs / 1000),
        undefined,
        undefined,
        userId,
      );

      if (!userResult.allowed) {
        const retryAfter =
          Math.ceil((userResult.resetAt - Date.now()) / 1000) * 1000;
        return {
          allowed: false,
          retryAfter,
        };
      }
    }

    // Check per-operation limit
    if (operation) {
      const operationResult = this.rateLimiter.checkRateLimit(
        request,
        `db:op:${operation}`,
        this.config.operationLimit,
        Math.floor(this.config.operationWindowMs / 1000),
        undefined,
        undefined,
        userId,
      );

      if (!operationResult.allowed) {
        const retryAfter =
          Math.ceil((operationResult.resetAt - Date.now()) / 1000) * 1000;
        return {
          allowed: false,
          retryAfter,
        };
      }
    }

    return { allowed: true };
  }
}
