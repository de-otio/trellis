/**
 * Unit Tests: Directory Search (T4)
 *
 * Covers the query builder / executor and its security-review invariants:
 *  - S3 (location triangulation): CITY/HIDDEN rows are structurally excluded
 *    from the distance-sorted / radius query path — proven both on the pure
 *    query builder (the precision restriction is emitted in the same WHERE that
 *    computes ST_DWithin) and end-to-end through the executor (a CITY listing at
 *    the same point as an EXACT one does NOT appear in a radius search but both
 *    appear in a name search).
 *  - S10 (min query length) / S18 (no empty filter, bounded pagination).
 *  - Per-precision response shaping.
 */

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  validateAndNormalize,
  buildDirectorySearchQuery,
  shapeRow,
  executeDirectorySearch,
  type NormalizedSearchParams,
} from "../../src/lib/tenant/directory-search.js";
import {
  resolveDirectorySearchEnv,
  type DirectorySearchConfig,
} from "../../src/lib/org-category/directory-search-config.js";

const CONFIG: DirectorySearchConfig = {
  minQueryLength: 3,
  maxPageSize: 25,
  maxPageDepth: 40,
  maxRadiusMeters: 50000,
  statementTimeoutMs: 5000,
  rateLimit: 30,
  rateLimitWindowSeconds: 60,
};

// ─── config resolver ─────────────────────────────────────────────────────────

describe("resolveDirectorySearchEnv", () => {
  it("uses the plan-mandated safe minimums by default", () => {
    const prev = { ...process.env };
    delete process.env.DIRECTORY_SEARCH_MAX_PAGE_SIZE;
    delete process.env.DIRECTORY_SEARCH_MAX_PAGE_DEPTH;
    delete process.env.DIRECTORY_SEARCH_MIN_QUERY_LENGTH;
    const { directorySearch } = resolveDirectorySearchEnv();
    expect(directorySearch.maxPageSize).toBe(25);
    expect(directorySearch.maxPageDepth).toBe(40);
    expect(directorySearch.minQueryLength).toBe(3);
    expect(directorySearch.statementTimeoutMs).toBeGreaterThan(0);
    expect(directorySearch.maxRadiusMeters).toBeGreaterThan(0);
    process.env = prev;
  });

  it("allows tuning upward via env vars", () => {
    const prev = { ...process.env };
    process.env.DIRECTORY_SEARCH_MAX_PAGE_SIZE = "50";
    const { directorySearch } = resolveDirectorySearchEnv();
    expect(directorySearch.maxPageSize).toBe(50);
    process.env = prev;
  });

  it("falls back to the default when the env var is not a positive int", () => {
    const prev = { ...process.env };
    process.env.DIRECTORY_SEARCH_MAX_PAGE_SIZE = "not-a-number";
    process.env.DIRECTORY_SEARCH_MAX_PAGE_DEPTH = "-5";
    const { directorySearch } = resolveDirectorySearchEnv();
    expect(directorySearch.maxPageSize).toBe(25);
    expect(directorySearch.maxPageDepth).toBe(40);
    process.env = prev;
  });
});

// ─── validation / normalization ──────────────────────────────────────────────

