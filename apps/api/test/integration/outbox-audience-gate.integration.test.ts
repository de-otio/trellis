/**
 * Integration: the unauthenticated ActivityPub outbox must not serve activities
 * whose post has since been narrowed, hidden or deleted (H2).
 *
 * `GET /users/:username/outbox` needs no credentials, and before this gate
 * `ActivityService.getOutboxActivities` returned every `Activity` row for the
 * actor: no audience filter, no join to `posts`, no lifecycle check. Nothing
 * removes an `Activity` when its post changes state — there is no
 * `activity.delete*` call anywhere in `apps/api/src` — and `editPost` emits an
 * `Update` only when `mayFederatePost` passes, so narrowing SHOUT -> WHISPER
 * emits neither an `Update` nor a `Delete` and the stale outbox row simply
 * stays. An anonymous caller could therefore list the outbox and treat every
 * objectId that now 404s on `/posts/:postId` as a post that used to be public:
 * precisely the existence oracle `da7cba1` removed from the object routes,
 * handed back by the adjacent collection.
 *
 * These are outcome assertions the unit lane structurally CANNOT make. The unit
 * suite mocks `$queryRaw` and resolves canned rows regardless of the statement,
 * so it can only assert the predicate's TEXT; it would pass just as happily if
 * that text admitted everything. Only a real Postgres evaluating the real
 * clause can say whether a row actually comes back. (Same argument, same lane,
 * as `post-read-isolation.integration.test.ts`.)
 *
 * This file is also the drift pin promised in `activity-service.ts`: the SQL
 * predicate and `mayFederatePost` are two transcriptions of one rule and
 * nothing mechanically binds them, so the matrix below asserts they agree
 * row-for-row. Change one without the other and this fails.
 *
 * Runs in the setup-free integration-ci lane (real DATABASE_URL, no
 * test/setup.ts). Same bootstrap as post-read-isolation.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActivityService } from "../../src/lib/activitypub/activity-service.js";
import { mayFederatePost } from "../../src/lib/post-handler.js";

// Hyperdrive guard: safe even under the broad integration config, whose
// test/setup.ts forces a fake hyperdrive URL.
const ENV_DB_URL = process.env.DATABASE_URL;
const TEST_DB_URL =
  ENV_DB_URL !== undefined && !ENV_DB_URL.includes("hyperdrive")
    ? ENV_DB_URL
    : "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const RUN = `h2-outbox-${Date.now()}`;
const TENANT = `${RUN}-tenant`;

const uuid = (n: number) =>
  `41111111-2222-4333-8444-${String(n).padStart(12, "0")}`;
const AUTHOR = uuid(1);
const OTHER = uuid(2);

const ACTOR = `https://example.com/users/${RUN}-author`;
const OTHER_ACTOR = `https://example.com/users/${RUN}-other`;

/** `https://host/posts/<postId>` — the shape `posts.object_id` actually holds. */
const objectUriFor = (postId: string) => `https://example.com/posts/${postId}`;

let prisma: PrismaClient;

/**
 * The post-state matrix. Every row is a post that DID federate once — it has an
 * `object_id` and an outbox `Create` — and then moved to the state named here.
 * `expectVisible` is asserted twice over: against the SQL gate, and against
 * `mayFederatePost` evaluating the same row.
 */
const MATRIX = [
  {
    key: "public",
    radius: "SHOUT" as const,
    deletedAt: null as Date | null,
    hiddenByAuthor: false,
    expectVisible: true,
  },
  {
    key: "narrowed",
    // The H2 attack shape: was SHOUT, federated, then narrowed. No Update and
    // no Delete was ever emitted, so the Create row is still sitting there.
    radius: "WHISPER" as const,
    deletedAt: null as Date | null,
    hiddenByAuthor: false,
    expectVisible: false,
  },
  {
    key: "narrowed-normal",
    // NORMAL and LOUD are narrower than SHOUT too — the gate is `= SHOUT`, not
    // `!= WHISPER`.
    radius: "NORMAL" as const,
    deletedAt: null as Date | null,
    hiddenByAuthor: false,
    expectVisible: false,
  },
  {
    key: "deleted",
    radius: "SHOUT" as const,
    deletedAt: new Date("2026-01-01T00:00:00Z"),
    hiddenByAuthor: false,
    expectVisible: false,
  },
  {
    key: "hidden",
    radius: "SHOUT" as const,
    deletedAt: null as Date | null,
    hiddenByAuthor: true,
    expectVisible: false,
  },
];

/** Activity ids that reference no post at all — these must survive the gate. */
const FOLLOW_ACCEPT = `${RUN}-act-accept`;
const NULL_OBJECT = `${RUN}-act-nullobject`;
const REMOTE_OBJECT = `${RUN}-act-remote`;
/** An `Update`, to prove the gate keys on the object, not on the type. */
const UPDATE_OF_NARROWED = `${RUN}-act-update-narrowed`;
/** Another actor's row, to prove the actor scoping still holds. */
const OTHER_ACTORS_ROW = `${RUN}-act-otheractor`;

