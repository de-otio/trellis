/**
 * Friend-set resolution over the graph edge table (`relationships`).
 *
 * Pre-launch convergence (schema end-state pass): the legacy KV-backed
 * FriendsHandler (Cloudflare-era, DynamoDB-shimmed) was removed. The single
 * source of truth for "who counts as a friend" is now the scored relationship
 * edge table that the connection-code / invitation redemption paths write via
 * the GraphService.
 *
 * Definition: a *friend* of `userId` is the target of a **mutual** user→user
 * relationship edge whose circle tier is ≤ {@link FRIEND_TIER_MAX} (tier 0 =
 * inner circle, tier 1 = close friends).
 *
 * **Mutuality is the load-bearing half, and it is why this predicate is not
 * just a tier lookup.** This function decides who may read a NORMAL-radius
 * post, so anything it derives access from must be state the *reader* cannot
 * set for themselves. `tier` is not such a state: it is computed from
 * `COALESCE(manual_score, computed_score)`, both of which the reader controls —
 * `manualScore` directly through `PATCH /api/relationships/score`, and
 * `computedScore` through the connection method recorded when the edge was
 * created. Before mutuality was required, a single unilateral
 * `POST /api/relationships` was enough to enter a stranger's tier 0 and read
 * their close-friends posts, with no action by, and no notification to, that
 * stranger (V1).
 *
 * `reciprocated` is not forgeable the same way: it is set by the server only
 * when the reverse edge is found, so it encodes an actual decision by the other
 * party. Requiring it turns "who I say is close to me" into "who we both
 * accepted", which is the difference between an affinity score and an audience.
 *
 * The tier bound is retained *on top of* mutuality because dropping it would
 * widen the set (every reciprocated edge, however distant, would become a
 * friend). Mutual-and-close is strictly narrower than the previous
 * one-directional-and-close, which is the direction this change must go.
 *
 * Note the asymmetry that remains and is harmless: a reader can still *lower*
 * their own tier and lose access. Self-inflicted narrowing needs no defence.
 *
 * This is deliberately a single-hop Prisma read, not a graph traversal — the
 * circle-tier feed queries proper live in lib/graph/ (AR8 owns those).
 *
 * Superseded by the audience resolver, which removes scores from access
 * entirely rather than constraining them — see trellis-internal
 * plans/audience-and-reach, D1.
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
        reciprocated: boolean;
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
    where: {
      userId,
      targetType: "user",
      tier: { lte: FRIEND_TIER_MAX },
      // REQUIRED, never optional: the consent half of the definition. Removing
      // this line restores the unilateral self-grant (V1).
      reciprocated: true,
    },
    select: { targetId: true },
  });
  return rows.map((r) => r.targetId);
}
