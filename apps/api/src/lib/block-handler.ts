/**
 * Block Handler
 *
 * The user-side remedy: block / unblock / list-my-blocks. The product has no
 * standing human moderator, so this is the remedy a user has, and until M2 it
 * had no write path at all — the `blocked_users` table was readable only by the
 * realtime delivery floor and nothing could put a row in it.
 *
 * Shape follows `RelationshipHandler` (the closest existing user-relationship
 * surface): a handler class of `handleX(request, session, env, requestContext)`
 * methods, Zod validation at the boundary, `{ error: CODE, message }` 4xx
 * bodies, and the route layer owning auth, CORS, CSRF, rate limiting and
 * security headers.
 *
 * ## Blocking removes the relationship edges, in one transaction
 *
 * Trellis has no `Follow` model — the follow/unfollow pair was replaced by the
 * scored `Relationship` edge (see lib/friend-ids.ts). A block that left those
 * edges standing would leave the blocked account inside the blocker's audience
 * (`getFriendUserIds` reads a tier ≤ 1 reciprocated edge to decide who may read
 * a NORMAL-radius post), so the block would hide the feed while the underlying
 * grant survived — and would come back the moment the block was lifted. Both
 * directed edges go with the block, inside the same transaction as the block
 * row: a half-applied block is a block that does not hold.
 */

import type { Env } from "../env.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { Session } from "./session-cookie.js";

/** Max page size for `GET /api/blocks`. */
const MAX_BLOCK_PAGE = 100;
const DEFAULT_BLOCK_PAGE = 50;

interface BlockCursor {
  createdAt: Date;
  id: string;
}

/**
 * Composite `(createdAt, id)` keyset cursor, same encoding as the home feed's
 * (feed-handler.ts). A bare timestamp cursor drops every row tied with the
 * boundary instant, which is reachable here: a client can create several blocks
 * in one burst.
 */
function encodeBlockCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString("base64");
}

function decodeBlockCursor(raw?: string | null): BlockCursor | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof d.createdAt === "string" && typeof d.id === "string") {
      const t = new Date(d.createdAt);
      if (!Number.isNaN(t.getTime())) return { createdAt: t, id: d.id };
    }
  } catch {
    // Not a cursor we issued.
  }
  return null;
}

/**
 * Bump the feed cache version so a block or unblock takes effect on the next
 * request instead of after the TTL. Dynamic import: `FeedHandler` imports the
 * audience filter this feature threads through, so a static import here would
 * make the cycle real rather than lazy.
 */
async function invalidateFeedCache(env: Env): Promise<void> {
  try {
    const { FeedHandler } = await import("./feed-handler.js");
    await FeedHandler.invalidateFeedCache(env as any);
  } catch (error) {
    // Never fail the write on a cache-invalidation problem: the block row is
    // committed, and the stale window closes on its own at the TTL.
    const { getLogger } = await import("./logger.js");
    getLogger().warn("[BlockHandler] Feed cache invalidation failed:", error);
  }
}

