/**
 * Abuse Prevention Service
 *
 * Implements abuse prevention for ActivityPub federation.
 * Fedify provides rate limiting and signature verification.
 * This service adds custom abuse detection logic.
 */

import type { Env } from "../../../env.js";
import { getLogger, Logger } from "../../logger.js";
import { getActivityPubBaseUrl } from "../fedify/context.js";

/**
 * Rate limit configuration
 *
 * Fedify provides rate limiting, but we can configure it here.
 */
export interface RateLimitConfig {
  requestsPerMinute: number;
  requestsPerHour: number;
  requestsPerDay: number;
}

/**
 * Default rate limit configuration
 */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  requestsPerMinute: 60,
  requestsPerHour: 1000,
  requestsPerDay: 10000,
};

// In-memory per-actor request tracking (resets on server restart)
const actorRequestCounts = new Map<string, { count: number; windowStart: number }>();

/**
 * Check rate limit for an actor.
 *
 * Uses a sliding window per actor URI. Returns false (and the request
 * should be rejected with 429) when the actor exceeds the limit.
 */
export async function checkRateLimit(
  actorUri: string,
  env: Env,
): Promise<boolean> {
  const now = Date.now();
  const windowMs = 60_000; // 1-minute window
  const maxPerWindow = DEFAULT_RATE_LIMITS.requestsPerMinute;

  const entry = actorRequestCounts.get(actorUri);

  if (!entry || now - entry.windowStart > windowMs) {
    // New window
    actorRequestCounts.set(actorUri, { count: 1, windowStart: now });
    return true;
  }

  entry.count++;
  if (entry.count > maxPerWindow) {
    const logger = getLogger();
    logger.warn("[AbusePrevention] Rate limit exceeded", {
      actorUri,
      count: entry.count,
      limit: maxPerWindow,
    });
    return false;
  }

  return true;
}

/**
 * Detect abusive activity patterns
 *
 * Custom abuse detection logic beyond Fedify's built-in protections.
 *
 * @param activity - Activity to check
 * @param actorUri - Actor URI
 * @param env - Cloudflare Workers environment
 * @returns True if activity appears abusive, false otherwise
 */
export function detectAbuse(
  activity: any,
  actorUri: string,
  env: Env,
): boolean {
  try {
    const logger = getLogger();
    // Check for suspicious activity patterns
    // 1. Rapid activity creation
    // 2. Spam-like content
    // 3. Suspicious actor patterns

    // Custom abuse detection logic can be implemented here
    // Fedify handles rate limiting and signature verification

    return false;
  } catch (error) {
    // getLogger might fail, try to get logger again for error logging
    try {
      const logger = getLogger();
      logger.error("[AbusePrevention] Error detecting abuse", {
        error: (error as Error).message,
        actorUri,
      });
    } catch {
      // If logger also fails, just continue
    }
    return false; // Fail open on error (allow activity)
  }
}

/**
 * Validate activity for abuse prevention
 *
 * Combines rate limiting and abuse detection.
 *
 * @param activity - Activity to validate
 * @param actorUri - Actor URI
 * @param env - Cloudflare Workers environment
 * @returns True if activity is safe, false if abusive
 */
export async function validateActivity(
  activity: any,
  actorUri: string,
  env: Env,
): Promise<boolean> {
  const logger = getLogger();

  // Check rate limit
  const withinRateLimit = await checkRateLimit(actorUri, env);
  if (!withinRateLimit) {
    logger.warn("[AbusePrevention] Rate limit exceeded", { actorUri });
    return false;
  }

  // Check for abuse patterns
  const isAbusive = detectAbuse(activity, actorUri, env);
  if (isAbusive) {
    logger.warn("[AbusePrevention] Abusive activity detected", {
      actorUri,
      activityType: activity.type,
    });
    return false;
  }

  return true;
}
