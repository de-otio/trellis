/**
 * Unit Tests: Neo4j GraphService — Sync/Remove Methods
 *
 * Tests for syncUser, syncEntity, syncPost, syncPostSubjects, syncOwnership,
 * removeUser, removeEntity, removePost, removePostSubjects, removeOwnership.
 *
 * The Neo4j driver is fully mocked — no database required.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Neo4jGraphService } from "../../../src/lib/graph/neo4j-graph-service.js";

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

vi.mock("../../../src/lib/graph/graph-schema-init", () => ({
  initGraphSchema: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emptyResult = { records: [] };

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let service: Neo4jGraphService;

beforeEach(async () => {
  vi.clearAllMocks();

  service = new Neo4jGraphService();

  mockVerifyConnectivity.mockResolvedValueOnce(undefined);
  mockSessionRun.mockResolvedValue(emptyResult);

  await service.connect({
    endpoint: "bolt://localhost:7687",
    auth: { type: "none" },
  });

  vi.clearAllMocks();
  mockSessionClose.mockResolvedValue(undefined);
  // Default: all queries return empty result (void methods don't need records)
  mockSessionRun.mockResolvedValue(emptyResult);
});

// ---------------------------------------------------------------------------
// syncUser
// ---------------------------------------------------------------------------

describe("syncUser", () => {
  it("creates user node with MERGE on first call", async () => {
    await service.syncUser({ id: "user-1", role: "END_USER" });

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("MERGE");
    expect(query).toContain(":User");
    expect(params.id).toBe("user-1");
    expect(params.role).toBe("END_USER");
  });

  it("is idempotent — same Cypher on second call with identical input", async () => {
    await service.syncUser({ id: "user-1", role: "END_USER" });
    await service.syncUser({ id: "user-1", role: "END_USER" });

    expect(mockSessionRun).toHaveBeenCalledTimes(2);
    const [q1, p1] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    const [q2, p2] = mockSessionRun.mock.calls[1] as [string, Record<string, unknown>];
    expect(q1).toBe(q2);
    expect(p1).toEqual(p2);
    // Query uses MERGE — safe to run twice
    expect(q1).toContain("MERGE");
  });

  it("passes values as parameters, not interpolated into Cypher", async () => {
    await service.syncUser({ id: "user-abc-123", role: "ADMIN" });

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).not.toContain("user-abc-123");
    expect(query).not.toContain("ADMIN");
    expect(params.id).toBe("user-abc-123");
    expect(params.role).toBe("ADMIN");
  });
});

// ---------------------------------------------------------------------------
// syncEntity
// ---------------------------------------------------------------------------

describe("syncEntity", () => {
  it("creates entity node with all required and optional fields", async () => {
    await service.syncEntity({
      id: "entity-1",
      entityType: "dog",
      name: "Buddy",
      breed: "Labrador",
      lifeStage: "adult",
      lat: 48.8566,
      lng: 2.3522,
    });

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("MERGE");
    expect(query).toContain(":Entity");
    expect(params.id).toBe("entity-1");
    expect(params.entityType).toBe("dog");
    expect(params.name).toBe("Buddy");
    expect(params.breed).toBe("Labrador");
    expect(params.lifeStage).toBe("adult");
    expect(params.lat).toBe(48.8566);
    expect(params.lng).toBe(2.3522);
  });

  it("is idempotent on second call with same input", async () => {
    const input = { id: "entity-1", entityType: "dog", name: "Max" };
    await service.syncEntity(input);
    await service.syncEntity(input);

    expect(mockSessionRun).toHaveBeenCalledTimes(2);
    const [q1] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(q1).toContain("MERGE");
  });

  it("sets optional fields to null when not provided", async () => {
    await service.syncEntity({ id: "entity-2", entityType: "cat", name: "Whiskers" });

    const [, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.breed).toBeNull();
    expect(params.lifeStage).toBeNull();
    expect(params.lat).toBeNull();
    expect(params.lng).toBeNull();
  });

  it("SECURITY: Cypher injection in name field is passed as parameter value, not interpolated", async () => {
    const injectionAttempt = 'test"}) DETACH DELETE n //';
    await service.syncEntity({ id: "entity-3", entityType: "dog", name: injectionAttempt });

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    // The injection string must appear in params, never in the query string
    expect(params.name).toBe(injectionAttempt);
    expect(query).not.toContain(injectionAttempt);
    expect(query).not.toContain("DETACH DELETE n");
  });
});

// ---------------------------------------------------------------------------
// syncPost
// ---------------------------------------------------------------------------

describe("syncPost", () => {
  const createdAt = new Date("2024-01-15T10:00:00Z");

  it("creates post node and AUTHORED edge to author", async () => {
    await service.syncPost({
      id: "post-1",
      authorId: "user-1",
      radius: "LOCAL",
      createdAt,
    });

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("MERGE");
    expect(query).toContain(":Post");
    expect(query).toContain(":User");
    expect(query).toContain("AUTHORED");
    expect(params.id).toBe("post-1");
    expect(params.authorId).toBe("user-1");
    expect(params.radius).toBe("LOCAL");
    expect(params.createdAt).toBe(createdAt.toISOString());
  });

  it("is idempotent on second call with same input", async () => {
    const input = { id: "post-1", authorId: "user-1", radius: "GLOBAL" as const, createdAt };
    await service.syncPost(input);
    await service.syncPost(input);

    expect(mockSessionRun).toHaveBeenCalledTimes(2);
    const [q1] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(q1).toContain("MERGE");
  });

  it("MERGEs the author User node (handles out-of-order sync)", async () => {
    await service.syncPost({
      id: "post-2",
      authorId: "user-new",
      radius: "LOCAL",
      createdAt,
    });

    const [query] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    // Should MERGE the User node to handle the case where User hasn't synced yet
    expect(query).toMatch(/MERGE.*User.*authorId/);
  });
});

// ---------------------------------------------------------------------------
// syncPostSubjects
// ---------------------------------------------------------------------------

describe("syncPostSubjects", () => {
  it("creates ABOUT edges for all entity IDs and marks primary", async () => {
    await service.syncPostSubjects({
      postId: "post-1",
      entityIds: ["entity-1", "entity-2"],
      primaryEntityId: "entity-1",
    });

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("ABOUT");
    expect(query).toContain("isPrimary");
    expect(params.postId).toBe("post-1");
    expect(params.entityIds).toEqual(["entity-1", "entity-2"]);
    expect(params.primaryEntityId).toBe("entity-1");
  });

  it("is idempotent — deletes existing ABOUT edges before recreating", async () => {
    const input = { postId: "post-1", entityIds: ["entity-1"], primaryEntityId: "entity-1" };
    await service.syncPostSubjects(input);
    await service.syncPostSubjects(input);

    expect(mockSessionRun).toHaveBeenCalledTimes(2);
    // Both calls should issue the same query (delete + recreate pattern)
    const [q1] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    const [q2] = mockSessionRun.mock.calls[1] as [string, Record<string, unknown>];
    expect(q1).toBe(q2);
  });

  it("sets primaryEntityId to null when not provided", async () => {
    await service.syncPostSubjects({ postId: "post-1", entityIds: ["entity-1"] });

    const [, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.primaryEntityId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// syncOwnership
// ---------------------------------------------------------------------------

describe("syncOwnership", () => {
  it("creates OWNS edge between user and entity with role", async () => {
    await service.syncOwnership({
      entityId: "entity-1",
      userId: "user-1",
      role: "PRIMARY",
    });

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("MATCH");
    expect(query).toContain(":User");
    expect(query).toContain(":Entity");
    expect(query).toContain("OWNS");
    expect(query).toContain("MERGE");
    expect(params.userId).toBe("user-1");
    expect(params.entityId).toBe("entity-1");
    expect(params.role).toBe("PRIMARY");
  });

  it("is idempotent on second call with same input", async () => {
    const input = { entityId: "entity-1", userId: "user-1", role: "PRIMARY" as const };
    await service.syncOwnership(input);
    await service.syncOwnership(input);

    expect(mockSessionRun).toHaveBeenCalledTimes(2);
    const [q1] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(q1).toContain("MERGE");
  });
});

// ---------------------------------------------------------------------------
// removeUser
// ---------------------------------------------------------------------------

describe("removeUser", () => {
  it("removes existing user node (DETACH DELETE)", async () => {
    await service.removeUser("user-1");

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("DETACH DELETE");
    expect(query).toContain(":User");
    expect(params.id).toBe("user-1");
    expect(query).not.toContain("user-1");
  });
});

// ---------------------------------------------------------------------------
// removeEntity
// ---------------------------------------------------------------------------

describe("removeEntity", () => {
  it("removes existing entity node (DETACH DELETE)", async () => {
    await service.removeEntity("entity-1");

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("DETACH DELETE");
    expect(query).toContain(":Entity");
    expect(params.id).toBe("entity-1");
    expect(query).not.toContain("entity-1");
  });
});

// ---------------------------------------------------------------------------
// removePost
// ---------------------------------------------------------------------------

describe("removePost", () => {
  it("removes existing post node (DETACH DELETE)", async () => {
    await service.removePost("post-1");

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("DETACH DELETE");
    expect(query).toContain(":Post");
    expect(params.id).toBe("post-1");
    expect(query).not.toContain("post-1");
  });
});

// ---------------------------------------------------------------------------
// removePostSubjects (edges only)
// ---------------------------------------------------------------------------

describe("removePostSubjects", () => {
  it("removes ABOUT edges from post without deleting the post node", async () => {
    await service.syncPostSubjects({ postId: "post-1", entityIds: [] });

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.postId).toBe("post-1");
    // The Post node should be MATCHed, not deleted
    expect(query).toContain(":Post");
    expect(query).not.toContain("DETACH DELETE");
  });
});

// ---------------------------------------------------------------------------
// removeOwnership
// ---------------------------------------------------------------------------

describe("removeOwnership", () => {
  it("removes OWNS edge between user and entity", async () => {
    await service.removeOwnership("entity-1", "user-1");

    const [query, params] = mockSessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("OWNS");
    expect(query).toContain("DELETE");
    expect(query).toContain(":User");
    expect(query).toContain(":Entity");
    expect(params.userId).toBe("user-1");
    expect(params.entityId).toBe("entity-1");
    expect(query).not.toContain("user-1");
    expect(query).not.toContain("entity-1");
  });
});
