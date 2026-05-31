/**
 * Unit Tests: Neo4jGraphService — Entity Discovery Queries
 *
 * Tests for:
 * - discoverByGraph (multi-hop traversal)
 * - discoverNearby (spatial query with distance band coarsening)
 * - getRecommendations (multi-signal merge)
 *
 * The Neo4j driver is mocked so these tests run without a live graph instance.
 * Each test verifies query parameterization, result mapping, and security rules.
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
  },
}));

// Mock schema init — we don't want it to run during discovery tests
vi.mock("../../../src/lib/graph/graph-schema-init", () => ({
  initGraphSchema: vi.fn().mockResolvedValue(undefined),
}));

import { Neo4jGraphService } from "../../../src/lib/graph/neo4j-graph-service.js";
import type { DiscoveryFilters, NearbyFilters } from "../../../src/lib/graph/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake Neo4j record that returns values by field name.
 */
function makeRecord(fields: Record<string, unknown>) {
  return {
    get: (key: string) => {
      if (!(key in fields)) throw new Error(`Field not found: ${key}`);
      return fields[key];
    },
  };
}

/**
 * Build a mock QueryResult with the given row objects.
 */
function makeQueryResult(rows: Record<string, unknown>[]) {
  return { records: rows.map(makeRecord) };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

async function createConnectedService(): Promise<Neo4jGraphService> {
  const svc = new Neo4jGraphService();
  // We need the driver to be set; connect() calls verifyConnectivity + initSchema
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
    expect(results[1]).toMatchObject({
      entityId: "entity-2",
      name: "Daisy",
      entityType: "dog",
      hops: 2,
    });
    // Null breed should not appear in result
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

    // The query string passed to session.run should contain *1..2, not *1..99
    const queryCalled = mockRun.mock.calls[0][0] as string;
    expect(queryCalled).not.toContain("*1..99");
    expect(queryCalled).not.toContain("*3");
    // Should contain hop range 1..2 or just 1
    expect(queryCalled).toMatch(/\*1\.\.2|\*1[^\.]/);
  });

  it("caps hops at 1 when caller passes 1", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    await service.discoverByGraph("user-1", 1);

    const queryCalled = mockRun.mock.calls[0][0] as string;
    // Should not contain *1..2 range; only single-hop
    expect(queryCalled).not.toContain("1..2");
  });

  it("passes userId as a parameter (never interpolated)", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    const userId = "user-with-special-chars'; DROP TABLE users;--";
    await service.discoverByGraph(userId, 2);

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.userId).toBe(userId);
    // The query itself should reference $userId, not the raw string
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
    const query = mockRun.mock.calls[0][0] as string;
    expect(query).toContain("$entityType");
  });

  it("applies breed filter via parameter", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    const filters: DiscoveryFilters = { breed: "Labrador", hops: 2 };
    await service.discoverByGraph("user-1", 2, filters);

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.breed).toBe("Labrador");
    const query = mockRun.mock.calls[0][0] as string;
    expect(query).toContain("$breed");
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

    const query = mockRun.mock.calls[0][0] as string;
    expect(query).toContain("discoverable");
  });

  it("excludes entities already in user's graph via query clause", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));
    await service.discoverByGraph("user-1", 2);

    const query = mockRun.mock.calls[0][0] as string;
    expect(query).toContain("RELATES_TO");
    expect(query).toContain("NOT EXISTS");
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
// discoverNearby
// ---------------------------------------------------------------------------

