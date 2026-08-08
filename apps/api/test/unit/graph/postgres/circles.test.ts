/**
 * Unit Tests: PostgresGraphService — CircleOps
 *
 * The Prisma client is mocked, so these tests exercise the app-side logic that
 * sits ON TOP of the SQL — they do NOT validate the dual-gated SQL itself
 * (that is a live-DB concern, covered by
 * test/integration/graph/circles.integration.test.ts). Specifically they pin:
 *
 *   - tier-bounds resolution from CircleConfig (default + custom thresholds)
 *   - getVisiblePostIds merge/dedupe: closest (min) resolvedTier wins, the
 *     (createdAt DESC, postId DESC) re-sort, and (limit+1)-style hasMore/cursor
 *   - getGlanceItems two-branch assembly + recency sort + limit
 *   - getCircleStatus read-state defaulting + caughtUp derivation
 *   - markCircleRead upsert shape
 *
 * The SQL strings themselves are opaque here (Prisma.sql tagged templates), so
 * we assert on the SHAPE the methods return given canned `$queryRaw` results.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// H1: CircleOps no longer reads an ambient tenant — every method takes one
// explicitly and refuses without it. There is nothing left to mock here; the
// tenant now arrives as an argument, which is the point.

import { CircleOps } from "../../../../src/lib/graph/postgres/circles.js";
import type { CircleTier } from "../../../../src/lib/graph/types.js";

// ---------------------------------------------------------------------------
// Mock prisma
// ---------------------------------------------------------------------------

interface MockPrisma {
  circleConfig: { findUnique: ReturnType<typeof vi.fn> };
  circleReadState: {
    findMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  $queryRaw: ReturnType<typeof vi.fn>;
}

function makePrisma(): MockPrisma {
  return {
    circleConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    circleReadState: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
}

const USER = "user-1";
const TENANT = "tenant-1";

describe("CircleOps", () => {
  let prisma: MockPrisma;
  let ops: CircleOps;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ops = new CircleOps(prisma as any);
  });

  // -------------------------------------------------------------------------
  // getCircleMembers
  // -------------------------------------------------------------------------

  describe("getCircleMembers", () => {
    it("maps rows to CircleMember with the queried tier", async () => {
      prisma.$queryRaw.mockResolvedValue([
        { id: "e1", type: "entity", name: "Bunsen", score: 0.9 },
        { id: "u2", type: "user", name: "alice", score: 0.85 },
      ]);

      const members = await ops.getCircleMembers(USER, 0, TENANT);

      expect(members).toEqual([
        { id: "e1", type: "entity", name: "Bunsen", score: 0.9, tier: 0 },
        { id: "u2", type: "user", name: "alice", score: 0.85, tier: 0 },
      ]);
    });

    it("coerces a null name to empty string", async () => {
      prisma.$queryRaw.mockResolvedValue([
        { id: "u3", type: "user", name: null, score: 0.6 },
      ]);
      const members = await ops.getCircleMembers(USER, 1, TENANT);
      expect(members[0].name).toBe("");
      expect(members[0].type).toBe("user");
    });
  });

  // -------------------------------------------------------------------------
  // getVisiblePostIds — merge / dedupe / pagination
  // -------------------------------------------------------------------------

  describe("getVisiblePostIds", () => {
    const since = new Date("2026-01-01T00:00:00.000Z");

    function makeRow(postId: string, iso: string, resolvedTier: number) {
      return { postId, createdAt: new Date(iso), resolvedTier };
    }

    it("dedupes posts visible via both branches keeping the closest (min) tier", async () => {
      // entity branch sees p1 at tier 2; author branch sees the same p1 at tier 0.
      prisma.$queryRaw
        .mockResolvedValueOnce([makeRow("p1", "2026-02-01T00:00:00.000Z", 2)]) // entity branch
        .mockResolvedValueOnce([makeRow("p1", "2026-02-01T00:00:00.000Z", 0)]); // author branch

      const res = await ops.getVisiblePostIds(USER, 0, since, { limit: 10 }, TENANT);

      expect(res.items).toHaveLength(1);
      expect(res.items[0].postId).toBe("p1");
      expect(res.items[0].resolvedTier).toBe(0); // min(2, 0)
      expect(res.hasMore).toBe(false);
      expect(res.cursor).toBeNull();
    });

    it("re-sorts the merged set by createdAt DESC then postId DESC", async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          makeRow("pA", "2026-02-01T00:00:00.000Z", 1),
          makeRow("pB", "2026-02-03T00:00:00.000Z", 1),
        ])
        .mockResolvedValueOnce([
          makeRow("pC", "2026-02-02T00:00:00.000Z", 2),
          // same timestamp as pB → postId DESC tiebreak ("pBa" > "pB")
          makeRow("pBa", "2026-02-03T00:00:00.000Z", 3),
        ]);

      const res = await ops.getVisiblePostIds(USER, 1, since, { limit: 10 }, TENANT);

      expect(res.items.map((i) => i.postId)).toEqual([
        "pBa", // 02-03, postId DESC: "pBa" > "pB"
        "pB", // 02-03
        "pC", // 02-02
        "pA", // 02-01
      ]);
    });

    it("truncates to the limit, sets hasMore, and emits a cursor", async () => {
      // Two branches, three distinct posts, limit 2 → hasMore true.
      prisma.$queryRaw
        .mockResolvedValueOnce([
          makeRow("p3", "2026-02-03T00:00:00.000Z", 0),
          makeRow("p2", "2026-02-02T00:00:00.000Z", 0),
        ])
        .mockResolvedValueOnce([makeRow("p1", "2026-02-01T00:00:00.000Z", 0)]);

      const res = await ops.getVisiblePostIds(USER, 0, since, { limit: 2 }, TENANT);

      expect(res.items.map((i) => i.postId)).toEqual(["p3", "p2"]);
      expect(res.hasMore).toBe(true);
      expect(res.cursor).not.toBeNull();

      // The cursor round-trips to the last returned item.
      const decoded = JSON.parse(
        Buffer.from(res.cursor as string, "base64").toString("utf8"),
      );
      expect(decoded.postId).toBe("p2");
      expect(decoded.createdAt).toBe("2026-02-02T00:00:00.000Z");
    });

    it("coerces a numeric/bigint resolvedTier from the driver", async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { postId: "p1", createdAt: new Date("2026-02-01T00:00:00.000Z"), resolvedTier: "2" },
        ])
        .mockResolvedValueOnce([]);

      const res = await ops.getVisiblePostIds(USER, 2, since, { limit: 10 }, TENANT);
      expect(res.items[0].resolvedTier).toBe(2);
      expect(typeof res.items[0].resolvedTier).toBe("number");
    });

    it("issues two parallel branch queries", async () => {
      await ops.getVisiblePostIds(USER, 0, since, { limit: 5 }, TENANT);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // getGlanceItems
  // -------------------------------------------------------------------------

  describe("getGlanceItems", () => {
    it("assembles entity + user branches, sorts by recency, applies limit", async () => {
      // Step 1a: ENTITY roster (the viewer's own subscriptions)
      prisma.$queryRaw
        .mockResolvedValueOnce([{ targetId: "e1", targetName: "Bunsen" }])
        // Step 1b: USER roster — H1: authors who placed THIS VIEWER at the tier,
        // reciprocated. A separate query now, because it reads the opposite
        // direction of the edge from the entity roster.
        .mockResolvedValueOnce([{ targetId: "u1", targetName: "alice" }])
        // Step 2a: entity latest posts
        .mockResolvedValueOnce([
          { targetId: "e1", postId: "pe1", postCreatedAt: new Date("2026-02-01T00:00:00.000Z") },
        ])
        // Step 2b: user latest posts
        .mockResolvedValueOnce([
          { targetId: "u1", postId: "pu1", postCreatedAt: new Date("2026-02-05T00:00:00.000Z") },
        ]);

      const items = await ops.getGlanceItems(USER, 0, 10, TENANT);

      expect(items.map((i) => i.postId)).toEqual(["pu1", "pe1"]); // recency DESC
      expect(items[0]).toMatchObject({ targetId: "u1", targetType: "user", targetName: "alice" });
      expect(items[1]).toMatchObject({ targetId: "e1", targetType: "entity", targetName: "Bunsen" });
    });

    it("skips the entity/user post queries when no members of that kind exist", async () => {
      // Only a user member → the entity POSTS query must be skipped.
      prisma.$queryRaw
        .mockResolvedValueOnce([]) // entity roster: empty
        .mockResolvedValueOnce([{ targetId: "u1", targetName: "alice" }])
        .mockResolvedValueOnce([
          { targetId: "u1", postId: "pu1", postCreatedAt: new Date("2026-02-05T00:00:00.000Z") },
        ]);

      const items = await ops.getGlanceItems(USER, 0, 10, TENANT);
      // two roster queries + user-posts query only (no entity-posts query)
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
      expect(items).toHaveLength(1);
    });

    it("truncates to the requested limit", async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { targetId: "e1", targetName: "A" },
          { targetId: "e2", targetName: "B" },
        ])
        .mockResolvedValueOnce([]) // user roster: empty
        .mockResolvedValueOnce([
          { targetId: "e1", postId: "p1", postCreatedAt: new Date("2026-02-01T00:00:00.000Z") },
          { targetId: "e2", postId: "p2", postCreatedAt: new Date("2026-02-02T00:00:00.000Z") },
        ]);

      const items = await ops.getGlanceItems(USER, 0, 1, TENANT);
      expect(items).toHaveLength(1);
      expect(items[0].postId).toBe("p2"); // most recent
    });
  });

  // -------------------------------------------------------------------------
  // getDepthPostIds
  // -------------------------------------------------------------------------

  describe("getDepthPostIds", () => {
    it("returns post IDs for an entity target", async () => {
      prisma.$queryRaw.mockResolvedValue([{ postId: "p1" }, { postId: "p2" }]);
      const ids = await ops.getDepthPostIds(USER, "entity", "e1", new Date(0), 10, TENANT);
      expect(ids).toEqual(["p1", "p2"]);
    });

    it("returns post IDs for a user target", async () => {
      prisma.$queryRaw.mockResolvedValue([{ postId: "pa" }]);
      const ids = await ops.getDepthPostIds(USER, "user", "u1", new Date(0), 10, TENANT);
      expect(ids).toEqual(["pa"]);
    });
  });

  // -------------------------------------------------------------------------
  // getCircleStatus
  // -------------------------------------------------------------------------

  describe("getCircleStatus", () => {
    it("returns all four tiers with caughtUp derived from the count", async () => {
      // No read-state rows → lastReadAt null for all tiers.
      // Four parallel count queries: tier 0 has 3 unseen, the rest 0.
      prisma.$queryRaw.mockImplementation(() => Promise.resolve([{ unseenCount: 0n }]));
      // Override the first call (tier 0) to return 3.
      prisma.$queryRaw
        .mockResolvedValueOnce([{ unseenCount: 3n }])
        .mockResolvedValue([{ unseenCount: 0n }]);

      const statuses = await ops.getCircleStatus(USER, TENANT);

      expect(statuses).toHaveLength(4);
      const byTier = new Map(statuses.map((s) => [s.tier, s]));
      expect(byTier.get(0 as CircleTier)).toMatchObject({
        tier: 0,
        name: "inner",
        unseenCount: 3,
        caughtUp: false,
        lastReadAt: null,
      });
      expect(byTier.get(3 as CircleTier)).toMatchObject({
        tier: 3,
        name: "ambient",
        unseenCount: 0,
        caughtUp: true,
        lastReadAt: null,
      });
    });

    it("threads CircleReadState.lastReadAt into the result", async () => {
      const lr = new Date("2026-03-01T00:00:00.000Z");
      prisma.circleReadState.findMany.mockResolvedValue([
        { tier: 2, lastReadAt: lr },
      ]);
      prisma.$queryRaw.mockResolvedValue([{ unseenCount: 0n }]);

      const statuses = await ops.getCircleStatus(USER, TENANT);
      const tier2 = statuses.find((s) => s.tier === 2);
      expect(tier2?.lastReadAt).toEqual(lr);
      const tier0 = statuses.find((s) => s.tier === 0);
      expect(tier0?.lastReadAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getCircleEntityStatus
  // -------------------------------------------------------------------------

  describe("getCircleEntityStatus", () => {
    it("maps rows with caughtUp and latestPostAt", async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          entityId: "e1",
          entityName: "Bunsen",
          unseenCount: 2n,
          latestPostAt: new Date("2026-02-10T00:00:00.000Z"),
        },
        {
          entityId: "e2",
          entityName: "Beaker",
          unseenCount: 0n,
          latestPostAt: null,
        },
      ]);

      const rows = await ops.getCircleEntityStatus(USER, 1, TENANT);

      expect(rows[0]).toMatchObject({
        entityId: "e1",
        entityName: "Bunsen",
        unseenCount: 2,
        caughtUp: false,
      });
      expect(rows[1]).toMatchObject({
        entityId: "e2",
        unseenCount: 0,
        caughtUp: true,
        latestPostAt: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Tenant guard (H1)
  // -------------------------------------------------------------------------

  describe("tenant guard", () => {
    // The predecessor resolved an ambient tenant and produced `Prisma.empty`
    // when there was none — a query with NO tenant predicate, returning every
    // tenant's rows. An absent tenant must reach no SQL at all.
    it("refuses every read that touches tenant-scoped rows, and issues no query", async () => {
      await expect(ops.getCircleMembers(USER, 0, "")).rejects.toThrow(
        /activeTenantId is required/,
      );
      await expect(
        ops.getVisiblePostIds(USER, 0, new Date(0), { limit: 10 }, ""),
      ).rejects.toThrow(/activeTenantId is required/);
      await expect(ops.getGlanceItems(USER, 0, 10, "")).rejects.toThrow(
        /activeTenantId is required/,
      );
      await expect(
        ops.getDepthPostIds(USER, "user", "u1", new Date(0), 10, ""),
      ).rejects.toThrow(/activeTenantId is required/);
      await expect(ops.getCircleStatus(USER, "")).rejects.toThrow(
        /activeTenantId is required/,
      );
      await expect(ops.getCircleEntityStatus(USER, 0, "")).rejects.toThrow(
        /activeTenantId is required/,
      );

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it("still allows markCircleRead, which touches no tenant-scoped row", async () => {
      // CircleReadState is keyed (userId, tier) and has no tenant column, so it
      // deliberately takes no tenant. This pins that asymmetry.
      await expect(ops.markCircleRead(USER, 0)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // markCircleRead
  // -------------------------------------------------------------------------

  describe("markCircleRead", () => {
    it("upserts CircleReadState on the (userId, tier) compound key", async () => {
      const readAt = new Date("2026-04-01T00:00:00.000Z");
      await ops.markCircleRead(USER, 2, readAt);

      expect(prisma.circleReadState.upsert).toHaveBeenCalledWith({
        where: { userId_tier: { userId: USER, tier: 2 } },
        update: { lastReadAt: readAt, caughtUp: true },
        create: { userId: USER, tier: 2, lastReadAt: readAt, caughtUp: true },
      });
    });

    it("defaults readAt to now when omitted", async () => {
      const before = Date.now();
      await ops.markCircleRead(USER, 0);
      const after = Date.now();

      const call = prisma.circleReadState.upsert.mock.calls[0][0];
      const ts = (call.create.lastReadAt as Date).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  // -------------------------------------------------------------------------
  // CircleConfig threshold resolution
  // -------------------------------------------------------------------------

  describe("threshold resolution", () => {
    it("loads CircleConfig once per request", async () => {
      await ops.getCircleMembers(USER, 0, TENANT);
      expect(prisma.circleConfig.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.circleConfig.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER } }),
      );
    });

    it("falls back to defaults when no CircleConfig exists", async () => {
      prisma.circleConfig.findUnique.mockResolvedValue(null);
      // Should not throw; defaults are used internally.
      await expect(ops.getCircleMembers(USER, 0, TENANT)).resolves.toEqual([]);
    });
  });
});
