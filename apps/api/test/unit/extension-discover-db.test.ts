/**
 * Unit Tests: Extension cross-tenant discover surface — Part B (05a §4, §7.2)
 *
 * The discover() facade is an UNSCOPED read surface, so every guard is tested
 * at runtime: read-only method set, model gate, projection + relation-`where` +
 * column guards, non-overridable baseline floor on every read method, take
 * clamp, reason validation, and the runUnscoped audit.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Spy on the warn the runUnscoped audit emits (tenant-scope → getLogger().warn).
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock("../../src/lib/logger", () => ({
  getLogger: () => mockLogger,
  Logger: class {},
}));

import {
  createDiscoverDb,
  planDiscoverOp,
  invalidCrossTenantReadModels,
  DiscoverGuardError,
  DISCOVER_CORE_ALLOWLIST,
} from "../../src/lib/extension-discover-db.js";

const ALLOWED = new Set(["post", "postTaxonomyTag", "taxonomyTaxon", "taxonomyCategory", "taxonomyDimension"]);

/** Fake raw prisma: each delegate records the args it received. */
function makeRawPrisma(rows: Record<string, unknown[]> = {}) {
  const mk = (model: string) => ({
    findMany: vi.fn().mockResolvedValue(rows[model] ?? []),
    findFirst: vi.fn().mockResolvedValue((rows[model] ?? [])[0] ?? null),
    count: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockResolvedValue({}),
    groupBy: vi.fn().mockResolvedValue([]),
  });
  return {
    post: mk("post"),
    postTaxonomyTag: mk("postTaxonomyTag"),
    taxonomyTaxon: mk("taxonomyTaxon"),
    taxonomyCategory: mk("taxonomyCategory"),
    taxonomyDimension: mk("taxonomyDimension"),
  } as any;
}

function db(raw: any, reason = "product-reco", region = "EU") {
  return createDiscoverDb(raw, "dog", reason, ALLOWED, region);
}

