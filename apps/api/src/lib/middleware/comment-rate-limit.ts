import type { KVNamespace, R2Bucket, CloudflareQueue } from "../../types/cloudflare-compat.js";
/**
 * Comment Rate Limiting Middleware
 *
 * Implements distributed rate limiting for comment creation using Cloudflare KV.
 *
 * Rate Limits:
 * - Per-post: 1 comment per user per 30 seconds (prevents rapid duplicate posts)
 * - Per-user global: 10 comments per minute (prevents spam across posts)
 *
 * Design:
 * - Uses Cloudflare KV for distributed state across Workers
 * - Fail-open strategy: If KV is unavailable, allow the request (don't block legitimate users)
 * - Returns retry-after time for HTTP 429 responses
 */


import { getLogger, Logger } from "../logger.js";

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number; // Seconds until next request allowed
  remaining?: number; // Remaining requests in current window
}

export interface CommentRateLimitEnv {
  RATE_LIMIT_KV?: KVNamespace;
}

/**
 * Check rate limits for comment creation
 *
 * @param userId - User ID creating the comment
 * @param postId - Post ID the comment is on
 * @param env - Environment with KV binding
 * @returns Rate limit result with allowed status and retry information
 */
export async function commentRateLimit(
  userId: string,
  postId: string,
  env: CommentRateLimitEnv,
): Promise<RateLimitResult> {
  const kv = env.RATE_LIMIT_KV;

  // Fail-open if KV not available - don't block users due to infrastructure issues
  if (!kv) {
    getLogger().warn(
      "[CommentRateLimit] RATE_LIMIT_KV not configured - rate limiting disabled",
    );
    return { allowed: true };
  }

  try {
    const now = Date.now();

    // Check 1: Per-post rate limit (30 seconds between comments on same post)
    const postKey = `rate:comment:post:${postId}:${userId}`;
    const lastPostComment = await kv.get(postKey);

    if (lastPostComment) {
      const lastTime = parseInt(lastPostComment, 10);
      const timeSince = now - lastTime;
      const waitTime = 30000; // 30 seconds in milliseconds

      if (timeSince < waitTime) {
        const retryAfter = Math.ceil((waitTime - timeSince) / 1000);
        getLogger().info(
          `[CommentRateLimit] Per-post limit hit for user ${userId} on post ${postId}. Wait ${retryAfter}s`,
          { userId, postId, timeSince, retryAfter },
        );
        return {
          allowed: false,
          retryAfter,
          remaining: 0,
        };
      }
    }

    // Check 2: Per-user global rate limit (10 comments per minute across all posts)
    const userKey = `rate:comment:user:${userId}`;
    const userLimitData = await kv.get(userKey);

    let commentCount = 0;
    let windowStart = now;

    if (userLimitData) {
      try {
        const parsed = JSON.parse(userLimitData);
        windowStart = parsed.windowStart;
        commentCount = parsed.count || 0;

        // Check if window has expired (60 seconds)
        const windowAge = now - windowStart;
        if (windowAge > 60000) {
          // Window expired, reset counter
          commentCount = 0;
          windowStart = now;
        }
      } catch (parseError) {
        // If parsing fails, reset the window
        getLogger().warn(
          "[CommentRateLimit] Failed to parse user limit data - resetting",
          parseError,
        );
        commentCount = 0;
        windowStart = now;
      }
    }

    const maxPerMinute = 10;
    if (commentCount >= maxPerMinute) {
      const windowAge = now - windowStart;
      const retryAfter = Math.ceil((60000 - windowAge) / 1000);
      getLogger().info(
        `[CommentRateLimit] Per-user global limit hit for user ${userId}. Wait ${retryAfter}s`,
        { userId, commentCount, maxPerMinute, retryAfter },
      );
      return {
        allowed: false,
        retryAfter,
        remaining: 0,
      };
    }

    // Rate limits passed - update KV entries
    // Update per-post rate limit (expires in 60 seconds)
    await kv.put(postKey, now.toString(), {
      expirationTtl: 60,
    });

    // Update per-user global rate limit (expires in 60 seconds)
    const newCount = commentCount + 1;
    await kv.put(
      userKey,
      JSON.stringify({
        windowStart,
        count: newCount,
      }),
      {
        expirationTtl: 60,
      },
    );

    return {
      allowed: true,
      remaining: maxPerMinute - newCount,
    };
  } catch (error) {
    // Fail-open on errors - log but allow request
    getLogger().error(
      "[CommentRateLimit] Error checking rate limit - allowing request",
      error,
    );
    return { allowed: true };
  }
}
