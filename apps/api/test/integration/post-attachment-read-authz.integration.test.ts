/**
 * Integration (H3): everything ATTACHED to a post must be as hard to read as
 * the post itself.
 *
 * V3 closed the door on the post row (`FeedHandler.getPost` gained a tenant and
 * an audience predicate). The doors on its contents stayed open: the comment
 * thread, the sentiment counts, and the who-reacted list each tested only that
 * the post row EXISTED — `DataRouter.getPost`, a bare
 * `findUnique({ where: { id } })` with no tenant and no audience predicate — and
 * then returned the attached rows. Any authenticated caller could read the full
 * thread of a WHISPER post by id; the who-reacted endpoint required no session
 * at all.
 *
 * These assertions cannot be made in the unit lane, and that is not a stylistic
 * preference. `test/unit/comment-handler.test.ts` and the reaction-handler unit
 * tests mock Prisma so that `findMany` / `groupBy` resolve canned rows
 * REGARDLESS of the `where` they are handed. A mock-based test therefore passes
 * whether the predicate is right, wrong, or absent — it cannot distinguish
 * "authorized" from "not asked". Only a real Postgres evaluating the real
 * clause decides whether a row comes back.
 *
 * Drives the REAL handlers (CommentHandler.getComments,
 * ReactionHandler.getPostSentiments, ReactionHandler.getPostSentimentUsers)
 * against real Postgres, so removing the `canReadPost` call from any one of
 * them fails a test here.
 *
 * Every deny assertion is paired with a grant assertion on the same endpoint
 * (non-vacuity): without that, the suite would pass just as happily if the
 * endpoint returned nothing to anyone.
 *
 * Runs in the setup-free integration-ci lane (real DATABASE_URL, no
 * test/setup.ts). Same bootstrap as post-read-isolation.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommentHandler } from "../../src/lib/comment-handler.js";
import { ReactionHandler } from "../../src/lib/reaction-handler.js";
import type { Env } from "../../src/env.js";

// Hyperdrive guard: safe even under the broad integration config, whose
// test/setup.ts forces a fake hyperdrive URL.
const ENV_DB_URL = process.env.DATABASE_URL;
const TEST_DB_URL =
  ENV_DB_URL !== undefined && !ENV_DB_URL.includes("hyperdrive")
    ? ENV_DB_URL
    : "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const RUN = `h3-attach-authz-${Date.now()}`;
const TENANT_A = `tenant-a-${RUN}`;
const TENANT_B = `tenant-b-${RUN}`;

const uuid = (n: number) =>
  `41111111-2222-4333-8444-${String(n).padStart(12, "0")}`;
/** Writes the posts. Always in their own audience. */
const AUTHOR = uuid(1);
/** Mutual, close (tier 0 both ways) with AUTHOR — in the NORMAL audience. */
const FRIEND = uuid(2);
/** Same tenant, no edge at all. The attacker in this story. */
const STRANGER = uuid(3);
/** Reacts to the posts, so the who-reacted list is non-empty. */
const REACTOR = uuid(4);

let prisma: PrismaClient;
let env: Env;
const comments = new CommentHandler();
const reactions = new ReactionHandler();

const requestContext = { region: "US", requestId: `req-${RUN}` } as never;

function sessionFor(userId: string) {
  return {
    userId,
    email: `${userId}@test.example.com`,
    role: "END_USER",
    expiresAt: Date.now() + 3_600_000,
  } as never;
}

function req(path: string): Request {
  return new Request(`https://api.test.example.com${path}`);
}

async function makeUser(id: string, personalTenantId: string) {
  await prisma.tenant.create({
    data: {
      id: personalTenantId,
      slug: personalTenantId,
      displayName: personalTenantId,
      type: "PERSONAL",
    },
  });
  await prisma.user.create({
    data: {
      id,
      email: `${id}@test.example.com`,
      handle: `h-${id.slice(-8)}-${RUN.slice(-6)}`,
      personalTenantId,
      dataRegion: "US",
    },
  });
}

