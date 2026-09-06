/**
 * Activity Service
 *
 * Handles storage and retrieval of ActivityPub activities in inbox/outbox.
 */

import { Prisma } from "@prisma/client";
import type { PrismaClient, Activity } from "@prisma/client";

export interface ActivityStreamsActivity {
  "@context"?: string | string[];
  type: string;
  id?: string;
  actor: string | object;
  object?: string | object;
  target?: string | object;
  to?: string | string[];
  cc?: string | string[];
  bto?: string | string[];
  bcc?: string | string[];
  published?: string;
  [key: string]: any;
}

/**
 * The outbox audience gate, as ONE SQL fragment shared by the list and the
 * count.
 *
 * `GET /users/:username/outbox` is unauthenticated. Before this fragment it
 * returned every `Activity` row for the actor with no audience check at all,
 * which handed away exactly the set the object routes were hardened to hide:
 * nothing ever deletes an `Activity` when its post is narrowed, hidden or
 * soft-deleted (there is no `activity.delete*` call anywhere in
 * `apps/api/src`), and `editPost` emits an `Update` only when
 * `mayFederatePost` passes — so narrowing SHOUT -> WHISPER emits neither an
 * `Update` nor a `Delete`. The stale outbox row survives, still carrying the
 * post's objectId plus its `to`/`cc`/`bto`/`bcc` audience metadata. An
 * anonymous caller could list the outbox, fetch each objectId from
 * `/posts/:postId`, and read the once-public-now-private set straight off the
 * 404s — the existence oracle `da7cba1` closed on the object routes, reopened
 * on the adjacent collection.
 *
 * The predicate below is `mayFederatePost` (see `lib/post-handler.ts`)
 * transcribed into SQL, condition for condition:
 *
 *     if (!post) return false;                 -> NOT EXISTS, see below
 *     if (post.deletedAt) return false;        -> p.deleted_at IS NULL
 *     if (post.hiddenByAuthor) return false;   -> p.hidden_by_author = false
 *     return post.radius === "SHOUT";          -> p.radius = 'SHOUT'
 *
 * DRIFT: the JS predicate and this SQL are two transcriptions of one rule and
 * nothing mechanically binds them. The lockstep that IS enforced is between the
 * list and the count — both consume this single fragment, so pagination's
 * `totalItems` can never disclose a count the page itself withholds. Keeping
 * the SQL in step with `mayFederatePost` is a review obligation, pinned by
 * `test/integration/outbox-audience-gate.integration.test.ts`, which asserts
 * the two agree row-for-row over a matrix of post states. When the audience
 * model replaces `radius` with the explicit `federate` column (see
 * trellis-internal plans/audience-and-reach, axis 3), BOTH sites change
 * together or the gate silently opens.
 *
 * Scoped by OBJECT IDENTITY, not by activity type. An activity is withheld only
 * when a `posts` row actually carries its `object_id`; `posts.object_id` is
 * `@unique`, so the match is exact and one-to-one, never a prefix or pattern
 * guess. Follow / Accept / Undo and anything referencing a remote object have
 * no matching `posts` row and pass through untouched — dropping those would
 * break federation. Identity beats a type allowlist here because it also covers
 * activity types that do not exist yet: any future `Announce` or `Delete` of a
 * local post is gated the day it is written, with no change to this fragment.
 *
 * BLIND-RECIPIENT ROWS are withheld too. A direct message is a `Create` whose
 * Note is addressed with `bto` only — no `to`, no `cc`, and no `posts` row,
 * so the object-identity clause above passes it straight through. That leaked
 * the DM's object URI (and its audience) to any anonymous outbox reader. An
 * activity that names blind recipients and nothing else has, by definition, no
 * public audience; the second clause below withholds every such row from the
 * anonymous collection. An activity with a `to`/`cc` audience AND a `bto`
 * (rare, but legal) is still served, with `bto`/`bcc` stripped by the caller.
 *
 * KNOWN FAIL-OPEN, deliberately not widened here: `lib/services/user-data-
 * deletion.ts` HARD-deletes a user's `posts` rows (step 6) without deleting
 * their `activities`, so an erased account's outbox rows match no post and are
 * kept by this predicate. It is not currently reachable — the same routine
 * deletes the `User`, and the outbox route 404s before it ever queries
 * activities — but the orphaned rows are real and are a GDPR residue bug in
 * their own right. Closing it belongs with that routine (delete the activities
 * too), not with a URI-shape guess here: a fuzzy match on "looks like a local
 * post URI" would either withhold legitimate remote activities or, wrong in the
 * other direction, leak.
 */
function outboxAudienceFilter(actorUri: string): Prisma.Sql {
  return Prisma.sql`
    a.outbox_actor_uri = ${actorUri}
    AND NOT EXISTS (
      SELECT 1
      FROM posts p
      WHERE p.object_id = a.object_id
        AND NOT (
          p.radius = 'SHOUT'
          AND p.deleted_at IS NULL
          AND p.hidden_by_author = false
        )
    )
    AND NOT (
      (a.bto IS NOT NULL OR a.bcc IS NOT NULL)
      AND a.to IS NULL
      AND a.cc IS NULL
    )
  `;
}

