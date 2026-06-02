/**
 * Unit Tests: Neo4jGraphService — Entity Discovery Queries
 *
 * Tests for:
 * - discoverByGraph (multi-hop traversal)
 * - discoverNearby (PostGIS proximity merged with graph facts)
 * - getRecommendations (multi-signal merge)
 *
 * The Neo4j driver is mocked so these tests run without a live graph instance.
 * Proximity is PostGIS's job (EntityGeoRepository, verified in its own suite) —
 * a fake EntityGeoLookup is injected here, and the discoverNearby / nearby-
 * recommendation merge against real Neo4j is covered by discovery-scoring.integration.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock neo4j-driver before any imports that use it
// ---------------------------------------------------------------------------

const { mockRun, mockClose, mockSession } = vi.hoisted(() => {
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockRun = vi.fn();
  const mockSession = vi.fn(() => ({ run: mockRun, close: mockClose }));
  return { mockRun, mockClose, mockSession };
});

vi.mock("neo4j-driver", () => ({
  default: {
    driver: vi.fn(() => ({
      verifyConnectivity: vi.fn().mockResolvedValue(undefined),
      session: mockSession,
      close: vi.fn().mockResolvedValue(undefined),
    })),
    auth: {
      basic: vi.fn((user: string, pass: string) => ({ scheme: "basic", principal: user, credentials: pass })),
    },
    // Static SKIP/LIMIT params are passed as neo4j.int(n); identity is enough
    // for unit assertions (the real driver returns an Integer wrapper).
    int: (n: number) => n,
  },
}));

// Mock schema init — we don't want it to run during discovery tests
vi.mock("../../../src/lib/graph/graph-schema-init", () => ({
  initGraphSchema: vi.fn().mockResolvedValue(undefined),
}));

import { Neo4jGraphService } from "../../../src/lib/graph/neo4j-graph-service.js";
import type { DiscoveryFilters, NearbyFilters } from "../../../src/lib/graph/types.js";
import type { EntityGeoLookup, NearbyEntity } from "../../../src/lib/geo/entity-geo-repository.js";
import { runWithTenantContext, tenantId } from "@de-otio/saas-foundation/tenant";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a fake Neo4j record that returns values by field name. */
function makeRecord(fields: Record<string, unknown>) {
  return {
    get: (key: string) => {
      if (!(key in fields)) throw new Error(`Field not found: ${key}`);
      return fields[key];
    },
  };
}

/** Build a mock QueryResult with the given row objects. */
function makeQueryResult(rows: Record<string, unknown>[]) {
  return { records: rows.map(makeRecord) };
}

// Fake geo lookup — tests drive `fakeNearby` / `fakeNearAnchors`; the writes
// are spies (no PostGIS here).
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
const TEST_TENANT = tenantId("t-unit-discovery");

async function createConnectedService(geo?: EntityGeoLookup): Promise<Neo4jGraphService> {
  const svc = new Neo4jGraphService(geo);
  await svc.connect({
    endpoint: "bolt://localhost:7687",
    auth: { type: "basic", username: "neo4j", password: "test" },
  });
  return svc;
}

// ---------------------------------------------------------------------------
// discoverByGraph
// ---------------------------------------------------------------------------

