/**
 * The shared read authorization for a post and everything attached to it.
 *
 * V3 closed the door on the post row itself: `FeedHandler.getPost` gained a
 * tenant and an audience predicate. It did not close the doors on the post's
 * CONTENTS. `GET /api/posts/:id/comments`, `GET /api/posts/:id/sentiments` and
 * `GET /api/v1/posts/:id/sentiments/users` each tested only that the post row
 * EXISTED — via `DataRouter.getPost`, which is a bare
 * `findUnique({ where: { id } })` with no tenant and no audience predicate — and
 * then returned the attached rows. So the thread of a WHISPER post (author ids
 * and comment text) and the list of WHO reacted to it were readable by any
 * caller who knew the id; the who-reacted endpoint did not even require a
 * session.
 *
 * An attachment must never be more readable than the thing it is attached to.
 * This function is that rule, expressed once.
 *
 * ## Why this is not inside `DataRouter.getPost`
 *
 * `DataRouter.getPost` has fourteen call sites with genuinely different needs —
 * the author's own edit path, moderation, deletion, federation — several of
 * which must see a row this predicate refuses. Putting the audience check there
 * would either break those or force a bypass flag, which is the same thing with
 * extra steps. The gate belongs at the read endpoints that serve a viewer.
 *
 * ## Why this reuses `buildPostAudienceFilter`
 *
 * A second copy of the predicate is a second thing to get wrong, and the two
 * copies would diverge silently — a viewer refused a post but granted its
 * comments has no audience boundary at all. `buildPostAudienceFilter` carries a
 * note asking that no third call site be added and that the audience resolver
 * (plans/audience-and-reach P1.4) be threaded in instead. This module is that
 * third call site, deliberately: it is ONE site serving three endpoints, and
 * when the resolver lands there is exactly one function to reroute rather than
 * four. The note in feed-handler.ts has been updated to say so.
 */

import { DataRouter } from "./data-router.js";
import type { DataRouterEnv } from "./data-router.js";
import { sharedDatabaseConnectionManager } from "./database-connection-manager.js";
import { QueryTimeoutPresets, withQueryTimeoutAndRetry } from "./db-query-helper.js";
import { buildPostAudienceFilter } from "./feed-handler.js";
import { getFriendUserIds } from "./friend-ids.js";
import { getLogger } from "./logger.js";

export interface CanReadPostArgs {
  postId: string;
  /** The cuid of the viewing user — never an OIDC `sub`, never null. */
  viewerUserId: string;
  /** The caller's active tenant, from the JWT. Never an ambient value. */
  tenantId: string;
  /** Region for the read, from the request context. */
  region: string;
  env: DataRouterEnv;
}

/**
 * May `viewerUserId` read post `postId`, reading as tenant `tenantId`?
 *
 * The decision is exactly the one `FeedHandler.getPost` makes, minus the
 * payload: same tenant predicate, same audience predicate, same `deletedAt` /
 * `hiddenByAuthor` exclusions. If the two ever disagree, a viewer can be refused
 * a post and handed its comments, or vice versa.
 *
 * Takes a named-argument object on purpose: `postId`, `viewerUserId` and
 * `tenantId` are three strings, so a positional call that transposes two of them
 * type-checks and silently authorizes the wrong thing.
 *
 * Returns false — never throws — for a missing viewer or tenant. A falsy
 * `tenantId` cannot be allowed to reach Prisma: an `undefined` `where` key is
 * DROPPED, so it would remove tenant isolation from the query rather than
 * failing it. `TENANT_SCOPE_MODE` defaults to `off` and there is no RLS
 * backstop, so this explicit predicate is the only tenant defence there is.
 */
export async function canReadPost(args: CanReadPostArgs): Promise<boolean> {
  const { postId, viewerUserId, tenantId, region, env } = args;

  if (!postId || !viewerUserId || !tenantId) return false;

  // Resolve the viewer's connections BEFORE the post lookup, so that "post
  // absent" and "post refused" perform the same work and cannot be told apart
  // by timing — the same ordering `FeedHandler.getPost` uses.
  //
  // `getFriendUserIds` reads the AUTHOR's outgoing edge and requires
  // `reciprocated` (see lib/friend-ids.ts). Do not re-derive the friend set
  // here: a local re-derivation is how the reader-side-tier defect (V1) got in.
  //
  // Tenant-scoped on the same `tenantId` the post lookup below uses: a friend
  // set resolved in a different tenant than the post would authorize a read
  // across the boundary (lane 7 HIGH-2).
  const friendIds = await getFriendUserIds(
    DataRouter.getDatabaseForRegion(region, env, undefined, viewerUserId),
    viewerUserId,
    tenantId,
  );

  const row = await withQueryTimeoutAndRetry(
    sharedDatabaseConnectionManager,
    region,
    env,
    async (db) => {
      // `findFirst`, not `findUnique`: the audience predicate is a top-level
      // `OR`, and `findFirst` accepts arbitrary filters without depending on
      // Prisma's extended-where-unique behaviour.
      return db.post.findFirst({
        where: {
          id: postId,
          deletedAt: null,
          hiddenByAuthor: false,
          tenantId,
          ...buildPostAudienceFilter(viewerUserId, friendIds),
        },
        select: { id: true },
      });
    },
    {
      ...QueryTimeoutPresets.USER_FACING,
      maxRetries: 3,
      baseDelayMs: 100,
      context: { operation: "canReadPost", userId: viewerUserId, postId },
    },
  );

  if (!row) {
    // Logged, never disclosed. The caller's refusal must not say which of
    // "no such post", "another tenant's post" or "not in the audience" it was.
    getLogger().debug("[authz] post read refused", {
      postId,
      viewerUserId,
      tenantId,
    });
    return false;
  }

  return true;
}
