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
 *
 * ---------------------------------------------------------------------------
 * ## Is friendship tenant-scoped, or account-global? (security review 2026-08,
 * lane 7 HIGH-2 — the semantic decision, recorded here because the code had
 * two answers and neither was written down.)
 *
 * **Decision: friendship is TENANT-SCOPED. A `relationships` edge means
 * "inside this tenant", never "between these two accounts everywhere".**
 *
 * This function previously carried no `tenantId` predicate at all, while
 * `authorAudienceSql` (lib/graph/postgres/circles.ts) — the *other* reader of
 * the very same column on the very same table, for the very same decision —
 * requires `ar.tenant_id = ${tenantId}`. Two readers of one table cannot
 * disagree about what a row means, so one of them had to move. Everything the
 * schema and the write path already assert points the same way:
 *
 *  1. `Relationship.tenantId` is **NOT NULL** (prisma/schema.prisma). An edge
 *     cannot be written without naming a tenant, so an edge is a fact *about a
 *     tenant*, not about a pair of accounts.
 *  2. `createRelationship` **refuses** without an ambient tenant. The write
 *     side has never been account-global.
 *  3. The per-user edge cap counts `{ userId, tenantId }` — a per-tenant
 *     roster quota. A global roster would make the cap meaningless.
 *  4. The unique key is `[tenantId, userId, targetType, targetId]` (M7), so the
 *     same pair of users may be placed at *different* tiers in different
 *     tenants. Per-tenant placement is representable, therefore intended; a
 *     global read of a per-tenant column takes the UNION of every placement,
 *     which is the widest possible reading of a deliberately narrow one.
 *  5. This set is ANDed with tenant-scoped post reads (`getPost`,
 *     `canReadPost`, `getHomeFeed` all require `activeTenantId`). Feeding a
 *     tenant-blind friend set into a tenant-scoped post query is precisely the
 *     leak: A and B share tenants T1 and T2; A puts B in their inner circle in
 *     T2; B's feed and `canReadPost` in **T1** then include A in `friendIds`,
 *     so A's NORMAL-radius posts in T1 become readable by B — and A cannot
 *     revoke it from T1 because the grant does not live there.
 *
 * The alternative (declare friendship account-global and drop the predicate
 * from `authorAudienceSql`) was rejected: it would widen the audience of every
 * existing tiered feed query, contradict the NOT NULL column and the write-side
 * refusal, and hand a tenant admin the ability to grant read access inside a
 * tenant they have no relationship with.
 *
 * Consequence for callers: `tenantId` is a **required** argument, and it must
 * be the caller's verified active tenant (JWT-derived), never an ambient value
 * and never a client-supplied string. It is passed explicitly rather than read
 * from the ambient ALS because the ambient tenant does not exist when
 * `TENANT_SCOPE_MODE` is `"off"` (the current deploy default), and a friend set
 * that silently goes global under a config flag is the defect being fixed.
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
        tenantId: string;
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
 * Resolve the authors whose friends-only posts `viewerUserId` may read **within
 * `tenantId`** (see the module doc for the definition, the direction argument,
 * and why friendship is tenant-scoped). Returns an empty array for a viewer no
 * author has placed close in that tenant.
 *
 * @param tenantId The caller's verified active tenant. Required and non-empty:
 *   Prisma DROPS an `undefined` `where` key, so a falsy tenant would not narrow
 *   the query — it would remove tenant isolation from it. Refused loudly rather
 *   than defaulted, because an empty friend set is indistinguishable from a
 *   correct one and would hide the misconfiguration.
 */
export async function getFriendUserIds(
  db: RelationshipReader,
  viewerUserId: string,
  tenantId: string,
): Promise<string[]> {
  if (!tenantId) {
    throw new Error(
      "getFriendUserIds: tenantId is required for tenant isolation",
    );
  }
  const rows = await db.relationship.findMany({
    where: {
      // REQUIRED, never optional. A friendship edge is scoped to the tenant it
      // was created in; without this predicate an edge created in tenant B
      // authorizes NORMAL-radius reads in tenant A (lane 7 HIGH-2). Matches
      // `authorAudienceSql`'s `ar.tenant_id = ${tenantId}` in
      // lib/graph/postgres/circles.ts — the two must agree or the feed and the
      // per-post gate disagree about who is a friend.
      tenantId,
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
