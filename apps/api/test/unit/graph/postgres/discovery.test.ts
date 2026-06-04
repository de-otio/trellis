/**
 * Unit Tests: PostgresGraphService — DiscoveryOps (B4)
 *
 * The Prisma client is mocked (`$queryRawUnsafe` returns canned rows), so these
 * run without a live DB. They assert the contract-level behaviour:
 *  - filter handling (entityType / breed / lifeStage bound as params, not interpolated)
 *  - hop-cap clamping (the recursive CTE never recurses past 2 hops)
 *  - already-related exclusion (the NOT EXISTS guard is present)
 *  - distance coarsening (exact metres never surfaced; only a band)
 *  - reason mapping (owner_proximity → shared_connections; signal merge/dedup)
 *  - tenant gating (no tenant in context → [])
 *
 * The recursive CTE itself needs a live DB — see the integration test under
 * test/integration/graph/discovery-postgres.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runWithTenantContext, tenantId } from "@de-otio/saas-foundation/tenant";
import { DiscoveryOps } from "../../../../src/lib/graph/postgres/discovery.js";
import type { EntityGeoLookup, NearbyEntity } from "../../../../src/lib/geo/entity-geo-repository.js";

const TEST_TENANT = tenantId("t-unit-pg-discovery");

// ---------------------------------------------------------------------------
// Mock Prisma — $queryRawUnsafe(sql, ...params)
// ---------------------------------------------------------------------------

const queryRawUnsafe = vi.fn();
const mockPrisma = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaClient;

/** The (sql, ...params) of the Nth $queryRawUnsafe call. */
function call(n: number): { sql: string; params: unknown[] } {
  const args = queryRawUnsafe.mock.calls[n] as unknown[];
  return { sql: args[0] as string, params: args.slice(1) };
}

// Fake geo lookup driven per-test.
let fakeNearby: NearbyEntity[] = [];
let fakeNearAnchors: NearbyEntity[] = [];
const findNearby = vi.fn(async () => fakeNearby);
const findNearAnchors = vi.fn(async () => fakeNearAnchors);
const fakeGeo: EntityGeoLookup = {
  findNearby,
  findNearAnchors,
  upsertLocation: vi.fn(async () => {}),
  removeLocation: vi.fn(async () => {}),
};

function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(TEST_TENANT, fn);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryRawUnsafe.mockReset();
  fakeNearby = [];
  fakeNearAnchors = [];
});

// ===========================================================================
// discoverByGraph
// ===========================================================================

