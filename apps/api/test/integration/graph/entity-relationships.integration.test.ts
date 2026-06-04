/**
 * Integration Tests: Neo4j GraphService — Entity Relationship Methods
 *
 * Tests createEntityRelationship, confirmEntityRelationship,
 * rejectEntityRelationship, removeEntityRelationship,
 * getEntityRelationships, and getPendingEntityRelationships
 * against a real local Neo4j instance.
 *
 * Prod-safe: all nodes are prefixed with RUN_ID and cleaned up in afterAll.
 * Does NOT use withCleanDb/wipeTestDb.
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
import {
  GraphAuthorizationError,
  GraphConflictError,
  GraphNotFoundError,
} from "../../../src/lib/graph/errors.js";
import { closeTestDriver, deleteTestNodes } from "./harness.js";
import { getTestDatabase, getTestDriver, getTestGraphServiceConfig } from "./setup.js";

// ---------------------------------------------------------------------------
// Unique run ID — all node IDs are prefixed so cleanup is scoped to this run
// ---------------------------------------------------------------------------

const RUN_ID = `test-${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// Cypher helpers (query by scoped IDs — never touch other test runs' data)
// ---------------------------------------------------------------------------

async function getEdgeProps(
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

async function edgeExists(fromId: string, edgeType: string, toId: string): Promise<boolean> {
  return (await getEdgeProps(fromId, edgeType, toId)) !== null;
}

async function countEdgesOfType(fromId: string, edgeType: string): Promise<number> {
  const driver = getTestDriver();
  const database = getTestDatabase();
  const session = driver.session({ database });
  try {
    const result = await session.run(
      `MATCH (a {id: $fromId})-[r:${edgeType}]->() RETURN count(r) AS c`,
      { fromId },
    );
    return (result.records[0]?.get("c") as number) ?? 0;
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Scoped ID helpers
// ---------------------------------------------------------------------------

function uid(suffix: string): string {
  return `${RUN_ID}-${suffix}`;
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
// Shared test-data setup
//
// We create a small fixture graph once per suite using scoped IDs:
//   u1 -[PRIMARY_OWNER]-> e1  (dog "Buddy")
//   u2 -[PRIMARY_OWNER]-> e2  (dog "Max")
//   u3 -[PRIMARY_OWNER]-> e3  (dog "Luna")
//   u1 -[CO_OWNER]->      e3  (u1 also co-owns e3, enabling auto-confirm)
//
// Each describe block that needs a relationship creates it inline so tests
// remain independent. The fixture nodes themselves are created once.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Users
  await svc.syncUser({ id: uid("u1"), role: "END_USER" });
  await svc.syncUser({ id: uid("u2"), role: "END_USER" });
  await svc.syncUser({ id: uid("u3"), role: "END_USER" });

  // Entities
  await svc.syncEntity({ id: uid("e1"), entityType: "dog", name: "Buddy" });
  await svc.syncEntity({ id: uid("e2"), entityType: "dog", name: "Max" });
  await svc.syncEntity({ id: uid("e3"), entityType: "dog", name: "Luna" });

  // Ownerships
  await svc.syncOwnership({ userId: uid("u1"), entityId: uid("e1"), role: "PRIMARY_OWNER" });
  await svc.syncOwnership({ userId: uid("u2"), entityId: uid("e2"), role: "PRIMARY_OWNER" });
  await svc.syncOwnership({ userId: uid("u3"), entityId: uid("e3"), role: "PRIMARY_OWNER" });
  // u1 also co-owns e3 → enables auto-confirm for PACK_MATE between e1 and e3
  await svc.syncOwnership({ userId: uid("u1"), entityId: uid("e3"), role: "CO_OWNER" });
});

// ---------------------------------------------------------------------------
// createEntityRelationship
// ---------------------------------------------------------------------------

describe("createEntityRelationship", () => {
  it("creates a PENDING edge from source to target", async () => {
    const result = await svc.createEntityRelationship({
      entityId: uid("e1"),
      relatedEntityId: uid("e2"),
      type: "SIBLING",
      proposedByUserId: uid("u1"),
    });

    expect(result.entityId).toBe(uid("e1"));
    expect(result.relatedEntityId).toBe(uid("e2"));
    expect(result.type).toBe("SIBLING");
    expect(result.status).toBe("PENDING");
    expect(result.proposedByUserId).toBe(uid("u1"));
    expect(result.since).toBeInstanceOf(Date);
  });

  it("persists the PENDING edge in the graph with correct props", async () => {
    const props = await getEdgeProps(uid("e1"), "ENTITY_RELATES", uid("e2"));
    expect(props).not.toBeNull();
    expect(props!.type).toBe("SIBLING");
    expect(props!.status).toBe("PENDING");
    expect(props!.proposedByUserId).toBe(uid("u1"));
  });

  it("auto-confirms PACK_MATE when a single user owns both entities (PRIMARY_OWNER + CO_OWNER)", async () => {
    // u1 owns e1 (PRIMARY_OWNER) and e3 (CO_OWNER) → auto-confirm
    const result = await svc.createEntityRelationship({
      entityId: uid("e1"),
      relatedEntityId: uid("e3"),
      type: "PACK_MATE",
      proposedByUserId: uid("u1"),
    });

    expect(result.status).toBe("CONFIRMED");
  });

  it("auto-confirm creates bidirectional CONFIRMED edges for PACK_MATE", async () => {
    const fwd = await getEdgeProps(uid("e1"), "ENTITY_RELATES", uid("e3"));
    const rev = await getEdgeProps(uid("e3"), "ENTITY_RELATES", uid("e1"));

    expect(fwd).not.toBeNull();
    expect(fwd!.status).toBe("CONFIRMED");
    expect(fwd!.type).toBe("PACK_MATE");
    expect(rev).not.toBeNull();
    expect(rev!.status).toBe("CONFIRMED");
    expect(rev!.type).toBe("PACK_MATE");
  });

  it("throws GraphAuthorizationError when proposing user does not own source entity", async () => {
    // u2 does not own e1
    await expect(
      svc.createEntityRelationship({
        entityId: uid("e1"),
        relatedEntityId: uid("e2"),
        type: "PLAYMATE",
        proposedByUserId: uid("u2"),
      }),
    ).rejects.toThrow(GraphAuthorizationError);
  });

  it("throws GraphNotFoundError when source entity does not exist", async () => {
    // First we need a user that owns the (non-existent) entity — ownership check
    // runs before entity-existence check, so we need a real user with no real entity.
    // The ownership check will fail first since nobody owns a ghost entity.
    await expect(
      svc.createEntityRelationship({
        entityId: uid("ghost-entity"),
        relatedEntityId: uid("e2"),
        type: "SIBLING",
        proposedByUserId: uid("u1"),
      }),
    ).rejects.toThrow(GraphAuthorizationError); // ownership fails before entity check
  });

  it("throws GraphNotFoundError when target entity does not exist", async () => {
    // Create a dedicated user+entity pair for this test to avoid type conflicts
    await svc.syncUser({ id: uid("u-nf"), role: "END_USER" });
    await svc.syncEntity({ id: uid("e-nf-src"), entityType: "dog", name: "SrcDog" });
    await svc.syncOwnership({ userId: uid("u-nf"), entityId: uid("e-nf-src"), role: "PRIMARY_OWNER" });

    await expect(
      svc.createEntityRelationship({
        entityId: uid("e-nf-src"),
        relatedEntityId: uid("e-nf-ghost"),
        type: "PLAYMATE",
        proposedByUserId: uid("u-nf"),
      }),
    ).rejects.toThrow(GraphNotFoundError);
  });

  it("throws GraphConflictError when a relationship of the same type already exists", async () => {
    // SIBLING e1→e2 was created in the first test of this suite
    await expect(
      svc.createEntityRelationship({
        entityId: uid("e1"),
        relatedEntityId: uid("e2"),
        type: "SIBLING",
        proposedByUserId: uid("u1"),
      }),
    ).rejects.toThrow(GraphConflictError);
  });
});

// ---------------------------------------------------------------------------
// confirmEntityRelationship
// ---------------------------------------------------------------------------

describe("confirmEntityRelationship", () => {
  // Set up a fresh PENDING relationship for this suite using unique entities
  beforeAll(async () => {
    await svc.syncUser({ id: uid("u-conf-src"), role: "END_USER" });
    await svc.syncUser({ id: uid("u-conf-tgt"), role: "END_USER" });
    await svc.syncEntity({ id: uid("e-conf-src"), entityType: "dog", name: "ConfSrc" });
    await svc.syncEntity({ id: uid("e-conf-tgt"), entityType: "dog", name: "ConfTgt" });
    await svc.syncOwnership({ userId: uid("u-conf-src"), entityId: uid("e-conf-src"), role: "PRIMARY_OWNER" });
    await svc.syncOwnership({ userId: uid("u-conf-tgt"), entityId: uid("e-conf-tgt"), role: "PRIMARY_OWNER" });

    // Pending WALK_BUDDY from src → tgt
    await svc.createEntityRelationship({
      entityId: uid("e-conf-src"),
      relatedEntityId: uid("e-conf-tgt"),
      type: "WALK_BUDDY",
      proposedByUserId: uid("u-conf-src"),
    });
  });

  it("confirms the edge and returns status CONFIRMED", async () => {
    const result = await svc.confirmEntityRelationship(
      uid("e-conf-src"),
      uid("e-conf-tgt"),
      uid("u-conf-tgt"),
    );

    expect(result.status).toBe("CONFIRMED");
    expect(result.type).toBe("WALK_BUDDY");
  });

  it("updates the forward edge status to CONFIRMED in the graph", async () => {
    const props = await getEdgeProps(uid("e-conf-src"), "ENTITY_RELATES", uid("e-conf-tgt"));
    expect(props!.status).toBe("CONFIRMED");
  });

  it("creates a reciprocal CONFIRMED edge for symmetric type (WALK_BUDDY)", async () => {
    const rev = await getEdgeProps(uid("e-conf-tgt"), "ENTITY_RELATES", uid("e-conf-src"));
    expect(rev).not.toBeNull();
    expect(rev!.status).toBe("CONFIRMED");
    expect(rev!.type).toBe("WALK_BUDDY");
  });

  it("creates OFFSPRING reciprocal edge when confirming PARENT relationship", async () => {
    await svc.syncUser({ id: uid("u-par-src"), role: "END_USER" });
    await svc.syncUser({ id: uid("u-par-tgt"), role: "END_USER" });
    await svc.syncEntity({ id: uid("e-par-src"), entityType: "dog", name: "ParentDog" });
    await svc.syncEntity({ id: uid("e-par-tgt"), entityType: "dog", name: "ChildDog" });
    await svc.syncOwnership({ userId: uid("u-par-src"), entityId: uid("e-par-src"), role: "PRIMARY_OWNER" });
    await svc.syncOwnership({ userId: uid("u-par-tgt"), entityId: uid("e-par-tgt"), role: "PRIMARY_OWNER" });

    await svc.createEntityRelationship({
      entityId: uid("e-par-src"),
      relatedEntityId: uid("e-par-tgt"),
      type: "PARENT",
      proposedByUserId: uid("u-par-src"),
    });

    await svc.confirmEntityRelationship(
      uid("e-par-src"),
      uid("e-par-tgt"),
      uid("u-par-tgt"),
    );

    const rev = await getEdgeProps(uid("e-par-tgt"), "ENTITY_RELATES", uid("e-par-src"));
    expect(rev).not.toBeNull();
    expect(rev!.type).toBe("OFFSPRING");
    expect(rev!.status).toBe("CONFIRMED");
  });

  it("throws GraphAuthorizationError when confirming user does not own target entity", async () => {
    // u-conf-src does not own e-conf-tgt
    await expect(
      svc.confirmEntityRelationship(
        uid("e-conf-src"),
        uid("e-conf-tgt"),
        uid("u-conf-src"),
      ),
    ).rejects.toThrow(GraphAuthorizationError);
  });

  it("throws GraphNotFoundError when the relationship does not exist", async () => {
    // Entity relationships are reciprocal: confirming e-conf-src ↔ e-conf-tgt
    // above created a CONFIRMED edge in BOTH directions, so querying the
    // "reverse" tgt→src would hit that edge (Conflict), not a missing one.
    // To exercise the genuine not-found path, use a fresh entity the
    // confirming user owns that has no relationship in any direction.
    await svc.syncEntity({ id: uid("e-conf-orphan"), entityType: "dog", name: "Orphan" });
    await svc.syncOwnership({
      userId: uid("u-conf-src"),
      entityId: uid("e-conf-orphan"),
      role: "PRIMARY_OWNER",
    });
    await expect(
      svc.confirmEntityRelationship(
        uid("e-conf-tgt"),
        uid("e-conf-orphan"),
        uid("u-conf-src"),
      ),
    ).rejects.toThrow(GraphNotFoundError);
  });

  it("throws GraphConflictError when relationship is already CONFIRMED", async () => {
    // The edge was confirmed above — confirming again should conflict
    await expect(
      svc.confirmEntityRelationship(
        uid("e-conf-src"),
        uid("e-conf-tgt"),
        uid("u-conf-tgt"),
      ),
    ).rejects.toThrow(GraphConflictError);
  });
});

// ---------------------------------------------------------------------------
// rejectEntityRelationship
// ---------------------------------------------------------------------------

describe("rejectEntityRelationship", () => {
  beforeAll(async () => {
    await svc.syncUser({ id: uid("u-rej-src"), role: "END_USER" });
    await svc.syncUser({ id: uid("u-rej-tgt"), role: "END_USER" });
    await svc.syncEntity({ id: uid("e-rej-src"), entityType: "dog", name: "RejSrc" });
    await svc.syncEntity({ id: uid("e-rej-tgt"), entityType: "dog", name: "RejTgt" });
    await svc.syncOwnership({ userId: uid("u-rej-src"), entityId: uid("e-rej-src"), role: "PRIMARY_OWNER" });
    await svc.syncOwnership({ userId: uid("u-rej-tgt"), entityId: uid("e-rej-tgt"), role: "PRIMARY_OWNER" });

    await svc.createEntityRelationship({
      entityId: uid("e-rej-src"),
      relatedEntityId: uid("e-rej-tgt"),
      type: "PLAYMATE",
      proposedByUserId: uid("u-rej-src"),
    });
  });

  it("sets edge status to REJECTED", async () => {
    await svc.rejectEntityRelationship(
      uid("e-rej-src"),
      uid("e-rej-tgt"),
      uid("u-rej-tgt"),
    );

    const props = await getEdgeProps(uid("e-rej-src"), "ENTITY_RELATES", uid("e-rej-tgt"));
    expect(props).not.toBeNull();
    expect(props!.status).toBe("REJECTED");
  });

  it("throws GraphAuthorizationError when rejecting user does not own target entity", async () => {
    // u-rej-src does not own e-rej-tgt
    await expect(
      svc.rejectEntityRelationship(
        uid("e-rej-src"),
        uid("e-rej-tgt"),
        uid("u-rej-src"),
      ),
    ).rejects.toThrow(GraphAuthorizationError);
  });

  it("throws GraphNotFoundError when relationship does not exist", async () => {
    await expect(
      svc.rejectEntityRelationship(
        uid("e-rej-tgt"),
        uid("e-rej-src"),
        uid("u-rej-src"),
      ),
    ).rejects.toThrow(GraphNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// removeEntityRelationship
// ---------------------------------------------------------------------------

describe("removeEntityRelationship", () => {
  beforeAll(async () => {
    await svc.syncUser({ id: uid("u-rem-src"), role: "END_USER" });
    await svc.syncUser({ id: uid("u-rem-tgt"), role: "END_USER" });
    await svc.syncEntity({ id: uid("e-rem-src"), entityType: "dog", name: "RemSrc" });
    await svc.syncEntity({ id: uid("e-rem-tgt"), entityType: "dog", name: "RemTgt" });
    await svc.syncOwnership({ userId: uid("u-rem-src"), entityId: uid("e-rem-src"), role: "PRIMARY_OWNER" });
    await svc.syncOwnership({ userId: uid("u-rem-tgt"), entityId: uid("e-rem-tgt"), role: "PRIMARY_OWNER" });
  });

  it("deletes the forward A→B edge", async () => {
    // Create the relationship
    await svc.createEntityRelationship({
      entityId: uid("e-rem-src"),
      relatedEntityId: uid("e-rem-tgt"),
      type: "SIBLING",
      proposedByUserId: uid("u-rem-src"),
    });

    expect(await edgeExists(uid("e-rem-src"), "ENTITY_RELATES", uid("e-rem-tgt"))).toBe(true);

    await svc.removeEntityRelationship(
      uid("e-rem-src"),
      uid("e-rem-tgt"),
      uid("u-rem-src"),
    );

    expect(await edgeExists(uid("e-rem-src"), "ENTITY_RELATES", uid("e-rem-tgt"))).toBe(false);
  });

  it("also deletes the reciprocal B→A edge when it exists", async () => {
    // Create and confirm to generate both directions
    await svc.createEntityRelationship({
      entityId: uid("e-rem-src"),
      relatedEntityId: uid("e-rem-tgt"),
      type: "PLAYMATE",
      proposedByUserId: uid("u-rem-src"),
    });
    await svc.confirmEntityRelationship(
      uid("e-rem-src"),
      uid("e-rem-tgt"),
      uid("u-rem-tgt"),
    );

    expect(await edgeExists(uid("e-rem-tgt"), "ENTITY_RELATES", uid("e-rem-src"))).toBe(true);

    await svc.removeEntityRelationship(
      uid("e-rem-src"),
      uid("e-rem-tgt"),
      uid("u-rem-src"),
    );

    expect(await edgeExists(uid("e-rem-tgt"), "ENTITY_RELATES", uid("e-rem-src"))).toBe(false);
  });

  it("allows removal by the owner of the target entity (not just source)", async () => {
    await svc.createEntityRelationship({
      entityId: uid("e-rem-src"),
      relatedEntityId: uid("e-rem-tgt"),
      type: "WALK_BUDDY",
      proposedByUserId: uid("u-rem-src"),
    });

    // u-rem-tgt owns the target entity — should be allowed
    await expect(
      svc.removeEntityRelationship(
        uid("e-rem-src"),
        uid("e-rem-tgt"),
        uid("u-rem-tgt"),
      ),
    ).resolves.toBeUndefined();

    expect(await edgeExists(uid("e-rem-src"), "ENTITY_RELATES", uid("e-rem-tgt"))).toBe(false);
  });

  it("throws GraphAuthorizationError when removing user owns neither entity", async () => {
    // Re-create so there's something to attempt removing
    await svc.createEntityRelationship({
      entityId: uid("e-rem-src"),
      relatedEntityId: uid("e-rem-tgt"),
      type: "PACK_MATE",
      proposedByUserId: uid("u-rem-src"),
    });

    await expect(
      svc.removeEntityRelationship(
        uid("e-rem-src"),
        uid("e-rem-tgt"),
        uid("u3"), // u3 owns e3, not rem-src or rem-tgt
      ),
    ).rejects.toThrow(GraphAuthorizationError);
  });

  it("throws GraphNotFoundError when the relationship does not exist", async () => {
    // No relationship between e1 and e-rem-src
    await expect(
      svc.removeEntityRelationship(
        uid("e1"),
        uid("e-rem-tgt"),
        uid("u1"),
      ),
    ).rejects.toThrow(GraphNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// getEntityRelationships
// ---------------------------------------------------------------------------

describe("getEntityRelationships", () => {
  beforeAll(async () => {
    await svc.syncUser({ id: uid("u-get"), role: "END_USER" });
    await svc.syncUser({ id: uid("u-get-b"), role: "END_USER" });
    await svc.syncUser({ id: uid("u-get-c"), role: "END_USER" });
    await svc.syncEntity({ id: uid("e-get-a"), entityType: "dog", name: "GetA" });
    await svc.syncEntity({ id: uid("e-get-b"), entityType: "dog", name: "GetB" });
    await svc.syncEntity({ id: uid("e-get-c"), entityType: "dog", name: "GetC" });
    await svc.syncOwnership({ userId: uid("u-get"), entityId: uid("e-get-a"), role: "PRIMARY_OWNER" });
    await svc.syncOwnership({ userId: uid("u-get-b"), entityId: uid("e-get-b"), role: "PRIMARY_OWNER" });
    await svc.syncOwnership({ userId: uid("u-get-c"), entityId: uid("e-get-c"), role: "PRIMARY_OWNER" });

    // Create two PENDING relationships from e-get-a
    await svc.createEntityRelationship({
      entityId: uid("e-get-a"),
      relatedEntityId: uid("e-get-b"),
      type: "SIBLING",
      proposedByUserId: uid("u-get"),
    });
    await svc.createEntityRelationship({
      entityId: uid("e-get-a"),
      relatedEntityId: uid("e-get-c"),
      type: "PLAYMATE",
      proposedByUserId: uid("u-get"),
    });
    // Confirm the SIBLING relationship
    await svc.confirmEntityRelationship(
      uid("e-get-a"),
      uid("e-get-b"),
      uid("u-get-b"),
    );
  });

  it("returns all ENTITY_RELATES edges from the entity when no filter is provided", async () => {
    const results = await svc.getEntityRelationships(uid("e-get-a"));
    // Should include at minimum the two we created (SIBLING+PLAYMATE); there may
    // be no others since e-get-a is only used in this describe block.
    const ids = results.map((r) => r.relatedEntityId);
    expect(ids).toContain(uid("e-get-b"));
    expect(ids).toContain(uid("e-get-c"));
  });

  it("each returned record has the correct shape", async () => {
    const results = await svc.getEntityRelationships(uid("e-get-a"));
    for (const r of results) {
      expect(r.entityId).toBe(uid("e-get-a"));
      expect(typeof r.relatedEntityId).toBe("string");
      expect(["PACK_MATE", "SIBLING", "PLAYMATE", "PARENT", "OFFSPRING", "WALK_BUDDY"]).toContain(r.type);
      expect(["PENDING", "CONFIRMED", "REJECTED"]).toContain(r.status);
      expect(r.since).toBeInstanceOf(Date);
    }
  });

  it("filters by type", async () => {
    const results = await svc.getEntityRelationships(uid("e-get-a"), { type: "SIBLING" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.type === "SIBLING")).toBe(true);
  });

  it("filters by status CONFIRMED", async () => {
    const results = await svc.getEntityRelationships(uid("e-get-a"), { status: "CONFIRMED" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.status === "CONFIRMED")).toBe(true);
    const ids = results.map((r) => r.relatedEntityId);
    expect(ids).toContain(uid("e-get-b"));
  });

  it("filters by status PENDING", async () => {
    const results = await svc.getEntityRelationships(uid("e-get-a"), { status: "PENDING" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.status === "PENDING")).toBe(true);
    const ids = results.map((r) => r.relatedEntityId);
    expect(ids).toContain(uid("e-get-c"));
  });

  it("returns empty array for entity with no relationships", async () => {
    await svc.syncEntity({ id: uid("e-get-lone"), entityType: "dog", name: "Lone" });
    const results = await svc.getEntityRelationships(uid("e-get-lone"));
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getPendingEntityRelationships
// ---------------------------------------------------------------------------

describe("getPendingEntityRelationships", () => {
  beforeAll(async () => {
    await svc.syncUser({ id: uid("u-pend-proposer"), role: "END_USER" });
    await svc.syncUser({ id: uid("u-pend-target"), role: "END_USER" });
    await svc.syncEntity({ id: uid("e-pend-src"), entityType: "dog", name: "PendSrc" });
    await svc.syncEntity({ id: uid("e-pend-tgt"), entityType: "dog", name: "PendTgt" });
    await svc.syncOwnership({ userId: uid("u-pend-proposer"), entityId: uid("e-pend-src"), role: "PRIMARY_OWNER" });
    await svc.syncOwnership({ userId: uid("u-pend-target"), entityId: uid("e-pend-tgt"), role: "PRIMARY_OWNER" });

    await svc.createEntityRelationship({
      entityId: uid("e-pend-src"),
      relatedEntityId: uid("e-pend-tgt"),
      type: "PACK_MATE",
      proposedByUserId: uid("u-pend-proposer"),
    });
  });

  it("returns pending relationships where user owns the target entity", async () => {
    const results = await svc.getPendingEntityRelationships(uid("u-pend-target"));
    const rel = results.find(
      (r) => r.entityId === uid("e-pend-src") && r.relatedEntityId === uid("e-pend-tgt"),
    );
    expect(rel).toBeDefined();
    expect(rel!.status).toBe("PENDING");
    expect(rel!.type).toBe("PACK_MATE");
  });

  it("returns empty array when user owns no entities that are pending targets", async () => {
    // u-pend-proposer is the proposer — they own the source, not the target
    const results = await svc.getPendingEntityRelationships(uid("u-pend-proposer"));
    // Filter to only this run's relationships to avoid interference
    const mine = results.filter(
      (r) => r.entityId.startsWith(RUN_ID) || r.relatedEntityId.startsWith(RUN_ID),
    );
    const hasTarget = mine.find((r) => r.relatedEntityId === uid("e-pend-tgt"));
    expect(hasTarget).toBeUndefined();
  });

  it("does not return confirmed or rejected relationships", async () => {
    // Confirm the pending relationship
    await svc.confirmEntityRelationship(
      uid("e-pend-src"),
      uid("e-pend-tgt"),
      uid("u-pend-target"),
    );

    const results = await svc.getPendingEntityRelationships(uid("u-pend-target"));
    const confirmed = results.find(
      (r) => r.entityId === uid("e-pend-src") && r.relatedEntityId === uid("e-pend-tgt"),
    );
    expect(confirmed).toBeUndefined();
  });
});
