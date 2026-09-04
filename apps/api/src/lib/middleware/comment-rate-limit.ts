import type { KVNamespace, R2Bucket, CloudflareQueue } from "../../types/cloudflare-compat.js";
/**
 * Comment Rate Limiting Middleware
 *
 * Distributed rate limiting for comment creation, over the KV binding.
 *
 * Rate limits: a per-post cooldown and a per-user-per-minute ceiling. Both
 * numbers are RUNTIME CONFIG (`env.commentRateLimit.*`, threshold-secrecy rule
 * 8) — they used to be compiled-in constants shipping in a public npm tarball,
 * which published the exact pacing needed to stay under them.
 *
 * ── Failure policy (was: unconditionally fail-open) ─────────────────────────
 * This module used to end in `catch { return { allowed: true } }`. That is
 * defensible when the store fails occasionally and the alternative is blocking
 * real users. It is indefensible when the store fails ALWAYS — which is what a
 * half-migrated platform produces: the binding is constructed against a host
 * that does not resolve, every call throws, and comment rate limiting is
 * therefore not "degraded" but entirely absent, silently, with no 5xx and no
 * signal beyond a log line on a path nobody watches.
 *
 * The failing guard was `if (!kv)` — a test of PRESENCE, not REACHABILITY. The
 * binding is present (a live client object), so the "not configured" branch
 * never fires and the call throws into the catch instead. Every `if (env.X)` in
 * this codebase has the same shape; on a fully-migrated platform presence and
 * reachability were the same question, and they no longer are.
 *
 * So: a store ERROR now denies by default (`failMode: "closed"`) — an abuse
 * control that cannot count must not wave traffic through. A store that is
 * ABSENT still allows, because absence is a deployment shape (local dev, unit
 * tests) rather than a malfunction, but it is logged at error rather than warn.
 * Operators who would rather lose the control than the endpoint set
 * COMMENT_RATE_LIMIT_FAIL_MODE=open.
 */


import { getLogger, Logger } from "../logger.js";

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number; // Seconds until next request allowed
  remaining?: number; // Remaining requests in current window
}

export interface CommentRateLimitEnv {
  RATE_LIMIT_KV?: KVNamespace;
  /**
   * Threshold-secrecy config (rule 8). Optional so callers holding a partial
   * env still typecheck; absent fields fall back to the same numbers the
   * compiled-in constants used, and to the SAFE fail mode.
   */
  commentRateLimit?: {
    perMinute?: number;
    postCooldownSeconds?: number;
    failMode?: "closed" | "open";
  };
}

/** Retry-After offered when the store is broken and we deny. */
const FAIL_CLOSED_RETRY_AFTER_SECONDS = 30;

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
  const perMinute = env.commentRateLimit?.perMinute ?? 10;
  const postCooldownMs = (env.commentRateLimit?.postCooldownSeconds ?? 30) * 1000;
  const failMode = env.commentRateLimit?.failMode ?? "closed";

  // ABSENT, not broken: a deployment that wired no store at all (local dev,
  // unit tests). Distinct from the catch below, and logged at error because a
  // production deployment reaching this line has silently no rate limiting.
  if (!kv) {
    getLogger().error(
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
      if (timeSince < postCooldownMs) {
        const retryAfter = Math.ceil((postCooldownMs - timeSince) / 1000);
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

    if (commentCount >= perMinute) {
      const windowAge = now - windowStart;
      const retryAfter = Math.ceil((60000 - windowAge) / 1000);
      getLogger().info(
        `[CommentRateLimit] Per-user global limit hit for user ${userId}. Wait ${retryAfter}s`,
        { userId, commentCount, maxPerMinute: perMinute, retryAfter },
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
      remaining: perMinute - newCount,
    };
  } catch (error) {
    // BROKEN, not absent. A store that throws cannot count, and a limiter that
    // cannot count has no basis for saying yes. Denying is the safe direction
    // for an abuse control: the cost is a retryable 429 on a comment, against
    // an unbounded, unmetered comment flood.
    if (failMode === "open") {
      getLogger().error(
        "[CommentRateLimit] Error checking rate limit - allowing request (COMMENT_RATE_LIMIT_FAIL_MODE=open)",
        error,
      );
      return { allowed: true };
    }
    getLogger().error(
      "[CommentRateLimit] Error checking rate limit - denying request (fail-closed)",
      error,
    );
    return {
      allowed: false,
      retryAfter: FAIL_CLOSED_RETRY_AFTER_SECONDS,
      remaining: 0,
    };
  }
}
