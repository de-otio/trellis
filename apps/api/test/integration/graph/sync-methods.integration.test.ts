/**
 * Integration Tests: Neo4j GraphService — Sync/Remove Methods
 *
 * Runs the 10 sync/remove methods against a real local Neo4j instance.
 * Each test body is wrapped in `withCleanDb` to guarantee an empty database.
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
  closeTestDriver,
  countNodes,
  createEntity,
  createUser,
  withCleanDb,
} from "./harness.js";
import { getTestDatabase, getTestDriver } from "./setup.js";

// ---------------------------------------------------------------------------
// Helpers to query edges directly via Cypher
// ---------------------------------------------------------------------------

async function countEdges(type: string): Promise<number> {
  const driver = getTestDriver();
  const database = getTestDatabase();
  const session = driver.session({ database });
  try {
    const result = await session.run(
      `MATCH ()-[r:${type}]->() RETURN count(r) AS c`,
    );
    return (result.records[0]?.get("c") as number) ?? 0;
  } finally {
    await session.close();
  }
}

async function getNodeProps(
  label: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const driver = getTestDriver();
  const database = getTestDatabase();
  const session = driver.session({ database });
  try {
    const result = await session.run(
      `MATCH (n:${label} {id: $id}) RETURN properties(n) AS props`,
      { id },
    );
    if (result.records.length === 0) return null;
    return result.records[0].get("props") as Record<string, unknown>;
  } finally {
    await session.close();
  }
}

async function getEdgeProps(
  fromLabel: string,
  fromId: string,
  edgeType: string,
  toLabel: string,
  toId: string,
): Promise<Record<string, unknown> | null> {
  const driver = getTestDriver();
  const database = getTestDatabase();
  const session = driver.session({ database });
  try {
    const result = await session.run(
      `MATCH (a:${fromLabel} {id: $fromId})-[r:${edgeType}]->(b:${toLabel} {id: $toId})
       RETURN properties(r) AS props`,
      { fromId, toId },
    );
    if (result.records.length === 0) return null;
    return result.records[0].get("props") as Record<string, unknown>;
  } finally {
    await session.close();
  }
}

async function nodeExists(label: string, id: string): Promise<boolean> {
  const props = await getNodeProps(label, id);
  return props !== null;
}

async function edgeExists(
  fromLabel: string,
  fromId: string,
  edgeType: string,
  toLabel: string,
  toId: string,
): Promise<boolean> {
  const props = await getEdgeProps(fromLabel, fromId, edgeType, toLabel, toId);
  return props !== null;
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

let svc: GraphService & GraphConnection;

beforeAll(async () => {
  svc = await createGraphService({
    uri: process.env.NEO4J_TEST_URI ?? "bolt://localhost:7687",
    user: process.env.NEO4J_TEST_USER,
    password: process.env.NEO4J_TEST_PASSWORD,
  });
});

afterAll(async () => {
  await svc.close();
  await closeTestDriver();
});

// ---------------------------------------------------------------------------
// syncUser
// ---------------------------------------------------------------------------

describe("syncUser", () => {
  it("creates a User node with the correct id and role", async () => {
    await withCleanDb(async () => {
      await svc.syncUser({ id: "u1", role: "END_USER" });

      expect(await countNodes("User")).toBe(1);
      const props = await getNodeProps("User", "u1");
      expect(props).not.toBeNull();
      expect(props!.id).toBe("u1");
      expect(props!.role).toBe("END_USER");
    });
  });

  it("is idempotent — second sync does not duplicate the node", async () => {
    await withCleanDb(async () => {
      await svc.syncUser({ id: "u1", role: "END_USER" });
      await svc.syncUser({ id: "u1", role: "END_USER" });

      expect(await countNodes("User")).toBe(1);
    });
  });

  it("updates role on re-sync with a different role", async () => {
    await withCleanDb(async () => {
      await svc.syncUser({ id: "u1", role: "END_USER" });
      await svc.syncUser({ id: "u1", role: "ADMIN" });

      expect(await countNodes("User")).toBe(1);
      const props = await getNodeProps("User", "u1");
      expect(props!.role).toBe("ADMIN");
    });
  });
});

// ---------------------------------------------------------------------------
// syncEntity
// ---------------------------------------------------------------------------

describe("syncEntity", () => {
  it("creates an Entity node with all required fields", async () => {
    await withCleanDb(async () => {
      await svc.syncEntity({
        id: "e1",
        entityType: "dog",
        name: "Buddy",
      });

      expect(await countNodes("Entity")).toBe(1);
      const props = await getNodeProps("Entity", "e1");
      expect(props).not.toBeNull();
      expect(props!.id).toBe("e1");
      expect(props!.entityType).toBe("dog");
      expect(props!.name).toBe("Buddy");
    });
  });

  it("stores non-spatial optional fields, but never lat/lng (geo lives in PostGIS, C7)", async () => {
    await withCleanDb(async () => {
      await svc.syncEntity({
        id: "e1",
        entityType: "dog",
        name: "Max",
        breed: "Labrador",
        lifeStage: "adult",
        lat: 48.856,
        lng: 2.352,
      });

      const props = await getNodeProps("Entity", "e1");
      expect(props!.breed).toBe("Labrador");
      expect(props!.lifeStage).toBe("adult");
      // C7: coordinates are no longer graph properties — they go to
      // Postgres/PostGIS via the injected EntityGeoLookup (absent here).
      expect(props!.lat ?? null).toBeNull();
      expect(props!.lng ?? null).toBeNull();
    });
  });

  it("sets optional fields to null/absent when not provided", async () => {
    await withCleanDb(async () => {
      await svc.syncEntity({ id: "e1", entityType: "cat", name: "Whiskers" });

      const props = await getNodeProps("Entity", "e1");
      // Neo4j omits properties stored as null from the returned map; they read
      // back as undefined via `properties(n)`. Either null or undefined is
      // acceptable — the point is the fields are not set to a real value.
      expect(props!.breed ?? null).toBeNull();
      expect(props!.lifeStage ?? null).toBeNull();
      expect(props!.lat ?? null).toBeNull();
      expect(props!.lng ?? null).toBeNull();
    });
  });

  it("is idempotent — second sync does not duplicate the node", async () => {
    await withCleanDb(async () => {
      await svc.syncEntity({ id: "e1", entityType: "dog", name: "Buddy" });
      await svc.syncEntity({ id: "e1", entityType: "dog", name: "Buddy" });

      expect(await countNodes("Entity")).toBe(1);
    });
  });

  it("updates properties on re-sync with changed values", async () => {
    await withCleanDb(async () => {
      await svc.syncEntity({ id: "e1", entityType: "dog", name: "Buddy" });
      await svc.syncEntity({ id: "e1", entityType: "dog", name: "Buddy-Updated", breed: "Poodle" });

      expect(await countNodes("Entity")).toBe(1);
      const props = await getNodeProps("Entity", "e1");
      expect(props!.name).toBe("Buddy-Updated");
      expect(props!.breed).toBe("Poodle");
    });
  });

  it("SECURITY: Cypher metacharacters in name are stored literally, not interpreted", async () => {
    await withCleanDb(async () => {
      const evilName = 'pwned"}) DETACH DELETE n RETURN ((';

      await svc.syncEntity({ id: "e-security", entityType: "dog", name: evilName });

      // 1. The entity was created
      expect(await nodeExists("Entity", "e-security")).toBe(true);

      // 2. Its name property contains the literal injection string
      const props = await getNodeProps("Entity", "e-security");
      expect(props!.name).toBe(evilName);

      // 3. No extra nodes were created or deleted — exactly 1 node exists
      expect(await countNodes()).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// syncPost
// ---------------------------------------------------------------------------

describe("syncPost", () => {
  const createdAt = new Date("2024-06-15T12:00:00Z");

  it("creates a Post node and the AUTHORED edge to the author User", async () => {
    await withCleanDb(async () => {
      await svc.syncPost({ id: "p1", authorId: "u1", radius: "NORMAL", createdAt });

      expect(await countNodes("Post")).toBe(1);
      expect(await countNodes("User")).toBe(1);
      expect(await countEdges("AUTHORED")).toBe(1);

      const postProps = await getNodeProps("Post", "p1");
      expect(postProps).not.toBeNull();
      expect(postProps!.id).toBe("p1");
      expect(postProps!.radius).toBe("NORMAL");
    });
  });

  it("MERGEs the author User node when post arrives before user sync", async () => {
    await withCleanDb(async () => {
      // No syncUser called first — author node should be auto-created
      await svc.syncPost({ id: "p1", authorId: "u-new", radius: "WHISPER", createdAt });

      expect(await countNodes("User")).toBe(1);
      expect(await nodeExists("User", "u-new")).toBe(true);
      expect(await countEdges("AUTHORED")).toBe(1);
    });
  });

  it("is idempotent — second sync does not duplicate nodes or edges", async () => {
    await withCleanDb(async () => {
      const input = { id: "p1", authorId: "u1", radius: "LOUD" as const, createdAt };
      await svc.syncPost(input);
      await svc.syncPost(input);

      expect(await countNodes("Post")).toBe(1);
      expect(await countNodes("User")).toBe(1);
      expect(await countEdges("AUTHORED")).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// syncPostSubjects
// ---------------------------------------------------------------------------

describe("syncPostSubjects", () => {
  it("creates ABOUT edges from post to all entity subjects", async () => {
    await withCleanDb(async () => {
      // Pre-create required nodes
      await createEntity("e1", { entityType: "dog", name: "Buddy" });
      await createEntity("e2", { entityType: "dog", name: "Max" });
      await svc.syncPost({ id: "p1", authorId: "u1", radius: "NORMAL", createdAt: new Date() });

      await svc.syncPostSubjects({
        postId: "p1",
        entityIds: ["e1", "e2"],
        primaryEntityId: "e1",
      });

      expect(await countEdges("ABOUT")).toBe(2);
    });
  });

  it("sets isPrimary=true only for the designated primary entity", async () => {
    await withCleanDb(async () => {
      await createEntity("e1", { entityType: "dog", name: "Buddy" });
      await createEntity("e2", { entityType: "dog", name: "Max" });
      await svc.syncPost({ id: "p1", authorId: "u1", radius: "NORMAL", createdAt: new Date() });

      await svc.syncPostSubjects({
        postId: "p1",
        entityIds: ["e1", "e2"],
        primaryEntityId: "e1",
      });

      const primaryEdge = await getEdgeProps("Post", "p1", "ABOUT", "Entity", "e1");
      const secondaryEdge = await getEdgeProps("Post", "p1", "ABOUT", "Entity", "e2");

      expect(primaryEdge!.isPrimary).toBe(true);
      expect(secondaryEdge!.isPrimary).toBe(false);
    });
  });

  it("is idempotent — re-syncing same entities leaves exactly the same edges", async () => {
    await withCleanDb(async () => {
      await createEntity("e1", { entityType: "dog", name: "Buddy" });
      await svc.syncPost({ id: "p1", authorId: "u1", radius: "NORMAL", createdAt: new Date() });

      const input = { postId: "p1", entityIds: ["e1"], primaryEntityId: "e1" };
      await svc.syncPostSubjects(input);
      await svc.syncPostSubjects(input);

      expect(await countEdges("ABOUT")).toBe(1);
    });
  });

  it("replaces ABOUT edges on re-sync with different entity set (old gone, new present)", async () => {
    await withCleanDb(async () => {
      await createEntity("e1", { entityType: "dog", name: "Buddy" });
      await createEntity("e2", { entityType: "dog", name: "Max" });
      await svc.syncPost({ id: "p1", authorId: "u1", radius: "NORMAL", createdAt: new Date() });

      // First sync: p1 -> [e1]
      await svc.syncPostSubjects({ postId: "p1", entityIds: ["e1"], primaryEntityId: "e1" });
      expect(await countEdges("ABOUT")).toBe(1);
      expect(await edgeExists("Post", "p1", "ABOUT", "Entity", "e1")).toBe(true);

      // Re-sync: p1 -> [e2] (e1 edge should be gone)
      await svc.syncPostSubjects({ postId: "p1", entityIds: ["e2"], primaryEntityId: "e2" });
      expect(await countEdges("ABOUT")).toBe(1);
      expect(await edgeExists("Post", "p1", "ABOUT", "Entity", "e1")).toBe(false);
      expect(await edgeExists("Post", "p1", "ABOUT", "Entity", "e2")).toBe(true);
    });
  });

  it("Post node survives after syncPostSubjects runs (subjects don't delete post)", async () => {
    await withCleanDb(async () => {
      await createEntity("e1", { entityType: "dog", name: "Buddy" });
      await svc.syncPost({ id: "p1", authorId: "u1", radius: "NORMAL", createdAt: new Date() });

      await svc.syncPostSubjects({ postId: "p1", entityIds: ["e1"], primaryEntityId: "e1" });

      expect(await nodeExists("Post", "p1")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// syncOwnership
// ---------------------------------------------------------------------------

describe("syncOwnership", () => {
  it("creates an OWNS edge between an existing User and Entity with the correct role", async () => {
    await withCleanDb(async () => {
      await createUser("u1", "END_USER");
      await createEntity("e1", { entityType: "dog", name: "Buddy" });

      await svc.syncOwnership({ userId: "u1", entityId: "e1", role: "PRIMARY_OWNER" });

      expect(await countEdges("OWNS")).toBe(1);
      const props = await getEdgeProps("User", "u1", "OWNS", "Entity", "e1");
      expect(props).not.toBeNull();
      expect(props!.role).toBe("PRIMARY_OWNER");
    });
  });

  it("is idempotent — second sync does not create a duplicate edge", async () => {
    await withCleanDb(async () => {
      await createUser("u1", "END_USER");
      await createEntity("e1", { entityType: "dog", name: "Buddy" });

      await svc.syncOwnership({ userId: "u1", entityId: "e1", role: "PRIMARY_OWNER" });
      await svc.syncOwnership({ userId: "u1", entityId: "e1", role: "PRIMARY_OWNER" });

      expect(await countEdges("OWNS")).toBe(1);
    });
  });

  it("updates role on re-sync with a different role", async () => {
    await withCleanDb(async () => {
      await createUser("u1", "END_USER");
      await createEntity("e1", { entityType: "dog", name: "Buddy" });

      await svc.syncOwnership({ userId: "u1", entityId: "e1", role: "PRIMARY_OWNER" });
      await svc.syncOwnership({ userId: "u1", entityId: "e1", role: "CO_OWNER" });

      expect(await countEdges("OWNS")).toBe(1);
      const props = await getEdgeProps("User", "u1", "OWNS", "Entity", "e1");
      expect(props!.role).toBe("CO_OWNER");
    });
  });
});

// ---------------------------------------------------------------------------
// removeUser
// ---------------------------------------------------------------------------

describe("removeUser", () => {
  it("deletes the User node", async () => {
    await withCleanDb(async () => {
      await svc.syncUser({ id: "u1", role: "END_USER" });
      expect(await nodeExists("User", "u1")).toBe(true);

      await svc.removeUser("u1");

      expect(await nodeExists("User", "u1")).toBe(false);
      expect(await countNodes("User")).toBe(0);
    });
  });

  it("also removes incident edges (DETACH DELETE)", async () => {
    await withCleanDb(async () => {
      await svc.syncUser({ id: "u1", role: "END_USER" });
      await svc.syncPost({ id: "p1", authorId: "u1", radius: "NORMAL", createdAt: new Date() });
      expect(await countEdges("AUTHORED")).toBe(1);

      await svc.removeUser("u1");

      expect(await countEdges("AUTHORED")).toBe(0);
      // Post node itself is left behind (only the edge is removed via DETACH DELETE on User)
    });
  });

  it("is idempotent — removing a non-existent user does not throw", async () => {
    await withCleanDb(async () => {
      // Should not throw
      await expect(svc.removeUser("does-not-exist")).resolves.toBeUndefined();
      expect(await countNodes()).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// removeEntity
// ---------------------------------------------------------------------------

describe("removeEntity", () => {
  it("deletes the Entity node", async () => {
    await withCleanDb(async () => {
      await svc.syncEntity({ id: "e1", entityType: "dog", name: "Buddy" });
      expect(await nodeExists("Entity", "e1")).toBe(true);

      await svc.removeEntity("e1");

      expect(await nodeExists("Entity", "e1")).toBe(false);
      expect(await countNodes("Entity")).toBe(0);
    });
  });

  it("also removes incident edges (DETACH DELETE)", async () => {
    await withCleanDb(async () => {
      await createUser("u1", "END_USER");
      await svc.syncEntity({ id: "e1", entityType: "dog", name: "Buddy" });
      await svc.syncOwnership({ userId: "u1", entityId: "e1", role: "PRIMARY_OWNER" });
      expect(await countEdges("OWNS")).toBe(1);

      await svc.removeEntity("e1");

      expect(await countEdges("OWNS")).toBe(0);
    });
  });

  it("is idempotent — removing a non-existent entity does not throw", async () => {
    await withCleanDb(async () => {
      await expect(svc.removeEntity("does-not-exist")).resolves.toBeUndefined();
      expect(await countNodes()).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// removePost
// ---------------------------------------------------------------------------

describe("removePost", () => {
  it("deletes the Post node", async () => {
    await withCleanDb(async () => {
      await svc.syncPost({ id: "p1", authorId: "u1", radius: "SHOUT", createdAt: new Date() });
      expect(await nodeExists("Post", "p1")).toBe(true);

      await svc.removePost("p1");

      expect(await nodeExists("Post", "p1")).toBe(false);
      expect(await countNodes("Post")).toBe(0);
    });
  });

  it("also removes incident edges including AUTHORED and ABOUT (DETACH DELETE)", async () => {
    await withCleanDb(async () => {
      await createEntity("e1", { entityType: "dog", name: "Buddy" });
      await svc.syncPost({ id: "p1", authorId: "u1", radius: "NORMAL", createdAt: new Date() });
      await svc.syncPostSubjects({ postId: "p1", entityIds: ["e1"], primaryEntityId: "e1" });
      expect(await countEdges("AUTHORED")).toBe(1);
      expect(await countEdges("ABOUT")).toBe(1);

      await svc.removePost("p1");

      expect(await countEdges("AUTHORED")).toBe(0);
      expect(await countEdges("ABOUT")).toBe(0);
    });
  });

  it("is idempotent — removing a non-existent post does not throw", async () => {
    await withCleanDb(async () => {
      await expect(svc.removePost("does-not-exist")).resolves.toBeUndefined();
      expect(await countNodes()).toBe(0);
    });
  });

  it("leaves the author User node intact after post deletion", async () => {
    await withCleanDb(async () => {
      await svc.syncUser({ id: "u1", role: "END_USER" });
      await svc.syncPost({ id: "p1", authorId: "u1", radius: "NORMAL", createdAt: new Date() });

      await svc.removePost("p1");

      expect(await nodeExists("User", "u1")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// removeOwnership
// ---------------------------------------------------------------------------

describe("removeOwnership", () => {
  it("deletes the specific OWNS edge between user and entity", async () => {
    await withCleanDb(async () => {
      await createUser("u1", "END_USER");
      await createEntity("e1", { entityType: "dog", name: "Buddy" });
      await svc.syncOwnership({ userId: "u1", entityId: "e1", role: "PRIMARY_OWNER" });
      expect(await countEdges("OWNS")).toBe(1);

      await svc.removeOwnership("e1", "u1");

      expect(await countEdges("OWNS")).toBe(0);
    });
  });

  it("leaves User and Entity nodes intact after removing ownership edge", async () => {
    await withCleanDb(async () => {
      await createUser("u1", "END_USER");
      await createEntity("e1", { entityType: "dog", name: "Buddy" });
      await svc.syncOwnership({ userId: "u1", entityId: "e1", role: "PRIMARY_OWNER" });

      await svc.removeOwnership("e1", "u1");

      expect(await nodeExists("User", "u1")).toBe(true);
      expect(await nodeExists("Entity", "e1")).toBe(true);
    });
  });

  it("only removes the targeted OWNS edge, not edges for other users", async () => {
    await withCleanDb(async () => {
      await createUser("u1", "END_USER");
      await createUser("u2", "END_USER");
      await createEntity("e1", { entityType: "dog", name: "Buddy" });

      await svc.syncOwnership({ userId: "u1", entityId: "e1", role: "PRIMARY_OWNER" });
      await svc.syncOwnership({ userId: "u2", entityId: "e1", role: "CO_OWNER" });
      expect(await countEdges("OWNS")).toBe(2);

      await svc.removeOwnership("e1", "u1");

      // u2's ownership edge should remain
      expect(await countEdges("OWNS")).toBe(1);
      expect(await edgeExists("User", "u2", "OWNS", "Entity", "e1")).toBe(true);
    });
  });

  it("is idempotent — removing a non-existent ownership does not throw", async () => {
    await withCleanDb(async () => {
      await createUser("u1", "END_USER");
      await createEntity("e1", { entityType: "dog", name: "Buddy" });

      // No ownership was created — should not throw
      await expect(svc.removeOwnership("e1", "u1")).resolves.toBeUndefined();
      expect(await countEdges("OWNS")).toBe(0);
    });
  });
});