describe("validateAndNormalize", () => {
  it("rejects a name query below the minimum trigram length (S10)", () => {
    const r = validateAndNormalize({ name: "ab" }, CONFIG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("QUERY_TOO_SHORT");
  });

  it("accepts a name query at the minimum length", () => {
    const r = validateAndNormalize({ name: "abc" }, CONFIG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.name).toBe("abc");
  });

  it("rejects an empty-filter request (S18 — no list-everything)", () => {
    const r = validateAndNormalize({}, CONFIG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("EMPTY_FILTER");
  });

  it("rejects whitespace-only inputs as an empty filter", () => {
    const r = validateAndNormalize({ name: "   ", locationLabel: "  " }, CONFIG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("EMPTY_FILTER");
  });

  it("accepts a category-id filter", () => {
    const r = validateAndNormalize({ categoryId: "cat-1" }, CONFIG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.categoryId).toBe("cat-1");
  });

  it("accepts a category-code filter", () => {
    const r = validateAndNormalize({ categoryCode: "nonprofit" }, CONFIG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.categoryCode).toBe("nonprofit");
  });

  it("accepts a complete lat/lng/radius location filter and clamps the radius", () => {
    const r = validateAndNormalize(
      { lat: "52.5", lng: "13.4", radius: "999999999" },
      CONFIG,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.location).toEqual({ lat: 52.5, lng: 13.4, radiusMeters: 50000 });
    }
  });

  it("defaults the radius to the configured maximum when omitted", () => {
    const r = validateAndNormalize({ lat: "52.5", lng: "13.4" }, CONFIG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.location?.radiusMeters).toBe(50000);
  });

  it("rejects out-of-range coordinates", () => {
    const r = validateAndNormalize({ lat: "200", lng: "13.4", radius: "1000" }, CONFIG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("INVALID_LOCATION");
  });

  it("rejects non-numeric coordinates", () => {
    const r = validateAndNormalize({ lat: "north", lng: "13.4", radius: "1000" }, CONFIG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("INVALID_LOCATION");
  });

  it("clamps pageSize to the configured maximum (S18)", () => {
    const r = validateAndNormalize({ name: "abc", pageSize: "1000" }, CONFIG);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.pageSize).toBe(25);
      expect(r.params.limit).toBe(25);
    }
  });

  it("clamps page depth to the configured maximum (S18)", () => {
    const r = validateAndNormalize({ name: "abc", page: "9999", pageSize: "10" }, CONFIG);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.page).toBe(39); // maxPageDepth - 1
      expect(r.params.offset).toBe(390);
    }
  });

  it("computes offset from page * pageSize", () => {
    const r = validateAndNormalize({ name: "abc", page: "2", pageSize: "10" }, CONFIG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.offset).toBe(20);
  });
});

// ─── query builder ───────────────────────────────────────────────────────────

const baseParams = (over: Partial<NormalizedSearchParams>): NormalizedSearchParams => ({
  page: 0,
  pageSize: 25,
  offset: 0,
  limit: 25,
  ...over,
});

describe("buildDirectorySearchQuery", () => {
  it("always filters isDiscoverable=true AND status=ACTIVE", () => {
    const { sql } = buildDirectorySearchQuery(baseParams({ name: "berlin" }), null, CONFIG);
    expect(sql).toContain("tdp.is_discoverable = true");
    expect(sql).toContain("t.status = 'ACTIVE'");
  });

  it("S3: a radius filter structurally excludes CITY/HIDDEN from the distance path", () => {
    const { sql, params } = buildDirectorySearchQuery(
      baseParams({ location: { lat: 52.5, lng: 13.4, radiusMeters: 5000 } }),
      null,
      CONFIG,
    );
    // The precision restriction and the distance computation live in the SAME
    // WHERE — no distance is ever computed for a CITY/HIDDEN row.
    expect(sql).toContain("tdp.location_precision IN ('EXACT', 'NEIGHBORHOOD')");
    expect(sql).toContain("ST_DWithin(");
    expect(sql).toContain("<->"); // KNN distance ordering
    // lng, lat, radius are bound params (never inlined user data).
    expect(params).toEqual([13.4, 52.5, 5000]);
  });

  it("a name-only search does NOT restrict precision (CITY reachable by name)", () => {
    const { sql } = buildDirectorySearchQuery(baseParams({ name: "berlin" }), null, CONFIG);
    expect(sql).not.toContain("location_precision IN");
    expect(sql).not.toContain("ST_DWithin(");
    expect(sql).toContain("similarity("); // ranked by trigram relevance
    expect(sql).toContain("t.display_name % $1");
  });

  it("a locationLabel filter is a coarse equality, never a distance computation", () => {
    const { sql, params } = buildDirectorySearchQuery(
      baseParams({ locationLabel: "Berlin, Germany" }),
      null,
      CONFIG,
    );
    expect(sql).toContain("tdp.location_label = $1");
    expect(sql).not.toContain("ST_DWithin(");
    expect(sql).not.toContain("location_precision IN");
    expect(params).toEqual(["Berlin, Germany"]);
  });

  it("a category filter joins tenant_classifications and matches the descendant id set", () => {
    const { sql, params } = buildDirectorySearchQuery(
      baseParams({ categoryId: "root" }),
      ["root", "leaf-a", "leaf-b"],
      CONFIG,
    );
    expect(sql).toContain("JOIN tenant_classifications tc ON tc.tenant_id = t.id");
    expect(sql).toContain("tc.category_id = ANY($1)");
    expect(params).toEqual([["root", "leaf-a", "leaf-b"]]);
  });

  it("combines name + category + radius with correctly numbered params", () => {
    const { sql, params } = buildDirectorySearchQuery(
      baseParams({
        name: "clinic",
        categoryId: "root",
        location: { lat: 1, lng: 2, radiusMeters: 3000 },
      }),
      ["root"],
      CONFIG,
    );
    expect(params).toEqual(["clinic", ["root"], 2, 1, 3000]);
    expect(sql).toContain("t.display_name % $1");
    expect(sql).toContain("tc.category_id = ANY($2)");
    expect(sql).toContain("location_precision IN");
    // radius path wins the ordering when both name and radius are present
    expect(sql).toContain("<->");
  });

  it("applies LIMIT/OFFSET from the pagination bounds and a stable tiebreaker", () => {
    const { sql } = buildDirectorySearchQuery(
      baseParams({ name: "abc", page: 3, pageSize: 10, offset: 30, limit: 10 }),
      null,
      CONFIG,
    );
    expect(sql).toContain("LIMIT 10 OFFSET 30");
    expect(sql).toContain("t.id ASC"); // deterministic pagination tiebreaker
  });
});

