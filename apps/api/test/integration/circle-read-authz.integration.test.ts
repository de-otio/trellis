/**
 * Integration (H1): the circle read paths must decide audience from the
 * AUTHOR's edge, require reciprocation, and carry an explicit tenant.
 *
 * `lib/graph/postgres/circles.ts` decided post visibility from inputs the READER
 * controls. Every circle query joined the viewer's own relationship row
 * (`WHERE r.user_id = <viewer>`), banded it on
 * `COALESCE(manual_score, computed_score)` — which the reader writes on their own
 * edge through `PATCH /api/relationships/score` — and then gated the post's
 * radius against the requested tier, where tier 0 admits WHISPER. The bands
 * themselves came from the READER's `CircleConfig`. No clause required
 * reciprocation, and the tenant predicate was an ambient lookup that resolved to
 * nothing under the default `TENANT_SCOPE_MODE=off`.
 *
 * So: add a stranger (no consent needed), PATCH your own score to 1.0, and
 * `GET /api/circles/depth?targetType=user&targetId=<stranger>` returned their
 * WHISPER post ids, unfiltered by tenant.
 *
 * WHY THIS CANNOT BE A UNIT TEST. Two independent reasons, both fatal:
 *   1. `test/unit/graph/postgres/circles.test.ts` mocks `$queryRaw` to resolve
 *      canned rows regardless of the SQL handed to it. It asserts the shape of
 *      the returned objects, never which rows Postgres would actually produce —
 *      it passes identically whether the predicate is right, wrong, or absent.
 *   2. This is raw SQL. There is no Prisma `where` object to inspect; the
 *      predicate exists only as a `Prisma.sql` template. Only a real Postgres
 *      evaluating it decides whether a row comes back.
 *
 * Every deny assertion is paired with a grant on the same query (non-vacuity):
 * without that, the suite passes just as happily if the query returns nothing to
 * anyone. The cross-tenant denial is paired with a SAME-tenant control on the
 * identical row, so it cannot pass because of the audience predicate alone.
 *
 * Runs in the setup-free integration-ci lane (real DATABASE_URL, no
 * test/setup.ts). Same bootstrap as post-read-isolation.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CircleHandler } from "../../src/lib/circle-handler.js";
import { CircleOps } from "../../src/lib/graph/postgres/circles.js";
import type { Env } from "../../src/env.js";

// Hyperdrive guard: safe even under the broad integration config, whose
// test/setup.ts forces a fake hyperdrive URL.
const ENV_DB_URL = process.env.DATABASE_URL;
const TEST_DB_URL =
  ENV_DB_URL !== undefined && !ENV_DB_URL.includes("hyperdrive")
    ? ENV_DB_URL
    : "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const RUN = `h1-circle-authz-${Date.now()}`;
const TENANT_A = `tenant-a-${RUN}`;
const TENANT_B = `tenant-b-${RUN}`;

const uuid = (n: number) =>
  `51111111-2222-4333-8444-${String(n).padStart(12, "0")}`;

/** The attacker. Adds edges unilaterally and sets his own score to 1.0. */
const ATTACKER = uuid(1);
/** Has no edge to ATTACKER at all. Writes the posts being hunted. */
const STRANGER = uuid(2);
/** Placed ATTACKER at tier 0 AND has a reverse edge — the grant case. */
const CLOSE_AUTHOR = uuid(3);
/** Placed ATTACKER at tier 0 but there is NO reverse edge — the deny case. */
const ONEWAY_AUTHOR = uuid(4);
/** Placed ATTACKER at tier 0, reciprocated, but posts in TENANT_B. */
const FOREIGN_AUTHOR = uuid(5);
/**
 * The residual attack that survives requiring `reciprocated` on its own: a
 * plain follow-back exists in both directions, so the flag is true on BOTH
 * rows, but this author filed ATTACKER at tier 3 (ambient) — while ATTACKER
 * self-scored them to tier 0. Only reading the AUTHOR's tier excludes them.
 */
const DISTANT_AUTHOR = uuid(6);

const ENTITY = `${RUN}-entity`;

const SINCE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const PAGE = { limit: 50 };

