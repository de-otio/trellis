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
import {
  clampRelationshipLimit,
  DEFAULT_MAX_EDGES_PER_USER,
  MAX_RELATIONSHIP_PAGE_SIZE,
  RelationshipOps,
  resolveMaxEdgesPerUser,
} from "../../../../src/lib/graph/postgres/relationships.js";
import {
  GraphAuthorizationError,
  GraphConflictError,
  GraphNotFoundError,
} from "../../../../src/lib/graph/errors.js";

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
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
};
const user = { findMany: vi.fn() };
const entity = { findMany: vi.fn() };

/**
 * The edge-list reads (getRelationships / getRelationshipGraph) issue ONE
 * tagged `Prisma.sql` statement instead of `findMany` + an in-app sort, so the
 * ordering, the keyset predicate and the LIMIT all execute in Postgres. The
 * mock therefore captures the statement rather than a `where` object; the
 * assertions read `.text` (with `$n` placeholders) and `.values` (the bound
 * parameters), which is exactly the boundary that matters — nothing
 * caller-supplied may appear in `.text`.
 */
const $queryRaw = vi.fn();

/** The Prisma.Sql handed to the most recent $queryRaw call. */
function lastQuery(): { text: string; values: unknown[] } {
  const sql = $queryRaw.mock.calls[$queryRaw.mock.calls.length - 1][0];
  return { text: sql.text as string, values: sql.values as unknown[] };
}

// $transaction runs the callback against the same mocked delegates (no real tx).
const $transaction = vi.fn(async (cb: (tx: unknown) => unknown) =>
  cb({ relationship }),
);

const prisma = {
  relationship,
  user,
  entity,
  $transaction,
  $queryRaw,
} as unknown as PrismaClient;

let ops: RelationshipOps;