function validationError(message: string): Response {
  return new Response(
    JSON.stringify({ error: "VALIDATION_ERROR", message }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function internalError(): Response {
  return new Response(
    JSON.stringify({ error: "INTERNAL_ERROR", message: "Internal server error" }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}

export class BlockHandler {
  /**
   * `POST /api/blocks` — block a user.
   *
   * Idempotent: a repeat block of the same user is 200 with
   * `alreadyBlocked: true`, not a 409. A conflict would be wrong here — the
   * caller asked for a state ("this account is blocked") that already holds,
   * and a client retrying after a dropped response must not have to distinguish
   * its own retry from a real failure.
   */
  async handleBlockUser(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      const { z } = await import("zod");
      const body = (await request.json()) as Record<string, unknown>;

      const schema = z
        .object({ userId: z.string().min(1).max(100) })
        .strict();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return validationError(
          parsed.error.issues[0]?.message ?? "Invalid request body",
        );
      }
      const blockedId = parsed.data.userId;

      if (blockedId === session.userId) {
        return validationError("Cannot block yourself");
      }

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env as any);

      // The target must exist in this tenant. Without this a caller can write
      // arbitrary ids into the table (the columns carry FKs to `users`, so a
      // nonexistent id would surface as an opaque P2003 500 rather than a 404).
      const target = await db.tenantMember.findFirst({
        where: {
          userId: blockedId,
          tenantId: activeTenantId,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      if (!target) {
        return new Response(
          JSON.stringify({ error: "NOT_FOUND", message: "User not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      const existing = await db.blockedUser.findUnique({
        where: {
          tenantId_blockerId_blockedId: {
            tenantId: activeTenantId,
            blockerId: session.userId,
            blockedId,
          },
        },
        select: { id: true, createdAt: true },
      });

      if (existing) {
        return new Response(
          JSON.stringify({
            blockedUserId: blockedId,
            createdAt: existing.createdAt.toISOString(),
            alreadyBlocked: true,
            relationshipsRemoved: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // One transaction: the block row and BOTH directed relationship edges.
      // See the module doc — an edge that outlives the block keeps the blocked
      // account inside the blocker's audience.
      let created: { createdAt: Date };
      let relationshipsRemoved = 0;
      try {
        const [row, removal] = await db.$transaction([
          db.blockedUser.create({
            data: {
              tenantId: activeTenantId,
              blockerId: session.userId,
              blockedId,
            },
            select: { createdAt: true },
          }),
          db.relationship.deleteMany({
            where: {
              tenantId: activeTenantId,
              targetType: "user",
              OR: [
                { userId: session.userId, targetId: blockedId },
                { userId: blockedId, targetId: session.userId },
              ],
            },
          }),
        ]);
        created = row;
        relationshipsRemoved = removal.count;
      } catch (txError: any) {
        // P2002 = the unique key fired, i.e. a concurrent identical block won
        // the race. Same observable as the idempotent branch above.
        if (txError?.code === "P2002") {
          return new Response(
            JSON.stringify({
              blockedUserId: blockedId,
              createdAt: new Date().toISOString(),
              alreadyBlocked: true,
              relationshipsRemoved: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw txError;
      }

      // The home feed is cached per viewer and the block is a visibility
      // change, so a feed computed a moment ago would keep serving the blocked
      // account's posts for the whole TTL. Bump the cache version — the same
      // invalidation the reaction path uses.
      await invalidateFeedCache(env);

      return new Response(
        JSON.stringify({
          blockedUserId: blockedId,
          createdAt: created.createdAt.toISOString(),
          alreadyBlocked: false,
          relationshipsRemoved,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      if (error instanceof SyntaxError) {
        return validationError("Invalid JSON body");
      }
      const { getLogger } = await import("./logger.js");
      getLogger().error("[BlockHandler] Failed to block user:", error);
      return internalError();
    }
  }

  /**
   * `DELETE /api/blocks/:userId` — unblock.
   *
   * Idempotent and 204 either way. A 404 for "you had not blocked them" would
   * report the absence of a row the caller is trying to be rid of, and would
   * make an interrupted-then-retried unblock look like a failure.
   *
   * Relationship edges removed by the block are NOT restored. They were deleted
   * rows, not disabled ones, and re-creating a connection is the users' call.
   */
  async handleUnblockUser(
    blockedId: string,
    _request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      if (!blockedId) {
        return validationError("userId path parameter is required");
      }

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env as any);

      await db.blockedUser.deleteMany({
        where: {
          tenantId: activeTenantId,
          blockerId: session.userId,
          blockedId,
        },
      });

      // Unblocking makes content visible again; the cached feed still has it
      // filtered out. Same bump as the block path.
      await invalidateFeedCache(env);

      return new Response(null, { status: 204 });
    } catch (error: any) {
      const { getLogger } = await import("./logger.js");
      getLogger().error("[BlockHandler] Failed to unblock user:", error);
      return internalError();
    }
  }

  /**
   * `GET /api/blocks` — the caller's OUTGOING blocks only.
   *
   * Never the incoming ones. "Who has blocked me" is not the caller's
   * information to have; publishing it would make the block an announcement and
   * hand a harasser a list of the people avoiding them.
   */
  async handleListBlocks(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const limitRaw = parseInt(
        url.searchParams.get("limit") || `${DEFAULT_BLOCK_PAGE}`,
        10,
      );
      const limit = Math.min(
        Math.max(Number.isNaN(limitRaw) ? DEFAULT_BLOCK_PAGE : limitRaw, 1),
        MAX_BLOCK_PAGE,
      );
      const cursor = decodeBlockCursor(url.searchParams.get("cursor"));

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env as any);

      const rows = await db.blockedUser.findMany({
        where: {
          tenantId: activeTenantId,
          blockerId: session.userId,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        // Tiebreak matches the cursor keyset exactly.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: { id: true, blockedId: true, createdAt: true },
      });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? encodeBlockCursor(last.createdAt, last.id) : undefined;

      return new Response(
        JSON.stringify({
          blocks: page.map((r) => ({
            userId: r.blockedId,
            createdAt: r.createdAt.toISOString(),
          })),
          cursor: nextCursor,
          hasMore,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      const { getLogger } = await import("./logger.js");
      getLogger().error("[BlockHandler] Failed to list blocks:", error);
      return internalError();
    }
  }
}