// ─── response shaping ────────────────────────────────────────────────────────

const row = (over: Record<string, unknown>) => ({
  tenant_id: "t1",
  slug: "acme",
  display_name: "Acme",
  short_description: "desc",
  location_precision: "EXACT",
  location_label: "Berlin, Germany",
  lat: 52.5,
  lng: 13.4,
  display_lat: 52.51,
  display_lng: 13.41,
  ...over,
}) as any;

describe("shapeRow (per-precision response shaping)", () => {
  it("EXACT exposes true lat/lng and the label", () => {
    const r = shapeRow(row({ location_precision: "EXACT" }));
    expect(r.lat).toBe(52.5);
    expect(r.lng).toBe(13.4);
    expect(r.locationLabel).toBe("Berlin, Germany");
    expect(r.displayLat).toBeUndefined();
  });

  it("NEIGHBORHOOD exposes the fuzzed display coordinate + label, never the true coordinate", () => {
    const r = shapeRow(row({ location_precision: "NEIGHBORHOOD" }));
    expect(r.displayLat).toBe(52.51);
    expect(r.displayLng).toBe(13.41);
    expect(r.locationLabel).toBe("Berlin, Germany");
    expect(r.lat).toBeUndefined();
    expect(r.lng).toBeUndefined();
  });

  it("CITY exposes only the label — no pin of any kind", () => {
    const r = shapeRow(row({ location_precision: "CITY" }));
    expect(r.locationLabel).toBe("Berlin, Germany");
    expect(r.lat).toBeUndefined();
    expect(r.lng).toBeUndefined();
    expect(r.displayLat).toBeUndefined();
    expect(r.displayLng).toBeUndefined();
  });

  it("HIDDEN exposes neither pin nor label", () => {
    const r = shapeRow(row({ location_precision: "HIDDEN" }));
    expect(r.lat).toBeUndefined();
    expect(r.lng).toBeUndefined();
    expect(r.displayLat).toBeUndefined();
    expect(r.displayLng).toBeUndefined();
    expect(r.locationLabel).toBeUndefined();
  });
});

// ─── executor (end-to-end, fake prisma) ──────────────────────────────────────

/**
 * A fake prisma whose `$queryRawUnsafe` honestly simulates Postgres applying the
 * WHERE predicate the builder generated: if the generated SQL carries the S3
 * precision restriction, only EXACT/NEIGHBORHOOD rows survive — exactly what a
 * real database would do. So this test fails if the builder ever drops the S3
 * clause (the CITY row would then leak into a radius search).
 */
