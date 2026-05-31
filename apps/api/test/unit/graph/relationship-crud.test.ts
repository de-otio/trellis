/**
 * Unit Tests: Neo4j GraphService — Relationship CRUD
 *
 * Tests for createRelationship, removeRelationship, updateRelationshipScore,
 * getRelationship, getRelationships, and getRelationshipGraph.
 *
 * The Neo4j driver is fully mocked — no database required.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Neo4jGraphService } from "../../../src/lib/graph/neo4j-graph-service.js";
import { GraphNotFoundError } from "../../../src/lib/graph/errors.js";
import type { Relationship } from "../../../src/lib/graph/types.js";

// ---------------------------------------------------------------------------
// Hoist mocks before module loading
// ---------------------------------------------------------------------------

const { mockSessionRun, mockSessionClose, mockVerifyConnectivity } = vi.hoisted(() => ({
  mockSessionRun: vi.fn(),
  mockSessionClose: vi.fn().mockResolvedValue(undefined),
  mockVerifyConnectivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("neo4j-driver", () => {
  const mockSession = {
    run: (...args: unknown[]) => mockSessionRun(...args),
    close: () => mockSessionClose(),
  };

  const mockDriver = {
    session: () => mockSession,
    verifyConnectivity: () => mockVerifyConnectivity(),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    default: {
      driver: vi.fn(() => mockDriver),
      auth: {
        basic: vi.fn(() => ({ scheme: "basic" })),
      },
      integer: {
        toNumber: (v: unknown) => Number(v),
      },
    },
  };
});

// initGraphSchema is called during connect — stub it to be a no-op
vi.mock("../../../src/lib/graph/graph-schema-init", () => ({
  initGraphSchema: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake Neo4j-style record properties object for a RELATES_TO edge */