describe("DiscoveryOps.discoverByGraph", () => {
  it("returns [] when no tenant is in context (does not query)", async () => {
    const ops = new DiscoveryOps(mockPrisma);
    const results = await ops.discoverByGraph("user-1", 2);
    expect(results).toEqual([]);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("maps rows to DiscoveryResult and coerces bigint hops to number", async () => {
    queryRawUnsafe.mockResolvedValueOnce([
      { entity_id: "e1", name: "Rocky", entity_type: "dog", breed: "Labrador", hops: 1n },
      { entity_id: "e2", name: "Daisy", entity_type: "dog", breed: null, hops: 2 },
    ]);
    const ops = new DiscoveryOps(mockPrisma);
    const results = await withTenant(() => ops.discoverByGraph("user-1", 2));

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ entityId: "e1", name: "Rocky", entityType: "dog", breed: "Labrador", hops: 1 });
    expect(typeof results[0].hops).toBe("number");
    expect(results[1]).toMatchObject({ entityId: "e2", name: "Daisy", entityType: "dog", hops: 2 });
    expect(results[1].breed).toBeUndefined();
  });

  it("binds userId + tenant as params (never interpolated) — injection-safe", async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    const ops = new DiscoveryOps(mockPrisma);
    const nasty = "user'; DROP TABLE entities;--";
    await withTenant(() => ops.discoverByGraph(nasty, 2));

    const { sql, params } = call(0);
    expect(params[0]).toBe(nasty);
    expect(params[1]).toBe(TEST_TENANT);
    expect(sql).toContain("$1");
    expect(sql).toContain("$2");
    expect(sql).not.toContain(nasty);
  });

  it("hard-caps hops at 2 even when the caller passes a larger value", async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    const ops = new DiscoveryOps(mockPrisma);
    await withTenant(() => ops.discoverByGraph("user-1", 99));

    const { sql } = call(0);
    // The recursion guard must be `hops < 2` (the clamp), never 99 or 3+.
    expect(sql).toContain("r.hops < 2");
    expect(sql).not.toContain("< 99");
    expect(sql).not.toContain("< 3");
  });

  it("caps hops at 1 when the caller passes 1 (recursion guard is hops < 1)", async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    const ops = new DiscoveryOps(mockPrisma);
    await withTenant(() => ops.discoverByGraph("user-1", 1));

    const { sql } = call(0);
    expect(sql).toContain("r.hops < 1");
    expect(sql).not.toContain("r.hops < 2");
  });

  it("excludes already-related entities via a NOT EXISTS guard on relationships", async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    const ops = new DiscoveryOps(mockPrisma);
    await withTenant(() => ops.discoverByGraph("user-1", 2));

    const { sql } = call(0);
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM relationships/);
  });

  it("excludes non-discoverable entities (metadata flag defaults to true)", async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    const ops = new DiscoveryOps(mockPrisma);
    await withTenant(() => ops.discoverByGraph("user-1", 2));

    const { sql } = call(0);
    expect(sql).toContain("COALESCE((d.metadata->>'discoverable')::boolean, true) = true");
  });

  it("traverses only CONFIRMED edges of the fixed label set", async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    const ops = new DiscoveryOps(mockPrisma);
    await withTenant(() => ops.discoverByGraph("user-1", 2));

    const { sql, params } = call(0);
    expect(sql).toContain("er.status = 'CONFIRMED'");
    // edge types bound as an array param ($3), not string-interpolated.
    expect(params[2]).toEqual(["PACK_MATE", "SIBLING", "PLAYMATE", "PARENT", "OFFSPRING", "WALK_BUDDY"]);
  });

  it("applies entityType / breed / lifeStage filters as bound params", async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    const ops = new DiscoveryOps(mockPrisma);
    await withTenant(() =>
      ops.discoverByGraph("user-1", 2, { entityType: "cat", breed: "Siamese", lifeStage: "kitten" }),
    );

    const { sql, params } = call(0);
    expect(sql).toContain("d.entity_type = $");
    expect(sql).toContain("d.metadata->>'breed' = $");
    expect(sql).toContain("d.life_stage = $");
    expect(params).toContain("cat");
    expect(params).toContain("Siamese");
    expect(params).toContain("kitten");
  });

  it("defaults the limit to 20 and binds a custom limit", async () => {
    queryRawUnsafe.mockResolvedValue([]);
    const ops = new DiscoveryOps(mockPrisma);

    await withTenant(() => ops.discoverByGraph("user-1", 2));
    expect(call(0).params[3]).toBe(20);

    await withTenant(() => ops.discoverByGraph("user-1", 2, { limit: 5 }));
    expect(call(1).params[3]).toBe(5);
  });
});

// ===========================================================================
// discoverNearby — proximity from PostGIS, fields/filters from Postgres graph facts
// ===========================================================================

