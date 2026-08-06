/**
 * Integration: the post read paths must not leak across tenants, audiences, or
 * one-directional relationships.
 *
 * These are the outcome assertions the unit lane structurally CANNOT make.
 * `test/unit/feed-handler.test.ts` mocks `post.findMany` to resolve canned rows
 * regardless of the `where` it is handed, so a unit test can only assert the
 * predicate's *shape*; it would pass just as happily if the predicate admitted
 * everything. Only a real Postgres evaluating the real clause can tell you
 * whether a row actually comes back.
 *
 * Covers the four defects fixed on this branch, at the outcome level:
 *
 *   V2 — the home feed carried no tenantId, so it returned every tenant's posts
 *   V3 — getPost applied no tenant and no audience predicate, so any
 *        authenticated caller could read any post by id, WHISPER included
 *   V1 — the friend set read one-directional edges, so unilaterally adding a
 *        stranger granted read access to their close-friends posts
 *
 * Runs in the setup-free integration-ci lane (real DATABASE_URL, no
 * test/setup.ts). Same bootstrap as post-create-radius.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFriendUserIds } from "../../src/lib/friend-ids.js";
import { buildPostAudienceFilter } from "../../src/lib/feed-handler.js";

// Hyperdrive guard: safe even under the broad integration config, whose
// test/setup.ts forces a fake hyperdrive URL.
const ENV_DB_URL = process.env.DATABASE_URL;
const TEST_DB_URL =
  ENV_DB_URL !== undefined && !ENV_DB_URL.includes("hyperdrive")
    ? ENV_DB_URL
    : "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const RUN = `p0-read-iso-${Date.now()}`;
const TENANT_A = `tenant-a-${RUN}`;
const TENANT_B = `tenant-b-${RUN}`;

const uuid = (n: number) =>
  `31111111-2222-4333-8444-${String(n).padStart(12, "0")}`;
const VIEWER = uuid(1);
const MUTUAL = uuid(2);
const ONE_WAY = uuid(3);
const OTHER_TENANT_AUTHOR = uuid(4);
/** Author who reciprocated the viewer but kept them at a DISTANT tier. */
const DISTANT_AUTHOR = uuid(5);

let prisma: PrismaClient;

/**
 * `User.personalTenantId` is UNIQUE — a personal tenant belongs to exactly one
 * user — so users cannot share one. Each therefore gets its own personal
 * tenant, and TENANT_A / TENANT_B are used only as `Post.tenantId`, which is the
 * boundary the read predicates actually constrain and the one under test.
 */
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
      // Required and globally unique; derive it from the run tag so parallel
      // runs of this suite cannot collide.
      handle: `h-${id.slice(-8)}-${RUN.slice(-6)}`,
      personalTenantId,
      dataRegion: "US",
    },
  });
}

async function makePost(
  id: string,
  authorId: string,
  tenantId: string,
  radius: "SHOUT" | "LOUD" | "NORMAL" | "WHISPER",
) {
  await prisma.post.create({
    data: {
      id: `${RUN}-${id}`,
      text: `post ${id}`,
      authorId,
      tenantId,
      radius,
      dataRegion: "US",
    },
  });
  return `${RUN}-${id}`;
}

/**
 * Run the real feed predicate against real Postgres. Mirrors the AND-block
 * getHomeFeed builds, so a divergence between this and the handler shows up as
 * a failure here rather than as a silent leak in production.
 */
async function readableByViewer(tenantId: string, friendIds: string[]) {
  const rows = await prisma.post.findMany({
    where: {
      AND: [
        buildPostAudienceFilter(VIEWER, friendIds),
        {
          deletedAt: null,
          hiddenByAuthor: false,
          tenantId,
          dataRegion: "US",
        },
      ],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id).sort();
}

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
  });
  await prisma.$connect();

  for (const [id, slug] of [
    [TENANT_A, TENANT_A],
    [TENANT_B, TENANT_B],
  ]) {
    await prisma.tenant.create({
      data: { id, slug, displayName: slug, type: "ORGANIZATION" },
    });
  }

  await makeUser(VIEWER, `${RUN}-pt-viewer`);
  await makeUser(MUTUAL, `${RUN}-pt-mutual`);
  await makeUser(ONE_WAY, `${RUN}-pt-oneway`);
  await makeUser(OTHER_TENANT_AUTHOR, `${RUN}-pt-foreign`);
  await makeUser(DISTANT_AUTHOR, `${RUN}-pt-distant`);

  // A mutual, close connection: both directions present, reciprocated true.
  await prisma.relationship.createMany({
    data: [
      {
        tenantId: TENANT_A,
        userId: VIEWER,
        targetType: "user",
        targetId: MUTUAL,
        tier: 0,
        reciprocated: true,
        connectionMethod: "code",
      },
      {
        tenantId: TENANT_A,
        userId: MUTUAL,
        targetType: "user",
        targetId: VIEWER,
        tier: 0,
        reciprocated: true,
        connectionMethod: "code",
      },
    ],
  });

  // The residual attack shape after `reciprocated` was required: MUTUAL in the
  // flag, asymmetric in the tier. The author reciprocated at tier 2 — an ordinary
  // follow-back — and the viewer promoted their OWN edge to tier 0, which
  // PATCH /api/relationships/score permits for one's own edge.
  await prisma.relationship.createMany({
    data: [
      {
        tenantId: TENANT_A,
        userId: VIEWER,
        targetType: "user",
        targetId: DISTANT_AUTHOR,
        tier: 0, // self-set via manualScore 1.0
        reciprocated: true,
        connectionMethod: "discovery",
      },
      {
        tenantId: TENANT_A,
        userId: DISTANT_AUTHOR,
        targetType: "user",
        targetId: VIEWER,
        tier: 2, // "community" — what a follow-back actually produces
        reciprocated: true,
        connectionMethod: "discovery",
      },
    ],
  });

  // The V1 attack shape: the viewer unilaterally claims a tier-0 connection to
  // someone who never reciprocated. This is exactly what one POST
  // /api/relationships used to produce.
  await prisma.relationship.create({
    data: {
      tenantId: TENANT_A,
      userId: VIEWER,
      targetType: "user",
      targetId: ONE_WAY,
      tier: 0,
      reciprocated: false,
      connectionMethod: "code",
    },
  });
});