function makeRelProps(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    computedScore: 0.5,
    manualScore: null,
    score: 0.5,
    tier: 2,
    interactionCount: 0,
    lastInteractionAt: null,
    connectionMethod: "import",
    reciprocated: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Build a single Neo4j record mock */
function makeRecord(props: Record<string, unknown>): { get: (key: string) => unknown } {
  return {
    get(key: string) {
      if (key === "r") return { properties: props };
      return props[key];
    },
  };
}

/** Successful query result with one relationship record */
function oneRelResult(relProps: Record<string, unknown>) {
  return { records: [makeRecord(relProps)] };
}

/** Empty query result */
const emptyResult = { records: [] };

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let service: Neo4jGraphService;

beforeEach(async () => {
  vi.clearAllMocks();

  service = new Neo4jGraphService();

  // connect() calls verifyConnectivity + initGraphSchema (mocked above)
  mockVerifyConnectivity.mockResolvedValueOnce(undefined);
  // initGraphSchema session.run calls happen during schema init — stub them
  mockSessionRun.mockResolvedValue({ records: [] });

  await service.connect({
    endpoint: "bolt://localhost:7687",
    auth: { type: "none" },
  });

  // Clear mock calls from connect/schema init
  vi.clearAllMocks();
  mockSessionClose.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// createRelationship
// ---------------------------------------------------------------------------

describe("createRelationship", () => {
  it("creates a user->entity relationship with 'import' initial score (0.5)", async () => {
    const relProps = makeRelProps({ computedScore: 0.5, score: 0.5, tier: 2, connectionMethod: "import" });
    mockSessionRun.mockResolvedValueOnce(oneRelResult(relProps));

    const rel = await service.createRelationship({
      userId: "user-1",
      targetType: "entity",
      targetId: "entity-1",
      connectionMethod: "import",
    });

    expect(rel.userId).toBe("user-1");
    expect(rel.targetType).toBe("entity");
    expect(rel.targetId).toBe("entity-1");
    expect(rel.score).toBe(0.5);
    expect(rel.computedScore).toBe(0.5);
    expect(rel.manualScore).toBeNull();
    expect(rel.connectionMethod).toBe("import");
    expect(rel.reciprocated).toBe(false);
    expect(rel.tier).toBe(1); // 0.5 >= 0.4 → close friends tier (scoring-engine thresholds)
    expect(rel.interactionCount).toBe(0);
  });

  it("creates a user->user relationship with 'code' initial score (0.7)", async () => {
    const relProps = makeRelProps({ computedScore: 0.7, score: 0.7, tier: 1, connectionMethod: "code" });
    mockSessionRun.mockResolvedValueOnce(oneRelResult(relProps));

    const rel = await service.createRelationship({
      userId: "user-1",
      targetType: "user",
      targetId: "user-2",
      connectionMethod: "code",
    });

    expect(rel.score).toBe(0.7);
    expect(rel.tier).toBe(0); // 0.7 >= 0.7 → inner tier (scoring-engine thresholds)
    expect(rel.targetType).toBe("user");
  });

  it("defaults to 'discovery' connectionMethod and score 0.3 when not specified", async () => {
    const relProps = makeRelProps({ computedScore: 0.3, score: 0.3, tier: 2, connectionMethod: "discovery" });
    mockSessionRun.mockResolvedValueOnce(oneRelResult(relProps));

    const rel = await service.createRelationship({
      userId: "user-1",
      targetType: "entity",
      targetId: "entity-1",
    });

    // Verify the query was called with connectionMethod=discovery
    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.connectionMethod).toBe("discovery");
    expect(params.initialScore).toBe(0.3);
    expect(rel.connectionMethod).toBe("discovery");
  });

  it("uses parameterized query — userId and targetId are parameters, not interpolated", async () => {
    mockSessionRun.mockResolvedValueOnce(oneRelResult(makeRelProps()));

    await service.createRelationship({
      userId: "user-1",
      targetType: "entity",
      targetId: "entity-1",
      connectionMethod: "discovery",
    });

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.userId).toBe("user-1");
    expect(params.targetId).toBe("entity-1");
    // Query must NOT contain literal user IDs
    expect(query).not.toContain("user-1");
    expect(query).not.toContain("entity-1");
  });

  it("throws GraphNotFoundError when source user or target not found", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    await expect(
      service.createRelationship({
        userId: "missing-user",
        targetType: "entity",
        targetId: "entity-1",
      }),
    ).rejects.toThrow(GraphNotFoundError);
  });

  it("sets reciprocated=true when reverse user->user edge exists", async () => {
    const relProps = makeRelProps({ reciprocated: true, targetType: "user" });
    mockSessionRun.mockResolvedValueOnce(oneRelResult(relProps));

    const rel = await service.createRelationship({
      userId: "user-1",
      targetType: "user",
      targetId: "user-2",
      connectionMethod: "code",
    });

    expect(rel.reciprocated).toBe(true);
  });

  it("computes correct initial scores for each connectionMethod", async () => {
    const cases: Array<[string, number]> = [
      ["code", 0.7],
      ["import", 0.5],
      ["suggestion", 0.3],
      ["discovery", 0.3],
    ];

    for (const [method, expectedScore] of cases) {
      vi.clearAllMocks();
      mockSessionRun.mockResolvedValueOnce(oneRelResult(makeRelProps()));

      await service.createRelationship({
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
        connectionMethod: method as "code" | "import" | "suggestion" | "discovery",
      });

      const [, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
      expect(params.initialScore, `initialScore for ${method}`).toBe(expectedScore);
    }
  });
});

// ---------------------------------------------------------------------------
// removeRelationship
// ---------------------------------------------------------------------------

describe("removeRelationship", () => {
  it("removes a user->entity relationship successfully", async () => {
    mockSessionRun.mockResolvedValueOnce({ records: [{ get: (k: string) => k === "found" ? true : null }] });

    await expect(
      service.removeRelationship("user-1", "entity", "entity-1"),
    ).resolves.toBeUndefined();
  });

  it("throws GraphNotFoundError when relationship does not exist", async () => {
    mockSessionRun.mockResolvedValueOnce({ records: [{ get: (k: string) => k === "found" ? false : null }] });

    await expect(
      service.removeRelationship("user-1", "entity", "missing-entity"),
    ).rejects.toThrow(GraphNotFoundError);
  });

  it("uses parameterized query", async () => {
    mockSessionRun.mockResolvedValueOnce({ records: [{ get: (k: string) => k === "found" ? true : null }] });

    await service.removeRelationship("user-1", "entity", "entity-1");

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.userId).toBe("user-1");
    expect(params.targetId).toBe("entity-1");
    expect(query).not.toContain("user-1");
    expect(query).not.toContain("entity-1");
  });

  it("removes a user->user relationship", async () => {
    mockSessionRun.mockResolvedValueOnce({ records: [{ get: (k: string) => k === "found" ? true : null }] });

    await expect(
      service.removeRelationship("user-1", "user", "user-2"),
    ).resolves.toBeUndefined();

    const [query] = mockSessionRun.mock.calls[0] as [string];
    expect(query).toContain(":User");
  });
});

// ---------------------------------------------------------------------------
// updateRelationshipScore
// ---------------------------------------------------------------------------

