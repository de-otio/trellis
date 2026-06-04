import type { KVNamespace, R2Bucket, CloudflareQueue } from "../types/cloudflare-compat.js";
/**
 * Entity Tagging Validator
 *
 * Validates entity tagging permissions (ownership OR friendship).
 * Implements security best practices from review.
 */

import type { PrismaClient } from "@prisma/client";
import { FriendsHandler } from "./friends-handler.js";
import type { Session } from "./session-cookie.js";
import {
  EntityTaggingError,
  InvalidEntitiesError,
  EntityTaggingPermissionError,
} from "./entity-tagging-errors.js";


export interface EntityTaggingEnv {
  FRIENDS_KV?: KVNamespace;
  CACHE_KV?: KVNamespace; // Optional cache for entity ownership
}

/**
 * Validate entity tagging permissions
 *
 * Security: Validates that user can tag each entity (owns it OR is friends with owner).
 * Performance: Batches entity and friendship checks to avoid N+1 queries.
 *
 * @param userId - User ID attempting to tag entities
 * @param entityRefs - Array of entity IDs to tag
 * @param db - Prisma client (can be transaction client)
 * @param friendsHandler - Friends handler for friendship checks
 * @param env - Environment with KV namespaces
 * @param session - Session object (for friends handler)
 * @returns Promise that resolves if validation passes, rejects with EntityTaggingError if not
 */
export async function validateEntityTagging(
  userId: string,
  entityRefs: string[],
  db: PrismaClient,
  friendsHandler: FriendsHandler,
  env: EntityTaggingEnv,
  session: Session,
): Promise<void> {
  // Early return if no entities to tag
  if (!entityRefs || entityRefs.length === 0) {
    return;
  }

  // Remove duplicates and sanitize
  const uniqueEntityRefs = [
    ...new Set(entityRefs.map((id) => id.trim().toLowerCase())),
  ].filter((id) => id.length > 0);

  if (uniqueEntityRefs.length === 0) {
    return;
  }

  // 1. Fetch all entities with owner info (single query)
  const entities = await db.entity.findMany({
    where: { id: { in: uniqueEntityRefs } },
    select: { id: true, owners: { select: { userId: true, role: true }, where: { status: 'ACTIVE' } } },
  });

  // 2. Check all entities exist (generic error message for security)
  if (entities.length !== uniqueEntityRefs.length) {
    throw new InvalidEntitiesError();
  }

  // 3. Get unique owner IDs
  const ownerIds = [...new Set(entities.flatMap((e) => e.owners.map((o) => o.userId)))];

  // 4. Get friends list once (cached by FriendsHandler)
  const friends = await friendsHandler.getFriends(session, "ACCEPTED", env);
  const friendIds = new Set(friends.map((f) => f.id));

  // 5. Group entities by ownership status
  const getOwnerId = (e: typeof entities[0]) => e.owners?.[0]?.userId;
  const ownEntities = entities.filter((e) => getOwnerId(e) === userId);
  const friendEntities = entities.filter((e) => { const oid = getOwnerId(e); return oid != null && friendIds.has(oid); });
  const invalidEntities = entities.filter(
    (e) => { const oid = getOwnerId(e); return oid !== userId && (!oid || !friendIds.has(oid)); },
  );

  // 6. Validate - if any invalid entities, reject
  if (invalidEntities.length > 0) {
    throw new EntityTaggingPermissionError();
  }
}

/**
 * Cache entity ownership check (optional optimization)
 *
 * @param entityId - Entity ID
 * @param ownerId - Owner ID
 * @param env - Environment with CACHE_KV
 * @param ttl - Cache TTL in seconds (default: 300 = 5 minutes)
 */
export async function cacheEntityOwner(
  entityId: string,
  ownerId: string,
  env: EntityTaggingEnv,
  ttl: number = 300,
): Promise<void> {
  if (!env.CACHE_KV) return;

  const cacheKey = `entity-owner:${entityId}`;
  await env.CACHE_KV.put(cacheKey, ownerId, { expirationTtl: ttl });
}

/**
 * Get cached entity owner (optional optimization)
 *
 * @param entityId - Entity ID
 * @param env - Environment with CACHE_KV
 * @returns Cached owner ID or null if not cached
 */
export async function getCachedEntityOwner(
  entityId: string,
  env: EntityTaggingEnv,
): Promise<string | null> {
  if (!env.CACHE_KV) return null;

  const cacheKey = `entity-owner:${entityId}`;
  return await env.CACHE_KV.get(cacheKey);
}