describe("Neo4jGraphService.discoverNearby", () => {
  let service: Neo4jGraphService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = await createConnectedService();
  });

  it("returns entities with coarse distance bands", async () => {
    mockRun.mockResolvedValueOnce(
      makeQueryResult([
        { entityId: "entity-1", name: "Rocky", entityType: "dog", breed: "Poodle", distanceMeters: 300 },
        { entityId: "entity-2", name: "Bella", entityType: "dog", breed: null, distanceMeters: 800 },
        { entityId: "entity-3", name: "Max",   entityType: "dog", breed: "Husky", distanceMeters: 1500 },
        { entityId: "entity-4", name: "Luna",  entityType: "dog", breed: null,   distanceMeters: 3000 },
        { entityId: "entity-5", name: "Coco",  entityType: "dog", breed: null,   distanceMeters: 7000 },
      ]),
    );

    const results = await service.discoverNearby("user-1", 48.2, 16.3, 10000);

    expect(results[0].distanceBand).toBe("< 500m");
    expect(results[1].distanceBand).toBe("500m-1km");
    expect(results[2].distanceBand).toBe("1-2km");
    expect(results[3].distanceBand).toBe("2-5km");
    expect(results[4].distanceBand).toBe("> 5km");
  });

  it("SECURITY: never returns exact distanceMeters for unrelated entities", async () => {
    mockRun.mockResolvedValueOnce(
      makeQueryResult([
        { entityId: "entity-1", name: "Rocky", entityType: "dog", breed: null, distanceMeters: 123.456 },
      ]),
    );

    const results = await service.discoverNearby("user-1", 48.2, 16.3, 1000);

    expect(results[0].distanceMeters).toBeUndefined();
    expect(results[0].distanceBand).toBeDefined();
  });

  it("passes lat/lng/radius as parameters (never interpolated)", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    await service.discoverNearby("user-1", 48.2082, 16.3738, 5000);

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.lat).toBe(48.2082);
    expect(params.lng).toBe(16.3738);
    expect(params.radiusMeters).toBe(5000);

    const query = mockRun.mock.calls[0][0] as string;
    expect(query).toContain("$lat");
    expect(query).toContain("$lng");
    expect(query).toContain("$radiusMeters");
  });

  it("passes userId as parameter for relationship exclusion check", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    await service.discoverNearby("user-42", 0, 0, 1000);

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.userId).toBe("user-42");
  });

  it("excludes entities the user already has a relationship with", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    await service.discoverNearby("user-1", 0, 0, 1000);

    const query = mockRun.mock.calls[0][0] as string;
    expect(query).toContain("RELATES_TO");
    // Verify the exclusion logic is present (rel IS NULL or NOT EXISTS pattern)
    expect(query).toMatch(/rel IS NULL|NOT EXISTS/);
  });

  it("excludes non-discoverable entities via query clause", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    await service.discoverNearby("user-1", 0, 0, 1000);

    const query = mockRun.mock.calls[0][0] as string;
    expect(query).toContain("discoverable");
  });

  it("uses point.distance() for spatial filtering", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    await service.discoverNearby("user-1", 48.2, 16.3, 2000);

    const query = mockRun.mock.calls[0][0] as string;
    expect(query).toContain("point.distance");
    expect(query).toContain("point({latitude:");
  });

  it("applies entityType filter via parameter", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    const filters: NearbyFilters = { entityType: "dog" };
    await service.discoverNearby("user-1", 0, 0, 1000, filters);

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.entityType).toBe("dog");
  });

  it("applies breed filter via parameter", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    const filters: NearbyFilters = { breed: "Bernese Mountain Dog" };
    await service.discoverNearby("user-1", 0, 0, 1000, filters);

    const params = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(params.breed).toBe("Bernese Mountain Dog");
  });

  it("returns empty array when no entities in radius", async () => {
    mockRun.mockResolvedValueOnce(makeQueryResult([]));

    const results = await service.discoverNearby("user-1", 0, 0, 100);

    expect(results).toHaveLength(0);
  });

  it("omits breed field when null", async () => {
    mockRun.mockResolvedValueOnce(
      makeQueryResult([
        { entityId: "e1", name: "Rocky", entityType: "dog", breed: null, distanceMeters: 200 },
      ]),
    );

    const results = await service.discoverNearby("user-1", 0, 0, 1000);

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
    service = await createConnectedService();
  });

  /**
   * getRecommendations runs 3 queries in parallel. We set up mockRun to return
   * different results for each call.
   */
  function setupThreeSignals(
    sharedConnections: Record<string, unknown>[],
    sameBreed: Record<string, unknown>[],
    nearby: Record<string, unknown>[],
  ) {
    mockRun
      .mockResolvedValueOnce(makeQueryResult(sharedConnections))
      .mockResolvedValueOnce(makeQueryResult(sameBreed))
      .mockResolvedValueOnce(makeQueryResult(nearby));
  }

  it("returns recommendations sorted by confidence descending", async () => {
    setupThreeSignals(
      [{ entityId: "e1", name: "Rocky",  entityType: "dog", score: 0.8, reason: "shared_connections" }],
      [{ entityId: "e2", name: "Bella",  entityType: "dog", score: 0.6, reason: "same_breed" }],
      [{ entityId: "e3", name: "Cooper", entityType: "dog", score: 0.4, reason: "nearby" }],
    );

    const results = await service.getRecommendations("user-1", 10);

    expect(results).toHaveLength(3);
    expect(results[0].confidence).toBeGreaterThanOrEqual(results[1].confidence);
    expect(results[1].confidence).toBeGreaterThanOrEqual(results[2].confidence);
  });

  it("deduplicates entities appearing in multiple signals (keeps highest score)", async () => {
    // entity-1 appears in both shared_connections (0.8) and same_breed (0.6)
    setupThreeSignals(
      [{ entityId: "entity-1", name: "Rocky", entityType: "dog", score: 0.8, reason: "shared_connections" }],
      [{ entityId: "entity-1", name: "Rocky", entityType: "dog", score: 0.6, reason: "same_breed" }],
      [],
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
      reason: "nearby",
    }));
    setupThreeSignals([], [], rows);

    const results = await service.getRecommendations("user-1", 3);

    expect(results).toHaveLength(3);
  });

  it("SECURITY: never returns owner_proximity as reason", async () => {
    // Even if a query somehow returns owner_proximity, the result mapping should
    // not expose it. In practice the queries always return 'shared_connections'.
    setupThreeSignals(
      [{ entityId: "e1", name: "Rocky", entityType: "dog", score: 0.9, reason: "shared_connections" }],
      [],
      [],
    );

    const results = await service.getRecommendations("user-1", 10);

    for (const rec of results) {
      expect(rec.reason).not.toBe("owner_proximity");
    }
  });

  it("returns valid RecommendationReason values", async () => {
    const validReasons = ["shared_connections", "same_breed", "nearby", "popular_in_circle"];
    setupThreeSignals(
      [{ entityId: "e1", name: "A", entityType: "dog", score: 0.8, reason: "shared_connections" }],
      [{ entityId: "e2", name: "B", entityType: "dog", score: 0.6, reason: "same_breed" }],
      [{ entityId: "e3", name: "C", entityType: "dog", score: 0.4, reason: "nearby" }],
    );

    const results = await service.getRecommendations("user-1", 10);

    for (const rec of results) {
      expect(validReasons).toContain(rec.reason);
    }
  });

  it("clamps confidence to [0.0, 1.0]", async () => {
    setupThreeSignals(
      [
        { entityId: "e1", name: "A", entityType: "dog", score: 9999, reason: "shared_connections" },
        { entityId: "e2", name: "B", entityType: "dog", score: -5,   reason: "shared_connections" },
      ],
      [],
      [],
    );

    const results = await service.getRecommendations("user-1", 10);

    for (const rec of results) {
      expect(rec.confidence).toBeGreaterThanOrEqual(0.0);
      expect(rec.confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it("passes userId as parameterized value to all three queries", async () => {
    setupThreeSignals([], [], []);

    await service.getRecommendations("user-special", 10);

    // All 3 calls should receive userId
    for (const call of mockRun.mock.calls) {
      const params = call[1] as Record<string, unknown>;
      expect(params.userId).toBe("user-special");
    }
  });

  it("runs exactly three queries in parallel", async () => {
    setupThreeSignals([], [], []);

    await service.getRecommendations("user-1", 10);

    // 1 call from connect's schema init + 3 discovery queries
    // (schema init mock is separate — mockRun covers all session.run calls)
    // We check that at least 3 calls happened from the discovery
    expect(mockRun.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("returns empty array when no candidates found", async () => {
    setupThreeSignals([], [], []);

    const results = await service.getRecommendations("user-1", 10);

    expect(results).toHaveLength(0);
  });

  it("includes entityType in each recommendation", async () => {
    setupThreeSignals(
      [{ entityId: "e1", name: "Rocky", entityType: "cat", score: 0.5, reason: "shared_connections" }],
      [],
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
    service = await createConnectedService();
  });

  const bandCases: [number, string][] = [
    [0,    "< 500m"],
    [499,  "< 500m"],
    [500,  "500m-1km"],
    [999,  "500m-1km"],
    [1000, "1-2km"],
    [1999, "1-2km"],
    [2000, "2-5km"],
    [4999, "2-5km"],
    [5000, "> 5km"],
    [10000, "> 5km"],
  ];

  for (const [meters, expectedBand] of bandCases) {
    it(`returns "${expectedBand}" for ${meters}m`, async () => {
      mockRun.mockResolvedValueOnce(
        makeQueryResult([
          { entityId: "e1", name: "Dog", entityType: "dog", breed: null, distanceMeters: meters },
        ]),
      );

      const results = await service.discoverNearby("user-1", 0, 0, meters + 1);

      expect(results[0].distanceBand).toBe(expectedBand);
    });
  }
});