const activityIdFor = (key: string) => `${RUN}-act-${key}`;
const postIdFor = (key: string) => `${RUN}-post-${key}`;

async function makeUser(id: string, actorUri: string, tag: string) {
  await prisma.tenant.create({
    data: {
      id: `${RUN}-pt-${tag}`,
      slug: `${RUN}-pt-${tag}`,
      displayName: `${RUN}-pt-${tag}`,
      type: "PERSONAL",
    },
  });
  await prisma.user.create({
    data: {
      id,
      email: `${id}@test.example.com`,
      handle: `h-${id.slice(-8)}-${RUN.slice(-6)}`,
      username: `${RUN}-${tag}`,
      actorUri,
      personalTenantId: `${RUN}-pt-${tag}`,
      dataRegion: "US",
    },
  });
}

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
  });
  await prisma.$connect();

  await prisma.tenant.create({
    data: {
      id: TENANT,
      slug: TENANT,
      displayName: TENANT,
      type: "ORGANIZATION",
    },
  });
  await makeUser(AUTHOR, ACTOR, "author");
  await makeUser(OTHER, OTHER_ACTOR, "other");

  // Posts + their outbox Create activities. `published` descends with the index
  // so the expected ordering is deterministic and the pagination assertion has
  // something to bite on.
  for (const [i, row] of MATRIX.entries()) {
    const postId = postIdFor(row.key);
    await prisma.post.create({
      data: {
        id: postId,
        text: `post ${row.key}`,
        authorId: AUTHOR,
        tenantId: TENANT,
        radius: row.radius,
        deletedAt: row.deletedAt,
        hiddenByAuthor: row.hiddenByAuthor,
        objectId: objectUriFor(postId),
        activityId: `${objectUriFor(postId)}/activity`,
        dataRegion: "US",
      },
    });
    await prisma.activity.create({
      data: {
        id: activityIdFor(row.key),
        actorUri: ACTOR,
        type: "Create",
        objectId: objectUriFor(postId),
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: new Date(Date.UTC(2026, 0, 20 - i)),
        outboxActorUri: ACTOR,
      },
    });
  }

  // An Update of the narrowed post. Same object, different type: a type
  // allowlist that only gated `Create` would leak this one.
  await prisma.activity.create({
    data: {
      id: UPDATE_OF_NARROWED,
      actorUri: ACTOR,
      type: "Update",
      objectId: objectUriFor(postIdFor("narrowed")),
      published: new Date(Date.UTC(2026, 0, 10)),
      outboxActorUri: ACTOR,
    },
  });

  // Federation plumbing that references no local post. Dropping these would
  // break follow handshakes, so they must pass the gate untouched.
  await prisma.activity.create({
    data: {
      id: FOLLOW_ACCEPT,
      actorUri: ACTOR,
      type: "Accept",
      objectId: "https://remote.example/activities/follow-1",
      targetId: "https://remote.example/users/bob",
      published: new Date(Date.UTC(2026, 0, 9)),
      outboxActorUri: ACTOR,
    },
  });
  await prisma.activity.create({
    data: {
      id: NULL_OBJECT,
      actorUri: ACTOR,
      type: "Follow",
      objectId: null,
      targetId: "https://remote.example/users/carol",
      published: new Date(Date.UTC(2026, 0, 8)),
      outboxActorUri: ACTOR,
    },
  });
  await prisma.activity.create({
    data: {
      id: REMOTE_OBJECT,
      actorUri: ACTOR,
      type: "Announce",
      objectId: "https://remote.example/posts/999",
      published: new Date(Date.UTC(2026, 0, 7)),
      outboxActorUri: ACTOR,
    },
  });

  // A different actor's public post + activity. Must never appear in ACTOR's
  // outbox — the gate must not have relaxed the actor scoping.
  const otherPostId = postIdFor("otheractor");
  await prisma.post.create({
    data: {
      id: otherPostId,
      text: "other actor post",
      authorId: OTHER,
      tenantId: TENANT,
      radius: "SHOUT",
      objectId: objectUriFor(otherPostId),
      dataRegion: "US",
    },
  });
  await prisma.activity.create({
    data: {
      id: OTHER_ACTORS_ROW,
      actorUri: OTHER_ACTOR,
      type: "Create",
      objectId: objectUriFor(otherPostId),
      published: new Date(Date.UTC(2026, 0, 25)),
      outboxActorUri: OTHER_ACTOR,
    },
  });
});

afterAll(async () => {
  await prisma.activity.deleteMany({ where: { id: { startsWith: RUN } } });
  await prisma.post.deleteMany({ where: { id: { startsWith: RUN } } });
  await prisma.user.deleteMany({ where: { id: { in: [AUTHOR, OTHER] } } });
  await prisma.tenant.deleteMany({ where: { id: { startsWith: RUN } } });
  await prisma.$disconnect();
});