describe("Neo4jGraphService.discoverByGraph", () => {
  let service: Neo4jGraphService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRun.mockReset();
    service = await createConnectedService();
  });

  it("returns discovered entities with hops field", async () => {
    mockRun.mockResolvedValueOnce(
      makeQueryResult([
        { entityId: "entity-1", name: "Rocky", entityType: "dog", breed: "Labrador", hops: 1 },
        { entityId: "entity-2", name: "Daisy", entityType: "dog", breed: null, hops: 2 },
      ]),
    );

    const results = await service.discoverByGraph("user-1", 2);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      entityId: "entity-1",
      name: "Rocky",
      entityType: "dog",
      breed: "Labrador",
      hops: 1,
    });
    expect(results[1]).toMatchObject({ entityId: "entity-2", name: "Daisy", entityType: "dog", hops: 2 });
    expect(results[1].breed).toBeUndefined();
  });

  it("returns empty array when no entities discovered", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    const results = await service.discoverByGraph("user-1", 2);

    expect(results).toHaveLength(0);
  });

  it("hard-caps hops at 2 even when caller passes a larger value", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    await service.discoverByGraph("user-1", 99);

    const queryCalled = mockRun.mock.calls[0][0] as string;
    expect(queryCalled).not.toContain("*1..99");
    expect(queryCalled).not.toContain("*3");
    expect(queryCalled).toMatch(/\*1\.\.2|\*1[^\.]/);
  });

  it("caps hops at 1 when caller passes 1", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    await service.discoverByGraph("user-1", 1);

    const queryCalled = mockRun.mock.calls[0][0] as string;
    expect(queryCalled).not.toContain("1..2");
  });

  it("passes userId as a parameter (never interpolated)", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    const userId = "user-with-special-chars'; DROP TABLE users;--";
    await service.discoverByGraph(userId, 2);

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.userId).toBe(userId);
    const query = mockRun.mock.calls[0][0] as string;
    expect(query).toContain("$userId");
    expect(query).not.toContain(userId);
  });

  it("applies entityType filter via parameter", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    const filters: DiscoveryFilters = { entityType: "cat", hops: 2 };
    await service.discoverByGraph("user-1", 2, filters);

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.entityType).toBe("cat");
    expect(mockRun.mock.calls[0][0] as string).toContain("$entityType");
  });

  it("applies breed filter via parameter", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    const filters: DiscoveryFilters = { breed: "Labrador", hops: 2 };
    await service.discoverByGraph("user-1", 2, filters);

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.breed).toBe("Labrador");
    expect(mockRun.mock.calls[0][0] as string).toContain("$breed");
  });

  it("applies lifeStage filter via parameter", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    const filters: DiscoveryFilters = { lifeStage: "puppy", hops: 2 };
    await service.discoverByGraph("user-1", 2, filters);

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.lifeStage).toBe("puppy");
  });

  it("applies limit filter via parameter with default of 20", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));
    await service.discoverByGraph("user-1", 2);

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.limit).toBe(20);
  });

  it("applies custom limit via filters", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));
    await service.discoverByGraph("user-1", 2, { limit: 5 });

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.limit).toBe(5);
  });

  it("excludes non-discoverable entities via query clause", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));
    await service.discoverByGraph("user-1", 2);

    expect(mockRun.mock.calls[0][0] as string).toContain("discoverable");
  });

  it("excludes entities already in user's graph via a Neptune-portable pattern predicate", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));
    await service.discoverByGraph("user-1", 2);

    const query = mockRun.mock.calls[0][0] as string;
    expect(query).toContain("RELATES_TO");
    // C2a: pattern predicate, not the Neptune-incompatible EXISTS { } subquery.
    expect(query).toMatch(/NOT \(me\)-\[:RELATES_TO\]/);
    expect(query).not.toContain("EXISTS {");
  });

  it("uses PLAYMATE|PACK_MATE|SIBLING relationship types", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));
    await service.discoverByGraph("user-1", 2);

    const query = mockRun.mock.calls[0][0] as string;
    expect(query).toContain("PLAYMATE");
    expect(query).toContain("PACK_MATE");
    expect(query).toContain("SIBLING");
  });
});

// ---------------------------------------------------------------------------
// discoverNearby — proximity from PostGIS, fields/filters from the graph (C7)
// ---------------------------------------------------------------------------

