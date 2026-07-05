/**
 * Friend-set resolution over the graph edge table (`relationships`).
 *
 * Pre-launch convergence (schema end-state pass): the legacy KV-backed
 * FriendsHandler (Cloudflare-era, DynamoDB-shimmed) was removed. The single
 * source of truth for "who counts as a friend" is now the scored relationship
 * edge table that the connection-code / invitation redemption paths write via
 * the GraphService.
 *
 * Definition: a *friend* of `userId` is the target of an outgoing
 * user→user relationship edge whose circle tier is ≤ {@link FRIEND_TIER_MAX}
 * (tier 0 = inner circle, tier 1 = close friends). Explicit connections
 * (connectionMethod "code" → score 0.7, "import" → 0.5) land in tiers 0–1;
 * passive "suggestion"/"discovery" edges (score 0.3 → tier 2) do NOT count —
 * matching the old handler's "explicitly connected" semantics.
 *
 * This is deliberately a single-hop Prisma read, not a graph traversal — the
 * circle-tier feed queries proper live in lib/graph/ (AR8 owns those).
 */

/** Highest circle tier that still counts as a "friend" (0 = inner, 1 = close). */
export const FRIEND_TIER_MAX = 1;

/**
 * Minimal structural client type so both the full PrismaClient and an
 * interactive-transaction client (`tx`) are accepted.
 */
export type RelationshipReader = {
  relationship: {
    findMany(args: {
      where: {
        userId: string;
        targetType: string;
        tier: { lte: number };
      };
      select: { targetId: true };
    }): Promise<Array<{ targetId: string }>>;
  };
};

/**
 * Resolve the user IDs of `userId`'s friends (see module doc for the
 * definition). Returns an empty array for a user with no qualifying edges.
 */
export async function getFriendUserIds(
  db: RelationshipReader,
  userId: string,
): Promise<string[]> {
  const rows = await db.relationship.findMany({
    where: { userId, targetType: "user", tier: { lte: FRIEND_TIER_MAX } },
    select: { targetId: true },
  });
  return rows.map((r) => r.targetId);
}