async function makePost(
  tag: string,
  radius: "SHOUT" | "NORMAL" | "WHISPER",
  tenantId = TENANT_A,
): Promise<string> {
  const id = `${RUN}-${tag}`;
  await prisma.post.create({
    data: { id, text: `post ${tag}`, authorId: AUTHOR, tenantId, radius, dataRegion: "US" },
  });
  // One comment and one reaction on every post, so a leak has something to leak
  // and a grant has something to return.
  await prisma.postComment.create({
    data: {
      id: `${id}-c`,
      postId: id,
      tenantId,
      authorId: REACTOR,
      text: `secret comment on ${tag}`,
    },
  });
  await prisma.postSentiment.create({
    data: { postId: id, tenantId, authorId: REACTOR, sentiment: "joy" },
  });
  return id;
}

// ---------------------------------------------------------------------------
// Endpoint drivers — the real handler methods, nothing re-implemented.
// ---------------------------------------------------------------------------

function getComments(postId: string, viewer: string, tenantId: string) {
  return comments.getComments(
    postId,
    req(`/api/posts/${postId}/comments`),
    sessionFor(viewer),
    { limit: 20 },
    env as never,
    requestContext,
    tenantId,
  );
}

function getSentiments(postId: string, viewer: string, tenantId: string) {
  return reactions.getPostSentiments(
    postId,
    sessionFor(viewer),
    env as never,
    requestContext,
    tenantId,
  );
}

function getSentimentUsers(postId: string, viewer: string, tenantId: string) {
  return reactions.getPostSentimentUsers(
    postId,
    "joy",
    20,
    null,
    sessionFor(viewer),
    env as never,
    requestContext,
    tenantId,
  );
}

/** The full response as a comparable value — status, content-type, body text. */
async function shapeOf(response: Response) {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

let whisperPost: string;
let normalPost: string;
let shoutPost: string;
let foreignPost: string;

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
  });
  await prisma.$connect();

  for (const id of [TENANT_A, TENANT_B]) {
    await prisma.tenant.create({
      data: { id, slug: id, displayName: id, type: "ORGANIZATION" },
    });
  }

  await makeUser(AUTHOR, `${RUN}-pt-author`);
  await makeUser(FRIEND, `${RUN}-pt-friend`);
  await makeUser(STRANGER, `${RUN}-pt-stranger`);
  await makeUser(REACTOR, `${RUN}-pt-reactor`);

  // AUTHOR placed FRIEND in an inner circle, and FRIEND connected back. Both
  // halves matter: `getFriendUserIds` reads the AUTHOR's edge (targetId = the
  // viewer) and requires `reciprocated`.
  await prisma.relationship.createMany({
    data: [
      {
        tenantId: TENANT_A,
        userId: AUTHOR,
        targetType: "user",
        targetId: FRIEND,
        tier: 0,
        reciprocated: true,
        connectionMethod: "code",
      },
      {
        tenantId: TENANT_A,
        userId: FRIEND,
        targetType: "user",
        targetId: AUTHOR,
        tier: 0,
        reciprocated: true,
        connectionMethod: "code",
      },
    ],
  });

  env = {
    DATABASE_URL: TEST_DB_URL,
    DEFAULT_REGION: "US",
    ENVIRONMENT: "test",
    SESSION_SECRET: "integration-test-secret-32-chars!!",
    APP_DOMAIN: "https://api.test.example.com",
  } as Env;

  whisperPost = await makePost("whisper", "WHISPER");
  normalPost = await makePost("normal", "NORMAL");
  shoutPost = await makePost("shout", "SHOUT");
  foreignPost = await makePost("foreign-shout", "SHOUT", TENANT_B);
});