describe("updateRelationshipScore", () => {
  it("sets a manual score override", async () => {
    const relProps = makeRelProps({ score: 0.9, manualScore: 0.9, computedScore: 0.5 });
    mockSessionRun.mockResolvedValueOnce(oneRelResult(relProps));

    const rel = await service.updateRelationshipScore({
      userId: "user-1",
      targetType: "entity",
      targetId: "entity-1",
      manualScore: 0.9,
    });

    expect(rel.manualScore).toBe(0.9);
    expect(rel.score).toBe(0.9);
    expect(rel.tier).toBe(0); // 0.9 >= 0.7 → inner (scoring-engine thresholds)
  });

  it("clears manual score (null) and falls back to computedScore", async () => {
    const relProps = makeRelProps({ score: 0.5, manualScore: null, computedScore: 0.5 });
    mockSessionRun.mockResolvedValueOnce(oneRelResult(relProps));

    const rel = await service.updateRelationshipScore({
      userId: "user-1",
      targetType: "entity",
      targetId: "entity-1",
      manualScore: null,
    });

    expect(rel.manualScore).toBeNull();
    expect(rel.score).toBe(0.5);
    expect(rel.tier).toBe(1); // 0.5 >= 0.4 → close friends (scoring-engine thresholds)
  });

  it("passes null to the query when clearing manual score", async () => {
    mockSessionRun.mockResolvedValueOnce(oneRelResult(makeRelProps()));

    await service.updateRelationshipScore({
      userId: "user-1",
      targetType: "entity",
      targetId: "entity-1",
      manualScore: null,
    });

    const [, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.manualScore).toBeNull();
  });

  it("throws GraphNotFoundError when relationship does not exist", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    await expect(
      service.updateRelationshipScore({
        userId: "user-1",
        targetType: "entity",
        targetId: "missing",
        manualScore: 0.8,
      }),
    ).rejects.toThrow(GraphNotFoundError);
  });

  it("computes tier correctly from effective score", async () => {
    // Tiers from scoring-engine TIER_THRESHOLDS: >= 0.7 inner, >= 0.4 close friends, >= 0.15 community
    const cases: Array<[number, number]> = [
      [0.85, 0], // inner (>= 0.7)
      [0.55, 1], // close friends (>= 0.4)
      [0.25, 2], // community (>= 0.15)
      [0.05, 3], // ambient (< 0.15)
    ];

    for (const [score, expectedTier] of cases) {
      vi.clearAllMocks();
      mockSessionRun.mockResolvedValueOnce(
        oneRelResult(makeRelProps({ score, manualScore: score, computedScore: 0.3 })),
      );

      const rel = await service.updateRelationshipScore({
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
        manualScore: score,
      });

      expect(rel.tier, `tier for score ${score}`).toBe(expectedTier);
    }
  });
});

// ---------------------------------------------------------------------------
// getRelationship
// ---------------------------------------------------------------------------

describe("getRelationship", () => {
  it("returns a relationship when it exists", async () => {
    const relProps = makeRelProps({ score: 0.7, tier: 1 });
    mockSessionRun.mockResolvedValueOnce(oneRelResult(relProps));

    const rel = await service.getRelationship("user-1", "entity", "entity-1");

    expect(rel).not.toBeNull();
    expect(rel!.userId).toBe("user-1");
    expect(rel!.targetId).toBe("entity-1");
    expect(rel!.score).toBe(0.7);
  });

  it("returns null when relationship does not exist", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    const rel = await service.getRelationship("user-1", "entity", "missing");

    expect(rel).toBeNull();
  });

  it("uses parameterized query", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    await service.getRelationship("user-1", "user", "user-2");

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.userId).toBe("user-1");
    expect(params.targetId).toBe("user-2");
    expect(query).not.toContain("user-1");
    expect(query).not.toContain("user-2");
  });

  it("uses correct label for user target", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);
    await service.getRelationship("user-1", "user", "user-2");
    const [query] = mockSessionRun.mock.calls[0] as [string];
    expect(query).toContain(":User");
  });

  it("uses correct label for entity target", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);
    await service.getRelationship("user-1", "entity", "entity-1");
    const [query] = mockSessionRun.mock.calls[0] as [string];
    expect(query).toContain(":Entity");
  });
});

// ---------------------------------------------------------------------------
// getRelationships
// ---------------------------------------------------------------------------