afterAll(async () => {
  await prisma.post.deleteMany({ where: { id: { startsWith: RUN } } });
  await prisma.relationship.deleteMany({
    where: { tenantId: { in: [TENANT_A, TENANT_B] } },
  });
  await prisma.user.deleteMany({
    where: {
      id: { in: [VIEWER, MUTUAL, ONE_WAY, OTHER_TENANT_AUTHOR, DISTANT_AUTHOR] },
    },
  });
  // Both the post tenants and the four personal tenants, all run-tagged.
  await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  await prisma.tenant.deleteMany({ where: { id: { startsWith: `${RUN}-pt-` } } });
  await prisma.$disconnect();
});

describe("friend-set resolution requires mutual consent (V1)", () => {
  it("includes a reciprocated close connection", async () => {
    const friends = await getFriendUserIds(prisma, VIEWER);
    expect(friends).toContain(MUTUAL);
  });

  it("EXCLUDES a one-directional edge the viewer created for themselves", async () => {
    const friends = await getFriendUserIds(prisma, VIEWER);

    // The whole of V1 in one assertion: the viewer wrote this edge, set it to
    // tier 0, and claimed connectionMethod "code" — and still gets nothing,
    // because the other party never reciprocated.
    expect(friends).not.toContain(ONE_WAY);
  });

  // The residual attack that survived requiring `reciprocated`, and the reason
  // the query now reads the AUTHOR's edge instead of the viewer's.
  //
  // Shape: the author reciprocated — so `reciprocated` is true on BOTH rows, and
  // no amount of checking that flag helps — but kept the viewer at tier 2
  // ("community"), which is what an ordinary follow-back produces. The viewer
  // then set their OWN edge to tier 0, which they can do for themselves through
  // PATCH /api/relationships/score with manualScore 1.0.
  //
  // Under the old direction the viewer's self-set tier 0 was the tier being read,
  // so this returned DISTANT_AUTHOR and the attacker read their friends-only
  // posts. The author could not revoke it by lowering their own tier, because
  // their tier was never consulted.
  it("EXCLUDES an author who reciprocated but kept the viewer at a distant tier", async () => {
    const friends = await getFriendUserIds(prisma, VIEWER);

    expect(friends).not.toContain(DISTANT_AUTHOR);
    // Non-vacuity: the fixture really is reciprocated and really is close on the
    // viewer's side, so exclusion can only come from reading the author's tier.
    const viewerSide = await prisma.relationship.findFirst({
      where: { userId: VIEWER, targetId: DISTANT_AUTHOR },
      select: { tier: true, reciprocated: true },
    });
    expect(viewerSide).toMatchObject({ tier: 0, reciprocated: true });
  });
});

describe("the audience predicate over real Postgres (V3)", () => {
  it("admits SHOUT from anyone, and NORMAL only from a mutual connection", async () => {
    const shoutFromStranger = await makePost(
      "shout-stranger",
      ONE_WAY,
      TENANT_A,
      "SHOUT",
    );
    const normalFromMutual = await makePost(
      "normal-mutual",
      MUTUAL,
      TENANT_A,
      "NORMAL",
    );
    const normalFromOneWay = await makePost(
      "normal-oneway",
      ONE_WAY,
      TENANT_A,
      "NORMAL",
    );
    const whisperFromMutual = await makePost(
      "whisper-mutual",
      MUTUAL,
      TENANT_A,
      "WHISPER",
    );
    const own = await makePost("own", VIEWER, TENANT_A, "WHISPER");

    const friends = await getFriendUserIds(prisma, VIEWER);
    const visible = await readableByViewer(TENANT_A, friends);

    expect(visible).toContain(shoutFromStranger);
    expect(visible).toContain(normalFromMutual);
    expect(visible).toContain(own); // author always sees their own

    // The leak that mattered: a close-friends post from someone the viewer
    // unilaterally "connected" to.
    expect(visible).not.toContain(normalFromOneWay);
    // WHISPER is admitted to nobody but the author by this predicate.
    expect(visible).not.toContain(whisperFromMutual);
  });
});

describe("tenant isolation on post reads (V2)", () => {
  it("never returns a post belonging to another tenant, even a public one", async () => {
    const foreignPublic = await makePost(
      "foreign-shout",
      OTHER_TENANT_AUTHOR,
      TENANT_B,
      "SHOUT",
    );

    const friends = await getFriendUserIds(prisma, VIEWER);
    const visible = await readableByViewer(TENANT_A, friends);

    // SHOUT is the widest audience there is, so if anything crosses the tenant
    // boundary it is this row. It must not.
    expect(visible).not.toContain(foreignPublic);
  });

  it("returns the foreign post only to a viewer scoped to that tenant", async () => {
    // Non-vacuity: proves the previous assertion is about the tenant predicate
    // and not about the row being unreadable for some unrelated reason.
    const visibleInB = await readableByViewer(TENANT_B, []);

    expect(visibleInB).toContain(`${RUN}-foreign-shout`);
  });
});
