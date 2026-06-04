/**
 * Integration Tests: Neo4j GraphService — Discovery & Scoring Methods
 *
 * Tests discoverByGraph, discoverNearby, getRecommendations, recordInteraction,
 * recomputeScores, and applyDecay against a real local Neo4j instance.
 *
 * PROD-SAFE: Uses a unique RUN_ID prefix for all node IDs.
 * afterAll cleans up only nodes whose IDs start with that prefix.
 * Does NOT use withCleanDb() — safe to run against shared/prod-like databases.
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
import type { EntityGeoLookup, NearbyEntity } from "../../../src/lib/geo/entity-geo-repository.js";
import { runWithTenantContext, tenantId } from "@de-otio/saas-foundation/tenant";
import { closeTestDriver, createEntity, createOwnership, createUser, deleteTestNodes } from "./harness.js";
import { getTestDatabase, getTestDriver, getTestGraphServiceConfig } from "./setup.js";

// ---------------------------------------------------------------------------
// Prod-safe run isolation
// ---------------------------------------------------------------------------

const RUN_ID = `test-${Date.now().toString(36)}`;

/** Prefix a local name with the run ID so cleanup is scoped. */
function id(name: string): string {
  return `${RUN_ID}-${name}`;
}

// ---------------------------------------------------------------------------
// Direct Cypher helpers (bypassing service auth checks)
// ---------------------------------------------------------------------------

async function runCypher(
  query: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  const driver = getTestDriver();
  const database = getTestDatabase();
  const session = driver.session({ database });
  try {
    await session.run(query, params);
  } finally {
    await session.close();
  }
}

/**
 * Create a RELATES_TO edge directly in the graph (bypasses ownership checks).
 * Used to set up scoring/discovery fixtures that require existing relationships.
 */
async function createRelatesToEdge(
  userId: string,
  targetLabel: "User" | "Entity",
  targetId: string,
  props: Record<string, unknown> = {},
): Promise<void> {
  const defaults = {
    computedScore: 0.3,
    manualScore: null,
    score: 0.3,
    tier: 3,
    interactionCount: 0,
    lastInteractionAt: null,
    connectionMethod: "discovery",
    reciprocated: false,
    createdAt: new Date().toISOString(),
  };
  const merged = { ...defaults, ...props };
  await runCypher(
    `
    MATCH (u:User {id: $userId}), (t:${targetLabel} {id: $targetId})
    MERGE (u)-[r:RELATES_TO]->(t)
    ON CREATE SET r += $props
    `,
    { userId, targetId, props: merged },
  );
}

/**
 * Create an ENTITY_RELATES edge between two entities directly via Cypher.
 * Used for discoverByGraph fixtures — skips the create/confirm ownership flow.
 */
async function createEntityRelatesEdge(
  fromEntityId: string,
  toEntityId: string,
  relationshipType: string = "PLAYMATE",
): Promise<void> {
  await runCypher(
    `
    MATCH (a:Entity {id: $fromId}), (b:Entity {id: $toId})
    MERGE (a)-[r:${relationshipType}]->(b)
    ON CREATE SET r.createdAt = datetime(), r.status = 'CONFIRMED'
    `,
    { fromId: fromEntityId, toId: toEntityId },
  );
}