export class ActivityService {
  /**
   * Store activity in inbox
   */
  static async storeInboxActivity(
    prisma: PrismaClient,
    inboxActorUri: string,
    activity: ActivityStreamsActivity,
  ): Promise<Activity> {
    const actorUri =
      typeof activity.actor === "string"
        ? activity.actor
        : (activity.actor as any)?.id || "";
    const objectId = activity.object
      ? typeof activity.object === "string"
        ? activity.object
        : (activity.object as any)?.id
      : null;
    const targetId = activity.target
      ? typeof activity.target === "string"
        ? activity.target
        : (activity.target as any)?.id
      : null;

    const published = activity.published
      ? new Date(activity.published)
      : new Date();

    return await prisma.activity.create({
      data: {
        actorUri,
        type: activity.type,
        objectId: objectId || undefined,
        targetId: targetId || undefined,
        to: activity.to
          ? Array.isArray(activity.to)
            ? activity.to
            : [activity.to]
          : undefined,
        cc: activity.cc
          ? Array.isArray(activity.cc)
            ? activity.cc
            : [activity.cc]
          : undefined,
        bto: activity.bto
          ? Array.isArray(activity.bto)
            ? activity.bto
            : [activity.bto]
          : undefined,
        bcc: activity.bcc
          ? Array.isArray(activity.bcc)
            ? activity.bcc
            : [activity.bcc]
          : undefined,
        published,
        inboxActorUri,
        receivedAt: new Date(),
      },
    });
  }

  /**
   * Store activity in outbox
   */
  static async storeOutboxActivity(
    prisma: PrismaClient,
    outboxActorUri: string,
    activity: ActivityStreamsActivity,
  ): Promise<Activity> {
    const actorUri =
      typeof activity.actor === "string"
        ? activity.actor
        : (activity.actor as any)?.id || "";
    const objectId = activity.object
      ? typeof activity.object === "string"
        ? activity.object
        : (activity.object as any)?.id
      : null;
    const targetId = activity.target
      ? typeof activity.target === "string"
        ? activity.target
        : (activity.target as any)?.id
      : null;

    const published = activity.published
      ? new Date(activity.published)
      : new Date();

    return await prisma.activity.create({
      data: {
        actorUri,
        type: activity.type,
        objectId: objectId || undefined,
        targetId: targetId || undefined,
        to: activity.to
          ? Array.isArray(activity.to)
            ? activity.to
            : [activity.to]
          : undefined,
        cc: activity.cc
          ? Array.isArray(activity.cc)
            ? activity.cc
            : [activity.cc]
          : undefined,
        bto: activity.bto
          ? Array.isArray(activity.bto)
            ? activity.bto
            : [activity.bto]
          : undefined,
        bcc: activity.bcc
          ? Array.isArray(activity.bcc)
            ? activity.bcc
            : [activity.bcc]
          : undefined,
        published,
        outboxActorUri,
      },
    });
  }

  /**
   * Get outbox activities (paginated), audience-gated.
   *
   * The gate is `outboxAudienceFilter` — see its comment for why this
   * unauthenticated collection needs one at all.
   *
   * Two queries on purpose. The raw statement decides membership, order and
   * page; `findMany` only hydrates the rows it selected. Selecting the rows
   * themselves in raw SQL would mean hand-aliasing all twelve columns back to
   * camelCase, where one typo silently yields `undefined` in a federated
   * payload; going through `findMany` keeps Prisma's own column mapping and
   * `Json`/`DateTime` handling. Filtering it in JS after the fact is not an
   * option — the page has to be cut AFTER the gate or `limit` would be spent on
   * withheld rows and pagination would still leak the shape of the denied set.
   *
   * Ordering is `published DESC` as before, with `id DESC` added as a
   * tiebreaker: the id page and the hydration have to agree on the order of
   * equal timestamps, and an unstable sort across pages drops or repeats rows.
   */
  static async getOutboxActivities(
    prisma: PrismaClient,
    actorUri: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<Activity[]> {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT a.id
      FROM activities a
      WHERE ${outboxAudienceFilter(actorUri)}
      ORDER BY a.published DESC, a.id DESC
      LIMIT ${limit}
      OFFSET ${(page - 1) * limit}
    `);

    if (rows.length === 0) return [];

    return await prisma.activity.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      orderBy: [{ published: "desc" }, { id: "desc" }],
    });
  }

  /**
   * Get outbox count.
   *
   * Consumes the SAME `outboxAudienceFilter` as `getOutboxActivities`. That is
   * the point: a count taken over the ungated set would publish `totalItems`
   * for rows the collection refuses to show, which is the same existence oracle
   * by arithmetic.
   */
  static async getOutboxCount(
    prisma: PrismaClient,
    actorUri: string,
  ): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS count
      FROM activities a
      WHERE ${outboxAudienceFilter(actorUri)}
    `);

    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Get inbox activities (paginated)
   */
  static async getInboxActivities(
    prisma: PrismaClient,
    actorUri: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<Activity[]> {
    return await prisma.activity.findMany({
      where: {
        inboxActorUri: actorUri,
      },
      orderBy: {
        receivedAt: "desc",
      },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  /**
   * Get inbox count
   */
  static async getInboxCount(
    prisma: PrismaClient,
    actorUri: string,
  ): Promise<number> {
    return await prisma.activity.count({
      where: {
        inboxActorUri: actorUri,
      },
    });
  }
}