let prisma: PrismaClient;
let ops: CircleOps;

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
  authorId: string,
  radius: "SHOUT" | "LOUD" | "NORMAL" | "WHISPER",
  opts: { tenantId?: string; subjectEntity?: boolean } = {},
): Promise<string> {
  const id = `${RUN}-${tag}`;
  await prisma.post.create({
    data: {
      id,
      text: `post ${tag}`,
      authorId,
      tenantId: opts.tenantId ?? TENANT_A,
      radius,
      dataRegion: "US",
      // `since` is 30d back and `getCircleStatus` floors its window at 7d, so
      // pin creation to "now" and let each query's own window include it.
      createdAt: new Date(),
    },
  });
  if (opts.subjectEntity) {
    await prisma.postSubject.create({ data: { postId: id, entityId: ENTITY } });
  }
  return id;
}

function edge(
  userId: string,
  targetId: string,
  tier: number,
  reciprocated: boolean,
  opts: { tenantId?: string; targetType?: string; manualScore?: number } = {},
) {
  return {
    tenantId: opts.tenantId ?? TENANT_A,
    userId,
    targetType: opts.targetType ?? "user",
    targetId,
    tier,
    manualScore: opts.manualScore ?? null,
    computedScore: 0,
    reciprocated,
    connectionMethod: "discovery",
  };
}

// ---------------------------------------------------------------------------
// Query drivers — the REAL CircleOps methods, nothing re-implemented here.
// A re-implementation would drift from the code under test and prove nothing.
// ---------------------------------------------------------------------------

async function feedIds(viewer: string, tier: 0 | 1 | 2 | 3, tenantId: string) {
  const page = await ops.getVisiblePostIds(viewer, tier, SINCE, PAGE, tenantId);
  return page.items.map((i) => i.postId).sort();
}

function depthUserIds(viewer: string, target: string, tenantId: string) {
  return ops
    .getDepthPostIds(viewer, "user", target, SINCE, 50, tenantId)
    .then((ids) => ids.sort());
}

function depthEntityIds(viewer: string, tenantId: string) {
  return ops
    .getDepthPostIds(viewer, "entity", ENTITY, SINCE, 50, tenantId)
    .then((ids) => ids.sort());
}

async function glanceIds(viewer: string, tier: 0 | 1 | 2 | 3, tenantId: string) {
  const items = await ops.getGlanceItems(viewer, tier, 50, tenantId);
  return items.map((i) => i.postId).sort();
}