describe("DiscoveryOps.discoverNearby", () => {
  it("returns [] when no geoLookup is wired", async () => {
    const ops = new DiscoveryOps(mockPrisma);
    const results = await withTenant(() => ops.discoverNearby("user-1", 48.2, 16.3, 5000));
    expect(results).toEqual([]);
    expect(findNearby).not.toHaveBeenCalled();
  });

  it("returns [] when no tenant is in context", async () => {
    const ops = new DiscoveryOps(mockPrisma, fakeGeo);
    const results = await ops.discoverNearby("user-1", 48.2, 16.3, 5000);
    expect(results).toEqual([]);
    expect(findNearby).not.toHaveBeenCalled();
  });

  it("delegates proximity to PostGIS (tenant, lat, lng, radius), over-fetching", async () => {
    fakeNearby = [];
    const ops = new DiscoveryOps(mockPrisma, fakeGeo);
    await withTenant(() => ops.discoverNearby("user-1", 48.2082, 16.3738, 5000, { limit: 10 }));

    expect(findNearby).toHaveBeenCalledTimes(1);
    const [tenant, lat, lng, radius, fetchLimit] = findNearby.mock.calls[0] as unknown as [
      string, number, number, number, number,
    ];
    expect(tenant).toBe(TEST_TENANT);
    expect(lat).toBe(48.2082);
    expect(lng).toBe(16.3738);
    expect(radius).toBe(5000);
    expect(fetchLimit).toBe(40); // limit * 4, capped at 200
    // No graph query runs when there are no candidates.
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("SECURITY: returns coarse bands only, never exact distanceMeters", async () => {
    fakeNearby = [
      { entityId: "e1", distanceMeters: 300 },
      { entityId: "e2", distanceMeters: 800 },
      { entityId: "e3", distanceMeters: 1500 },
      { entityId: "e4", distanceMeters: 3000 },
      { entityId: "e5", distanceMeters: 7000 },
    ];
    queryRawUnsafe.mockResolvedValueOnce([
      { entity_id: "e1", name: "Rocky", entity_type: "dog", breed: "Poodle" },
      { entity_id: "e2", name: "Bella", entity_type: "dog", breed: null },
      { entity_id: "e3", name: "Max", entity_type: "dog", breed: "Husky" },
      { entity_id: "e4", name: "Luna", entity_type: "dog", breed: null },
      { entity_id: "e5", name: "Coco", entity_type: "dog", breed: null },
    ]);
    const ops = new DiscoveryOps(mockPrisma, fakeGeo);
    const results = await withTenant(() => ops.discoverNearby("user-1", 48.2, 16.3, 10000));

    expect(results.map((r) => r.distanceBand)).toEqual([
      "< 500m", "500m-1km", "1-2km", "2-5km", "> 5km",
    ]);
    for (const r of results) expect(r.distanceMeters).toBeUndefined();
  });

  it("preserves PostGIS distance order and drops candidates the graph filtered out", async () => {
    fakeNearby = [
      { entityId: "near", distanceMeters: 100 },
      { entityId: "filtered", distanceMeters: 200 }, // not returned by the field query
      { entityId: "far", distanceMeters: 900 },
    ];
    queryRawUnsafe.mockResolvedValueOnce([
      { entity_id: "near", name: "A", entity_type: "dog", breed: null },
      { entity_id: "far", name: "B", entity_type: "dog", breed: null },
    ]);
    const ops = new DiscoveryOps(mockPrisma, fakeGeo);
    const results = await withTenant(() => ops.discoverNearby("user-1", 48.2, 16.3, 5000));

    expect(results.map((r) => r.entityId)).toEqual(["near", "far"]);
  });

  it("the graph-facts query excludes already-related + non-discoverable and binds the id set", async () => {
    fakeNearby = [{ entityId: "e1", distanceMeters: 100 }];
    queryRawUnsafe.mockResolvedValueOnce([{ entity_id: "e1", name: "A", entity_type: "dog", breed: null }]);
    const ops = new DiscoveryOps(mockPrisma, fakeGeo);
    await withTenant(() => ops.discoverNearby("user-1", 48.2, 16.3, 5000, { entityType: "dog", breed: "Husky" }));

    const { sql, params } = call(0);
    expect(sql).toContain("d.id = ANY($3)");
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM relationships/);
    expect(sql).toContain("COALESCE((d.metadata->>'discoverable')::boolean, true) = true");
    expect(params[0]).toBe("user-1");
    expect(params[1]).toBe(TEST_TENANT);
    expect(params[2]).toEqual(["e1"]);
    expect(params).toContain("dog");
    expect(params).toContain("Husky");
  });

  it("honours the result limit after filtering", async () => {
    fakeNearby = [
      { entityId: "e1", distanceMeters: 100 },
      { entityId: "e2", distanceMeters: 200 },
      { entityId: "e3", distanceMeters: 300 },
    ];
    queryRawUnsafe.mockResolvedValueOnce([
      { entity_id: "e1", name: "A", entity_type: "dog", breed: null },
      { entity_id: "e2", name: "B", entity_type: "dog", breed: null },
      { entity_id: "e3", name: "C", entity_type: "dog", breed: null },
    ]);
    const ops = new DiscoveryOps(mockPrisma, fakeGeo);
    const results = await withTenant(() => ops.discoverNearby("user-1", 48.2, 16.3, 5000, { limit: 2 }));
    expect(results).toHaveLength(2);
  });
});

// ===========================================================================
// getRecommendations — signal merge + reason mapping
// ===========================================================================

describe("DiscoveryOps.getRecommendations", () => {
  it("returns [] when no tenant is in context", async () => {
    const ops = new DiscoveryOps(mockPrisma, fakeGeo);
    const results = await ops.getRecommendations("user-1", 10);
    expect(results).toEqual([]);
  });

  it("merges shared-connections + same-breed + nearby, dedups keeping the highest score", async () => {
    // call 0: shared-connections CTE; call 1: same-breed; nearby uses geo.
    queryRawUnsafe
      .mockResolvedValueOnce([
        { entity_id: "shared", name: "Shared", entity_type: "dog", score: 0.9 },
        { entity_id: "dup", name: "Dup", entity_type: "dog", score: 0.3 }, // lower than the breed signal
      ])
      .mockResolvedValueOnce([
        { entity_id: "breedonly", name: "BreedOnly", entity_type: "dog" },
        { entity_id: "dup", name: "Dup", entity_type: "dog" }, // 0.6 wins over the 0.3 shared score
      ]);
    // anchors query (nearby) then no candidates.
    queryRawUnsafe.mockResolvedValueOnce([]); // anchors
    fakeNearAnchors = [];

    const ops = new DiscoveryOps(mockPrisma, fakeGeo);
    const results = await withTenant(() => ops.getRecommendations("user-1", 10));

    const byId = new Map(results.map((r) => [r.entityId, r]));
    expect(byId.get("shared")?.reason).toBe("shared_connections");
    expect(byId.get("breedonly")?.reason).toBe("same_breed");
    // dup appeared in both signals; the higher (0.6 same-breed) wins.
    expect(byId.get("dup")?.reason).toBe("same_breed");
    expect(byId.get("dup")?.confidence).toBeCloseTo(0.6);
    // sorted by score desc.
    expect(results[0].entityId).toBe("shared");
  });

  it("includes the nearby signal and maps it to reason 'nearby'", async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([]) // shared-connections
      .mockResolvedValueOnce([]); // same-breed
    queryRawUnsafe.mockResolvedValueOnce([{ id: "anchor-1" }]); // anchors
    fakeNearAnchors = [{ entityId: "n1", distanceMeters: 1000 }];
    queryRawUnsafe.mockResolvedValueOnce([
      { entity_id: "n1", name: "Nearby", entity_type: "dog", breed: null },
    ]); // fetchDiscoverableFields

    const ops = new DiscoveryOps(mockPrisma, fakeGeo);
    const results = await withTenant(() => ops.getRecommendations("user-1", 10));

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ entityId: "n1", reason: "nearby" });
    // score = (1 - 1000/10000) * 0.5 = 0.45
    expect(results[0].confidence).toBeCloseTo(0.45);
  });

  it("clamps confidence into [0,1]", async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{ entity_id: "hot", name: "Hot", entity_type: "dog", score: 5.0 }]) // shared (5 shared → 0.5? no, raw 5.0)
      .mockResolvedValueOnce([]);
    queryRawUnsafe.mockResolvedValueOnce([]); // anchors
    fakeNearAnchors = [];

    const ops = new DiscoveryOps(mockPrisma, fakeGeo);
    const results = await withTenant(() => ops.getRecommendations("user-1", 10));
    expect(results[0].confidence).toBe(1.0);
  });

  it("respects the limit after merge", async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([
        { entity_id: "a", name: "A", entity_type: "dog", score: 0.9 },
        { entity_id: "b", name: "B", entity_type: "dog", score: 0.8 },
        { entity_id: "c", name: "C", entity_type: "dog", score: 0.7 },
      ])
      .mockResolvedValueOnce([]);
    queryRawUnsafe.mockResolvedValueOnce([]); // anchors
    fakeNearAnchors = [];

    const ops = new DiscoveryOps(mockPrisma, fakeGeo);
    const results = await withTenant(() => ops.getRecommendations("user-1", 2));
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.entityId)).toEqual(["a", "b"]);
  });

  it("shared-connections CTE excludes already-owned + already-related candidates", async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([]) // shared
      .mockResolvedValueOnce([]); // breed
    queryRawUnsafe.mockResolvedValueOnce([]); // anchors
    fakeNearAnchors = [];

    const ops = new DiscoveryOps(mockPrisma, fakeGeo);
    await withTenant(() => ops.getRecommendations("user-1", 10));

    const sharedSql = call(0).sql;
    expect(sharedSql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM relationships/);
    expect(sharedSql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM entity_ownerships/);
    expect(sharedSql).toContain("er.status = 'CONFIRMED'");
  });
});