afterAll(async () => {
  await prisma.postSentiment.deleteMany({
    where: { postId: { startsWith: RUN } },
  });
  await prisma.postComment.deleteMany({ where: { postId: { startsWith: RUN } } });
  await prisma.post.deleteMany({ where: { id: { startsWith: RUN } } });
  await prisma.relationship.deleteMany({
    where: { tenantId: { in: [TENANT_A, TENANT_B] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [AUTHOR, FRIEND, STRANGER, REACTOR] } },
  });
  await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  await prisma.tenant.deleteMany({ where: { id: { startsWith: `${RUN}-pt-` } } });
  await prisma.$disconnect();
});

// ===========================================================================
// GET /api/posts/:id/comments
// ===========================================================================

describe("comment thread is audience-gated (H3)", () => {
  it("REFUSES a same-tenant stranger the thread of a WHISPER post", async () => {
    const res = await getComments(whisperPost, STRANGER, TENANT_A);

    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toBe(JSON.stringify({ error: "Post not found" }));
    // The leak, spelled out: neither the comment text nor its author id.
    expect(body).not.toContain("secret comment");
    expect(body).not.toContain(REACTOR);
  });

  it("still returns the thread to the author (non-vacuity)", async () => {
    const res = await getComments(whisperPost, AUTHOR, TENANT_A);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: Array<{ text: string }> };
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].text).toBe("secret comment on whisper");
  });

  it("still returns the thread to a genuinely in-audience friend (non-vacuity)", async () => {
    const res = await getComments(normalPost, FRIEND, TENANT_A);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: Array<{ text: string }> };
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].text).toBe("secret comment on normal");
  });

  it("REFUSES a stranger a NORMAL (friends-only) post's thread", async () => {
    const res = await getComments(normalPost, STRANGER, TENANT_A);
    expect(res.status).toBe(404);
  });

  it("REFUSES a friend a WHISPER post's thread — WHISPER admits nobody but the author", async () => {
    const res = await getComments(whisperPost, FRIEND, TENANT_A);
    expect(res.status).toBe(404);
  });

  it("serves a SHOUT post's thread to a stranger (non-vacuity: the gate is not a blanket deny)", async () => {
    const res = await getComments(shoutPost, STRANGER, TENANT_A);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: unknown[] };
    expect(body.comments).toHaveLength(1);
  });

  it("REFUSES a cross-tenant caller, even the author, even on a public post", async () => {
    // SHOUT is the widest audience there is: if anything crosses the tenant
    // boundary it is this row. The author reads as TENANT_A; the post lives in
    // TENANT_B.
    const res = await getComments(foreignPost, AUTHOR, TENANT_A);
    expect(res.status).toBe(404);

    // Non-vacuity: the same call scoped to the post's own tenant succeeds, so
    // the refusal above is the tenant predicate and not some unrelated reason.
    const scoped = await getComments(foreignPost, AUTHOR, TENANT_B);
    expect(scoped.status).toBe(200);
  });

  it("refuses an absent post and a forbidden post IDENTICALLY", async () => {
    const absent = await shapeOf(
      await getComments(`${RUN}-no-such-post`, STRANGER, TENANT_A),
    );
    const forbidden = await shapeOf(
      await getComments(whisperPost, STRANGER, TENANT_A),
    );

    // A distinguishable refusal is an existence oracle for private post ids.
    expect(forbidden).toEqual(absent);
  });
});

// ===========================================================================
// GET /api/posts/:id/sentiments
// ===========================================================================