async function unseenAtTier(viewer: string, tier: 0 | 1 | 2 | 3, tenantId: string) {
  const tiers = await ops.getCircleStatus(viewer, tenantId);
  return tiers.find((t) => t.tier === tier)!.unseenCount;
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
  });
  await prisma.$connect();
  ops = new CircleOps(prisma);

  for (const id of [TENANT_A, TENANT_B]) {
    await prisma.tenant.create({
      data: { id, slug: id, displayName: id, type: "ORGANIZATION" },
    });
  }

  await makeUser(ATTACKER, `${RUN}-pt-attacker`);
  await makeUser(STRANGER, `${RUN}-pt-stranger`);
  await makeUser(CLOSE_AUTHOR, `${RUN}-pt-close`);
  await makeUser(ONEWAY_AUTHOR, `${RUN}-pt-oneway`);
  await makeUser(FOREIGN_AUTHOR, `${RUN}-pt-foreign`);
  await makeUser(DISTANT_AUTHOR, `${RUN}-pt-distant`);

  await prisma.entity.create({
    data: {
      id: ENTITY,
      tenantId: TENANT_A,
      name: `entity ${RUN}`,
      entityType: "dog",
    },
  });

  await prisma.relationship.createMany({
    data: [
      // THE ATTACK, exactly as the API produces it: one POST /api/relationships
      // (no consent from STRANGER, who has no edge back at all) plus one
      // PATCH /api/relationships/score { manualScore: 1.0 } → tier 0.
      edge(ATTACKER, STRANGER, 0, false, { manualScore: 1.0 }),
      // Same move against the ENTITY, which is how the entity-subject branch and
      // the entity depth view were reached.
      edge(ATTACKER, ENTITY, 0, false, {
        targetType: "entity",
        manualScore: 1.0,
      }),

      // GRANT: the author placed ATTACKER at tier 0 and a reverse edge exists.
      edge(CLOSE_AUTHOR, ATTACKER, 0, true),
      edge(ATTACKER, CLOSE_AUTHOR, 3, true),

      // DENY: the author placed ATTACKER at tier 0 but nobody reciprocated.
      // Identical to the grant case in every respect except the reverse edge.
      edge(ONEWAY_AUTHOR, ATTACKER, 0, false),

      // RECIPROCATED BUT DISTANT: the shape that defeats a `reciprocated`-only
      // fix. Both rows carry the flag; the author's tier is 3 and the reader's
      // self-set tier is 0. Under the old direction the reader's 0 was the tier
      // being read, so tier 0 (which admits WHISPER) matched.
      edge(DISTANT_AUTHOR, ATTACKER, 3, true),
      edge(ATTACKER, DISTANT_AUTHOR, 0, true, { manualScore: 1.0 }),

      // CROSS-TENANT: identical to the grant case, in TENANT_B.
      edge(FOREIGN_AUTHOR, ATTACKER, 0, true, { tenantId: TENANT_B }),
      edge(ATTACKER, FOREIGN_AUTHOR, 3, true, { tenantId: TENANT_B }),
    ],
  });

  // The reader's own tier boundaries were an input to the old decision too.
  // Push them to the floor so every edge lands in tier 0's band: if any query
  // still reads CircleConfig to decide access, this makes it maximally wrong.
  await prisma.circleConfig.create({
    data: {
      userId: ATTACKER,
      innerThreshold: 0.0,
      closeFriendThreshold: 0.0,
      communityThreshold: 0.0,
    },
  });
});

afterAll(async () => {
  await prisma.postSubject.deleteMany({
    where: { postId: { startsWith: RUN } },
  });
  await prisma.post.deleteMany({ where: { id: { startsWith: RUN } } });
  await prisma.relationship.deleteMany({
    where: { tenantId: { in: [TENANT_A, TENANT_B] } },
  });
  await prisma.circleConfig.deleteMany({ where: { userId: ATTACKER } });
  await prisma.entity.deleteMany({ where: { id: ENTITY } });
  await prisma.user.deleteMany({
    where: {
      id: {
        in: [
          ATTACKER,
          STRANGER,
          CLOSE_AUTHOR,
          ONEWAY_AUTHOR,
          FOREIGN_AUTHOR,
          DISTANT_AUTHOR,
        ],
      },
    },
  });
  await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  await prisma.tenant.deleteMany({ where: { id: { startsWith: `${RUN}-pt-` } } });
  await prisma.$disconnect();
});