describe("extension discover() — Part B", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("reason validation", () => {
    it("throws on an empty or free-text reason", () => {
      const raw = makeRawPrisma();
      expect(() => db(raw, "")).toThrow(DiscoverGuardError);
      expect(() => db(raw, "Bad Reason!")).toThrow(DiscoverGuardError);
      expect(() => db(raw, "ok")).toThrow(DiscoverGuardError); // < 3 chars
      expect(() => db(raw, "product-reco")).not.toThrow();
    });
  });

  describe("read-only + model gate", () => {
    it("exposes only the five read methods; write methods are absent", () => {
      const d = db(makeRawPrisma());
      expect(typeof (d.post as any).findMany).toBe("function");
      expect((d.post as any).deleteMany).toBeUndefined();
      expect((d.post as any).create).toBeUndefined();
      expect((d.post as any).update).toBeUndefined();
    });

    it("blocks an undeclared / never-allowed model (fail-closed)", () => {
      const d = db(makeRawPrisma());
      expect(() => (d as any).user.findMany()).toThrow(DiscoverGuardError);
      expect(() => (d as any).tenant.findMany()).toThrow(DiscoverGuardError);
      // A core-allow-list model the extension did NOT declare is still blocked.
      expect(() => (d as any).productTaxonomyTag.findMany()).toThrow(DiscoverGuardError);
    });
  });

  describe("projection guard", () => {
    it("rejects include and relation select", async () => {
      const d = db(makeRawPrisma());
      await expect(d.post.findMany({ include: { author: true } } as any)).rejects.toThrow(DiscoverGuardError);
      await expect(d.post.findMany({ select: { author: { select: { id: true } } } } as any)).rejects.toThrow(DiscoverGuardError);
    });
  });

  describe("relation-where guard (the load-bearing one)", () => {
    it("throws on relation traversal to a non-declared model", async () => {
      const d = db(makeRawPrisma());
      await expect(d.post.findMany({ where: { author: { email: { startsWith: "a" } } } } as any)).rejects.toThrow(DiscoverGuardError);
      await expect(d.post.findMany({ where: { tenant: { id: "x" } } } as any)).rejects.toThrow(DiscoverGuardError);
    });

    it("allows relation traversal to a declared model", async () => {
      const raw = makeRawPrisma();
      const d = db(raw);
      await expect(
        d.post.findMany({ where: { taxonomyTags: { some: { taxonId: "category:dim:t" } } } } as any),
      ).resolves.toEqual([]);
      expect(raw.post.findMany).toHaveBeenCalledOnce();
    });

    it("walks nested AND/OR and deep relation chains", async () => {
      const raw = makeRawPrisma();
      const d = db(raw);
      // taxonomyTaxon → category → dimension, all declared → allowed
      await expect(
        d.taxonomyTaxon.findMany({
          where: { OR: [{ category: { dimension: { id: "d" } } }, { isActive: true }] },
        } as any),
      ).resolves.toEqual([]);
      // one branch traverses to a non-declared model → throws
      await expect(
        d.post.findMany({ where: { AND: [{ radius: "SHOUT" }, { author: { id: "u" } }] } } as any),
      ).rejects.toThrow(DiscoverGuardError);
    });
  });

  describe("baseline visibility floor", () => {
    it("applies the post floor to an empty where (zero WHISPER rows by construction)", async () => {
      // Mirrors andTenant: no caller `where` → the floor is the whole `where`.
      const raw = makeRawPrisma();
      await db(raw).post.findMany();
      const args = raw.post.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        deletedAt: null,
        hiddenByAuthor: false,
        radius: "SHOUT",
        dataRegion: "EU",
      });
    });

    it("is non-overridable — a caller radius still AND-s with SHOUT", async () => {
      const raw = makeRawPrisma();
      await db(raw).post.findMany({ where: { radius: "NORMAL" } } as any);
      const args = raw.post.findMany.mock.calls[0][0];
      expect(args.where.AND[0]).toEqual({ radius: "NORMAL" });
      expect(args.where.AND[1].radius).toBe("SHOUT");
    });

    it("applies the floor on every read method, not just findMany", async () => {
      const raw = makeRawPrisma();
      const d = db(raw);
      await d.post.count();
      await d.post.aggregate({ _count: true } as any);
      await d.post.groupBy({ by: ["radius"] } as any);
      for (const fn of [raw.post.count, raw.post.aggregate, raw.post.groupBy]) {
        expect(fn.mock.calls[0][0].where.radius).toBe("SHOUT");
      }
    });

    it("uses the caller region in the floor", async () => {
      const raw = makeRawPrisma();
      await db(raw, "post-reco", "US").post.findMany();
      expect(raw.post.findMany.mock.calls[0][0].where.dataRegion).toBe("US");
    });

    it("floors taxonomyTaxon to isActive", async () => {
      const raw = makeRawPrisma();
      await db(raw).taxonomyTaxon.findMany();
      expect(raw.taxonomyTaxon.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
    });
  });

  describe("column allow-list", () => {
    it("rejects select of an excluded column", async () => {
      const d = db(makeRawPrisma());
      await expect(d.post.findMany({ select: { tenantId: true } } as any)).rejects.toThrow(DiscoverGuardError);
      await expect(d.post.findMany({ select: { authorId: true } } as any)).rejects.toThrow(DiscoverGuardError);
    });

    it("rejects groupBy of an excluded column", async () => {
      const d = db(makeRawPrisma());
      await expect(d.post.groupBy({ by: ["tenantId"] } as any)).rejects.toThrow(DiscoverGuardError);
    });

    it("strips excluded columns from result rows (no-select case)", async () => {
      const raw = makeRawPrisma({
        post: [
          { id: "p1", text: "hi", radius: "SHOUT", tenantId: "t1", authorId: "u1", geoData: { lat: 1 }, uri: "x" },
        ],
      });
      const out = (await db(raw).post.findMany()) as any[];
      expect(out[0]).toEqual({ id: "p1", text: "hi", radius: "SHOUT" });
      expect(out[0].tenantId).toBeUndefined();
      expect(out[0].authorId).toBeUndefined();
      expect(out[0].geoData).toBeUndefined();
    });
  });

  describe("abuse caps", () => {
    it("defaults and clamps take on findMany", async () => {
      const raw = makeRawPrisma();
      const d = db(raw);
      await d.post.findMany();
      expect(raw.post.findMany.mock.calls[0][0].take).toBe(50);
      await d.post.findMany({ take: 500 } as any);
      expect(raw.post.findMany.mock.calls[1][0].take).toBe(200);
    });

    it("rejects deep skip pagination", async () => {
      await expect(db(makeRawPrisma()).post.findMany({ skip: 5000 } as any)).rejects.toThrow(DiscoverGuardError);
    });
  });

  describe("audit", () => {
    it("wraps every executed read in a runUnscoped warn with ext:<id>:<reason>", async () => {
      const raw = makeRawPrisma();
      await db(raw, "product-filter").post.findMany();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "[tenant-scope] unscoped (cross-tenant) execution",
        { reason: "ext:dog:product-filter" },
      );
    });
  });

  describe("registration validation (pure)", () => {
    it("flags models outside the core allow-list ∪ own models", () => {
      expect(invalidCrossTenantReadModels(["user"], [])).toEqual(["user"]);
      expect(invalidCrossTenantReadModels(["entity"], [])).toEqual(["entity"]);
      expect(invalidCrossTenantReadModels(["post", "productTaxonomyTag"], [])).toEqual([]);
      expect(invalidCrossTenantReadModels(["dogReminder"], ["dogReminder"])).toEqual([]);
      expect(invalidCrossTenantReadModels(undefined, [])).toEqual([]);
    });

    it("core allow-list is catalog/content only (never user/tenant/entity)", () => {
      for (const forbidden of ["user", "tenant", "tenantMember", "entity"]) {
        expect(DISCOVER_CORE_ALLOWLIST.has(forbidden)).toBe(false);
      }
    });
  });

  describe("planDiscoverOp (pure) is directly testable", () => {
    it("returns rewritten args + strip columns without I/O", () => {
      const plan = planDiscoverOp("post", "findMany", { where: { radius: "SHOUT" } }, ALLOWED, "EU");
      expect(plan.args.take).toBe(50);
      expect(plan.stripColumns.has("tenantId")).toBe(true);
      expect(plan.stripColumns.has("authorId")).toBe(true);
    });
  });
});
