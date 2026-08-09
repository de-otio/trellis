/**
 * Friend-set resolution over the graph edge table (`relationships`).
 *
 * Pre-launch convergence (schema end-state pass): the legacy KV-backed
 * FriendsHandler (Cloudflare-era, DynamoDB-shimmed) was removed. The single
 * source of truth for "who counts as a friend" is now the scored relationship
 * edge table that the connection-code / invitation redemption paths write via
 * the GraphService.
 *
 * Definition: for a viewer `userId`, this resolves the authors who have placed
 * **that viewer** in a circle of tier ≤ {@link FRIEND_TIER_MAX} (tier 0 = inner
 * circle, tier 1 = close friends) on a **mutual** user→user edge.
 *
 * **The direction is the load-bearing part.** This function decides who may read
 * an author's NORMAL-radius post, so every input to it must be state the
 * *reader* cannot set for themselves — and `tier` is not such a state. It is
 * derived from `COALESCE(manual_score, computed_score)`, and a reader sets
 * `manualScore` on their own edge directly via `PATCH /api/relationships/score`
 * (`manualScore: 1.0` → `scoreToTier` → tier 0), which `recomputeScores`
 * then preserves.
 *
 * Requiring `reciprocated` was not sufficient, and the earlier version of this
 * comment was wrong to claim it was. `reciprocated` is set by the server, but
 * only on the *existence* of the reverse edge — there is no tier, score or
 * method condition on it, and it is written to both rows. So the cheapest social
 * action there is (a follow-back, which lands at tier 2 "community") combined
 * with a self-set `manualScore` was enough to read a stranger's close-friends
 * posts. Worse, the victim could not revoke it: lowering their own tier changed
 * nothing, because the tier being read was the attacker's. Only deleting the
 * edge worked.
 *
 * Hence the query reads the **author's** outgoing edge, not the viewer's. Who is
 * in an audience is the author's choice — that is the premise of the whole
 * audience model (scopes are author-owned) — and reading the viewer's own tier to
 * decide what an author shares was backwards, not merely permissive.
 *
 * `reciprocated` is retained on top of the direction flip, so the set is
 * "authors who placed this viewer close, and where the viewer connected back".
 * Requiring the viewer's edge to *also* be close would be narrower still, but it
 * would silently drop people an author deliberately included.
 *
 * This flip is not purely a narrowing. Where an author placed the viewer close
 * but the viewer reciprocated at a distant tier, the viewer now GAINS access —
 * correct semantics, but a change for existing rows. Before deploying, count the
 * rows where the two directions disagree on closeness:
 *
 *   SELECT count(*) FROM relationships a
 *     JOIN relationships b ON b.user_id = a.target_id AND b.target_id = a.user_id
 *   WHERE a.target_type = 'user' AND b.target_type = 'user'
 *     AND a.reciprocated AND (a.tier <= 1) <> (b.tier <= 1);
 *
 * Expected to be 0: `TENANT_SCOPE_MODE` defaults to `off`, the ambient tenant is
 * established only when it is not `off` (app.ts), and `createRelationship`
 * refuses without one — so no edge can have been written in the default
 * configuration.
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
        targetId: string;
        targetType: string;
        tier: { lte: number };
        reciprocated: boolean;
      };
      select: { userId: true };
    }): Promise<Array<{ userId: string }>>;
  };
};

/**
 * Resolve the authors whose friends-only posts `viewerUserId` may read (see the
 * module doc for the definition and the direction argument). Returns an empty
 * array for a viewer no author has placed close.
 */
export async function getFriendUserIds(
  db: RelationshipReader,
  viewerUserId: string,
): Promise<string[]> {
  const rows = await db.relationship.findMany({
    where: {
      // The AUTHOR's edge, not the viewer's: `targetId` is the viewer, so `tier`
      // below is the tier the AUTHOR assigned. Flipping this back to
      // `userId: viewerUserId` hands the audience boundary to the reader, who
      // can set their own tier via PATCH /api/relationships/score (V1).
      targetId: viewerUserId,
      targetType: "user",
      tier: { lte: FRIEND_TIER_MAX },
      // REQUIRED, never optional: the consent half of the definition. Removing
      // this line lets an author's one-sided classification of a stranger grant
      // that stranger read access.
      reciprocated: true,
    },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}
