/**
 * Secure Event Structure for Followers Feature
 *
 * SECURITY: All events are validated before queuing and in the consumer
 * to prevent injection attacks, replay attacks, and unauthorized processing.
 *
 * This module provides secure event creation and validation for Phase 6
 * (Event-Driven Non-Critical Operations).
 */

import { getLogger, Logger } from "./logger.js";
import { getExtension } from "../extensions.js";

export interface FollowEvent {
  type: "follow_created" | "follow_deleted";
  followerId: string;
  targetType: string;
  targetId: string;
  timestamp: number;
  nonce: string; // Unique identifier for idempotency
  signature?: string; // Optional: HMAC signature for verification
}

/**
 * Create a secure follow event with validation
 *
 * SECURITY: Validates all event data before creation
 */
export function createFollowEvent(
  type: "follow_created" | "follow_deleted",
  followerId: string,
  targetType: string,
  targetId: string,
): FollowEvent {
  // SECURITY: Validate inputs
  if (!followerId || followerId.length === 0) {
    throw new Error("Invalid followerId");
  }

  if (targetType !== "user" && !getExtension(targetType)) {
    throw new Error("Invalid targetType");
  }

  if (!targetId || targetId.length === 0) {
    throw new Error("Invalid targetId");
  }

  // SECURITY: Validate userId format (UUID)
  const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(followerId)) {
    throw new Error("Invalid followerId format");
  }

  return {
    type,
    followerId,
    targetType,
    targetId,
    timestamp: Date.now(),
    nonce: crypto.randomUUID(), // Generate unique nonce for idempotency
  };
}

/**
 * Validate follow event data
 *
 * SECURITY: Validates event data to prevent injection attacks
 */
export function validateFollowEvent(
  event: FollowEvent,
  sessionUserId: string,
  maxAgeMs: number = 300000, // 5 minutes default
): void {
  // Validate event structure
  if (!event || typeof event !== "object") {
    throw new Error("Invalid event structure");
  }

  // Validate type
  if (event.type !== "follow_created" && event.type !== "follow_deleted") {
    throw new Error("Invalid event type");
  }

  // Validate userId matches session
  if (event.followerId !== sessionUserId) {
    throw new Error("Event userId mismatch");
  }

  // Validate targetType
  if (event.targetType !== "user" && !getExtension(event.targetType)) {
    throw new Error("Invalid targetType");
  }

  // Validate targetId format
  if (!event.targetId || event.targetId.length === 0) {
    throw new Error("Invalid targetId");
  }

  // Validate userId format (UUID)
  const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(event.followerId)) {
    throw new Error("Invalid followerId format");
  }

  // Validate timestamp (prevent replay attacks)
  const now = Date.now();
  const eventTime = event.timestamp;
  if (eventTime < now - maxAgeMs || eventTime > now + 1000) {
    throw new Error("Invalid timestamp (event too old or in future)");
  }

  // Validate nonce (idempotency key)
  if (!event.nonce || event.nonce.length < 16) {
    throw new Error("Invalid nonce");
  }
}

/**
 * Process follow event with idempotency check
 *
 * SECURITY: Prevents duplicate processing of events
 */
export async function processFollowEvent(
  event: FollowEvent,
  env: any,
  processor: (event: FollowEvent) => Promise<void>,
): Promise<void> {
  const logger = getLogger();

  // SECURITY: Re-validate event in consumer
  try {
    // Note: sessionUserId validation would need to be passed in or verified differently
    // For now, we validate structure and timestamp
    if (!event.followerId || !event.targetId || !event.targetType) {
      throw new Error("Invalid event data");
    }

    // SECURITY: Check timestamp (prevent replay)
    const now = Date.now();
    if (event.timestamp < now - 300000) {
      // 5 minutes max age
      throw new Error("Event too old");
    }
  } catch (error: any) {
    logger.error("[FollowersEvents] Event validation failed", {
      error: error.message,
      event: { type: event.type, followerId: event.followerId },
    });
    throw error;
  }

  // SECURITY: Idempotency check (prevent duplicate processing)
  if (env.FOLLOWERS_KV) {
    const idempotencyKey = `event:${event.nonce}`;
    const processed = await env.FOLLOWERS_KV.get(idempotencyKey);
    if (processed) {
      logger.info("[FollowersEvents] Event already processed", {
        nonce: event.nonce,
        type: event.type,
      });
      return; // Already processed
    }

    // Process event
    try {
      await processor(event);

      // Mark as processed
      await env.FOLLOWERS_KV.put(idempotencyKey, "processed", {
        expirationTtl: 3600, // 1 hour
      });
    } catch (error: any) {
      logger.error("[FollowersEvents] Event processing failed", {
        error: error.message,
        event: { type: event.type, nonce: event.nonce },
      });
      throw error;
    }
  } else {
    // No KV available - process directly (not recommended for production)
    await processor(event);
  }
}
