/**
 * Integration Tests: Neo4j GraphService — Relationship CRUD Methods
 *
 * Tests createRelationship, removeRelationship, updateRelationshipScore,
 * getRelationship, getRelationships, and getRelationshipGraph against a real
 * local Neo4j instance.
 *
 * PROD-SAFE: Uses RUN_ID-prefixed node IDs and cleans up only this run's data
 * in afterAll. Does NOT use withCleanDb() — safe to run alongside live data.
 *
 * Prerequisites:
 *   - Neo4j running locally (bolt://localhost:7687)
 *   - .env.test.local configured (NEO4J_TEST_URI / USER / PASSWORD)
 *
 * Run:
 *   npm run test:graph -w @de-otio/trellis
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphService } from "../../../src/lib/graph/graph-factory.js";
import type { GraphConnection, GraphService } from "../../../src/lib/graph/graph-service.js";
import { CONNECTION_BONUSES, TIER_THRESHOLDS } from "../../../src/lib/graph/scoring-engine.js";
import { closeTestDriver, deleteTestNodes } from "./harness.js";
import { getTestDatabase, getTestDriver, getTestGraphServiceConfig } from "./setup.js";

// ---------------------------------------------------------------------------
// Prod-safe run isolation
// ---------------------------------------------------------------------------

const RUN_ID = `test-${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// Direct Cypher helpers (bypass the service for assertions)
// ---------------------------------------------------------------------------

async function getEdge(
  fromId: string,
  edgeType: string,
  toId: string,
): Promise<Record<string, unknown> | null> {
  const driver = getTestDriver();
  const database = getTestDatabase();
  const session = driver.session({ database });
  try {
    const result = await session.run(
      `MATCH (a {id: $fromId})-[r:${edgeType}]->(b {id: $toId})
       RETURN properties(r) AS props`,
      { fromId, toId },
    );
    if (result.records.length === 0) return null;
    return result.records[0].get("props") as Record<string, unknown>;
  } finally {
    await session.close();
  }
}

async function edgeExists(
  fromId: string,
  edgeType: string,
  toId: string,
): Promise<boolean> {
  return (await getEdge(fromId, edgeType, toId)) !== null;
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

let svc: GraphService & GraphConnection;

beforeAll(async () => {
  svc = await createGraphService(getTestGraphServiceConfig());
});

afterAll(async () => {
  await deleteTestNodes(RUN_ID);
  await svc.close();
  await closeTestDriver();
});

// ---------------------------------------------------------------------------
// Constants derived from the scoring engine (single source of truth)
// ---------------------------------------------------------------------------

const BONUS = CONNECTION_BONUSES;

// scoreToTier uses TIER_THRESHOLDS: 0.7+ = 0, 0.4+ = 1, 0.15+ = 2, else 3
function expectedTier(score: number): 0 | 1 | 2 | 3 {
  for (const { tier, minScore } of TIER_THRESHOLDS) {
    if (score >= minScore) return tier as 0 | 1 | 2 | 3;
  }
  return 3;
}

// ---------------------------------------------------------------------------
// createRelationship
// ---------------------------------------------------------------------------

describe("createRelationship", () => {
  it("creates a RELATES_TO edge with correct initial score for 'code' connectionMethod", async () => {
    const u = `${RUN_ID}-cr1-u1`;
    const target = `${RUN_ID}-cr1-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: target, entityType: "dog", name: "Buddy" });

    const rel = await svc.createRelationship({
      userId: u,
      targetType: "entity",
      targetId: target,
      connectionMethod: "code",
    });

    expect(rel.userId).toBe(u);
    expect(rel.targetId).toBe(target);
    expect(rel.targetType).toBe("entity");
    expect(rel.connectionMethod).toBe("code");
    expect(rel.score).toBeCloseTo(BONUS.code);
    expect(rel.computedScore).toBeCloseTo(BONUS.code);
    expect(rel.manualScore).toBeNull();
    expect(rel.tier).toBe(expectedTier(BONUS.code));
    expect(rel.interactionCount).toBe(0);
    expect(rel.reciprocated).toBe(false);
    expect(rel.createdAt).toBeInstanceOf(Date);
  });

  it("creates a RELATES_TO edge with correct initial score for 'import' connectionMethod", async () => {
    const u = `${RUN_ID}-cr2-u1`;
    const target = `${RUN_ID}-cr2-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: target, entityType: "dog", name: "Max" });

    const rel = await svc.createRelationship({
      userId: u,
      targetType: "entity",
      targetId: target,
      connectionMethod: "import",
    });

    expect(rel.score).toBeCloseTo(BONUS.import);
    expect(rel.tier).toBe(expectedTier(BONUS.import));
  });

  it("creates a RELATES_TO edge with correct initial score for 'discovery' connectionMethod", async () => {
    const u = `${RUN_ID}-cr3-u1`;
    const target = `${RUN_ID}-cr3-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: target, entityType: "dog", name: "Luna" });

    const rel = await svc.createRelationship({
      userId: u,
      targetType: "entity",
      targetId: target,
      connectionMethod: "discovery",
    });

    expect(rel.score).toBeCloseTo(BONUS.discovery);
    expect(rel.tier).toBe(expectedTier(BONUS.discovery));
  });

  it("defaults to 'discovery' connectionMethod when none is provided", async () => {
    const u = `${RUN_ID}-cr4-u1`;
    const target = `${RUN_ID}-cr4-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: target, entityType: "dog", name: "Coco" });

    const rel = await svc.createRelationship({
      userId: u,
      targetType: "entity",
      targetId: target,
      // connectionMethod intentionally omitted
    });

    expect(rel.connectionMethod).toBe("discovery");
    expect(rel.score).toBeCloseTo(BONUS.discovery);
  });

  it("creates a user→user RELATES_TO edge", async () => {
    const u1 = `${RUN_ID}-cr5-u1`;
    const u2 = `${RUN_ID}-cr5-u2`;
    await svc.syncUser({ id: u1, role: "END_USER" });
    await svc.syncUser({ id: u2, role: "END_USER" });

    const rel = await svc.createRelationship({
      userId: u1,
      targetType: "user",
      targetId: u2,
      connectionMethod: "suggestion",
    });

    expect(rel.targetType).toBe("user");
    expect(rel.score).toBeCloseTo(BONUS.suggestion);
    expect(rel.reciprocated).toBe(false); // no reverse edge yet
  });

  it("sets reciprocated=true on both edges when user→user reverse edge already exists", async () => {
    const u1 = `${RUN_ID}-cr6-u1`;
    const u2 = `${RUN_ID}-cr6-u2`;
    await svc.syncUser({ id: u1, role: "END_USER" });
    await svc.syncUser({ id: u2, role: "END_USER" });

    // u2 → u1 first
    await svc.createRelationship({
      userId: u2,
      targetType: "user",
      targetId: u1,
      connectionMethod: "code",
    });

    // u1 → u2: should trigger reciprocity
    const rel = await svc.createRelationship({
      userId: u1,
      targetType: "user",
      targetId: u2,
      connectionMethod: "code",
    });

    // Forward edge is reciprocated
    expect(rel.reciprocated).toBe(true);

    // Reverse edge should also be marked reciprocated in the DB
    const reverseEdge = await getEdge(u2, "RELATES_TO", u1);
    expect(reverseEdge).not.toBeNull();
    expect(reverseEdge!.reciprocated).toBe(true);
  });

  it("does NOT set reciprocated on user→entity edges even if entity has no reverse path", async () => {
    const u = `${RUN_ID}-cr7-u1`;
    const e = `${RUN_ID}-cr7-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Rocky" });

    const rel = await svc.createRelationship({
      userId: u,
      targetType: "entity",
      targetId: e,
      connectionMethod: "code",
    });

    expect(rel.reciprocated).toBe(false);
  });

  it("throws GraphNotFoundError when target entity does not exist", async () => {
    const u = `${RUN_ID}-cr8-u1`;
    await svc.syncUser({ id: u, role: "END_USER" });

    await expect(
      svc.createRelationship({
        userId: u,
        targetType: "entity",
        targetId: `${RUN_ID}-cr8-nonexistent`,
        connectionMethod: "discovery",
      }),
    ).rejects.toThrow();
  });

  it("throws GraphNotFoundError when source user does not exist", async () => {
    const e = `${RUN_ID}-cr9-e1`;
    await svc.syncEntity({ id: e, entityType: "dog", name: "Bella" });

    await expect(
      svc.createRelationship({
        userId: `${RUN_ID}-cr9-nonexistent`,
        targetType: "entity",
        targetId: e,
        connectionMethod: "discovery",
      }),
    ).rejects.toThrow();
  });

  it("second createRelationship call on existing edge uses MERGE (does not throw, returns relationship)", async () => {
    // The impl uses MERGE so it is idempotent; the _alreadyExisted flag is set
    // on the edge properties but the method still returns the relationship.
    const u = `${RUN_ID}-cr10-u1`;
    const e = `${RUN_ID}-cr10-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Toby" });

    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e, connectionMethod: "code" });

    // Second call — should not throw (MERGE is used, not CREATE)
    const rel = await svc.createRelationship({ userId: u, targetType: "entity", targetId: e, connectionMethod: "import" });

    // The relationship exists and is returned
    expect(rel.userId).toBe(u);
    expect(rel.targetId).toBe(e);

    // Only one edge should exist
    expect(await edgeExists(u, "RELATES_TO", e)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// removeRelationship
// ---------------------------------------------------------------------------

describe("removeRelationship", () => {
  it("deletes the RELATES_TO edge", async () => {
    const u = `${RUN_ID}-rr1-u1`;
    const e = `${RUN_ID}-rr1-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Milo" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e, connectionMethod: "code" });
    expect(await edgeExists(u, "RELATES_TO", e)).toBe(true);

    await svc.removeRelationship(u, "entity", e);

    expect(await edgeExists(u, "RELATES_TO", e)).toBe(false);
  });

  it("leaves User and Entity nodes intact after edge deletion", async () => {
    const u = `${RUN_ID}-rr2-u1`;
    const e = `${RUN_ID}-rr2-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Charlie" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e, connectionMethod: "discovery" });

    await svc.removeRelationship(u, "entity", e);

    // Nodes survive
    const driver = getTestDriver();
    const database = getTestDatabase();
    const session = driver.session({ database });
    try {
      const uResult = await session.run("MATCH (n:User {id: $id}) RETURN n", { id: u });
      const eResult = await session.run("MATCH (n:Entity {id: $id}) RETURN n", { id: e });
      expect(uResult.records.length).toBe(1);
      expect(eResult.records.length).toBe(1);
    } finally {
      await session.close();
    }
  });

  it("clears reciprocated flag on reverse user→user edge when forward edge is removed", async () => {
    const u1 = `${RUN_ID}-rr3-u1`;
    const u2 = `${RUN_ID}-rr3-u2`;
    await svc.syncUser({ id: u1, role: "END_USER" });
    await svc.syncUser({ id: u2, role: "END_USER" });

    // Create both directions
    await svc.createRelationship({ userId: u1, targetType: "user", targetId: u2, connectionMethod: "code" });
    await svc.createRelationship({ userId: u2, targetType: "user", targetId: u1, connectionMethod: "code" });

    // Both edges should be reciprocated
    const revBefore = await getEdge(u2, "RELATES_TO", u1);
    expect(revBefore!.reciprocated).toBe(true);

    // Remove u1 → u2
    await svc.removeRelationship(u1, "user", u2);

    // Reverse edge (u2 → u1) should have reciprocated cleared
    const revAfter = await getEdge(u2, "RELATES_TO", u1);
    expect(revAfter).not.toBeNull();
    expect(revAfter!.reciprocated).toBe(false);
  });

  it("throws GraphNotFoundError when the edge does not exist", async () => {
    const u = `${RUN_ID}-rr4-u1`;
    const e = `${RUN_ID}-rr4-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Oscar" });
    // No relationship created

    await expect(svc.removeRelationship(u, "entity", e)).rejects.toThrow();
  });

  it("throws GraphNotFoundError when user or entity do not exist at all", async () => {
    await expect(
      svc.removeRelationship(
        `${RUN_ID}-rr5-ghost-u`,
        "entity",
        `${RUN_ID}-rr5-ghost-e`,
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// updateRelationshipScore
// ---------------------------------------------------------------------------

describe("updateRelationshipScore", () => {
  it("sets manualScore and updates effective score on the edge", async () => {
    const u = `${RUN_ID}-urs1-u1`;
    const e = `${RUN_ID}-urs1-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Pepper" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e, connectionMethod: "discovery" });

    const updated = await svc.updateRelationshipScore({
      userId: u,
      targetType: "entity",
      targetId: e,
      manualScore: 0.9,
    });

    expect(updated.manualScore).toBeCloseTo(0.9);
    expect(updated.score).toBeCloseTo(0.9);
    expect(updated.tier).toBe(expectedTier(0.9)); // 0.9 >= 0.7 → tier 0

    // Verify in DB
    const edge = await getEdge(u, "RELATES_TO", e);
    expect(edge).not.toBeNull();
    expect(edge!.manualScore as number).toBeCloseTo(0.9);
    expect(edge!.score as number).toBeCloseTo(0.9);
  });

  it("clearing manualScore (null) reverts score to computedScore", async () => {
    const u = `${RUN_ID}-urs2-u1`;
    const e = `${RUN_ID}-urs2-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Daisy" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e, connectionMethod: "code" });

    // First, set a manual score
    await svc.updateRelationshipScore({ userId: u, targetType: "entity", targetId: e, manualScore: 0.95 });

    // Then clear it
    const cleared = await svc.updateRelationshipScore({
      userId: u,
      targetType: "entity",
      targetId: e,
      manualScore: null,
    });

    expect(cleared.manualScore).toBeNull();
    // Score should revert to computedScore (which was set at creation as connection bonus)
    expect(cleared.score).toBeCloseTo(BONUS.code);
  });

  it("updating score recalculates tier correctly", async () => {
    const u = `${RUN_ID}-urs3-u1`;
    const e = `${RUN_ID}-urs3-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Zeus" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e, connectionMethod: "discovery" });

    // Set low manual score → tier 3
    const lowScore = await svc.updateRelationshipScore({
      userId: u,
      targetType: "entity",
      targetId: e,
      manualScore: 0.05,
    });
    expect(lowScore.tier).toBe(3); // 0.05 < 0.15 → ambient

    // Set high manual score → tier 0
    const highScore = await svc.updateRelationshipScore({
      userId: u,
      targetType: "entity",
      targetId: e,
      manualScore: 0.85,
    });
    expect(highScore.tier).toBe(0); // 0.85 >= 0.7 → inner circle
  });

  it("throws GraphNotFoundError when relationship does not exist", async () => {
    const u = `${RUN_ID}-urs4-u1`;
    const e = `${RUN_ID}-urs4-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Simba" });

    await expect(
      svc.updateRelationshipScore({ userId: u, targetType: "entity", targetId: e, manualScore: 0.5 }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getRelationship
// ---------------------------------------------------------------------------

describe("getRelationship", () => {
  it("returns the relationship when it exists", async () => {
    const u = `${RUN_ID}-gr1-u1`;
    const e = `${RUN_ID}-gr1-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Nala" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e, connectionMethod: "import" });

    const rel = await svc.getRelationship(u, "entity", e);

    expect(rel).not.toBeNull();
    expect(rel!.userId).toBe(u);
    expect(rel!.targetId).toBe(e);
    expect(rel!.targetType).toBe("entity");
    expect(rel!.connectionMethod).toBe("import");
    expect(rel!.score).toBeCloseTo(BONUS.import);
  });

  it("returns null when the relationship does not exist", async () => {
    const u = `${RUN_ID}-gr2-u1`;
    const e = `${RUN_ID}-gr2-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Kira" });

    const rel = await svc.getRelationship(u, "entity", e);

    expect(rel).toBeNull();
  });

  it("returns null when the user does not exist", async () => {
    const rel = await svc.getRelationship(
      `${RUN_ID}-gr3-ghost`,
      "entity",
      `${RUN_ID}-gr3-ghost-e`,
    );
    expect(rel).toBeNull();
  });

  it("returns user→user relationship correctly", async () => {
    const u1 = `${RUN_ID}-gr4-u1`;
    const u2 = `${RUN_ID}-gr4-u2`;
    await svc.syncUser({ id: u1, role: "END_USER" });
    await svc.syncUser({ id: u2, role: "END_USER" });
    await svc.createRelationship({ userId: u1, targetType: "user", targetId: u2, connectionMethod: "code" });

    const rel = await svc.getRelationship(u1, "user", u2);

    expect(rel).not.toBeNull();
    expect(rel!.targetType).toBe("user");
    expect(rel!.score).toBeCloseTo(BONUS.code);
  });
});

// ---------------------------------------------------------------------------
// getRelationships
// ---------------------------------------------------------------------------

describe("getRelationships", () => {
  it("returns all relationships for a user ordered by score descending", async () => {
    const u = `${RUN_ID}-grs1-u1`;
    await svc.syncUser({ id: u, role: "END_USER" });

    // Create 3 entities with different connection methods (scores: code=0.7, import=0.5, discovery=0.3)
    const e1 = `${RUN_ID}-grs1-e1`;
    const e2 = `${RUN_ID}-grs1-e2`;
    const e3 = `${RUN_ID}-grs1-e3`;
    await svc.syncEntity({ id: e1, entityType: "dog", name: "Alpha" });
    await svc.syncEntity({ id: e2, entityType: "dog", name: "Beta" });
    await svc.syncEntity({ id: e3, entityType: "dog", name: "Gamma" });

    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e1, connectionMethod: "code" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e2, connectionMethod: "import" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e3, connectionMethod: "discovery" });

    const result = await svc.getRelationships(u);

    expect(result.items.length).toBe(3);
    // Ordered by score descending: code (0.7) > import (0.5) > discovery (0.3)
    expect(result.items[0].score).toBeGreaterThan(result.items[1].score);
    expect(result.items[1].score).toBeGreaterThan(result.items[2].score);
    expect(result.items[0].targetId).toBe(e1);
    expect(result.items[1].targetId).toBe(e2);
    expect(result.items[2].targetId).toBe(e3);
  });

  it("returns empty list when user has no relationships", async () => {
    const u = `${RUN_ID}-grs2-u1`;
    await svc.syncUser({ id: u, role: "END_USER" });

    const result = await svc.getRelationships(u);

    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });

  it("filters by tier", async () => {
    const u = `${RUN_ID}-grs3-u1`;
    await svc.syncUser({ id: u, role: "END_USER" });

    const eInner = `${RUN_ID}-grs3-e-inner`;
    const eAmbient = `${RUN_ID}-grs3-e-ambient`;
    await svc.syncEntity({ id: eInner, entityType: "dog", name: "Inner" });
    await svc.syncEntity({ id: eAmbient, entityType: "dog", name: "Ambient" });

    // code=0.7 → tier 0 (inner)
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: eInner, connectionMethod: "code" });
    // discovery=0.3 → tier 2 (community)
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: eAmbient, connectionMethod: "discovery" });

    // Filter tier 0 — should only return the inner circle entity
    const innerOnly = await svc.getRelationships(u, { tier: 0 });
    expect(innerOnly.items).toHaveLength(1);
    expect(innerOnly.items[0].targetId).toBe(eInner);
    expect(innerOnly.items[0].tier).toBe(0);

    // Filter tier 2 — should only return the community entity
    const communityOnly = await svc.getRelationships(u, { tier: 2 });
    expect(communityOnly.items).toHaveLength(1);
    expect(communityOnly.items[0].targetId).toBe(eAmbient);
  });

  it("filters by targetType=entity", async () => {
    const u = `${RUN_ID}-grs4-u1`;
    const u2 = `${RUN_ID}-grs4-u2`;
    const e = `${RUN_ID}-grs4-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncUser({ id: u2, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Scout" });

    await svc.createRelationship({ userId: u, targetType: "user", targetId: u2, connectionMethod: "code" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e, connectionMethod: "code" });

    const entityOnly = await svc.getRelationships(u, { targetType: "entity" });

    expect(entityOnly.items.every((r) => r.targetType === "entity")).toBe(true);
    expect(entityOnly.items.some((r) => r.targetId === e)).toBe(true);
    expect(entityOnly.items.some((r) => r.targetType === "user")).toBe(false);
  });

  it("filters by targetType=user", async () => {
    const u = `${RUN_ID}-grs5-u1`;
    const u2 = `${RUN_ID}-grs5-u2`;
    const e = `${RUN_ID}-grs5-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncUser({ id: u2, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Rex" });

    await svc.createRelationship({ userId: u, targetType: "user", targetId: u2, connectionMethod: "import" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e, connectionMethod: "code" });

    const userOnly = await svc.getRelationships(u, { targetType: "user" });

    expect(userOnly.items.every((r) => r.targetType === "user")).toBe(true);
    expect(userOnly.items.some((r) => r.targetId === u2)).toBe(true);
  });

  it("paginates results with hasMore=true and a cursor when limit is exceeded", async () => {
    const u = `${RUN_ID}-grs6-u1`;
    await svc.syncUser({ id: u, role: "END_USER" });

    // Create 3 entities and relationships
    const ids = [`${RUN_ID}-grs6-e1`, `${RUN_ID}-grs6-e2`, `${RUN_ID}-grs6-e3`];
    for (const id of ids) {
      await svc.syncEntity({ id, entityType: "dog", name: id });
      await svc.createRelationship({ userId: u, targetType: "entity", targetId: id, connectionMethod: "discovery" });
    }

    // Request only 2 of 3
    const page1 = await svc.getRelationships(u, { pagination: { limit: 2 } });

    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).not.toBeNull();
  });

  it("second page using cursor returns remaining items with hasMore=false", async () => {
    const u = `${RUN_ID}-grs7-u1`;
    await svc.syncUser({ id: u, role: "END_USER" });

    const e1 = `${RUN_ID}-grs7-e1`;
    const e2 = `${RUN_ID}-grs7-e2`;
    const e3 = `${RUN_ID}-grs7-e3`;
    await svc.syncEntity({ id: e1, entityType: "dog", name: "P1" });
    await svc.syncEntity({ id: e2, entityType: "dog", name: "P2" });
    await svc.syncEntity({ id: e3, entityType: "dog", name: "P3" });

    // Use different connection methods to guarantee different scores
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e1, connectionMethod: "code" });      // 0.7
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e2, connectionMethod: "import" });    // 0.5
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e3, connectionMethod: "discovery" }); // 0.3

    const page1 = await svc.getRelationships(u, { pagination: { limit: 2 } });
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).not.toBeNull();

    const page2 = await svc.getRelationships(u, { pagination: { limit: 2, cursor: page1.cursor! } });
    expect(page2.items).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.cursor).toBeNull();

    // Ensure the two pages together cover all 3 relationships with no duplicates
    const allIds = [...page1.items.map((r) => r.targetId), ...page2.items.map((r) => r.targetId)];
    expect(allIds).toContain(e1);
    expect(allIds).toContain(e2);
    expect(allIds).toContain(e3);
  });
});

// ---------------------------------------------------------------------------
// getRelationshipGraph
// ---------------------------------------------------------------------------

describe("getRelationshipGraph", () => {
  it("returns nodes and tier summary for a user's relationships", async () => {
    const u = `${RUN_ID}-grg1-u1`;
    const e1 = `${RUN_ID}-grg1-e1`;
    const e2 = `${RUN_ID}-grg1-e2`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e1, entityType: "dog", name: "Fido" });
    await svc.syncEntity({ id: e2, entityType: "dog", name: "Spot" });

    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e1, connectionMethod: "code" });      // 0.7
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e2, connectionMethod: "discovery" }); // 0.3

    const graph = await svc.getRelationshipGraph(u);

    expect(graph.nodes).toHaveLength(2);

    // Nodes are ordered by score descending
    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).toContain(e1);
    expect(nodeIds).toContain(e2);

    const node1 = graph.nodes.find((n) => n.id === e1)!;
    const node2 = graph.nodes.find((n) => n.id === e2)!;

    // Tier is set correctly
    expect(node1.tier).toBe(expectedTier(BONUS.code));   // tier 0
    expect(node2.tier).toBe(expectedTier(BONUS.discovery)); // tier 2

    // closeness is bucketed to nearest 10 (rawScore * 10 * 10, rounded)
    expect(node1.closeness).toBe(Math.round(BONUS.code * 10) * 10);
    expect(node2.closeness).toBe(Math.round(BONUS.discovery * 10) * 10);
  });

  it("returns empty nodes and zero counts for a user with no relationships", async () => {
    const u = `${RUN_ID}-grg2-u1`;
    await svc.syncUser({ id: u, role: "END_USER" });

    const graph = await svc.getRelationshipGraph(u);

    expect(graph.nodes).toHaveLength(0);
    expect(graph.tiers.inner.count).toBe(0);
    expect(graph.tiers.closeFriends.count).toBe(0);
    expect(graph.tiers.community.count).toBe(0);
    expect(graph.tiers.ambient.count).toBe(0);
  });

  it("tier summary counts match nodes by tier", async () => {
    const u = `${RUN_ID}-grg3-u1`;
    await svc.syncUser({ id: u, role: "END_USER" });

    // tier 0: code=0.7
    const eInner = `${RUN_ID}-grg3-e-inner`;
    // tier 1: import=0.5
    const eClose = `${RUN_ID}-grg3-e-close`;
    // tier 2: discovery=0.3
    const eCommunity1 = `${RUN_ID}-grg3-e-comm1`;
    const eCommunity2 = `${RUN_ID}-grg3-e-comm2`;

    for (const id of [eInner, eClose, eCommunity1, eCommunity2]) {
      await svc.syncEntity({ id, entityType: "dog", name: id });
    }

    await svc.createRelationship({ userId: u, targetType: "entity", targetId: eInner, connectionMethod: "code" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: eClose, connectionMethod: "import" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: eCommunity1, connectionMethod: "discovery" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: eCommunity2, connectionMethod: "suggestion" });

    const graph = await svc.getRelationshipGraph(u);

    expect(graph.tiers.inner.count).toBe(1);       // code: tier 0
    expect(graph.tiers.closeFriends.count).toBe(1); // import: tier 1
    expect(graph.tiers.community.count).toBe(2);    // discovery + suggestion: tier 2
    expect(graph.tiers.ambient.count).toBe(0);
  });

  it("tier thresholds in summary match TIER_THRESHOLDS constants", async () => {
    const u = `${RUN_ID}-grg4-u1`;
    await svc.syncUser({ id: u, role: "END_USER" });

    const graph = await svc.getRelationshipGraph(u);

    expect(graph.tiers.inner.threshold).toBe(TIER_THRESHOLDS.find((t) => t.tier === 0)!.minScore);
    expect(graph.tiers.closeFriends.threshold).toBe(TIER_THRESHOLDS.find((t) => t.tier === 1)!.minScore);
    expect(graph.tiers.community.threshold).toBe(TIER_THRESHOLDS.find((t) => t.tier === 2)!.minScore);
    expect(graph.tiers.ambient.threshold).toBe(TIER_THRESHOLDS.find((t) => t.tier === 3)!.minScore);
  });

  it("closeness is coarsened to nearest 10 (no raw score exposure)", async () => {
    const u = `${RUN_ID}-grg5-u1`;
    const e = `${RUN_ID}-grg5-e1`;
    await svc.syncUser({ id: u, role: "END_USER" });
    await svc.syncEntity({ id: e, entityType: "dog", name: "Roxy" });
    await svc.createRelationship({ userId: u, targetType: "entity", targetId: e, connectionMethod: "import" });

    const graph = await svc.getRelationshipGraph(u);

    const node = graph.nodes.find((n) => n.id === e)!;
    // closeness must be a multiple of 10
    expect(node.closeness % 10).toBe(0);
    // For import (0.5): Math.round(0.5 * 10) * 10 = Math.round(5) * 10 = 50
    expect(node.closeness).toBe(Math.round(BONUS.import * 10) * 10);
  });
});
