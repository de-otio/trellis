/**
 * User blocks on the READ and WRITE-GUARD paths (M2).
 *
 * The realtime delivery floor already consulted the `BlockStore` port
 * (lib/realtime/block-store.ts) for notifications. Everything else — the feed,
 * a single post, a comment thread, reactions — did not, so a blocked account's
 * posts and comments stayed fully visible and it could still comment on and
 * react to the posts of the person who blocked it. That is the whole remedy
 * failing quietly: the product has no standing human moderator, so the block is
 * the user-side remedy, and a remedy that only silences notifications is not
 * one.
 *
 * This module is the single seam those paths use. It holds no state and no
 * second lookup: it delegates to the same `BlockStore` port, which is why the
 * port grew `listMutualBlockIds` rather than each read site growing a
 * `blockedUser` query of its own.
 *
 * ## Bidirectional, always
 *
 * A block hides BOTH directions. Neither party sees the other's posts or
 * comments. One-way hiding would leave the blocked account watching the person
 * who blocked it, which is the exact situation the block is invoked to end.
 *
 * ## Where the exclusion is applied
 *
 * As a `WHERE authorId NOT IN (…)` predicate inside the same query that
 * paginates, never as a post-filter over an already-paginated page. A
 * post-filter would silently shorten pages and — worse — make `hasMore` and the
 * keyset cursor disagree with the rows actually returned, so a reader could
 * skip unblocked content near a page boundary. Feed keyset pagination is
 * `(createdAt, id)` (see feed-pagination.ts and the cursor built in
 * feed-handler.ts); the comment thread keys on `createdAt`. Both stay exact
 * under an additional `WHERE` conjunct and both break under a post-filter.
 */

import {
  PrismaBlockStore,
  type BlockStore,
  type PrismaWithBlockedUser,
} from "./realtime/block-store.js";

/**
 * Resolve the ids mutually invisible to `viewerUserId` inside `tenantId` — one
 * batched query per request, both directions.
 *
 * Returns `[]` for a falsy viewer or tenant rather than throwing: this is a
 * visibility NARROWING, so an empty set is the no-op, and the tenant predicate
 * that actually isolates data lives in the caller's own query (which already
 * refuses a falsy tenant loudly).
 */
export async function resolveMutualBlockIds(
  db: PrismaWithBlockedUser,
  tenantId: string,
  viewerUserId: string,
  store?: BlockStore,
): Promise<string[]> {
  if (!tenantId || !viewerUserId) return [];
  const blockStore = store ?? new PrismaBlockStore(db);
  return blockStore.listMutualBlockIds(tenantId, viewerUserId);
}

/**
 * Is there a block edge in EITHER direction between `userA` and `userB`?
 *
 * The write guard. Two indexed unique lookups rather than the set query,
 * because a write guard knows both ids up front and only needs a boolean.
 */
export async function isBlockedEitherWay(
  db: PrismaWithBlockedUser,
  tenantId: string,
  userA: string,
  userB: string,
  store?: BlockStore,
): Promise<boolean> {
  if (!tenantId || !userA || !userB || userA === userB) return false;
  const blockStore = store ?? new PrismaBlockStore(db);
  const [aBlockedB, bBlockedA] = await Promise.all([
    blockStore.isBlocked(tenantId, userA, userB),
    blockStore.isBlocked(tenantId, userB, userA),
  ]);
  return aBlockedB || bBlockedA;
}

/**
 * The refusal a blocked write gets: 403 with the structured envelope
 * (`error` / `message` / `remediation`) the 4xx surfaces use.
 *
 * The message does not say WHICH direction the block runs in. Distinguishing
 * "you blocked them" from "they blocked you" would turn every post into a probe
 * for whether a given account has blocked you; the caller can already read its
 * own outgoing list from `GET /api/blocks`, which is the non-probing way to
 * learn the first case.
 */
export function blockedWriteResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "BLOCKED",
      message: "This interaction is unavailable because of a block.",
      remediation:
        "Review your blocked accounts with GET /api/blocks and remove the block with DELETE /api/blocks/{userId} if it is yours.",
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}