describe("sentiment counts are audience-gated (H3)", () => {
  it("REFUSES a same-tenant stranger the counts on a WHISPER post", async () => {
    const res = await getSentiments(whisperPost, STRANGER, TENANT_A);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe(JSON.stringify({ error: "Post not found" }));
  });

  it("still returns counts to the author (non-vacuity)", async () => {
    const res = await getSentiments(whisperPost, AUTHOR, TENANT_A);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sentimentCounts: Record<string, number>;
    };
    expect(body.sentimentCounts.joy).toBe(1);
  });

  it("still returns counts to an in-audience friend (non-vacuity)", async () => {
    const res = await getSentiments(normalPost, FRIEND, TENANT_A);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sentimentCounts: Record<string, number>;
    };
    expect(body.sentimentCounts.joy).toBe(1);
  });

  it("REFUSES a stranger a NORMAL post's counts", async () => {
    const res = await getSentiments(normalPost, STRANGER, TENANT_A);
    expect(res.status).toBe(404);
  });

  it("REFUSES a cross-tenant caller", async () => {
    expect((await getSentiments(foreignPost, AUTHOR, TENANT_A)).status).toBe(404);
    expect((await getSentiments(foreignPost, AUTHOR, TENANT_B)).status).toBe(200);
  });

  it("does not let a shared cache store the gated body", async () => {
    // The response carries per-viewer `userSentiment` and is now audience-gated;
    // `public, max-age=30` would hand it to callers the gate refused.
    const res = await getSentiments(shoutPost, STRANGER, TENANT_A);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses an absent post and a forbidden post IDENTICALLY", async () => {
    const absent = await shapeOf(
      await getSentiments(`${RUN}-no-such-post`, STRANGER, TENANT_A),
    );
    const forbidden = await shapeOf(
      await getSentiments(whisperPost, STRANGER, TENANT_A),
    );

    expect(forbidden).toEqual(absent);
  });
});

// ===========================================================================
// GET /api/v1/posts/:id/sentiments/users  — the who-reacted list
// ===========================================================================

describe("the who-reacted list is audience-gated (H3)", () => {
  it("REFUSES a same-tenant stranger the reader list of a WHISPER post", async () => {
    const res = await getSentimentUsers(whisperPost, STRANGER, TENANT_A);

    expect(res.status).toBe(404);
    // The disclosure this endpoint makes is IDENTITIES, so assert the identity
    // is absent, not merely that the status is 404.
    expect(await res.text()).not.toContain(REACTOR);
  });

  it("still returns the reader list to the author (non-vacuity)", async () => {
    const res = await getSentimentUsers(whisperPost, AUTHOR, TENANT_A);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain(REACTOR);
  });

  it("still returns the reader list to an in-audience friend (non-vacuity)", async () => {
    const res = await getSentimentUsers(normalPost, FRIEND, TENANT_A);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain(REACTOR);
  });

  it("REFUSES a stranger a NORMAL post's reader list", async () => {
    const res = await getSentimentUsers(normalPost, STRANGER, TENANT_A);
    expect(res.status).toBe(404);
  });

  it("REFUSES a cross-tenant caller", async () => {
    expect((await getSentimentUsers(foreignPost, AUTHOR, TENANT_A)).status).toBe(404);
    expect((await getSentimentUsers(foreignPost, AUTHOR, TENANT_B)).status).toBe(200);
  });

  it("refuses an absent post and a forbidden post IDENTICALLY (modulo the per-request traceId)", async () => {
    const absentId = `${RUN}-no-such-post`;
    const absent = await shapeOf(
      await getSentimentUsers(absentId, STRANGER, TENANT_A),
    );
    const forbidden = await shapeOf(
      await getSentimentUsers(whisperPost, STRANGER, TENANT_A),
    );

    expect(forbidden.status).toBe(absent.status);
    expect(forbidden.contentType).toBe(absent.contentType);

    // `traceId` is a fresh id on every request and `instance`/`detail` echo the
    // requested id, so compare the two bodies with those substituted out: what
    // must not differ is anything DERIVED from whether the post exists.
    const normalise = (body: string, postId: string) =>
      JSON.parse(body.split(postId).join("<id>")) as Record<string, unknown>;
    const a = normalise(absent.body, absentId);
    const f = normalise(forbidden.body, whisperPost);
    delete a.traceId;
    delete f.traceId;
    expect(f).toEqual(a);
  });
});