beforeEach(() => {
  vi.clearAllMocks();
  // Re-wire $transaction after clearAllMocks resets its implementation.
  $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ relationship }),
  );
  // Default: user is well below the per-user edge cap.
  relationship.count.mockResolvedValue(0);
  $queryRaw.mockResolvedValue([]);
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
      relationship.count.mockResolvedValue(0);
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

  // -------------------------------------------------------------------------
  // M7 — the reciprocated set/clear pair must scope identically
  // (security review 2026-08, lane 7 MEDIUM-3)
  // -------------------------------------------------------------------------
  describe("reciprocated is set within one tenant only (M7)", () => {
    it("scopes the idempotency lookup to the tenant, via the tenant-leading unique key", async () => {
      relationship.findUnique.mockResolvedValueOnce(null);
      relationship.create.mockResolvedValueOnce(makeRow());

      await withTenant(() =>
        ops.createRelationship({
          userId: "user-1",
          targetType: "entity",
          targetId: "entity-1",
        }),
      );

      // The tenant-blind key made an edge in tenant B suppress the create in
      // tenant A and hand back tenant B's row.
      expect(relationship.findUnique.mock.calls[0][0].where).toEqual({
        tenantId_userId_targetType_targetId: {
          tenantId: "tenant-1",
          userId: "user-1",
          targetType: "entity",
          targetId: "entity-1",
        },
      });
    });

    it("looks for the reverse edge ONLY in the caller's tenant", async () => {
      relationship.findUnique
        .mockResolvedValueOnce(null) // no forward edge
        .mockResolvedValueOnce(null); // no reverse edge in THIS tenant
      relationship.create.mockResolvedValueOnce(
        makeRow({ targetType: "user", targetId: "user-2" }),
      );

      await withTenant(() =>
        ops.createRelationship({
          userId: "user-1",
          targetType: "user",
          targetId: "user-2",
        }),
      );

      // The whole of MEDIUM-3's SET half. Before the fix this lookup used the
      // tenant-blind key, so a B→A edge in ANOTHER tenant satisfied it and
      // flipped both rows to reciprocated — a consent grant in a tenant where
      // no reverse edge exists, which the tenant-scoped clear could never undo.
      const reverseWhere = relationship.findUnique.mock.calls[1][0].where;
      expect(reverseWhere).toEqual({
        tenantId_userId_targetType_targetId: {
          tenantId: "tenant-1",
          userId: "user-2",
          targetType: "user",
          targetId: "user-1",
        },
      });
      // No reverse edge in this tenant → no grant, and nothing updated.
      expect(relationship.create.mock.calls[0][0].data.reciprocated).toBe(false);
      expect(relationship.update).not.toHaveBeenCalled();
    });

    it("set and clear filter on the SAME tenant key, so the pair round-trips", async () => {
      // SET
      relationship.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makeRow({ id: "reverse-1", userId: "user-2", targetId: "user-1", targetType: "user" }),
        );
      relationship.update.mockResolvedValueOnce(makeRow());
      relationship.create.mockResolvedValueOnce(
        makeRow({ targetType: "user", targetId: "user-2", reciprocated: true }),
      );
      await withTenant(() =>
        ops.createRelationship({
          userId: "user-1",
          targetType: "user",
          targetId: "user-2",
        }),
      );
      const setTenant =
        relationship.findUnique.mock.calls[1][0].where
          .tenantId_userId_targetType_targetId.tenantId;

      // CLEAR
      vi.clearAllMocks();
      $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
        cb({ relationship }),
      );
      relationship.findFirst.mockResolvedValueOnce(makeRow({ id: "fwd-1" }));
      relationship.delete.mockResolvedValueOnce(makeRow());
      await withTenant(() =>
        ops.removeRelationship("user-1", "user", "user-2"),
      );
      const clearTenant =
        relationship.updateMany.mock.calls[0][0].where.tenantId;

      // Asymmetry here IS the defect: a set that reaches wider than the clear
      // leaves grants nothing can revoke.
      expect(setTenant).toBe(clearTenant);
      expect(clearTenant).toBe("tenant-1");
    });
  });

  // -------------------------------------------------------------------------
  // L3b — the fail-open read/write paths now refuse
  // -------------------------------------------------------------------------
  describe("every tenant-scoped op refuses without an ambient tenant (L3b)", () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["removeRelationship", () => ops.removeRelationship("user-1", "user", "user-2")],
      [
        "updateRelationshipScore",
        () =>
          ops.updateRelationshipScore({
            userId: "user-1",
            targetType: "user",
            targetId: "user-2",
            manualScore: 1,
          }),
      ],
      ["getRelationship", () => ops.getRelationship("user-1", "user", "user-2")],
      ["getRelationships", () => ops.getRelationships("user-1")],
      ["getRelationshipGraph", () => ops.getRelationshipGraph("user-1")],
    ];

    for (const [name, call] of cases) {
      it(`${name} throws and issues no query`, async () => {
        // No runWithTenantContext wrapper. Prisma drops `tenantId: undefined`
        // from a `where`, so the pre-fix behaviour of each of these was to run
        // ACROSS EVERY TENANT — silently, with nothing logged.
        await expect(call()).rejects.toBeInstanceOf(GraphAuthorizationError);
      });
    }

    it("does not delete anything when removeRelationship refuses", async () => {
      await expect(
        ops.removeRelationship("user-1", "user", "user-2"),
      ).rejects.toBeInstanceOf(GraphAuthorizationError);
      expect(relationship.delete).not.toHaveBeenCalled();
      expect(relationship.updateMany).not.toHaveBeenCalled();
      expect($transaction).not.toHaveBeenCalled();
    });
  });

  // L3b unified every "no tenant" refusal in this adapter on one guard
  // (graph/postgres/tenant-guard.ts) and one error type. This site used to
  // throw GraphNotFoundError — which the handler maps to a 404 "Relationship
  // not found", a misleading answer to "the server has no tenant context".
  it("throws when there is no ambient tenant context", async () => {
    await expect(
      ops.createRelationship({
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
      }),
    ).rejects.toThrow(GraphAuthorizationError);
    expect(relationship.create).not.toHaveBeenCalled();
  });

  it("rejects a NEW edge once the per-user cap is reached (GraphConflictError)", async () => {
    const capped = new RelationshipOps(prisma, 3);
    relationship.findUnique.mockResolvedValueOnce(null); // no existing edge
    relationship.count.mockResolvedValueOnce(3); // at cap

    await expect(
      withTenant(() =>
        capped.createRelationship({
          userId: "user-1",
          targetType: "entity",
          targetId: "entity-1",
        }),
      ),
    ).rejects.toThrow(GraphConflictError);
    expect(relationship.create).not.toHaveBeenCalled();
  });

  it("still returns an EXISTING edge idempotently when the user is at the cap", async () => {
    const capped = new RelationshipOps(prisma, 3);
    relationship.findUnique.mockResolvedValueOnce(
      makeRow({ computedScore: 0.42 }),
    );
    relationship.count.mockResolvedValueOnce(3);

    const rel = await withTenant(() =>
      capped.createRelationship({
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
      }),
    );
    expect(rel.computedScore).toBe(0.42);
    expect(relationship.create).not.toHaveBeenCalled();
  });

  it("resolveMaxEdgesPerUser: env override wins, bad values fall back to the default", () => {
    expect(resolveMaxEdgesPerUser({} as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MAX_EDGES_PER_USER,
    );
    expect(
      resolveMaxEdgesPerUser({ GRAPH_MAX_EDGES_PER_USER: "250" } as NodeJS.ProcessEnv),
    ).toBe(250);
    for (const bad of ["0", "-5", "abc", ""]) {
      expect(
        resolveMaxEdgesPerUser({ GRAPH_MAX_EDGES_PER_USER: bad } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_MAX_EDGES_PER_USER);
    }
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
  it("refuses without an ambient tenant instead of querying every tenant", async () => {
    // The pre-fix code built `where` with `tenantId: undefined` when there was
    // no ambient tenant — a key Prisma DROPS, so the query returned every
    // tenant's edges for that user id. Refuse before the database is touched.
    await expect(ops.getRelationships("user-1")).rejects.toBeInstanceOf(
      GraphAuthorizationError,
    );
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("binds the tenant and the caller's filters as parameters, never as SQL text", async () => {
    await withTenant(() =>
      ops.getRelationships("user-1", {
        targetType: "entity",
        tier: 1,
        pagination: { limit: 10 },
      }),
    );

    const { text, values } = lastQuery();
    expect(text).toContain("tenant_id = $1");
    expect(text).toContain("user_id = $2");
    expect(text).toContain("target_type = $3");
    expect(text).toContain("tier = $4");
    // Every caller-influenced value is a bound parameter; none of them can
    // appear in the statement text.
    expect(values.slice(0, 4)).toEqual(["tenant-1", "user-1", "entity", 1]);
  });

  it("omits the optional filters but NEVER the tenant predicate", async () => {
    await withTenant(() => ops.getRelationships("user-1"));

    const { text, values } = lastQuery();
    expect(text).toContain("tenant_id = $1");
    expect(text).not.toContain("target_type =");
    expect(text).not.toContain("tier =");
    expect(values[0]).toBe("tenant-1");
  });

  it("orders by the effective score IN SQL, and no longer loads the edge set to sort it", async () => {
    await withTenant(() => ops.getRelationships("user-1"));

    expect(lastQuery().text).toContain(
      "ORDER BY COALESCE(manual_score, computed_score) DESC, target_id ASC",
    );
    // The whole point of the change: the unbounded findMany is gone.
    expect(relationship.findMany).not.toHaveBeenCalled();
  });

  it("asks the database for exactly limit + 1 rows (the has-more probe)", async () => {
    await withTenant(() =>
      ops.getRelationships("user-1", { pagination: { limit: 10 } }),
    );

    const { text, values } = lastQuery();
    expect(text).toContain("LIMIT");
    expect(values[values.length - 1]).toBe(11);
  });

  it("clamps an oversized caller-supplied limit to MAX_RELATIONSHIP_PAGE_SIZE", async () => {
    // The defect: `limit` came straight from the client and was applied AFTER
    // the whole edge set had already been loaded, so a single request could ask
    // for — and get — every edge the user has.
    await withTenant(() =>
      ops.getRelationships("user-1", { pagination: { limit: 100000 } }),
    );

    expect(lastQuery().values.at(-1)).toBe(MAX_RELATIONSHIP_PAGE_SIZE + 1);
  });

  it("clamps nonsense page sizes rather than passing them through", async () => {
    expect(clampRelationshipLimit(undefined)).toBe(50);
    expect(clampRelationshipLimit(Number.NaN)).toBe(50);
    expect(clampRelationshipLimit(0)).toBe(1);
    expect(clampRelationshipLimit(-7)).toBe(1);
    expect(clampRelationshipLimit(10.9)).toBe(10);
    expect(clampRelationshipLimit(MAX_RELATIONSHIP_PAGE_SIZE + 1)).toBe(
      MAX_RELATIONSHIP_PAGE_SIZE,
    );
  });

  it("never returns more than the page size, even if the database over-returns", async () => {
    // Defence against the probe row leaking into the payload.
    $queryRaw.mockResolvedValueOnce(
      ["a", "b", "c"].map((id) => makeRow({ targetId: id, computedScore: 0.5 })),
    );

    const result = await withTenant(() =>
      ops.getRelationships("user-1", { pagination: { limit: 2 } }),
    );

    expect(result.items.map((r) => r.targetId)).toEqual(["a", "b"]);
    expect(result.hasMore).toBe(true);
    expect(result.cursor).not.toBeNull();
  });

  it("reports no next page when the probe row does not come back", async () => {
    $queryRaw.mockResolvedValueOnce([
      makeRow({ targetId: "a", computedScore: 0.9 }),
      makeRow({ targetId: "b", computedScore: 0.6 }),
    ]);

    const result = await withTenant(() =>
      ops.getRelationships("user-1", { pagination: { limit: 2 } }),
    );

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });

  it("pushes the composite keyset predicate into SQL, bound not interpolated", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ score: 0.5, targetId: "m" }),
    ).toString("base64");

    await withTenant(() =>
      ops.getRelationships("user-1", { pagination: { limit: 10, cursor } }),
    );

    const { text, values } = lastQuery();
    // Tied rows past the boundary id must survive — a strict `<` on score
    // alone drops every row sharing the boundary score.
    expect(text).toContain("target_id >");
    expect(values).toContain(0.5);
    expect(values).toContain("m");
  });

  it("degrades a legacy score-only cursor to a strict less-than", async () => {
    const cursor = Buffer.from(JSON.stringify({ score: 0.6 })).toString("base64");

    await withTenant(() =>
      ops.getRelationships("user-1", { pagination: { limit: 10, cursor } }),
    );

    const { text, values } = lastQuery();
    expect(text).not.toContain("target_id >");
    expect(values).toContain(0.6);
  });

  it("ignores an undecodable cursor rather than erroring", async () => {
    await withTenant(() =>
      ops.getRelationships("user-1", {
        pagination: { limit: 10, cursor: "!!!not-base64-json!!!" },
      }),
    );

    expect(lastQuery().text).not.toContain("target_id >");
  });

  it("returns an empty page when the user has no relationships", async () => {
    $queryRaw.mockResolvedValueOnce([]);
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
    $queryRaw.mockResolvedValueOnce([
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
    $queryRaw.mockResolvedValueOnce([
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
    $queryRaw.mockResolvedValueOnce([
      makeRow({ targetType: "entity", targetId: "ghost", computedScore: 0.5 }),
    ]);
    user.findMany.mockResolvedValueOnce([]);
    entity.findMany.mockResolvedValueOnce([]); // no row for "ghost"

    const graph = await withTenant(() => ops.getRelationshipGraph("user-1"));

    expect(graph.nodes[0].name).toBe("");
  });

  it("returns empty nodes (and skips name lookups) when there are no edges", async () => {
    $queryRaw.mockResolvedValueOnce([]);

    const graph = await withTenant(() => ops.getRelationshipGraph("user-1"));

    expect(graph.nodes).toEqual([]);
    expect(user.findMany).not.toHaveBeenCalled();
    expect(entity.findMany).not.toHaveBeenCalled();
    expect(graph.tiers.inner.count).toBe(0);
  });
});