describe("H1 — a self-set score must not decide someone else's audience", () => {
  it("does not return a stranger's WHISPER posts to a viewer who scored themselves close", async () => {
    const target = await makePost("stranger-whisper", STRANGER, "WHISPER");
    const granted = await makePost("close-whisper", CLOSE_AUTHOR, "WHISPER");

    // The direct attack: depth mode on the stranger the attacker "connected" to.
    const depth = await depthUserIds(ATTACKER, STRANGER, TENANT_A);
    expect(depth).not.toContain(target);

    // The sweep: tier 0 admits radiusInt >= 0, i.e. WHISPER.
    const feed = await feedIds(ATTACKER, 0, TENANT_A);
    expect(feed).not.toContain(target);

    // Glance and the unseen badge are the same disclosure by another route.
    expect(await glanceIds(ATTACKER, 0, TENANT_A)).not.toContain(target);

    // NON-VACUITY, on the same three queries: an author who really did place
    // this viewer at tier 0, reciprocated, IS visible. Without this the suite
    // passes if the queries return nothing to anyone.
    expect(await depthUserIds(ATTACKER, CLOSE_AUTHOR, TENANT_A)).toContain(
      granted,
    );
    expect(await feedIds(ATTACKER, 0, TENANT_A)).toContain(granted);
    expect(await glanceIds(ATTACKER, 0, TENANT_A)).toContain(granted);
  });

  it("counts the granted post and not the stranger's in the unseen badge", async () => {
    // getCircleStatus is a separate query pair from the feed and leaks the same
    // fact — that a WHISPER post exists — as a number.
    const unseen = await unseenAtTier(ATTACKER, 0, TENANT_A);

    // CLOSE_AUTHOR's WHISPER is countable; STRANGER's is not. Two posts exist at
    // this point and exactly one of them is in this viewer's audience.
    expect(unseen).toBe(1);
  });

  it("does not surface a stranger's WHISPER post through an entity the viewer follows", async () => {
    const target = await makePost("stranger-entity-whisper", STRANGER, "WHISPER", {
      subjectEntity: true,
    });
    const granted = await makePost("close-entity-whisper", CLOSE_AUTHOR, "WHISPER", {
      subjectEntity: true,
    });

    // The entity branch had the same inversion: the viewer's self-set score on
    // an ENTITY set the radius gate for every author who tagged it.
    const depth = await depthEntityIds(ATTACKER, TENANT_A);
    expect(depth).not.toContain(target);
    // Non-vacuity on the identical query: same entity, same radius, same tier —
    // the only difference is who the AUTHOR placed close.
    expect(depth).toContain(granted);

    const feed = await feedIds(ATTACKER, 0, TENANT_A);
    expect(feed).not.toContain(target);
    expect(feed).toContain(granted);
  });

  it("does not return the WHISPER posts of an author who reciprocated but filed the viewer far away", async () => {
    // THE CENTRAL CASE. `reciprocated` is true on both rows here, so requiring
    // that flag alone changes nothing — this is the shape that survived the V1
    // fix on the post read paths and is why the direction has to flip. The
    // attacker self-scored to tier 0 (manualScore 1.0), which is exactly what
    // `PATCH /api/relationships/score` permits on one's own edge.
    const target = await makePost("distant-whisper", DISTANT_AUTHOR, "WHISPER");
    const granted = await makePost("close-whisper-3", CLOSE_AUTHOR, "WHISPER");

    expect(await feedIds(ATTACKER, 0, TENANT_A)).not.toContain(target);
    expect(await depthUserIds(ATTACKER, DISTANT_AUTHOR, TENANT_A)).not.toContain(
      target,
    );
    expect(await glanceIds(ATTACKER, 0, TENANT_A)).not.toContain(target);

    // Non-vacuity on the same three queries.
    expect(await feedIds(ATTACKER, 0, TENANT_A)).toContain(granted);
    expect(await glanceIds(ATTACKER, 0, TENANT_A)).toContain(granted);
  });

  it("proves the reciprocated-but-distant fixture is close on the READER's side", async () => {
    // Non-vacuity for the clause above: the exclusion must come from reading the
    // author's tier, not from the reader's edge being distant or unreciprocated.
    const readerSide = await prisma.relationship.findFirst({
      where: { userId: ATTACKER, targetId: DISTANT_AUTHOR },
      select: { tier: true, reciprocated: true, manualScore: true },
    });
    expect(readerSide).toMatchObject({
      tier: 0,
      reciprocated: true,
      manualScore: 1,
    });
    const authorSide = await prisma.relationship.findFirst({
      where: { userId: DISTANT_AUTHOR, targetId: ATTACKER },
      select: { tier: true, reciprocated: true },
    });
    expect(authorSide).toMatchObject({ tier: 3, reciprocated: true });
  });

  it("still serves public (SHOUT) posts from a stranger", async () => {
    // The fix must not turn into "deny everything": SHOUT is the public band and
    // `buildPostAudienceFilter` admits it from anyone. A suite that only asserts
    // denials would happily accept a query that returns nothing.
    const shout = await makePost("stranger-shout", STRANGER, "SHOUT");
    expect(await depthUserIds(ATTACKER, STRANGER, TENANT_A)).toContain(shout);
  });
});