/** Every activity the gate lets through, over a page large enough to hold all. */
async function outboxIds() {
  const rows = await ActivityService.getOutboxActivities(prisma, ACTOR, 1, 100);
  return rows.map((r) => r.id);
}

describe("outbox audience gate (H2)", () => {
  it("SERVES an activity whose post is still public", async () => {
    // Non-vacuity. Without this, every exclusion assertion below would pass on
    // an outbox that returns nothing at all.
    expect(await outboxIds()).toContain(activityIdFor("public"));
  });

  it("WITHHOLDS the activity of a post narrowed SHOUT -> WHISPER", async () => {
    // The H2 attack in one assertion: the Create is still in the table, the
    // post is still in the table, and the anonymous caller gets neither the
    // objectId nor the audience metadata that would identify it.
    const ids = await outboxIds();
    expect(ids).not.toContain(activityIdFor("narrowed"));

    // Non-vacuity for THIS row specifically: the fixture really does exist and
    // really is in the actor's outbox, so its absence can only come from the
    // gate.
    const stillStored = await prisma.activity.findUnique({
      where: { id: activityIdFor("narrowed") },
    });
    expect(stillStored?.outboxActorUri).toBe(ACTOR);
  });

  it("WITHHOLDS the activity of a post narrowed SHOUT -> NORMAL", async () => {
    expect(await outboxIds()).not.toContain(activityIdFor("narrowed-normal"));
  });

  it("WITHHOLDS the activity of a soft-deleted post", async () => {
    expect(await outboxIds()).not.toContain(activityIdFor("deleted"));
  });

  it("WITHHOLDS the activity of a post hidden by its author", async () => {
    expect(await outboxIds()).not.toContain(activityIdFor("hidden"));
  });

  it("gates on the OBJECT, not the activity type — an Update is withheld too", async () => {
    expect(await outboxIds()).not.toContain(UPDATE_OF_NARROWED);
  });

  it("STILL SERVES federation plumbing that references no local post", async () => {
    // Follow/Accept and remote-object activities carry no local audience
    // decision. Dropping them would break the follow handshake, which is the
    // failure mode a blunter filter would have produced.
    const ids = await outboxIds();
    expect(ids).toContain(FOLLOW_ACCEPT);
    expect(ids).toContain(NULL_OBJECT);
    expect(ids).toContain(REMOTE_OBJECT);
  });

  it("does not relax the actor scoping", async () => {
    expect(await outboxIds()).not.toContain(OTHER_ACTORS_ROW);
  });
});

describe("the SQL gate and mayFederatePost agree (drift pin)", () => {
  it.each(MATRIX)(
    "$key: SQL visibility matches mayFederatePost",
    async (row) => {
      const post = await prisma.post.findUniqueOrThrow({
        where: { id: postIdFor(row.key) },
      });

      // The JS predicate, on the same row the SQL just judged.
      expect(mayFederatePost(post)).toBe(row.expectVisible);

      // And the SQL, on the same row. A change to one transcription and not the
      // other lands here rather than in production.
      expect(await outboxIds()).toEqual(
        expect.arrayContaining(
          row.expectVisible ? [activityIdFor(row.key)] : [],
        ),
      );
      if (!row.expectVisible) {
        expect(await outboxIds()).not.toContain(activityIdFor(row.key));
      }
    },
  );
});

describe("count and list cannot disclose different sets", () => {
  it("getOutboxCount equals the length of the ungated-page list", async () => {
    const ids = await outboxIds();
    const count = await ActivityService.getOutboxCount(prisma, ACTOR);

    // If the count were taken over the raw table it would be 9 (5 post Creates
    // + Update + Accept + Follow + Announce); the gate withholds 5 of them, so
    // both sides must read 4.
    expect(count).toBe(ids.length);
    expect(count).toBe(4);
  });

  it("the raw table really does hold more rows than either side reports", async () => {
    // Non-vacuity for the count assertion: it is only meaningful if the ungated
    // count would have differed.
    const ungated = await prisma.activity.count({
      where: { outboxActorUri: ACTOR },
    });
    expect(ungated).toBe(9);
  });
});

describe("pagination cuts the page AFTER the gate", () => {
  it("fills a page with kept rows instead of spending it on withheld ones", async () => {
    // Newest first: public (Jan 20) is the only kept row among the five post
    // Creates (Jan 16-20), then Update (Jan 10, withheld), Accept (Jan 9),
    // Follow (Jan 8), Announce (Jan 7). A gate applied AFTER the page cut would
    // return just [public] here, because the first three raw rows are all
    // withheld post Creates.
    const page = await ActivityService.getOutboxActivities(prisma, ACTOR, 1, 3);
    expect(page.map((r) => r.id)).toEqual([
      activityIdFor("public"),
      FOLLOW_ACCEPT,
      NULL_OBJECT,
    ]);
  });

  it("preserves published-desc ordering and offsets over the gated set", async () => {
    const page2 = await ActivityService.getOutboxActivities(prisma, ACTOR, 2, 3);
    expect(page2.map((r) => r.id)).toEqual([REMOTE_OBJECT]);
  });
});
