/**
 * Unit Tests: CircleOps org-category feed-declutter predicate (T2).
 *
 * The Prisma client is mocked, so — like the sibling circles.test.ts — these
 * tests do not hit a live DB. They pin the SHAPE of the SQL that CircleOps
 * generates for the new `orgFilter` param: that the
 * `posts.author_org_root_category_code` predicate is emitted (or NOT emitted)
 * as specified, that the requested codes travel as BOUND parameters (never
 * interpolated into the SQL text), and that the documented null-code semantics
 * are structurally present (exclude keeps null-code posts; include drops them).
 *
 * The runtime correctness of the predicate against real rows is a live-DB
 * concern (integration suite); here we prove the query is built correctly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// H1: the tenant is an explicit argument now, not an ambient lookup — nothing
// to mock.

import { CircleOps } from "../../../../src/lib/graph/postgres/circles.js";

// ---------------------------------------------------------------------------
// Mock prisma + Sql inspection helpers
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

/** Literal SQL text of a captured Prisma.Sql (bound values excluded). */
function sqlText(call: unknown): string {
  const sql = call as Prisma.Sql;
  return sql.strings.join(" ");
}

/** Bound parameter values of a captured Prisma.Sql. */
function sqlValues(call: unknown): unknown[] {
  return (call as Prisma.Sql).values;
}

const COL = "author_org_root_category_code";
const USER = "user-1";
const TENANT = "tenant-1";
const since = new Date("2026-01-01T00:00:00.000Z");

describe("CircleOps org-category feed filter", () => {
  let prisma: MockPrisma;
  let ops: CircleOps;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ops = new CircleOps(prisma as any);
  });

  // -------------------------------------------------------------------------
  // getVisiblePostIds
  // -------------------------------------------------------------------------

  describe("getVisiblePostIds", () => {
    it("emits NO org predicate when orgFilter is omitted (no-filter-param case)", async () => {
      await ops.getVisiblePostIds(USER, 0, since, { limit: 10 }, TENANT);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2); // entity + author branch
      for (const call of prisma.$queryRaw.mock.calls) {
        expect(sqlText(call[0])).not.toContain(COL);
      }
    });

    it("emits NO org predicate when both lists are empty", async () => {
      await ops.getVisiblePostIds(USER, 0, since, { limit: 10 }, TENANT, {
        exclude: [],
        include: [],
      });

      for (const call of prisma.$queryRaw.mock.calls) {
        expect(sqlText(call[0])).not.toContain(COL);
      }
    });

    it("emits an exclude predicate that KEEPS null-code posts, with codes bound", async () => {
      await ops.getVisiblePostIds(USER, 1, since, { limit: 10 }, TENANT, {
        exclude: ["business", "government"],
      });

      // Both branches (entity + author) must carry the predicate.
      for (const call of prisma.$queryRaw.mock.calls) {
        const text = sqlText(call[0]);
        expect(text).toContain(`${COL} IS NULL`);
        expect(text).toContain(`${COL} NOT IN`);
        // Include-whitelist form must NOT appear for an exclude-only filter.
        expect(text).not.toContain(`AND ${COL} IN (`);

        const values = sqlValues(call[0]);
        expect(values).toContain("business");
        expect(values).toContain("government");
      }
    });

    it("emits an include whitelist predicate (drops null-code posts) with codes bound", async () => {
      await ops.getVisiblePostIds(USER, 2, since, { limit: 10 }, TENANT, {
        include: ["nonprofit"],
      });

      for (const call of prisma.$queryRaw.mock.calls) {
        const text = sqlText(call[0]);
        expect(text).toContain(`${COL} IN`);
        // A pure include filter must not add the null-keeping exclude branch.
        expect(text).not.toContain(`${COL} IS NULL`);
        expect(sqlValues(call[0])).toContain("nonprofit");
      }
    });

    it("combines exclude + include predicates alongside the tier filter", async () => {
      await ops.getVisiblePostIds(USER, 0, since, { limit: 10 }, TENANT, {
        exclude: ["business"],
        include: ["nonprofit", "community-group"],
      });

      for (const call of prisma.$queryRaw.mock.calls) {
        const text = sqlText(call[0]);
        // Existing tier/radius filter still present (predicate is ADDED, not replacing).
        expect(text).toContain("radius");
        expect(text).toContain(`${COL} IS NULL`); // exclude branch
        expect(text).toContain(`${COL} IN`); // include branch
        const values = sqlValues(call[0]);
        expect(values).toContain("business");
        expect(values).toContain("nonprofit");
        expect(values).toContain("community-group");
      }
    });

    it("returns an empty result set when the filtered query yields no rows", async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      const res = await ops.getVisiblePostIds(USER, 0, since, { limit: 10 }, TENANT, {
        exclude: ["business"],
      });
      expect(res.items).toEqual([]);
      expect(res.hasMore).toBe(false);
      expect(res.cursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getGlanceItems
  // -------------------------------------------------------------------------

  describe("getGlanceItems", () => {
    function withMembers() {
      // H1 split the single roster query in two — the ENTITY roster reads the
      // viewer's own edges, the USER roster reads the authors' edges back — so
      // the post subqueries are now calls [2] and [3], not [1] and [2].
      // call[0] = entity roster; call[1] = user roster;
      // call[2] = entity post subquery; call[3] = user post subquery
      prisma.$queryRaw
        .mockResolvedValueOnce([{ targetId: "e1", targetName: "Ent" }])
        .mockResolvedValueOnce([{ targetId: "u1", targetName: "Usr" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
    }

    it("emits NO org predicate in the post subqueries when orgFilter is omitted", async () => {
      withMembers();
      await ops.getGlanceItems(USER, 0, 20, TENANT);

      // The roster queries (calls[0], [1]) never reference the post column; the
      // two post subqueries (calls[2], [3]) must also be free of it.
      for (const call of prisma.$queryRaw.mock.calls) {
        expect(sqlText(call[0])).not.toContain(COL);
      }
    });

    it("applies the exclude predicate to BOTH glance post subqueries", async () => {
      withMembers();
      await ops.getGlanceItems(USER, 0, 20, TENANT, { exclude: ["business"] });

      const entitySubquery = sqlText(prisma.$queryRaw.mock.calls[2][0]);
      const userSubquery = sqlText(prisma.$queryRaw.mock.calls[3][0]);
      expect(entitySubquery).toContain(`${COL} NOT IN`);
      expect(userSubquery).toContain(`${COL} NOT IN`);
      expect(sqlValues(prisma.$queryRaw.mock.calls[2][0])).toContain("business");
      expect(sqlValues(prisma.$queryRaw.mock.calls[3][0])).toContain("business");
    });

    it("applies the include whitelist to BOTH glance post subqueries", async () => {
      withMembers();
      await ops.getGlanceItems(USER, 0, 20, TENANT, { include: ["nonprofit"] });

      expect(sqlText(prisma.$queryRaw.mock.calls[2][0])).toContain(`${COL} IN`);
      expect(sqlText(prisma.$queryRaw.mock.calls[3][0])).toContain(`${COL} IN`);
    });
  });
});