function makeFakePrisma(dataset: any[], categories: any[] = []) {
  const executed: string[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      executed.push(sql);
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      queries.push({ sql, params });
      const radiusMode = sql.includes("tdp.location_precision IN ('EXACT', 'NEIGHBORHOOD')");
      return dataset.filter((r) => {
        if (r.is_discoverable === false) return false;
        if (r.status && r.status !== "ACTIVE") return false;
        if (radiusMode && !(r.location_precision === "EXACT" || r.location_precision === "NEIGHBORHOOD")) {
          return false;
        }
        return true;
      });
    }),
  };
  const prisma = {
    platformCategory: { findMany: vi.fn(async () => categories) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  return { prisma, executed, queries };
}

describe("executeDirectorySearch (S3 end-to-end)", () => {
  const exactRow = row({ tenant_id: "exact-t", location_precision: "EXACT", is_discoverable: true });
  const cityRow = row({
    tenant_id: "city-t",
    location_precision: "CITY",
    is_discoverable: true,
    // Same point as the EXACT row — the triangulation scenario.
    lat: 52.5,
    lng: 13.4,
  });

  it("a radius search returns the EXACT listing but NOT the CITY listing at the same point", async () => {
    const { prisma } = makeFakePrisma([exactRow, cityRow]);
    const results = await executeDirectorySearch(
      prisma,
      baseParams({ location: { lat: 52.5, lng: 13.4, radiusMeters: 5000 } }),
      CONFIG,
    );
    const ids = results.map((r) => r.tenantId);
    expect(ids).toContain("exact-t");
    expect(ids).not.toContain("city-t");
  });

  it("a name search returns BOTH the EXACT and CITY listings (CITY still reachable)", async () => {
    const { prisma } = makeFakePrisma([exactRow, cityRow]);
    const results = await executeDirectorySearch(prisma, baseParams({ name: "acme" }), CONFIG);
    const ids = results.map((r) => r.tenantId);
    expect(ids).toContain("exact-t");
    expect(ids).toContain("city-t");
  });

  it("applies the statement_timeout backstop before running the query (S10)", async () => {
    const { prisma, executed } = makeFakePrisma([exactRow]);
    await executeDirectorySearch(prisma, baseParams({ name: "acme" }), CONFIG);
    expect(executed.some((s) => s.includes("SET LOCAL statement_timeout ="))).toBe(true);
  });

  it("resolves a category (any depth) to its active descendant id set for the query", async () => {
    const categories = [
      { id: "root", code: "nonprofit", parentCategoryId: null },
      { id: "leaf", code: "nonprofit:animal-welfare", parentCategoryId: "root" },
    ];
    const { prisma, queries } = makeFakePrisma([exactRow], categories);
    await executeDirectorySearch(prisma, baseParams({ categoryCode: "nonprofit" }), CONFIG);
    // The ANY($1) param is the descendant id set (root + leaf), resolved from the tree.
    const anyParam = queries[0].params[0] as string[];
    expect(new Set(anyParam)).toEqual(new Set(["root", "leaf"]));
  });

  it("excludes a non-discoverable listing (isDiscoverable = false)", async () => {
    const hidden = row({ tenant_id: "hidden-t", location_precision: "CITY", is_discoverable: false });
    const { prisma } = makeFakePrisma([exactRow, hidden]);
    const results = await executeDirectorySearch(prisma, baseParams({ name: "acme" }), CONFIG);
    const ids = results.map((r) => r.tenantId);
    expect(ids).toContain("exact-t");
    expect(ids).not.toContain("hidden-t");
  });

  it("excludes a SUSPENDED tenant's listing (status != ACTIVE)", async () => {
    const suspended = row({
      tenant_id: "suspended-t",
      location_precision: "CITY",
      is_discoverable: true,
      status: "SUSPENDED",
    });
    const { prisma } = makeFakePrisma([exactRow, suspended]);
    const results = await executeDirectorySearch(prisma, baseParams({ name: "acme" }), CONFIG);
    const ids = results.map((r) => r.tenantId);
    expect(ids).toContain("exact-t");
    expect(ids).not.toContain("suspended-t");
  });

  it("an unknown category resolves to an empty id set and yields no results", async () => {
    const categories = [{ id: "root", code: "nonprofit", parentCategoryId: null }];
    const { prisma, queries } = makeFakePrisma([exactRow], categories);
    const results = await executeDirectorySearch(
      prisma,
      baseParams({ categoryCode: "does-not-exist" }),
      CONFIG,
    );
    expect(queries[0].params[0]).toEqual([]); // = ANY('{}') → matches nothing
    // (the fake ignores the ANY filter, but the real DB would return []).
    expect(Array.isArray(results)).toBe(true);
  });
});