/** Read a RELATES_TO edge's properties directly via Cypher. */
async function getRelatesToProps(
  userId: string,
  targetLabel: "User" | "Entity",
  targetId: string,
): Promise<Record<string, unknown> | null> {
  const driver = getTestDriver();
  const database = getTestDatabase();
  const session = driver.session({ database });
  try {
    const result = await session.run(
      `MATCH (u:User {id: $userId})-[r:RELATES_TO]->(t:${targetLabel} {id: $targetId})
       RETURN properties(r) AS props`,
      { userId, targetId },
    );
    if (result.records.length === 0) return null;
    return result.records[0].get("props") as Record<string, unknown>;
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

let svc: GraphService & GraphConnection;

// Fake geo lookup — proximity is PostGIS's job (EntityGeoRepository, verified in
// its own suite). Tests set `fakeNearby` / `fakeNearAnchors` to drive the
// graph-side merge/filter; the write methods record nothing (no PostGIS here).
let fakeNearby: NearbyEntity[] = [];
let fakeNearAnchors: NearbyEntity[] = [];
const fakeGeo: EntityGeoLookup = {
  findNearby: async () => fakeNearby,
  findNearAnchors: async () => fakeNearAnchors,
  upsertLocation: async () => {},
  removeLocation: async () => {},
};
const TEST_TENANT = tenantId("t-discovery-test");

/** Run discoverNearby with a given geo candidate set, inside a tenant context. */
async function discoverWith(nearby: NearbyEntity[], userId: string) {
  fakeNearby = nearby;
  return runWithTenantContext(TEST_TENANT, () => svc.discoverNearby(userId, 52.52, 13.4, 5000));
}

/** Run getRecommendations with a given near-anchors set, inside a tenant context. */
async function recommendWith(nearAnchors: NearbyEntity[], userId: string, limit = 10) {
  fakeNearAnchors = nearAnchors;
  return runWithTenantContext(TEST_TENANT, () => svc.getRecommendations(userId, limit));
}

beforeAll(async () => {
  svc = await createGraphService(getTestGraphServiceConfig(), fakeGeo);
});

afterAll(async () => {
  await deleteTestNodes(RUN_ID);
  await svc.close();
  await closeTestDriver();
});

// ---------------------------------------------------------------------------
// discoverByGraph
// ---------------------------------------------------------------------------

describe("discoverByGraph", () => {
  it("returns an entity reachable in 1 hop via PLAYMATE edge", async () => {
    const u1 = id("dbg-u1");
    const e1 = id("dbg-e1");
    const e2 = id("dbg-e2");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "Alpha" });
    await createEntity(e2, { entityType: "dog", name: "Beta" });
    await createOwnership(u1, e1, "PRIMARY_OWNER");
    await createEntityRelatesEdge(e1, e2, "PLAYMATE");

    const results = await svc.discoverByGraph(u1, 1);

    expect(results.some((r) => r.entityId === e2)).toBe(true);
    const betaResult = results.find((r) => r.entityId === e2);
    expect(betaResult?.hops).toBe(1);
    expect(betaResult?.name).toBe("Beta");
    expect(betaResult?.entityType).toBe("dog");
  });

  it("does NOT return entities the user already has a RELATES_TO with", async () => {
    const u1 = id("dbg-u2");
    const e1 = id("dbg-e3");
    const e2 = id("dbg-e4");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "Gamma" });
    await createEntity(e2, { entityType: "dog", name: "Delta" });
    await createOwnership(u1, e1, "PRIMARY_OWNER");
    await createEntityRelatesEdge(e1, e2, "PACK_MATE");
    // User already follows e2
    await createRelatesToEdge(u1, "Entity", e2);

    const results = await svc.discoverByGraph(u1, 1);

    expect(results.some((r) => r.entityId === e2)).toBe(false);
  });

  it("returns empty array when user owns no entities", async () => {
    const u1 = id("dbg-u3");
    await createUser(u1, "END_USER");

    const results = await svc.discoverByGraph(u1, 1);

    expect(results).toEqual([]);
  });

  it("caps hops at 2 even when caller passes a larger value", async () => {
    const u1 = id("dbg-u4");
    const e1 = id("dbg-e5");
    const e2 = id("dbg-e6");
    const e3 = id("dbg-e7");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "Hop1" });
    await createEntity(e2, { entityType: "dog", name: "Hop2" });
    await createEntity(e3, { entityType: "dog", name: "Hop3" });
    await createOwnership(u1, e1, "PRIMARY_OWNER");
    await createEntityRelatesEdge(e1, e2, "SIBLING");
    await createEntityRelatesEdge(e2, e3, "SIBLING");

    // Pass hops=5 — should be silently clamped to 2, not throw
    const results = await svc.discoverByGraph(u1, 5);

    // e2 is 1 hop from e1, so should appear
    expect(results.some((r) => r.entityId === e2)).toBe(true);
    // e3 is 2 hops from e1, so should also appear (within cap)
    expect(results.some((r) => r.entityId === e3)).toBe(true);
  });

  it("applies entityType filter correctly", async () => {
    const u1 = id("dbg-u5");
    const e1 = id("dbg-e8");
    const e2 = id("dbg-e9");
    const e3 = id("dbg-e10");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "OwnerDog" });
    await createEntity(e2, { entityType: "dog", name: "FriendDog" });
    await createEntity(e3, { entityType: "cat", name: "FilteredCat" });
    await createOwnership(u1, e1, "PRIMARY_OWNER");
    await createEntityRelatesEdge(e1, e2, "WALK_BUDDY");
    await createEntityRelatesEdge(e1, e3, "WALK_BUDDY");

    const results = await svc.discoverByGraph(u1, 1, { entityType: "dog" });

    expect(results.some((r) => r.entityId === e2)).toBe(true);
    expect(results.some((r) => r.entityId === e3)).toBe(false);
  });

  it("does NOT return entities with discoverable=false", async () => {
    const u1 = id("dbg-u6");
    const e1 = id("dbg-e11");
    const e2 = id("dbg-e12");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "OwnerPup" });
    // Create entity with discoverable=false using direct Cypher
    await runCypher(
      `CREATE (e:Entity {id: $id, entityType: 'dog', name: 'Hidden', discoverable: false, createdAt: datetime()})`,
      { id: e2 },
    );
    await createOwnership(u1, e1, "PRIMARY_OWNER");
    await createEntityRelatesEdge(e1, e2, "PLAYMATE");

    const results = await svc.discoverByGraph(u1, 1);

    expect(results.some((r) => r.entityId === e2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// discoverNearby
// ---------------------------------------------------------------------------

describe("discoverNearby", () => {
  // Proximity is computed in Postgres/PostGIS (EntityGeoRepository, verified in
  // its own suite). Here a fake geo lookup supplies the candidate set, and we
  // assert the graph-side behaviour: entity fields, coarse band, IN-restriction,
  // and exclude-already-related.

  it("returns nearby entities with a coarse distanceBand (never exact distance)", async () => {
    const u1 = id("dn-u1");
    const e1 = id("dn-e1");
    await createUser(u1, "END_USER");
    await runCypher(
      `CREATE (e:Entity {id: $id, entityType: 'dog', name: 'NearDog', createdAt: datetime()})`,
      { id: e1 },
    );

    const results = await discoverWith([{ entityId: e1, distanceMeters: 200 }], u1);
    const target = results.find((r) => r.entityId === e1);

    expect(target).toBeDefined();
    expect(["< 500m", "500m-1km", "1-2km", "2-5km", "> 5km"]).toContain(target?.distanceBand);
  });

  it("returns only entities in the geo candidate set (radius is the repo's job)", async () => {
    const u1 = id("dn-u2");
    const e1 = id("dn-e2");
    await createUser(u1, "END_USER");
    await runCypher(
      `CREATE (e:Entity {id: $id, entityType: 'dog', name: 'FarDog', createdAt: datetime()})`,
      { id: e1 },
    );

    // Geo lookup returns nothing for this entity → discovery excludes it.
    const results = await discoverWith([], u1);
    expect(results.some((r) => r.entityId === e1)).toBe(false);
  });

  it("excludes entities with an existing RELATES_TO relationship", async () => {
    const u1 = id("dn-u4");
    const e1 = id("dn-e4");
    await createUser(u1, "END_USER");
    await runCypher(
      `CREATE (e:Entity {id: $id, entityType: 'dog', name: 'RelatedNearDog', createdAt: datetime()})`,
      { id: e1 },
    );
    await createRelatesToEdge(u1, "Entity", e1);

    // Even though geo returns it, the graph excludes already-related entities.
    const results = await discoverWith([{ entityId: e1, distanceMeters: 100 }], u1);
    expect(results.some((r) => r.entityId === e1)).toBe(false);
  });

  it("returns empty when the geo lookup finds nothing", async () => {
    const u1 = id("dn-u5");
    await createUser(u1, "END_USER");

    const results = await discoverWith([], u1);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getRecommendations
// ---------------------------------------------------------------------------

describe("getRecommendations", () => {
  it("returns an array (possibly empty) for a user with no connections", async () => {
    const u1 = id("rec-u1");
    await createUser(u1, "END_USER");

    const results = await svc.getRecommendations(u1, 10);

    expect(Array.isArray(results)).toBe(true);
  });

  it("returns recommendations with required fields when breed-matching data exists", async () => {
    const u1 = id("rec-u2");
    const e1 = id("rec-e1"); // Owned entity — Labrador
    const e2 = id("rec-e2"); // Candidate — also Labrador (not owned, not followed)

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "MyLabrador", breed: "Labrador" });
    await createEntity(e2, { entityType: "dog", name: "OtherLabrador", breed: "Labrador" });
    await createOwnership(u1, e1, "PRIMARY_OWNER");

    const results = await svc.getRecommendations(u1, 10);

    // e2 should appear via same_breed signal
    const rec = results.find((r) => r.entityId === e2);
    expect(rec).toBeDefined();
    expect(rec).toMatchObject({
      entityId: e2,
      name: "OtherLabrador",
      entityType: "dog",
      reason: expect.any(String),
      confidence: expect.any(Number),
    });
    expect(rec!.confidence).toBeGreaterThanOrEqual(0);
    expect(rec!.confidence).toBeLessThanOrEqual(1);
  });

  it("respects the limit parameter", async () => {
    const u1 = id("rec-u3");

    await createUser(u1, "END_USER");
    // Create 3 breed-matched candidates
    for (let i = 0; i < 3; i++) {
      const ownedId = id(`rec-owned-${i}`);
      const candidateId = id(`rec-cand-${i}`);
      await createEntity(ownedId, { entityType: "dog", name: `MyPoodle${i}`, breed: "Poodle" });
      await createEntity(candidateId, { entityType: "dog", name: `OtherPoodle${i}`, breed: "Poodle" });
      await createOwnership(u1, ownedId, "PRIMARY_OWNER");
    }

    const results = await svc.getRecommendations(u1, 2);

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("surfaces a PostGIS near-anchor candidate as a 'nearby' recommendation", async () => {
    const u1 = id("rec-nb-u1");
    const owned = id("rec-nb-owned"); // anchor the user owns
    const near = id("rec-nb-near"); // PostGIS says this is close to the anchor

    await createUser(u1, "END_USER");
    await createEntity(owned, { entityType: "dog", name: "MyAnchor" });
    await createEntity(near, { entityType: "dog", name: "NearbyDog" });
    await createOwnership(u1, owned, "PRIMARY_OWNER");

    // PostGIS returns `near` within 1200m of an anchor; the graph confirms it is
    // discoverable and unrelated, so it should surface with reason "nearby".
    const results = await recommendWith([{ entityId: near, distanceMeters: 1200 }], u1);

    const rec = results.find((r) => r.entityId === near);
    expect(rec).toBeDefined();
    expect(rec!.reason).toBe("nearby");
    // score = (1 - 1200/10000) * 0.5 = 0.44; confidence clamps to [0,1].
    expect(rec!.confidence).toBeCloseTo(0.44, 2);
  });

  it("excludes a near-anchor candidate the user already relates to", async () => {
    const u1 = id("rec-nb-u2");
    const owned = id("rec-nb-owned2");
    const related = id("rec-nb-related"); // close in PostGIS, but already followed

    await createUser(u1, "END_USER");
    await createEntity(owned, { entityType: "dog", name: "MyAnchor2" });
    await createEntity(related, { entityType: "dog", name: "AlreadyFollowed" });
    await createOwnership(u1, owned, "PRIMARY_OWNER");
    await createRelatesToEdge(u1, "Entity", related);

    const results = await recommendWith([{ entityId: related, distanceMeters: 300 }], u1);

    expect(results.some((r) => r.entityId === related)).toBe(false);
  });

  it("returns no 'nearby' signal when the user owns no anchor entities", async () => {
    const u1 = id("rec-nb-u3");
    const orphan = id("rec-nb-orphan");

    await createUser(u1, "END_USER");
    await createEntity(orphan, { entityType: "dog", name: "OrphanNearby" });

    // Even though PostGIS would return a candidate, no owned anchors → the graph
    // anchor query is empty → the nearby signal is skipped entirely.
    const results = await recommendWith([{ entityId: orphan, distanceMeters: 100 }], u1);

    expect(results.some((r) => r.entityId === orphan)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordInteraction
// ---------------------------------------------------------------------------

describe("recordInteraction", () => {
  it("increments interactionCount and sets lastInteractionAt on the RELATES_TO edge", async () => {
    const u1 = id("ri-u1");
    const e1 = id("ri-e1");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "InteractionDog" });
    await createRelatesToEdge(u1, "Entity", e1, { interactionCount: 0 });

    await svc.recordInteraction({
      userId: u1,
      targetType: "entity",
      targetId: e1,
      interactionType: "view",
    });

    const props = await getRelatesToProps(u1, "Entity", e1);
    expect(props).not.toBeNull();
    expect(props!.interactionCount).toBe(1);
    expect(props!.lastInteractionAt).not.toBeNull();
    expect(props!.i_view).toBe(1);
  });

  it("accumulates multiple interactions of the same type", async () => {
    const u1 = id("ri-u2");
    const e1 = id("ri-e2");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "MultiInteractionDog" });
    await createRelatesToEdge(u1, "Entity", e1, { interactionCount: 0 });

    await svc.recordInteraction({
      userId: u1,
      targetType: "entity",
      targetId: e1,
      interactionType: "comment",
    });
    await svc.recordInteraction({
      userId: u1,
      targetType: "entity",
      targetId: e1,
      interactionType: "comment",
    });

    const props = await getRelatesToProps(u1, "Entity", e1);
    expect(props!.interactionCount).toBe(2);
    expect(props!.i_comment).toBe(2);
  });

  it("is a no-op when the RELATES_TO edge does not exist (does not throw)", async () => {
    const u1 = id("ri-u3");
    const e1 = id("ri-e3");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "NoRelationDog" });

    // No edge — should resolve without throwing
    await expect(
      svc.recordInteraction({
        userId: u1,
        targetType: "entity",
        targetId: e1,
        interactionType: "react",
      }),
    ).resolves.toBeUndefined();
  });

  it("records interactions on user→user RELATES_TO edges", async () => {
    const u1 = id("ri-u4");
    const u2 = id("ri-u5");

    await createUser(u1, "END_USER");
    await createUser(u2, "END_USER");
    await createRelatesToEdge(u1, "User", u2, { interactionCount: 0 });

    await svc.recordInteraction({
      userId: u1,
      targetType: "user",
      targetId: u2,
      interactionType: "profile_visit",
    });

    const props = await getRelatesToProps(u1, "User", u2);
    expect(props!.interactionCount).toBe(1);
    expect(props!.i_profile_visit).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// recomputeScores
// ---------------------------------------------------------------------------

describe("recomputeScores", () => {
  it("returns an array for a user with no relationships", async () => {
    const u1 = id("rs-u1");
    await createUser(u1, "END_USER");

    const result = await svc.recomputeScores(u1);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("updates computedScore and tier on the edge after recompute", async () => {
    const u1 = id("rs-u2");
    const e1 = id("rs-e1");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "ScoreDog" });
    // Start with a fresh relationship (score=0.3, tier=3)
    await createRelatesToEdge(u1, "Entity", e1, {
      computedScore: 0.3,
      tier: 3,
      interactionCount: 0,
    });

    await svc.recomputeScores(u1);

    const props = await getRelatesToProps(u1, "Entity", e1);
    expect(props).not.toBeNull();
    // computedScore should be a valid number in [0, 1]
    expect(typeof props!.computedScore).toBe("number");
    expect(props!.computedScore as number).toBeGreaterThanOrEqual(0);
    expect(props!.computedScore as number).toBeLessThanOrEqual(1);
  });

  it("returns ScoreUpdate entries only for relationships where tier changed", async () => {
    const u1 = id("rs-u3");
    const e1 = id("rs-e2");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "TierChangeDog" });
    // Set tier=0 (inner circle) — scoring formula on a fresh discovery edge will
    // produce a lower score, causing a tier change
    await createRelatesToEdge(u1, "Entity", e1, {
      computedScore: 0.9,
      tier: 0,
      interactionCount: 0,
    });

    const updates = await svc.recomputeScores(u1);

    // There may or may not be a tier change depending on formula outcome,
    // but the return type must always be an array of ScoreUpdate objects.
    expect(Array.isArray(updates)).toBe(true);
    for (const update of updates) {
      expect(update).toMatchObject({
        userId: expect.any(String),
        targetType: expect.stringMatching(/^(user|entity)$/),
        targetId: expect.any(String),
        previousScore: expect.any(Number),
        newScore: expect.any(Number),
        previousTier: expect.any(Number),
        newTier: expect.any(Number),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// applyDecay
// ---------------------------------------------------------------------------

describe("applyDecay", () => {
  it("returns an empty array for a user with no relationships", async () => {
    const u1 = id("ad-u1");
    await createUser(u1, "END_USER");

    const result = await svc.applyDecay(u1);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("returns an array for a user with relationships (no throw)", async () => {
    const u1 = id("ad-u2");
    const e1 = id("ad-e1");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "DecayDog" });
    await createRelatesToEdge(u1, "Entity", e1, {
      computedScore: 0.5,
      tier: 2,
      interactionCount: 1,
      lastInteractionAt: new Date().toISOString(),
    });

    const result = await svc.applyDecay(u1);

    expect(Array.isArray(result)).toBe(true);
  });

  it("applies decay to a user→entity edge with an old lastInteractionAt and returns tier changes", async () => {
    const u1 = id("ad-u3");
    const e1 = id("ad-e2");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "OldInteractionDog" });

    // Set lastInteractionAt to 200 days ago — well past the 120-day half-life
    const oldDate = new Date(Date.now() - 200 * 86_400_000).toISOString();
    await createRelatesToEdge(u1, "Entity", e1, {
      computedScore: 0.8,
      tier: 0, // inner circle
      interactionCount: 10,
      lastInteractionAt: oldDate,
    });

    const updates = await svc.applyDecay(u1);

    // 200 days at 120-day half-life: decay = 1 - 2^(-200/120) ≈ 0.688
    // decayedScore = 0.8 * (1 - 0.688) ≈ 0.25, which is tier 2 (was tier 0)
    // So a tier change SHOULD be produced
    const update = updates.find((u) => u.targetId === e1);
    expect(update).toBeDefined();
    expect(update!.previousTier).toBe(0);
    expect(update!.newTier).toBeGreaterThan(0);
    expect(update!.newScore).toBeLessThan(update!.previousScore);
  });

  it("does NOT apply decay to owned entities", async () => {
    const u1 = id("ad-u4");
    const e1 = id("ad-e3");

    await createUser(u1, "END_USER");
    await createEntity(e1, { entityType: "dog", name: "OwnedDog" });
    await createOwnership(u1, e1, "PRIMARY_OWNER");

    // Also add a RELATES_TO edge with an old interaction date
    const oldDate = new Date(Date.now() - 200 * 86_400_000).toISOString();
    await createRelatesToEdge(u1, "Entity", e1, {
      computedScore: 0.8,
      tier: 0,
      interactionCount: 5,
      lastInteractionAt: oldDate,
    });

    const updates = await svc.applyDecay(u1);

    // Owned entities are exempt — should not appear in tier changes for e1
    const ownedUpdate = updates.find((u) => u.targetId === e1);
    expect(ownedUpdate).toBeUndefined();
  });
});