describe("H1 — reciprocation is required, not optional", () => {
  it("does not return posts from an author who placed the viewer close with no edge back", async () => {
    const oneway = await makePost("oneway-whisper", ONEWAY_AUTHOR, "WHISPER");
    const granted = await makePost("close-whisper-2", CLOSE_AUTHOR, "WHISPER");

    const feed = await feedIds(ATTACKER, 0, TENANT_A);

    // ONEWAY_AUTHOR's edge is tier 0 — identical to CLOSE_AUTHOR's — and differs
    // only in `reciprocated`. So this pair isolates that one clause.
    expect(feed).not.toContain(oneway);
    expect(feed).toContain(granted);

    // Same isolation on the entity-subject path, which uses the EXISTS form of
    // the predicate rather than the inverted join.
    const onewayEntity = await makePost(
      "oneway-entity-whisper",
      ONEWAY_AUTHOR,
      "WHISPER",
      { subjectEntity: true },
    );
    const depth = await depthEntityIds(ATTACKER, TENANT_A);
    expect(depth).not.toContain(onewayEntity);
    expect(depth).toContain(`${RUN}-close-entity-whisper`);
  });

  it("proves the one-way fixture really is tier 0 on the author's side", async () => {
    // Non-vacuity for the clause above: the exclusion must come from
    // `reciprocated`, not from the author having filed the viewer far away.
    const row = await prisma.relationship.findFirst({
      where: { userId: ONEWAY_AUTHOR, targetId: ATTACKER },
      select: { tier: true, reciprocated: true },
    });
    expect(row).toMatchObject({ tier: 0, reciprocated: false });
  });
});

describe("H1 — the tenant predicate is explicit, and it is the tenant that denies", () => {
  it("does not return a foreign-tenant post even from a close, reciprocated author", async () => {
    const foreign = await makePost("foreign-whisper", FOREIGN_AUTHOR, "WHISPER", {
      tenantId: TENANT_B,
    });

    const feedInA = await feedIds(ATTACKER, 0, TENANT_A);
    expect(feedInA).not.toContain(foreign);
    expect(await depthUserIds(ATTACKER, FOREIGN_AUTHOR, TENANT_A)).not.toContain(
      foreign,
    );
  });

  it("returns that same post when the viewer reads as the tenant that owns it", async () => {
    // THE CONTROL. Without it, the assertion above passes for the wrong reason:
    // the audience predicate alone could be excluding the row. Reading the
    // IDENTICAL row as TENANT_B proves the denial above was the tenant clause.
    const feedInB = await feedIds(ATTACKER, 0, TENANT_B);
    expect(feedInB).toContain(`${RUN}-foreign-whisper`);
  });

  it("refuses to query at all when no tenant is supplied", async () => {
    // An empty tenant must NOT mean "no tenant filter". The predecessor built
    // `Prisma.empty` here and returned every tenant's rows with no error.
    await expect(
      ops.getVisiblePostIds(ATTACKER, 0, SINCE, PAGE, ""),
    ).rejects.toThrow(/activeTenantId is required/);
    await expect(
      ops.getDepthPostIds(ATTACKER, "user", STRANGER, SINCE, 50, ""),
    ).rejects.toThrow(/activeTenantId is required/);
    await expect(ops.getGlanceItems(ATTACKER, 0, 50, "")).rejects.toThrow(
      /activeTenantId is required/,
    );
    await expect(ops.getCircleStatus(ATTACKER, "")).rejects.toThrow(
      /activeTenantId is required/,
    );
    await expect(ops.getCircleEntityStatus(ATTACKER, 0, "")).rejects.toThrow(
      /activeTenantId is required/,
    );
    await expect(ops.getCircleMembers(ATTACKER, 0, "")).rejects.toThrow(
      /activeTenantId is required/,
    );
  });

  it("refuses a tenant-less caller at the handler boundary, without touching the graph", async () => {
    // The handler guard runs before `createGraphServiceFromEnv`, so a deliberately
    // empty Env is enough — reaching the graph at all would throw something else.
    const handler = new CircleHandler();
    const request = new Request(
      "https://api.test.example.com/api/circles/depth?targetType=user&targetId=" +
        STRANGER,
    );
    const session = { userId: ATTACKER, expiresAt: Date.now() + 3_600_000 };

    const response = await handler.handleGetDepth(
      request,
      session as never,
      {} as Env,
      {} as never,
      "",
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("FORBIDDEN");
  });
});