describe("getRelationships", () => {
  function makeRecordWithTarget(
    relProps: Record<string, unknown>,
    targetId: string,
    targetType: "user" | "entity",
  ) {
    return {
      get(key: string) {
        if (key === "r") return { properties: relProps };
        if (key === "targetId") return targetId;
        if (key === "targetType") return targetType;
        return null;
      },
    };
  }

  it("returns all relationships for a user", async () => {
    const records = [
      makeRecordWithTarget(makeRelProps({ score: 0.8 }), "entity-1", "entity"),
      makeRecordWithTarget(makeRelProps({ score: 0.5 }), "entity-2", "entity"),
    ];
    mockSessionRun.mockResolvedValueOnce({ records });

    const result = await service.getRelationships("user-1");

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
    expect(result.items[0].targetId).toBe("entity-1");
    expect(result.items[1].targetId).toBe("entity-2");
  });

  it("applies tier filter when tier is specified", async () => {
    mockSessionRun.mockResolvedValueOnce({ records: [] });

    await service.getRelationships("user-1", { tier: 1 });

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("r.tier = $tier");
    expect(params.tier).toBe(1);
  });

  it("does not apply tier filter when tier is not specified", async () => {
    mockSessionRun.mockResolvedValueOnce({ records: [] });

    await service.getRelationships("user-1");

    const [query] = mockSessionRun.mock.calls[0] as [string];
    expect(query).not.toContain("r.tier = $tier");
  });

  it("applies User label filter for targetType=user", async () => {
    mockSessionRun.mockResolvedValueOnce({ records: [] });

    await service.getRelationships("user-1", { targetType: "user" });

    const [query] = mockSessionRun.mock.calls[0] as [string];
    expect(query).toContain("(tgt:User)");
  });

  it("applies Entity label filter for targetType=entity", async () => {
    mockSessionRun.mockResolvedValueOnce({ records: [] });

    await service.getRelationships("user-1", { targetType: "entity" });

    const [query] = mockSessionRun.mock.calls[0] as [string];
    expect(query).toContain("(tgt:Entity)");
  });

  it("paginates using hasMore detection (fetches limit+1)", async () => {
    // Return 3 records when limit=2 → hasMore=true
    const records = [
      makeRecordWithTarget(makeRelProps({ score: 0.9 }), "e1", "entity"),
      makeRecordWithTarget(makeRelProps({ score: 0.8 }), "e2", "entity"),
      makeRecordWithTarget(makeRelProps({ score: 0.7 }), "e3", "entity"), // extra
    ];
    mockSessionRun.mockResolvedValueOnce({ records });

    const result = await service.getRelationships("user-1", { pagination: { limit: 2 } });

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.cursor).not.toBeNull();
  });

  it("returns hasMore=false and cursor=null when fewer items than limit", async () => {
    const records = [
      makeRecordWithTarget(makeRelProps({ score: 0.5 }), "e1", "entity"),
    ];
    mockSessionRun.mockResolvedValueOnce({ records });

    const result = await service.getRelationships("user-1", { pagination: { limit: 10 } });

    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });

  it("includes cursor score filter when cursor is provided", async () => {
    // Encode a cursor
    const cursor = Buffer.from(JSON.stringify({ score: 0.7 })).toString("base64");
    mockSessionRun.mockResolvedValueOnce({ records: [] });

    await service.getRelationships("user-1", { pagination: { limit: 10, cursor } });

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("r.score < $cursorScore");
    expect(params.cursorScore).toBe(0.7);
  });

  it("returns empty result when no relationships exist", async () => {
    mockSessionRun.mockResolvedValueOnce({ records: [] });

    const result = await service.getRelationships("user-1");

    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRelationshipGraph
// ---------------------------------------------------------------------------

describe("getRelationshipGraph", () => {
  function makeGraphRecord(
    targetId: string,
    targetType: "user" | "entity",
    name: string,
    score: number,
    tier: number,
  ) {
    return {
      get(key: string) {
        if (key === "targetId") return targetId;
        if (key === "targetType") return targetType;
        if (key === "name") return name;
        if (key === "score") return score;
        if (key === "tier") return tier;
        return null;
      },
    };
  }

  it("returns nodes with coarse closeness (bucketed to nearest 10)", async () => {
    const records = [
      makeGraphRecord("e1", "entity", "Bunsen", 0.85, 0),
      makeGraphRecord("u1", "user", "Alice", 0.62, 1),
    ];
    mockSessionRun.mockResolvedValueOnce({ records });

    const data = await service.getRelationshipGraph("user-1");

    expect(data.nodes).toHaveLength(2);

    // 0.85 * 10 = 8.5 → round → 9 → * 10 = 90
    expect(data.nodes[0].closeness).toBe(90);
    // 0.62 * 10 = 6.2 → round → 6 → * 10 = 60
    expect(data.nodes[1].closeness).toBe(60);
  });

  it("does NOT expose raw scores (closeness is bucketed)", async () => {
    const records = [makeGraphRecord("e1", "entity", "Bunsen", 0.73, 1)];
    mockSessionRun.mockResolvedValueOnce({ records });

    const data = await service.getRelationshipGraph("user-1");

    // 0.73 → round(7.3) = 7 → 70
    expect(data.nodes[0].closeness).toBe(70);
    // closeness should not equal the raw score
    expect(data.nodes[0].closeness).not.toBe(0.73);
  });

  it("returns correct node shape (id, type, name, closeness, tier)", async () => {
    const records = [makeGraphRecord("entity-42", "entity", "Buddy", 0.9, 0)];
    mockSessionRun.mockResolvedValueOnce({ records });

    const data = await service.getRelationshipGraph("user-1");

    expect(data.nodes[0]).toEqual({
      id: "entity-42",
      type: "entity",
      name: "Buddy",
      closeness: 90,
      tier: 0,
    });
  });

  it("returns tier summaries with correct counts", async () => {
    // Tier values in graph records come from the DB (set by scoring engine)
    const records = [
      makeGraphRecord("e1", "entity", "Dog1", 0.9, 0),  // inner (tier=0)
      makeGraphRecord("u1", "user", "User1", 0.65, 1),   // closeFriends (tier=1)
      makeGraphRecord("u2", "user", "User2", 0.55, 1),   // closeFriends (tier=1)
      makeGraphRecord("e2", "entity", "Dog2", 0.25, 2),  // community (tier=2)
    ];
    mockSessionRun.mockResolvedValueOnce({ records });

    const data = await service.getRelationshipGraph("user-1");

    expect(data.tiers.inner.count).toBe(1);
    expect(data.tiers.closeFriends.count).toBe(2);
    expect(data.tiers.community.count).toBe(1);
    expect(data.tiers.ambient.count).toBe(0);
  });

  it("returns correct tier thresholds from scoring engine", async () => {
    mockSessionRun.mockResolvedValueOnce({ records: [] });

    const data = await service.getRelationshipGraph("user-1");

    // From scoring-engine TIER_THRESHOLDS
    expect(data.tiers.inner.threshold).toBe(0.7);
    expect(data.tiers.closeFriends.threshold).toBe(0.4);
    expect(data.tiers.community.threshold).toBe(0.15);
    expect(data.tiers.ambient.threshold).toBe(0.0);
  });

  it("returns empty nodes and zero counts when user has no relationships", async () => {
    mockSessionRun.mockResolvedValueOnce({ records: [] });

    const data = await service.getRelationshipGraph("user-1");

    expect(data.nodes).toHaveLength(0);
    expect(data.tiers.inner.count).toBe(0);
    expect(data.tiers.closeFriends.count).toBe(0);
    expect(data.tiers.community.count).toBe(0);
    expect(data.tiers.ambient.count).toBe(0);
  });

  it("uses parameterized query", async () => {
    mockSessionRun.mockResolvedValueOnce({ records: [] });

    await service.getRelationshipGraph("user-99");

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.userId).toBe("user-99");
    expect(query).not.toContain("user-99");
  });
});

// ---------------------------------------------------------------------------
// Tier computation logic (scoreToTier from scoring engine, tested indirectly)
// ---------------------------------------------------------------------------

describe("tier computation via createRelationship", () => {
  async function getRelWithScore(score: number): Promise<Relationship> {
    mockSessionRun.mockResolvedValueOnce(
      oneRelResult(makeRelProps({ score, computedScore: score, tier: 3 })),
    );
    return service.createRelationship({
      userId: "user-1",
      targetType: "entity",
      targetId: "entity-1",
      connectionMethod: "discovery",
    });
  }

  // Tiers from scoring-engine TIER_THRESHOLDS: >= 0.7 inner, >= 0.4 close friends, >= 0.15 community

  it("score >= 0.7 resolves to tier 0 (inner)", async () => {
    const rel = await getRelWithScore(0.8);
    expect(rel.tier).toBe(0);
  });

  it("score >= 0.4 and < 0.7 resolves to tier 1 (close friends)", async () => {
    const rel = await getRelWithScore(0.55);
    expect(rel.tier).toBe(1);
  });

  it("score >= 0.15 and < 0.4 resolves to tier 2 (community)", async () => {
    const rel = await getRelWithScore(0.25);
    expect(rel.tier).toBe(2);
  });

  it("score < 0.15 resolves to tier 3 (ambient)", async () => {
    const rel = await getRelWithScore(0.05);
    expect(rel.tier).toBe(3);
  });
});
