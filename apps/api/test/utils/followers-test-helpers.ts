/**
 * Test helpers for followers feature
 */

import type { Env } from "../../../src/env";
import { FollowersHandler } from "../../../src/lib/followers-handler";
import type { Session } from "../../../src/lib/session-cookie";

/**
 * Create a test follow relationship
 */
export async function createTestFollow(
  session: Session,
  targetType: "user" | "dog",
  targetId: string,
  env: Env,
): Promise<{ success: boolean; followId?: string }> {
  const handler = new FollowersHandler();
  return await handler.follow(session, targetType, targetId, env);
}

/**
 * Remove a test follow relationship
 */
export async function removeTestFollow(
  session: Session,
  targetType: "user" | "dog",
  targetId: string,
  env: Env,
): Promise<{ success: boolean }> {
  const handler = new FollowersHandler();
  return await handler.unfollow(session, targetType, targetId, env);
}

/**
 * Get test follow status
 */
export async function getTestFollowStatus(
  session: Session,
  targetType: "user" | "dog",
  targetId: string,
  env: Env,
): Promise<boolean> {
  const handler = new FollowersHandler();
  return await handler.isFollowing(session, targetType, targetId, env);
}
