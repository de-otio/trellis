/**
 * Integration Tests: PostgresGraphService — CircleOps (dual-gated visibility)
 *
 * The dual-gated visibility query in getVisiblePostIds is a PRIVACY CONTROL and
 * its correctness can only be verified against a real Postgres — the SQL (the
 * radius→tier mapping, the entity-subject ∪ author UNION, and the MIN-tier
 * resolution for multi-entity posts) is opaque to the unit suite. This suite
 * seeds a small graph and asserts who-can-see-what across tiers and radii.
 *
 * REWRITTEN FOR H1. The fixture used to give the VIEWER a high-scored edge to a
 * target and expect that to open the target's narrow-radius posts. That was the
 * defect: the reader set that score on their own edge. Every author here now
 * carries an explicit, reciprocated edge placing the VIEWER at a tier, and it is
 * THAT tier the radius is measured against. The viewer's own edges still select
 * which entity band a post lands in — that part is the viewer's own data — but
 * they no longer authorize anything. See lib/graph/postgres/circles.ts.
 *
 * Audience-boundary assertions proper live in
 * test/integration/circle-read-authz.integration.test.ts (the CI lane). This
 * suite is the behaviour/pagination/counting suite.
 *
 * Opt-in: set DATABASE_URL to a Postgres database carrying the trellis schema
 * (e.g. the local docker dev DB). Skipped otherwise so the default unit run
 * needs no database.
 *
 *   DATABASE_URL=postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev \
 *     npm run test:integration -- test/integration/graph/circles.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { CircleOps } from "../../../src/lib/graph/postgres/circles.js";

const TEST_DB_URL = process.env.DATABASE_URL ?? process.env.GEO_TEST_DATABASE_URL;
const suite = TEST_DB_URL ? describe : describe.skip;

const TENANT = "t-circles-itest";
const OTHER_TENANT = "t-circles-itest-other";

// Viewer + targets
const VIEWER = "circ-viewer";
const ENT_INNER = "circ-ent-inner"; // viewer relates at inner tier (0)
const ENT_COMMUNITY = "circ-ent-comm"; // viewer relates at community tier (2)
const AUTHOR_CLOSE = "circ-author-close"; // places the viewer at tier 1
const AUTHOR_INNER = "circ-author-inner"; // places the viewer at tier 0
const AUTHOR_COMM = "circ-author-comm"; // places the viewer at tier 2
const STRANGER = "circ-stranger"; // no relationship in either direction

const since = new Date("2026-01-01T00:00:00.000Z");
// Recent timestamp (1h ago): getCircleStatus only counts posts inside its
// 7-day window (CIRCLE_STATUS_WINDOW_DAYS), so the shared fixture posts must
// be recent for the status assertions below.
const POST_TS = new Date(Date.now() - 60 * 60 * 1000);

suite("CircleOps dual-gated visibility (Postgres)", () => {
  let prisma: PrismaClient;
  let ops: CircleOps;

  async function seedTenant(id: string) {
    await prisma.tenant.create({
      data: { id, slug: id, displayName: id, type: "ORGANIZATION" },
    });
  }

  async function seedUser(id: string) {
    // `personal_tenant_id` is UNIQUE per user, so each user gets its OWN
    // personal tenant — distinct from the shared operating TENANT the circle
    // queries scope by (applied via runWithTenantContext + the row tenantId on
    // relationships/posts, not via the user's personal tenant).
    const pt = `${id}-pt`;
    await prisma.tenant.upsert({
      where: { id: pt },
      update: {},
      create: { id: pt, slug: pt, displayName: pt, type: "ORGANIZATION" },
    });
    await prisma.user.create({
      data: { id, email: `${id}@example.com`, handle: id, personalTenantId: pt },
    });
  }

  async function seedEntity(id: string, tenant: string, name: string) {
    await prisma.entity.create({ data: { id, tenantId: tenant, name } });
  }

  /**
   * An edge the VIEWER owns. Selects which band a target falls into for the
   * viewer's own views; authorizes nothing (H1).
   */
  async function relate(
    targetType: "entity" | "user",
    targetId: string,
    computedScore: number,
    tenant = TENANT,
  ) {
    await prisma.relationship.create({
      data: {
        tenantId: tenant,
        userId: VIEWER,
        targetType,
        targetId,
        computedScore,
        connectionMethod: "discovery",
      },
    });
  }

  /**
   * The edge an AUTHOR owns, placing the VIEWER at `tier` with a reverse edge
   * present. This is what decides which of the author's radii the viewer may
   * read — the whole point of H1 — and it is written from the author's side, so
   * no amount of self-scoring by the viewer can produce it.
   */
  async function placesViewerAt(authorId: string, tier: number) {
    await prisma.relationship.createMany({
      data: [
        {
          tenantId: TENANT,
          userId: authorId,
          targetType: "user",
          targetId: VIEWER,
          tier,
          reciprocated: true,
          connectionMethod: "discovery",
        },
        {
          tenantId: TENANT,
          userId: VIEWER,
          targetType: "user",
          targetId: authorId,
          tier: 3,
          reciprocated: true,
          connectionMethod: "discovery",
        },
      ],
    });
  }

  /** Post about zero or more entities, by an author, at a radius. */
  async function seedPost(
    id: string,
    authorId: string,
    radius: "WHISPER" | "NORMAL" | "LOUD" | "SHOUT",
    subjectEntityIds: string[],
    tenant = TENANT,
    createdAt = POST_TS,
  ) {
    await prisma.post.create({
      data: { id, tenantId: tenant, authorId, text: id, radius, createdAt },
    });
    for (const entityId of subjectEntityIds) {
      await prisma.postSubject.create({
        data: { postId: id, entityId },
      });
    }
  }

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DB_URL! }),
    });
    ops = new CircleOps(prisma);

    // Clean any leftover from a prior run (re-runnable without a manual reset).
    // `relationships` has no FK to `users`, so deleting the users below does
    // not cascade to relationship rows; clear them explicitly or the
    // @@unique([userId, targetType, targetId]) trips on a rerun.
    // Cross-tenant fixtures from the "no cross-tenant leakage" test have no
    // cascade from the tenant deletes below, so clear them explicitly too
    // (FK-safe order: post-subject → post → relationship → entity → user).
    await prisma.postSubject.deleteMany({ where: { postId: "p-other-tenant" } });
    await prisma.post.deleteMany({ where: { id: "p-other-tenant" } });
    await prisma.entity.deleteMany({ where: { id: "circ-other-ent" } });
    await prisma.relationship.deleteMany({
      where: {
        userId: {
          in: [VIEWER, AUTHOR_CLOSE, AUTHOR_INNER, AUTHOR_COMM, STRANGER],
        },
      },
    });
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [
            VIEWER,
            AUTHOR_CLOSE,
            AUTHOR_INNER,
            AUTHOR_COMM,
            STRANGER,
            "circ-other-author",
          ],
        },
      },
    });
    await prisma.tenant.deleteMany({
      where: {
        id: {
          in: [
            TENANT,
            OTHER_TENANT,
            `${VIEWER}-pt`,
            `${AUTHOR_CLOSE}-pt`,
            `${AUTHOR_INNER}-pt`,
            `${AUTHOR_COMM}-pt`,
            `${STRANGER}-pt`,
          ],
        },
      },
    });
    await seedTenant(TENANT);
    await seedTenant(OTHER_TENANT);

    // Users (authors + viewer + stranger) — each with its own personal tenant.
    await seedUser(VIEWER);
    await seedUser(AUTHOR_CLOSE);
    await seedUser(AUTHOR_INNER);
    await seedUser(AUTHOR_COMM);
    await seedUser(STRANGER);

    // Entities.
    await seedEntity(ENT_INNER, TENANT, "InnerEnt");
    await seedEntity(ENT_COMMUNITY, TENANT, "CommunityEnt");

    // Relationships (effective score → tier band):
    //  - ENT_INNER     0.9  → tier 0 (inner)
    //  - ENT_COMMUNITY 0.3  → tier 2 (community)
    //  - AUTHOR_CLOSE  0.65 → tier 1 (close friends)
    await relate("entity", ENT_INNER, 0.9);
    await relate("entity", ENT_COMMUNITY, 0.3);

    // The author-side placements — the audience decision (H1). AUTHOR_CLOSE
    // gets its reverse edge here rather than through `relate`, because what
    // matters is the tier on the edge AUTHOR_CLOSE owns.
    await placesViewerAt(AUTHOR_CLOSE, 1);
    await placesViewerAt(AUTHOR_INNER, 0);
    await placesViewerAt(AUTHOR_COMM, 2);

    // Posts:
    // p-inner-whisper: WHISPER (radiusInt 0) about ENT_INNER, by an author who
    //   placed the viewer at tier 0 → the only tier WHISPER reaches.
    await seedPost("p-inner-whisper", AUTHOR_INNER, "WHISPER", [ENT_INNER]);
    // p-comm-whisper: WHISPER about ENT_COMMUNITY by an author who placed the
    //   viewer at tier 2 → radiusInt 0 < 2, so it reaches nobody here.
    await seedPost("p-comm-whisper", AUTHOR_COMM, "WHISPER", [ENT_COMMUNITY]);
    // p-comm-loud: LOUD (radiusInt 2) by the same author → reaches tier 2.
    await seedPost("p-comm-loud", AUTHOR_COMM, "LOUD", [ENT_COMMUNITY]);
    // p-author-normal: NORMAL (radiusInt 1) by AUTHOR_CLOSE → reaches tier 1.
    await seedPost("p-author-normal", AUTHOR_CLOSE, "NORMAL", []);
    // p-multi: SHOUT about BOTH ENT_INNER (tier0 band) and ENT_COMMUNITY
    //   (tier2 band) → resolvedTier = MIN(0,2) = 0 within the tier-0 query.
    await seedPost("p-multi", AUTHOR_INNER, "SHOUT", [ENT_INNER, ENT_COMMUNITY]);
    // p-stranger: SHOUT by STRANGER, no subjects and no edge in either
    //   direction → never reachable through a circle view.
    await seedPost("p-stranger", STRANGER, "SHOUT", []);
    // (The cross-tenant post is seeded inside its own test, below.)
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({
      where: { id: { in: [TENANT, OTHER_TENANT] } },
    });
    await prisma.$disconnect();
  });

  it("tier 0 sees inner-entity posts (any radius reaches tier 0)", async () => {
    const res = await ops.getVisiblePostIds(VIEWER, 0, since, { limit: 50 }, TENANT);
    const ids = res.items.map((i) => i.postId);
    expect(ids).toContain("p-inner-whisper");
    expect(ids).toContain("p-multi");
    // Not visible at tier 0: community-only posts and unrelated posts.
    expect(ids).not.toContain("p-comm-loud");
    expect(ids).not.toContain("p-stranger");
  });

  it("resolves a multi-entity post to the closest (min) tier", async () => {
    const res = await ops.getVisiblePostIds(VIEWER, 0, since, { limit: 50 }, TENANT);
    const multi = res.items.find((i) => i.postId === "p-multi");
    expect(multi?.resolvedTier).toBe(0); // MIN(tier0, tier2)
  });

  it("the radius gate blocks a WHISPER post from a community-tier relationship", async () => {
    const res = await ops.getVisiblePostIds(VIEWER, 2, since, { limit: 50 }, TENANT);
    const ids = res.items.map((i) => i.postId);
    // LOUD reaches tier 2; WHISPER does not.
    expect(ids).toContain("p-comm-loud");
    expect(ids).not.toContain("p-comm-whisper");
  });

  it("the author path makes a post visible at the tier THE AUTHOR assigned", async () => {
    const res = await ops.getVisiblePostIds(VIEWER, 1, since, { limit: 50 }, TENANT);
    const ids = res.items.map((i) => i.postId);
    expect(ids).toContain("p-author-normal");
  });

  it("never surfaces posts from a user with no edge in either direction", async () => {
    for (const tier of [0, 1, 2, 3] as const) {
      const res = await ops.getVisiblePostIds(VIEWER, tier, since, { limit: 50 }, TENANT);
      expect(res.items.map((i) => i.postId)).not.toContain("p-stranger");
    }
  });

  it("scopes to the tenant it is GIVEN — no cross-tenant leakage", async () => {
    // Seed a cross-tenant post about the SAME entity id space; viewer relates to
    // ENT_INNER only within TENANT, so an OTHER_TENANT relationship row is needed
    // for any chance of a match — which we never create. Assert the OTHER_TENANT
    // post never appears in the TENANT-scoped view.
    await prisma.user.create({
      data: {
        id: "circ-other-author",
        email: "circ-other-author@example.com",
        handle: "circ-other-author",
        personalTenantId: OTHER_TENANT,
      },
    });
    await prisma.entity.create({
      data: { id: "circ-other-ent", tenantId: OTHER_TENANT, name: "OtherEnt" },
    });
    await prisma.relationship.create({
      data: {
        tenantId: OTHER_TENANT,
        userId: VIEWER,
        targetType: "entity",
        targetId: "circ-other-ent",
        computedScore: 0.9,
        connectionMethod: "discovery",
      },
    });
    await prisma.post.create({
      data: {
        id: "p-other-tenant",
        tenantId: OTHER_TENANT,
        authorId: "circ-other-author",
        text: "p-other-tenant",
        radius: "SHOUT",
        createdAt: POST_TS,
      },
    });
    await prisma.postSubject.create({
      data: { postId: "p-other-tenant", entityId: "circ-other-ent" },
    });

    const res = await ops.getVisiblePostIds(VIEWER, 0, since, { limit: 50 }, TENANT);
    expect(res.items.map((i) => i.postId)).not.toContain("p-other-tenant");
  });

  it("paginates deterministically by (createdAt DESC, postId DESC)", async () => {
    const page1 = await ops.getVisiblePostIds(VIEWER, 0, since, { limit: 1 }, TENANT);
    expect(page1.items).toHaveLength(1);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).not.toBeNull();

    const page2 = await ops.getVisiblePostIds(VIEWER, 0, since, {
        limit: 1,
        cursor: page1.cursor ?? undefined,
      }, TENANT);
    // No overlap between pages.
    const p1Ids = new Set(page1.items.map((i) => i.postId));
    for (const item of page2.items) {
      expect(p1Ids.has(item.postId)).toBe(false);
    }
  });

  it("getCircleMembers returns tenant-scoped tier members", async () => {
    const members = await ops.getCircleMembers(VIEWER, 0, TENANT);
    const ids = members.map((m) => m.id);
    expect(ids).toContain(ENT_INNER);
    expect(ids).not.toContain(ENT_COMMUNITY); // tier 2, not tier 0
  });

  it("markCircleRead + getCircleStatus reflect the read watermark", async () => {
    // Before marking: tier 0 has unseen posts (POST_TS is inside the window).
    const before = await ops.getCircleStatus(VIEWER, TENANT);
    const t0Before = before.find((s) => s.tier === 0);
    expect(t0Before?.unseenCount ?? 0).toBeGreaterThan(0);

    // Mark read at a timestamp after all seeded posts.
    const readAt = new Date();
    await ops.markCircleRead(VIEWER, 0, readAt);

    const after = await ops.getCircleStatus(VIEWER, TENANT);
    const t0After = after.find((s) => s.tier === 0);
    expect(t0After?.unseenCount).toBe(0);
    expect(t0After?.caughtUp).toBe(true);
    expect(t0After?.lastReadAt).toEqual(readAt);
  });

  it("getGlanceItems surfaces the most-recent post per tier member (entity + author paths)", async () => {
    // Tier 0: the only member is ENT_INNER (entity path).
    const glance0 = await ops.getGlanceItems(VIEWER, 0, 10, TENANT);
    const inner = glance0.find((g) => g.targetId === ENT_INNER);
    expect(inner).toBeDefined();
    expect(inner?.targetType).toBe("entity");
    // Its most-recent visible post is one of the two POST_TS posts about it.
    expect(["p-multi", "p-inner-whisper"]).toContain(inner?.postId);

    // Tier 1: the only member is AUTHOR_CLOSE (author path).
    const glance1 = await ops.getGlanceItems(VIEWER, 1, 10, TENANT);
    const author = glance1.find((g) => g.targetId === AUTHOR_CLOSE);
    expect(author).toBeDefined();
    expect(author?.targetType).toBe("user");
    expect(author?.postId).toBe("p-author-normal");
  });

  it("getDepthPostIds gates by the AUTHOR's placement (entity + user targets)", async () => {
    const entityPosts = await ops.getDepthPostIds(VIEWER, "entity", ENT_INNER, since, 10, TENANT);
    // The viewer subscribes to ENT_INNER, and AUTHOR_INNER placed them at
    // tier 0, so both posts about it are readable (p-multi is SHOUT anyway).
    expect(new Set(entityPosts)).toEqual(new Set(["p-multi", "p-inner-whisper"]));

    const userPosts = await ops.getDepthPostIds(VIEWER, "user", AUTHOR_CLOSE, since, 10, TENANT);
    // AUTHOR_CLOSE placed the viewer at tier 1 → NORMAL (radiusInt 1) reaches.
    expect(userPosts).toEqual(["p-author-normal"]);
  });

  it("getCircleEntityStatus lists tier entities with unseen counts (radius-gated)", async () => {
    const statuses = await ops.getCircleEntityStatus(VIEWER, 2, TENANT);
    const comm = statuses.find((s) => s.entityId === ENT_COMMUNITY);
    expect(comm).toBeDefined();
    expect(comm?.entityName).toBe("CommunityEnt");
    // Posts about ENT_COMMUNITY reaching tier 2: p-comm-loud + p-multi
    // (p-comm-whisper is radius-gated out).
    expect(comm?.unseenCount).toBe(2);
    expect(comm?.caughtUp).toBe(false);
    expect(comm?.latestPostAt).toEqual(POST_TS);
  });

  it("applies the org-category feed filter (null-code posts: kept by exclude, dropped by include)", async () => {
    const unfiltered = await ops.getVisiblePostIds(VIEWER, 0, since, { limit: 50 }, TENANT);
    // All fixture posts carry a NULL author_org_root_category_code:
    // an exclude list keeps them …
    const excluded = await ops.getVisiblePostIds(VIEWER, 0, since, { limit: 50 }, TENANT, { exclude: ["VETS"] });
    expect(excluded.items.map((i) => i.postId).sort()).toEqual(
      unfiltered.items.map((i) => i.postId).sort(),
    );
    // … an include whitelist drops them (NULL belongs to no listed category).
    const included = await ops.getVisiblePostIds(VIEWER, 0, since, { limit: 50 }, TENANT, { include: ["VETS"] });
    expect(included.items).toEqual([]);

    // Same predicate on the glance query.
    const glance = await ops.getGlanceItems(VIEWER, 0, 10, TENANT, { include: ["VETS"] });
    expect(glance).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // getCircleStatus window floor + saturation cap (AR8 fix 1)
  // ---------------------------------------------------------------------------

  describe("getCircleStatus window floor + cap", () => {
    const CAP_TENANT = "t-circles-itest-cap";
    const CAP_VIEWER = "circ-cap-viewer"; // 120 recent posts → cap at 100
    const CAP_ENT = "circ-cap-ent";
    const WIN_VIEWER = "circ-win-viewer"; // 5 recent + 3 old posts → 5
    const WIN_ENT = "circ-win-ent";
    const AUTHOR = "circ-cap-author";

    /** Bulk-seed posts about an entity (createMany — the cap fixture is 100+ rows). */
    async function seedManyPosts(
      prefix: string,
      entityId: string,
      count: number,
      createdAt: Date,
      tenant: string,
    ) {
      await prisma.post.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          id: `${prefix}-${i + 1}`,
          tenantId: tenant,
          authorId: AUTHOR,
          text: `${prefix}-${i + 1}`,
          radius: "SHOUT" as const,
          createdAt,
        })),
      });
      await prisma.postSubject.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          postId: `${prefix}-${i + 1}`,
          entityId,
        })),
      });
    }

    async function wipeCapFixture() {
      await prisma.postSubject.deleteMany({
        where: { post: { tenantId: CAP_TENANT } },
      });
      await prisma.post.deleteMany({ where: { tenantId: CAP_TENANT } });
      await prisma.relationship.deleteMany({ where: { tenantId: CAP_TENANT } });
      await prisma.entity.deleteMany({ where: { tenantId: CAP_TENANT } });
      await prisma.user.deleteMany({
        where: { id: { in: [CAP_VIEWER, WIN_VIEWER, AUTHOR] } },
      });
      await prisma.tenant.deleteMany({
        where: {
          id: {
            in: [
              CAP_TENANT,
              `${CAP_VIEWER}-pt`,
              `${WIN_VIEWER}-pt`,
              `${AUTHOR}-pt`,
            ],
          },
        },
      });
    }

    beforeAll(async () => {
      await wipeCapFixture();
      await seedTenant(CAP_TENANT);
      await seedUser(CAP_VIEWER);
      await seedUser(WIN_VIEWER);
      await seedUser(AUTHOR);
      await seedEntity(CAP_ENT, CAP_TENANT, "CapEnt");
      await seedEntity(WIN_ENT, CAP_TENANT, "WinEnt");

      // Both viewers relate at tier 0 (score 0.9) inside CAP_TENANT.
      await prisma.relationship.createMany({
        data: [
          {
            tenantId: CAP_TENANT,
            userId: CAP_VIEWER,
            targetType: "entity",
            targetId: CAP_ENT,
            computedScore: 0.9,
            connectionMethod: "discovery",
          },
          {
            tenantId: CAP_TENANT,
            userId: WIN_VIEWER,
            targetType: "entity",
            targetId: WIN_ENT,
            computedScore: 0.9,
            connectionMethod: "discovery",
          },
        ],
      });

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      // Cap fixture: 120 recent posts (> the 100 cap).
      await seedManyPosts("p-cap", CAP_ENT, 120, oneHourAgo, CAP_TENANT);
      // Window fixture: 5 recent + 3 outside the 7-day window.
      await seedManyPosts("p-win-new", WIN_ENT, 5, oneHourAgo, CAP_TENANT);
      await seedManyPosts("p-win-old", WIN_ENT, 3, eightDaysAgo, CAP_TENANT);
    });

    afterAll(async () => {
      await wipeCapFixture();
    });

    it("saturates unseenCount at 100 (client renders 99+)", async () => {
      const statuses = await ops.getCircleStatus(CAP_VIEWER, CAP_TENANT);
      const t0 = statuses.find((s) => s.tier === 0);
      expect(t0?.unseenCount).toBe(100);
      expect(t0?.caughtUp).toBe(false);
    });

    it("floors a never-read tier at the 7-day window (old posts not counted)", async () => {
      const statuses = await ops.getCircleStatus(WIN_VIEWER, CAP_TENANT);
      const t0 = statuses.find((s) => s.tier === 0);
      // 5 recent posts count; the 3 posts older than 7 days do not.
      expect(t0?.unseenCount).toBe(5);
      expect(t0?.caughtUp).toBe(false);
    });

    it("a read watermark inside the window still wins over the floor", async () => {
      // Watermark 30 minutes ago — inside the 7d window and NEWER than the
      // recent posts (1h ago) → everything is seen.
      await ops.markCircleRead(WIN_VIEWER, 0, new Date(Date.now() - 30 * 60 * 1000));
      const mid = await ops.getCircleStatus(WIN_VIEWER, CAP_TENANT);
      expect(mid.find((s) => s.tier === 0)?.unseenCount).toBe(0);

      // Watermark BEFORE the recent posts (2h ago) → all 5 unseen again.
      await ops.markCircleRead(WIN_VIEWER, 0, new Date(Date.now() - 2 * 60 * 60 * 1000));
      const back = await ops.getCircleStatus(WIN_VIEWER, CAP_TENANT);
      expect(back.find((s) => s.tier === 0)?.unseenCount).toBe(5);
    });
  });
});
