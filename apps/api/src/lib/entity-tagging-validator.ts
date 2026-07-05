/**
 * Entity Tagging Validator
 *
 * Validates entity tagging permissions (ownership OR friendship).
 * Friendship is resolved from the graph edge table via lib/friend-ids.ts
 * (the legacy KV-backed FriendsHandler was removed in the pre-launch schema
 * end-state pass). Implements security best practices from review.
 */

import type { PrismaClient } from "@prisma/client";
import { getFriendUserIds, type RelationshipReader } from "./friend-ids.js";
import {
  InvalidEntitiesError,
  EntityTaggingPermissionError,
} from "./entity-tagging-errors.js";

/**
 * Validate entity tagging permissions
 *
 * Security: Validates that user can tag each entity (owns it OR is friends with owner).
 * Performance: Batches entity and friendship checks to avoid N+1 queries.
 *
 * @param userId - User ID attempting to tag entities
 * @param entityRefs - Array of entity IDs to tag
 * @param db - Prisma client (can be transaction client)
 * @returns Promise that resolves if validation passes, rejects with EntityTaggingError if not
 */
export async function validateEntityTagging(
  userId: string,
  entityRefs: string[],
  db: PrismaClient,
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

  // 3. Get friend user IDs once (single relationship-edge query)
  const friendIds = new Set(
    await getFriendUserIds(db as unknown as RelationshipReader, userId),
  );

  // 4. Group entities by ownership status
  const getOwnerId = (e: typeof entities[0]) => e.owners?.[0]?.userId;
  const invalidEntities = entities.filter(
    (e) => { const oid = getOwnerId(e); return oid !== userId && (!oid || !friendIds.has(oid)); },
  );

  // 5. Validate - if any invalid entities, reject
  if (invalidEntities.length > 0) {
    throw new EntityTaggingPermissionError();
  }
}
