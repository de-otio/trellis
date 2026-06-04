/**
 * Unit Tests: Postgres GraphService — Relationship CRUD (RelationshipOps)
 *
 * Covers createRelationship, removeRelationship, updateRelationshipScore,
 * getRelationship, getRelationships, getRelationshipGraph.
 *
 * Prisma is fully mocked — no database required. Tenant context is provided by
 * the real `runWithTenantContext` ALS carrier from saas-foundation so the
 * tenant-scoping behavior is exercised end-to-end.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  runWithTenantContext,
  tenantId,
} from "@de-otio/saas-foundation/tenant";
import { RelationshipOps } from "../../../../src/lib/graph/postgres/relationships.js";
import { GraphNotFoundError } from "../../../../src/lib/graph/errors.js";

const TENANT = tenantId("tenant-1");
const withTenant = <T>(fn: () => T): T => runWithTenantContext(TENANT, fn);

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

type RowOverrides = Partial<{
  id: string;
  tenantId: string;
  userId: string;
  targetType: string;
  targetId: string;
  computedScore: number;
  manualScore: number | null;
  tier: number;
  interactionCount: number;
  lastInteractionAt: Date | null;
  connectionMethod: string;
  reciprocated: boolean;
  createdAt: Date;
}>;

function makeRow(overrides: RowOverrides = {}) {
  return {
    id: "rel-1",
    tenantId: "tenant-1",
    userId: "user-1",
    targetType: "entity",
    targetId: "entity-1",
    computedScore: 0.5,
    manualScore: null,
    tier: 1,
    interactionCount: 0,
    lastInteractionAt: null,
    connectionMethod: "import",
    reciprocated: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const relationship = {
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
};
const user = { findMany: vi.fn() };
const entity = { findMany: vi.fn() };

// $transaction runs the callback against the same mocked delegates (no real tx).
const $transaction = vi.fn(async (cb: (tx: unknown) => unknown) =>
  cb({ relationship }),
);

const prisma = {
  relationship,
  user,
  entity,
  $transaction,
} as unknown as PrismaClient;

let ops: RelationshipOps;

beforeEach(() => {
  vi.clearAllMocks();
  // Re-wire $transaction after clearAllMocks resets its implementation.
  $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ relationship }),
  );
  ops = new RelationshipOps(prisma);
});

// ---------------------------------------------------------------------------
// createRelationship
// ---------------------------------------------------------------------------

describe("createRelationship", () => {
  it("creates a user->entity edge with the 'import' initial score (0.5, tier 1)", async () => {
    relationship.findUnique.mockResolvedValueOnce(null); // no existing edge
    relationship.create.mockResolvedValueOnce(
      makeRow({ computedScore: 0.5, connectionMethod: "import" }),
    );

    const rel = await withTenant(() =>
      ops.createRelationship({
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
        connectionMethod: "import",
      }),
    );

    expect(rel.score).toBe(0.5);
    expect(rel.computedScore).toBe(0.5);
    expect(rel.manualScore).toBeNull();
    expect(rel.tier).toBe(1); // 0.5 >= 0.4
    expect(rel.connectionMethod).toBe("import");
    expect(rel.reciprocated).toBe(false);

    // tenantId is taken from ambient context; score derives from CONNECTION_BONUSES.
    const data = relationship.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe("tenant-1");
    expect(data.computedScore).toBe(0.5);
    expect(data.tier).toBe(1);
    expect(data.manualScore).toBeNull();
  });

  it("defaults to 'discovery' method and score 0.3 when unspecified", async () => {
    relationship.findUnique.mockResolvedValueOnce(null);
    relationship.create.mockResolvedValueOnce(
      makeRow({ computedScore: 0.3, connectionMethod: "discovery" }),
    );

    await withTenant(() =>
      ops.createRelationship({
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
      }),
    );

    const data = relationship.create.mock.calls[0][0].data;
    expect(data.connectionMethod).toBe("discovery");
    expect(data.computedScore).toBe(0.3);
  });

  it("computes correct initial score per connection method", async () => {
    const cases: Array<["code" | "import" | "suggestion" | "discovery", number]> = [
      ["code", 0.7],
      ["import", 0.5],
      ["suggestion", 0.3],
      ["discovery", 0.3],
    ];
    for (const [method, expected] of cases) {
      vi.clearAllMocks();
      $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
        cb({ relationship }),
      );
      relationship.findUnique.mockResolvedValueOnce(null);
      relationship.create.mockResolvedValueOnce(makeRow());

      await withTenant(() =>
        ops.createRelationship({
          userId: "user-1",
          targetType: "entity",
          targetId: "entity-1",
          connectionMethod: method,
        }),
      );

      const data = relationship.create.mock.calls[0][0].data;
      expect(data.computedScore, `score for ${method}`).toBe(expected);
    }
  });

  it("marks both edges reciprocated when a reverse user->user edge exists", async () => {
    relationship.findUnique
      .mockResolvedValueOnce(null) // existing forward edge: none
      .mockResolvedValueOnce(makeRow({ id: "reverse-1", userId: "user-2", targetId: "user-1", targetType: "user" })); // reverse exists
    relationship.update.mockResolvedValueOnce(makeRow());
    relationship.create.mockResolvedValueOnce(
      makeRow({ targetType: "user", targetId: "user-2", reciprocated: true }),
    );

    const rel = await withTenant(() =>
      ops.createRelationship({
        userId: "user-1",
        targetType: "user",
        targetId: "user-2",
        connectionMethod: "code",
      }),
    );

    expect(rel.reciprocated).toBe(true);
    // The reverse edge is flipped reciprocated=true.
    expect(relationship.update).toHaveBeenCalledWith({
      where: { id: "reverse-1" },
      data: { reciprocated: true },
    });
    // And the new edge is created reciprocated=true.
    expect(relationship.create.mock.calls[0][0].data.reciprocated).toBe(true);
  });

  it("does NOT check reciprocity for entity targets", async () => {
    relationship.findUnique.mockResolvedValueOnce(null);
    relationship.create.mockResolvedValueOnce(makeRow());

    await withTenant(() =>
      ops.createRelationship({
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
      }),
    );

    // Only the existing-edge lookup ran — no reverse-edge lookup.
    expect(relationship.findUnique).toHaveBeenCalledTimes(1);
    expect(relationship.update).not.toHaveBeenCalled();
  });

  it("is idempotent: returns the existing edge instead of creating a duplicate", async () => {
    relationship.findUnique.mockResolvedValueOnce(
      makeRow({ computedScore: 0.42, connectionMethod: "code" }),
    );

    const rel = await withTenant(() =>
      ops.createRelationship({
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
      }),
    );

    expect(rel.computedScore).toBe(0.42);
    expect(relationship.create).not.toHaveBeenCalled();
  });

  it("throws when there is no ambient tenant context", async () => {
    await expect(
      ops.createRelationship({
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
      }),
    ).rejects.toThrow(GraphNotFoundError);
    expect(relationship.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// removeRelationship
// ---------------------------------------------------------------------------

describe("removeRelationship", () => {
  it("deletes an existing edge and scopes by the ambient tenant", async () => {
    relationship.findFirst.mockResolvedValueOnce(makeRow());
    relationship.delete.mockResolvedValueOnce(makeRow());

    await withTenant(() =>
      ops.removeRelationship("user-1", "entity", "entity-1"),
    );

    expect(relationship.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
        tenantId: "tenant-1",
      },
    });
    expect(relationship.delete).toHaveBeenCalledWith({ where: { id: "rel-1" } });
  });

  it("clears the reverse reciprocated flag for user->user edges", async () => {
    relationship.findFirst.mockResolvedValueOnce(
      makeRow({ targetType: "user", targetId: "user-2" }),
    );
    relationship.updateMany.mockResolvedValueOnce({ count: 1 });
    relationship.delete.mockResolvedValueOnce(makeRow());

    await withTenant(() => ops.removeRelationship("user-1", "user", "user-2"));

    expect(relationship.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-2",
        targetType: "user",
        targetId: "user-1",
        tenantId: "tenant-1",
      },
      data: { reciprocated: false },
    });
  });

  it("does not touch reverse edges for entity targets", async () => {
    relationship.findFirst.mockResolvedValueOnce(makeRow());
    relationship.delete.mockResolvedValueOnce(makeRow());

    await withTenant(() =>
      ops.removeRelationship("user-1", "entity", "entity-1"),
    );

    expect(relationship.updateMany).not.toHaveBeenCalled();
  });

  it("throws GraphNotFoundError when the edge does not exist", async () => {
    relationship.findFirst.mockResolvedValueOnce(null);

    await expect(
      withTenant(() => ops.removeRelationship("user-1", "entity", "missing")),
    ).rejects.toThrow(GraphNotFoundError);
    expect(relationship.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateRelationshipScore
// ---------------------------------------------------------------------------

describe("updateRelationshipScore", () => {
  it("sets a manual override and derives the effective score + tier", async () => {
    relationship.findFirst.mockResolvedValueOnce(
      makeRow({ computedScore: 0.5 }),
    );
    relationship.update.mockResolvedValueOnce(
      makeRow({ computedScore: 0.5, manualScore: 0.9 }),
    );

    const rel = await withTenant(() =>
      ops.updateRelationshipScore({
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
        manualScore: 0.9,
      }),
    );

    expect(rel.manualScore).toBe(0.9);
    expect(rel.score).toBe(0.9); // manual overrides computed
    expect(rel.tier).toBe(0); // 0.9 >= 0.7
    // The write persists the manual score and the tier derived from it.
    const data = relationship.update.mock.calls[0][0].data;
    expect(data.manualScore).toBe(0.9);
    expect(data.tier).toBe(0);
  });

  it("clears the override (null) and falls back to computedScore", async () => {
    relationship.findFirst.mockResolvedValueOnce(
      makeRow({ computedScore: 0.5, manualScore: 0.9 }),
    );
    relationship.update.mockResolvedValueOnce(
      makeRow({ computedScore: 0.5, manualScore: null }),
    );

    const rel = await withTenant(() =>
      ops.updateRelationshipScore({
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
        manualScore: null,
      }),
    );

    expect(rel.manualScore).toBeNull();
    expect(rel.score).toBe(0.5);
    expect(rel.tier).toBe(1); // 0.5 >= 0.4
    expect(relationship.update.mock.calls[0][0].data.tier).toBe(1);
  });

  it("throws GraphNotFoundError when the edge does not exist", async () => {
    relationship.findFirst.mockResolvedValueOnce(null);

    await expect(
      withTenant(() =>
        ops.updateRelationshipScore({
          userId: "user-1",
          targetType: "entity",
          targetId: "missing",
          manualScore: 0.5,
        }),
      ),
    ).rejects.toThrow(GraphNotFoundError);
    expect(relationship.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getRelationship
// ---------------------------------------------------------------------------

describe("getRelationship", () => {
  it("returns the mapped relationship, scoped by tenant", async () => {
    relationship.findFirst.mockResolvedValueOnce(makeRow({ computedScore: 0.5 }));

    const rel = await withTenant(() =>
      ops.getRelationship("user-1", "entity", "entity-1"),
    );

    expect(rel).not.toBeNull();
    expect(rel?.score).toBe(0.5);
    expect(relationship.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
        tenantId: "tenant-1",
      },
    });
  });

  it("returns null when not found", async () => {
    relationship.findFirst.mockResolvedValueOnce(null);
    const rel = await withTenant(() =>
      ops.getRelationship("user-1", "entity", "missing"),
    );
    expect(rel).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRelationships
// ---------------------------------------------------------------------------

describe("getRelationships", () => {
  it("orders by effective score descending and applies tenant + filters", async () => {
    relationship.findMany.mockResolvedValueOnce([
      makeRow({ targetId: "a", computedScore: 0.2 }),
      makeRow({ targetId: "b", computedScore: 0.8 }),
      makeRow({ targetId: "c", computedScore: 0.5, manualScore: 0.95 }),
    ]);

    const result = await withTenant(() =>
      ops.getRelationships("user-1", {
        targetType: "entity",
        tier: 1,
        pagination: { limit: 10 },
      }),
    );

    expect(result.items.map((r) => r.targetId)).toEqual(["c", "b", "a"]); // 0.95, 0.8, 0.2
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();

    const where = relationship.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      userId: "user-1",
      tenantId: "tenant-1",
      targetType: "entity",
      tier: 1,
    });
  });

  it("paginates: returns a cursor and hasMore when there are extra rows", async () => {
    relationship.findMany.mockResolvedValueOnce([
      makeRow({ targetId: "a", computedScore: 0.9 }),
      makeRow({ targetId: "b", computedScore: 0.6 }),
      makeRow({ targetId: "c", computedScore: 0.3 }),
    ]);

    const result = await withTenant(() =>
      ops.getRelationships("user-1", { pagination: { limit: 2 } }),
    );

    expect(result.items).toHaveLength(2);
    expect(result.items.map((r) => r.targetId)).toEqual(["a", "b"]);
    expect(result.hasMore).toBe(true);
    expect(result.cursor).not.toBeNull();
  });

  it("honors a score cursor by returning items strictly below it", async () => {
    relationship.findMany.mockResolvedValueOnce([
      makeRow({ targetId: "a", computedScore: 0.9 }),
      makeRow({ targetId: "b", computedScore: 0.6 }),
      makeRow({ targetId: "c", computedScore: 0.3 }),
    ]);
    const cursor = Buffer.from(JSON.stringify({ score: 0.6 })).toString(
      "base64",
    );

    const result = await withTenant(() =>
      ops.getRelationships("user-1", { pagination: { limit: 10, cursor } }),
    );

    // Only c (0.3) is strictly below the cursor score 0.6.
    expect(result.items.map((r) => r.targetId)).toEqual(["c"]);
    expect(result.hasMore).toBe(false);
  });

  it("returns an empty page when the user has no relationships", async () => {
    relationship.findMany.mockResolvedValueOnce([]);
    const result = await withTenant(() =>
      ops.getRelationships("user-1", { pagination: { limit: 10 } }),
    );
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRelationshipGraph
// ---------------------------------------------------------------------------

describe("getRelationshipGraph", () => {
  it("returns coarse closeness (nearest 10) and never raw scores", async () => {
    relationship.findMany.mockResolvedValueOnce([
      makeRow({ targetType: "user", targetId: "user-2", computedScore: 0.83 }),
      makeRow({ targetType: "entity", targetId: "entity-1", computedScore: 0.46 }),
    ]);
    user.findMany.mockResolvedValueOnce([
      { id: "user-2", handle: "@friend", username: null },
    ]);
    entity.findMany.mockResolvedValueOnce([{ id: "entity-1", name: "Rex" }]);

    const graph = await withTenant(() => ops.getRelationshipGraph("user-1"));

    // Sorted by score DESC: user-2 (0.83) then entity-1 (0.46)
    expect(graph.nodes.map((n) => n.id)).toEqual(["user-2", "entity-1"]);
    // closeness = round(score*10)*10 → 0.83 → 80, 0.46 → 50
    expect(graph.nodes[0]).toMatchObject({
      id: "user-2",
      type: "user",
      name: "@friend",
      closeness: 80,
      tier: 0, // 0.83 >= 0.7
    });
    expect(graph.nodes[1]).toMatchObject({
      id: "entity-1",
      type: "entity",
      name: "Rex",
      closeness: 50,
      tier: 1, // 0.46 >= 0.4
    });
    // No raw score leaks onto the node.
    for (const node of graph.nodes) {
      expect((node as Record<string, unknown>).score).toBeUndefined();
    }
  });

  it("counts tier summaries and includes canonical thresholds", async () => {
    relationship.findMany.mockResolvedValueOnce([
      makeRow({ targetType: "user", targetId: "u-inner", computedScore: 0.9 }),
      makeRow({ targetType: "user", targetId: "u-close", computedScore: 0.5 }),
      makeRow({ targetType: "entity", targetId: "e-comm", computedScore: 0.2 }),
      makeRow({ targetType: "entity", targetId: "e-amb", computedScore: 0.05 }),
    ]);
    user.findMany.mockResolvedValueOnce([
      { id: "u-inner", handle: "a", username: null },
      { id: "u-close", handle: "b", username: null },
    ]);
    entity.findMany.mockResolvedValueOnce([
      { id: "e-comm", name: "C" },
      { id: "e-amb", name: "D" },
    ]);

    const graph = await withTenant(() => ops.getRelationshipGraph("user-1"));

    expect(graph.tiers.inner).toEqual({ threshold: 0.7, count: 1 });
    expect(graph.tiers.closeFriends).toEqual({ threshold: 0.4, count: 1 });
    expect(graph.tiers.community).toEqual({ threshold: 0.15, count: 1 });
    expect(graph.tiers.ambient).toEqual({ threshold: 0.0, count: 1 });
  });

  it("falls back to an empty name when a target node is missing", async () => {
    relationship.findMany.mockResolvedValueOnce([
      makeRow({ targetType: "entity", targetId: "ghost", computedScore: 0.5 }),
    ]);
    user.findMany.mockResolvedValueOnce([]);
    entity.findMany.mockResolvedValueOnce([]); // no row for "ghost"

    const graph = await withTenant(() => ops.getRelationshipGraph("user-1"));

    expect(graph.nodes[0].name).toBe("");
  });

  it("returns empty nodes (and skips name lookups) when there are no edges", async () => {
    relationship.findMany.mockResolvedValueOnce([]);

    const graph = await withTenant(() => ops.getRelationshipGraph("user-1"));

    expect(graph.nodes).toEqual([]);
    expect(user.findMany).not.toHaveBeenCalled();
    expect(entity.findMany).not.toHaveBeenCalled();
    expect(graph.tiers.inner.count).toBe(0);
  });
});