describe("Neo4jGraphService.discoverNearby", () => {
  let service: Neo4jGraphService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRun.mockReset();
    fakeNearby = [];
    fakeNearAnchors = [];
    service = await createConnectedService(fakeGeo);
  });

  /** PostGIS returns these candidates; the graph filter returns these fields. */
  function withCandidates(
    candidates: NearbyEntity[],
    graphRows: Record<string, unknown>[],
  ) {
    fakeNearby = candidates;
    mockRun.mockResolvedValueOnce(makeQueryResult(graphRows));
  }

  const nearby = (userId: string, lat = 48.2, lng = 16.3, radius = 10000, filters?: NearbyFilters) =>
    runWithTenantContext(TEST_TENANT, () => service.discoverNearby(userId, lat, lng, radius, filters));

  it("returns entities with coarse distance bands (from the PostGIS distance)", async () => {
    withCandidates(
      [
        { entityId: "entity-1", distanceMeters: 300 },
        { entityId: "entity-2", distanceMeters: 800 },
        { entityId: "entity-3", distanceMeters: 1500 },
        { entityId: "entity-4", distanceMeters: 3000 },
        { entityId: "entity-5", distanceMeters: 7000 },
      ],
      [
        { entityId: "entity-1", name: "Rocky", entityType: "dog", breed: "Poodle" },
        { entityId: "entity-2", name: "Bella", entityType: "dog", breed: null },
        { entityId: "entity-3", name: "Max", entityType: "dog", breed: "Husky" },
        { entityId: "entity-4", name: "Luna", entityType: "dog", breed: null },
        { entityId: "entity-5", name: "Coco", entityType: "dog", breed: null },
      ],
    );

    const results = await nearby("user-1");

    expect(results[0].distanceBand).toBe("< 500m");
    expect(results[1].distanceBand).toBe("500m-1km");
    expect(results[2].distanceBand).toBe("1-2km");
    expect(results[3].distanceBand).toBe("2-5km");
    expect(results[4].distanceBand).toBe("> 5km");
  });

  it("SECURITY: never returns exact distanceMeters for unrelated entities", async () => {
    withCandidates(
      [{ entityId: "entity-1", distanceMeters: 123.456 }],
      [{ entityId: "entity-1", name: "Rocky", entityType: "dog", breed: null }],
    );

    const results = await nearby("user-1", 48.2, 16.3, 1000);

    expect(results[0].distanceMeters).toBeUndefined();
    expect(results[0].distanceBand).toBeDefined();
  });

  it("delegates proximity to PostGIS (tenant, lat, lng, radius), not the graph", async () => {
    fakeNearby = []; // no candidates → no graph query runs (don't queue one)

    await nearby("user-1", 48.2082, 16.3738, 5000);

    expect(findNearby).toHaveBeenCalledTimes(1);
    const [tenant, lat, lng, radius] = findNearby.mock.calls[0] as unknown as [string, number, number, number];
    expect(tenant).toBe(TEST_TENANT);
    expect(lat).toBe(48.2082);
    expect(lng).toBe(16.3738);
    expect(radius).toBe(5000);
  });

  it("the graph filter excludes already-related + non-discoverable, with no spatial Cypher", async () => {
    withCandidates(
      [{ entityId: "entity-1", distanceMeters: 100 }],
      [{ entityId: "entity-1", name: "Rocky", entityType: "dog", breed: null }],
    );

    await nearby("user-1", 0, 0, 1000);

    const query = mockRun.mock.calls[0][0] as string;
    expect(query).toContain("RELATES_TO");
    expect(query).toContain("discoverable");
    expect(query).not.toContain("point.distance");
    expect(query).not.toContain("point({latitude:");
    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.userId).toBe("user-1");
    expect(params.ids).toEqual(["entity-1"]);
  });

  it("applies entityType filter via parameter on the graph query", async () => {
    withCandidates(
      [{ entityId: "e1", distanceMeters: 100 }],
      [{ entityId: "e1", name: "Rocky", entityType: "dog", breed: null }],
    );

    await nearby("user-1", 0, 0, 1000, { entityType: "dog" });

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.entityType).toBe("dog");
  });

  it("applies breed filter via parameter on the graph query", async () => {
    withCandidates(
      [{ entityId: "e1", distanceMeters: 100 }],
      [{ entityId: "e1", name: "Rocky", entityType: "dog", breed: "Bernese Mountain Dog" }],
    );

    await nearby("user-1", 0, 0, 1000, { breed: "Bernese Mountain Dog" });

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.breed).toBe("Bernese Mountain Dog");
  });

  it("returns empty array (and runs no graph query) when PostGIS finds nothing", async () => {
    fakeNearby = [];

    const results = await nearby("user-1", 0, 0, 100);

    expect(results).toHaveLength(0);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("returns empty array when there is no tenant in context", async () => {
    fakeNearby = [{ entityId: "e1", distanceMeters: 100 }];

    // No runWithTenantContext wrapper → getCurrentTenantId() is undefined.
    const results = await service.discoverNearby("user-1", 0, 0, 1000);

    expect(results).toHaveLength(0);
    expect(findNearby).not.toHaveBeenCalled();
  });

  it("omits breed field when null", async () => {
    withCandidates(
      [{ entityId: "e1", distanceMeters: 200 }],
      [{ entityId: "e1", name: "Rocky", entityType: "dog", breed: null }],
    );

    const results = await nearby("user-1", 0, 0, 1000);

    expect(results[0].breed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getRecommendations
// ---------------------------------------------------------------------------

describe("Neo4jGraphService.getRecommendations", () => {
  let service: Neo4jGraphService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRun.mockReset();
    // No geo injected → the "nearby" signal is skipped here (it is exercised
    // end-to-end in discovery-scoring.integration). Only the two graph signals
    // (shared_connections, same_breed) run, in array order.
    service = await createConnectedService();
  });

  /** The two graph signals run via Promise.all in array order: shared, then breed. */
  function setupGraphSignals(
    sharedConnections: Record<string, unknown>[],
    sameBreed: Record<string, unknown>[],
  ) {
    mockRun
      .mockResolvedValueOnce(makeQueryResult(sharedConnections))
      .mockResolvedValueOnce(makeQueryResult(sameBreed));
  }

  it("returns recommendations sorted by confidence descending", async () => {
    setupGraphSignals(
      [
        { entityId: "e1", name: "Rocky", entityType: "dog", score: 0.8, reason: "shared_connections" },
        { entityId: "e3", name: "Cooper", entityType: "dog", score: 0.4, reason: "shared_connections" },
      ],
      [{ entityId: "e2", name: "Bella", entityType: "dog", score: 0.6, reason: "same_breed" }],
    );

    const results = await service.getRecommendations("user-1", 10);

    expect(results).toHaveLength(3);
    expect(results[0].confidence).toBeGreaterThanOrEqual(results[1].confidence);
    expect(results[1].confidence).toBeGreaterThanOrEqual(results[2].confidence);
  });

  it("deduplicates entities appearing in multiple signals (keeps highest score)", async () => {
    setupGraphSignals(
      [{ entityId: "entity-1", name: "Rocky", entityType: "dog", score: 0.8, reason: "shared_connections" }],
      [{ entityId: "entity-1", name: "Rocky", entityType: "dog", score: 0.6, reason: "same_breed" }],
    );

    const results = await service.getRecommendations("user-1", 10);

    expect(results).toHaveLength(1);
    expect(results[0].entityId).toBe("entity-1");
    expect(results[0].confidence).toBe(0.8);
    expect(results[0].reason).toBe("shared_connections");
  });

  it("respects limit parameter", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      entityId: `e${i}`,
      name: `Dog${i}`,
      entityType: "dog",
      score: (8 - i) * 0.1,
      reason: "shared_connections",
    }));
    setupGraphSignals(rows, []);

    const results = await service.getRecommendations("user-1", 3);

    expect(results).toHaveLength(3);
  });

  it("SECURITY: never returns owner_proximity as reason", async () => {
    setupGraphSignals(
      [{ entityId: "e1", name: "Rocky", entityType: "dog", score: 0.9, reason: "shared_connections" }],
      [],
    );

    const results = await service.getRecommendations("user-1", 10);

    for (const rec of results) {
      expect(rec.reason).not.toBe("owner_proximity");
    }
  });

  it("returns valid RecommendationReason values", async () => {
    const validReasons = ["shared_connections", "same_breed", "nearby", "popular_in_circle"];
    setupGraphSignals(
      [{ entityId: "e1", name: "A", entityType: "dog", score: 0.8, reason: "shared_connections" }],
      [{ entityId: "e2", name: "B", entityType: "dog", score: 0.6, reason: "same_breed" }],
    );

    const results = await service.getRecommendations("user-1", 10);

    for (const rec of results) {
      expect(validReasons).toContain(rec.reason);
    }
  });

  it("clamps confidence to [0.0, 1.0]", async () => {
    setupGraphSignals(
      [
        { entityId: "e1", name: "A", entityType: "dog", score: 9999, reason: "shared_connections" },
        { entityId: "e2", name: "B", entityType: "dog", score: -5, reason: "shared_connections" },
      ],
      [],
    );

    const results = await service.getRecommendations("user-1", 10);

    for (const rec of results) {
      expect(rec.confidence).toBeGreaterThanOrEqual(0.0);
      expect(rec.confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it("passes userId as a parameterized value to the graph signal queries", async () => {
    setupGraphSignals([], []);

    await service.getRecommendations("user-special", 10);

    for (const call of mockRun.mock.calls) {
      const params = call[1] as Record<string, unknown>;
      expect(params.userId).toBe("user-special");
    }
  });

  it("runs the two graph signal queries (the nearby signal is PostGIS-backed)", async () => {
    setupGraphSignals([], []);

    await service.getRecommendations("user-1", 10);

    // Without an injected geo lookup, only shared_connections + same_breed run.
    expect(mockRun.mock.calls.length).toBe(2);
  });

  it("returns empty array when no candidates found", async () => {
    setupGraphSignals([], []);

    const results = await service.getRecommendations("user-1", 10);

    expect(results).toHaveLength(0);
  });

  it("includes entityType in each recommendation", async () => {
    setupGraphSignals(
      [{ entityId: "e1", name: "Rocky", entityType: "cat", score: 0.5, reason: "shared_connections" }],
      [],
    );

    const results = await service.getRecommendations("user-1", 10);

    expect(results[0].entityType).toBe("cat");
  });
});

// ---------------------------------------------------------------------------
// toDistanceBand (via discoverNearby output)
// ---------------------------------------------------------------------------

describe("distance band coarsening (via discoverNearby)", () => {
  let service: Neo4jGraphService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRun.mockReset();
    fakeNearby = [];
    service = await createConnectedService(fakeGeo);
  });

  const bandCases: [number, string][] = [
    [0, "< 500m"],
    [499, "< 500m"],
    [500, "500m-1km"],
    [999, "500m-1km"],
    [1000, "1-2km"],
    [1999, "1-2km"],
    [2000, "2-5km"],
    [4999, "2-5km"],
    [5000, "> 5km"],
    [10000, "> 5km"],
  ];

  for (const [meters, expectedBand] of bandCases) {
    it(`returns "${expectedBand}" for ${meters}m`, async () => {
      fakeNearby = [{ entityId: "e1", distanceMeters: meters }];
      mockRun.mockResolvedValueOnce(
        makeQueryResult([{ entityId: "e1", name: "Dog", entityType: "dog", breed: null }]),
      );

      const results = await runWithTenantContext(TEST_TENANT, () =>
        service.discoverNearby("user-1", 0, 0, meters + 1),
      );

      expect(results[0].distanceBand).toBe(expectedBand);
    });
  }
});
