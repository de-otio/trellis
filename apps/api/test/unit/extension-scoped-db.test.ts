/**
 * Unit tests for the extension scoped-DB proxy (O-1 L1, design §12.3).
 *
 * Two layers, mirroring the functional-core / imperative-shell split:
 *  - {@link planScopedOp} — the pure planner (rewrite table, boundary + failure
 *    paths).
 *  - {@link createScopedDb} — the imperative shell over a fake raw-Prisma client
 *    (a per-tenant in-memory store), where the isolation guarantees are proven
 *    end-to-end: zero-row cross-tenant for EVERY op incl. by-id, FK-target
 *    ownership, nested-write rejection, include/select guard, and
 *    double-injection idempotency.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { TenantId } from "@de-otio/trellis-extension-api";
import {
  buildScopedModelMetas,
  createScopedDb,
  planScopedOp,
  registryToMetas,
  ScopedDbError,
  type RawPrismaLike,
  type ScopedModelMeta,
} from "../../src/lib/extension-scoped-db.js";

const tid = (t: string) => t as unknown as TenantId;

// A shallow ext model with a declared FK to core `entity` (tenant-validated).
const REMINDER: ScopedModelMeta = {
  model: "dogReminder",
  tenantField: "tenantId",
  fkFields: [
    { field: "entityId", targetModel: "entity", targetTenantField: "tenantId" },
  ],
  jsonFields: ["payload"],
};

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

describe("planScopedOp — where-mergeable ops (a)", () => {
  it("AND-merges the tenant clause into findMany.where", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "findMany",
      args: { where: { status: "scheduled" } },
      tenantId: "t-a",
    });
    expect(plan).toEqual({
      kind: "call",
      operation: "findMany",
      args: { where: { AND: [{ status: "scheduled" }, { tenantId: "t-a" }] } },
      fkChecks: [],
    });
  });

  it("injects a bare tenant clause when no where is present", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "count",
      args: undefined,
      tenantId: "t-a",
    });
    expect(plan).toEqual({
      kind: "call",
      operation: "count",
      args: { where: { tenantId: "t-a" } },
      fkChecks: [],
    });
  });

  it("scopes deleteMany/aggregate/groupBy the same way", () => {
    for (const operation of ["deleteMany", "aggregate", "groupBy"]) {
      const plan = planScopedOp({
        meta: REMINDER,
        operation,
        args: {},
        tenantId: "t-a",
      });
      expect(plan).toMatchObject({ kind: "call", operation });
    }
  });
});

describe("planScopedOp — by-id rewrites (b)", () => {
  it("rewrites findUnique to a tenant-merged findFirst", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "findUnique",
      args: { where: { id: "r1" } },
      tenantId: "t-a",
    });
    expect(plan).toEqual({
      kind: "find-by-id",
      args: { where: { AND: [{ id: "r1" }, { tenantId: "t-a" }] } },
    });
  });

  it("rewrites update to update-by-id with a tenant-merged where", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "update",
      args: { where: { id: "r1" }, data: { status: "sent" } },
      tenantId: "t-a",
    });
    expect(plan).toEqual({
      kind: "update-by-id",
      where: { AND: [{ id: "r1" }, { tenantId: "t-a" }] },
      data: { status: "sent" },
      fkChecks: [],
    });
  });

  it("rewrites delete to delete-by-id with a tenant-merged where", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "delete",
      args: { where: { id: "r1" } },
      tenantId: "t-a",
    });
    expect(plan).toEqual({
      kind: "delete-by-id",
      where: { AND: [{ id: "r1" }, { tenantId: "t-a" }] },
    });
  });
});

describe("planScopedOp — create/stamp + FK checks (a,c)", () => {
  it("stamps the tenant field on create and emits an FK check", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "create",
      args: { data: { entityId: "e1", status: "scheduled" } },
      tenantId: "t-a",
    });
    expect(plan).toEqual({
      kind: "call",
      operation: "create",
      args: { data: { entityId: "e1", status: "scheduled", tenantId: "t-a" } },
      fkChecks: [
        { targetModel: "entity", where: { id: "e1", tenantId: "t-a" } },
      ],
    });
  });

  it("stamps every row of createMany and gathers per-row FK checks", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "createMany",
      args: { data: [{ entityId: "e1" }, { entityId: "e2" }] },
      tenantId: "t-a",
    });
    expect(plan).toMatchObject({
      kind: "call",
      operation: "createMany",
      args: { data: [{ entityId: "e1", tenantId: "t-a" }, { entityId: "e2", tenantId: "t-a" }] },
      fkChecks: [
        { targetModel: "entity", where: { id: "e1", tenantId: "t-a" } },
        { targetModel: "entity", where: { id: "e2", tenantId: "t-a" } },
      ],
    });
  });

  it("does not emit an FK check for an absent or non-scalar FK value", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "create",
      args: { data: { status: "scheduled" } },
      tenantId: "t-a",
    });
    expect(plan).toMatchObject({ fkChecks: [] });
  });
});

describe("planScopedOp — rejections (d,e) + tenant reassignment", () => {
  it("rejects a nested relation write in data (d)", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "create",
      args: { data: { entity: { connect: { id: "e1" } } } },
      tenantId: "t-a",
    });
    expect(plan.kind).toBe("reject");
  });

  it("does NOT flag a scalar update operator as a nested write", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "update",
      args: { where: { id: "r1" }, data: { count: { increment: 1 } } },
      tenantId: "t-a",
    });
    expect(plan.kind).toBe("update-by-id");
  });

  it("does NOT flag a JSON blob shaped like a nested write (jsonFields skip)", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "create",
      args: { data: { entityId: "e1", payload: { connect: "not-a-relation" } } },
      tenantId: "t-a",
    });
    expect(plan.kind).toBe("call");
  });

  it("rejects include on any op (e)", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "findMany",
      args: { include: { entity: true } },
      tenantId: "t-a",
    });
    expect(plan.kind).toBe("reject");
  });

  it("rejects a nested relation select but allows scalar select (e)", () => {
    expect(
      planScopedOp({
        meta: REMINDER,
        operation: "findMany",
        args: { select: { entity: { select: { id: true } } } },
        tenantId: "t-a",
      }).kind,
    ).toBe("reject");
    expect(
      planScopedOp({
        meta: REMINDER,
        operation: "findMany",
        args: { select: { id: true, status: true } },
        tenantId: "t-a",
      }).kind,
    ).toBe("call");
  });

  it("rejects a write that tries to set the tenant field itself", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "create",
      args: { data: { entityId: "e1", tenantId: "t-other" } },
      tenantId: "t-a",
    });
    expect(plan.kind).toBe("reject");
  });

  it("fails closed on an unrecognized operation ($queryRaw-shaped)", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "$queryRaw",
      args: {},
      tenantId: "t-a",
    });
    expect(plan.kind).toBe("reject");
  });
});

describe("planScopedOp — upsert-by-id (b,c,d)", () => {
  it("guards where, stamps create, and gathers FK checks for both branches", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "upsert",
      args: {
        where: { id: "r1" },
        create: { entityId: "e1", status: "scheduled" },
        update: { entityId: "e2", status: "sent" },
      },
      tenantId: "t-a",
    });
    expect(plan).toEqual({
      kind: "upsert-by-id",
      where: { AND: [{ id: "r1" }, { tenantId: "t-a" }] },
      create: { entityId: "e1", status: "scheduled", tenantId: "t-a" },
      update: { entityId: "e2", status: "sent" },
      createFkChecks: [{ targetModel: "entity", where: { id: "e1", tenantId: "t-a" } }],
      updateFkChecks: [{ targetModel: "entity", where: { id: "e2", tenantId: "t-a" } }],
    });
  });
});

describe("planScopedOp — idempotency (double injection)", () => {
  it("re-planning an already-rewritten findMany only nests a second tenant clause (still tenant-safe)", () => {
    const first = planScopedOp({
      meta: REMINDER,
      operation: "findMany",
      args: { where: { status: "x" } },
      tenantId: "t-a",
    });
    const firstArgs = (first as { args: Record<string, unknown> }).args;
    const second = planScopedOp({
      meta: REMINDER,
      operation: "findMany",
      args: firstArgs,
      tenantId: "t-a",
    });
    const secondArgs = (second as { args: { where: { AND: unknown[] } } }).args;
    // The tenant clause is present (idempotent in EFFECT — the extra AND still
    // filters to t-a), which is the defense-in-depth property H1 relies on.
    expect(JSON.stringify(secondArgs.where)).toContain('"tenantId":"t-a"');
    expect(secondArgs.where.AND).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Fake raw-Prisma client — a per-tenant in-memory store for the shell tests
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  tenantId: string;
  [k: string]: unknown;
}

/** Minimal Prisma-delegate emulation honoring where/AND/tenantId filters. */
function makeStore(seed: Row[]) {
  let rows: Row[] = seed.map((r) => ({ ...r }));

  const flatten = (where: unknown): Record<string, unknown> => {
    // Collapse `{ AND: [a, b] }` (and bare clauses) into one predicate map.
    if (where && typeof where === "object" && "AND" in (where as object)) {
      const parts = (where as { AND: unknown[] }).AND;
      return Object.assign({}, ...parts.map(flatten));
    }
    return (where as Record<string, unknown>) ?? {};
  };

  const matches = (row: Row, where: unknown): boolean => {
    const pred = flatten(where);
    return Object.entries(pred).every(([k, v]) => row[k] === v);
  };

  const delegate = {
    findMany: async (args?: unknown) =>
      rows.filter((r) => matches(r, (args as { where?: unknown })?.where)),
    findFirst: async (args?: unknown) =>
      rows.find((r) => matches(r, (args as { where?: unknown })?.where)) ?? null,
    create: async (args: unknown) => {
      const data = (args as { data: Row }).data;
      const row = { ...data };
      rows.push(row);
      return row;
    },
    createMany: async (args: unknown) => {
      const data = (args as { data: Row[] }).data;
      for (const d of data) rows.push({ ...d });
      return { count: data.length };
    },
    updateMany: async (args: unknown) => {
      const { where, data } = args as { where: unknown; data: Record<string, unknown> };
      let count = 0;
      rows = rows.map((r) => {
        if (matches(r, where)) {
          count++;
          return { ...r, ...data };
        }
        return r;
      });
      return { count };
    },
    deleteMany: async (args?: unknown) => {
      const where = (args as { where?: unknown })?.where;
      const before = rows.length;
      rows = rows.filter((r) => !matches(r, where));
      return { count: before - rows.length };
    },
    count: async (args?: unknown) =>
      rows.filter((r) => matches(r, (args as { where?: unknown })?.where)).length,
    aggregate: async () => ({}),
    groupBy: async () => [],
  };
  return { delegate, dump: () => rows };
}

function makePrisma(stores: Record<string, ReturnType<typeof makeStore>>): RawPrismaLike {
  const client: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(stores)) client[k] = s.delegate;
  return client as RawPrismaLike;
}

// ---------------------------------------------------------------------------
// Imperative shell — end-to-end tenant isolation
// ---------------------------------------------------------------------------

describe("createScopedDb — zero-row cross-tenant isolation", () => {
  let stores: Record<string, ReturnType<typeof makeStore>>;
  let prisma: RawPrismaLike;
  const metas = buildScopedModelMetas([REMINDER]);

  beforeEach(() => {
    stores = {
      dogReminder: makeStore([
        { id: "r-a", tenantId: "t-a", entityId: "e-a", status: "scheduled" },
        { id: "r-b", tenantId: "t-b", entityId: "e-b", status: "scheduled" },
      ]),
      entity: makeStore([
        { id: "e-a", tenantId: "t-a" },
        { id: "e-b", tenantId: "t-b" },
      ]),
    };
    prisma = makePrisma(stores);
  });

  it("findMany from tenant B never returns tenant A's rows", async () => {
    const db = createScopedDb(prisma, tid("t-b"), metas);
    const rows = (await db.dogReminder.findMany({})) as Row[];
    expect(rows.map((r) => r.id)).toEqual(["r-b"]);
  });

  it("findUnique by another tenant's id returns null (by-id rewrite)", async () => {
    const db = createScopedDb(prisma, tid("t-b"), metas);
    const row = await db.dogReminder.findUnique({ where: { id: "r-a" } });
    expect(row).toBeNull();
  });

  it("findUnique by own id returns the row", async () => {
    const db = createScopedDb(prisma, tid("t-b"), metas);
    const row = (await db.dogReminder.findUnique({ where: { id: "r-b" } })) as Row;
    expect(row.id).toBe("r-b");
  });

  it("update by another tenant's id throws NotFound and mutates nothing", async () => {
    const db = createScopedDb(prisma, tid("t-b"), metas);
    await expect(
      db.dogReminder.update({ where: { id: "r-a" }, data: { status: "HACKED" } }),
    ).rejects.toBeInstanceOf(ScopedDbError);
    expect(stores.dogReminder.dump().find((r) => r.id === "r-a")?.status).toBe(
      "scheduled",
    );
  });

  it("update by own id updates and returns the row", async () => {
    const db = createScopedDb(prisma, tid("t-b"), metas);
    const row = (await db.dogReminder.update({
      where: { id: "r-b" },
      data: { status: "sent" },
    })) as Row;
    expect(row.status).toBe("sent");
  });

  it("delete by another tenant's id throws and removes nothing", async () => {
    const db = createScopedDb(prisma, tid("t-b"), metas);
    await expect(
      db.dogReminder.delete({ where: { id: "r-a" } }),
    ).rejects.toBeInstanceOf(ScopedDbError);
    expect(stores.dogReminder.dump()).toHaveLength(2);
  });

  it("delete by own id removes it and returns the captured row", async () => {
    const db = createScopedDb(prisma, tid("t-b"), metas);
    const row = (await db.dogReminder.delete({ where: { id: "r-b" } })) as Row;
    expect(row.id).toBe("r-b");
    expect(stores.dogReminder.dump().map((r) => r.id)).toEqual(["r-a"]);
  });

  it("deleteMany from tenant B cannot reach tenant A's rows", async () => {
    const db = createScopedDb(prisma, tid("t-b"), metas);
    const res = (await db.dogReminder.deleteMany({})) as { count: number };
    expect(res.count).toBe(1);
    expect(stores.dogReminder.dump().map((r) => r.id)).toEqual(["r-a"]);
  });

  it("updateMany from tenant B cannot reach tenant A's rows", async () => {
    const db = createScopedDb(prisma, tid("t-b"), metas);
    await db.dogReminder.updateMany({ data: { status: "swept" } });
    const dump = stores.dogReminder.dump();
    expect(dump.find((r) => r.id === "r-a")?.status).toBe("scheduled");
    expect(dump.find((r) => r.id === "r-b")?.status).toBe("swept");
  });

  it("count from tenant B counts only its own rows", async () => {
    const db = createScopedDb(prisma, tid("t-b"), metas);
    expect(await db.dogReminder.count({})).toBe(1);
  });

  it("create stamps the caller's tenant, ignoring any hostile intent", async () => {
    const db = createScopedDb(prisma, tid("t-b"), metas);
    const row = (await db.dogReminder.create({
      data: { id: "r-new", entityId: "e-b", status: "scheduled" },
    })) as Row;
    expect(row.tenantId).toBe("t-b");
  });
});

describe("createScopedDb — FK-target tenant ownership (c)", () => {
  const metas = buildScopedModelMetas([REMINDER]);

  function fresh() {
    const stores = {
      dogReminder: makeStore([]),
      entity: makeStore([
        { id: "e-a", tenantId: "t-a" },
        { id: "e-b", tenantId: "t-b" },
      ]),
    };
    return { stores, prisma: makePrisma(stores) };
  }

  it("create referencing another tenant's entity is rejected (read-before-write)", async () => {
    const { stores, prisma } = fresh();
    const db = createScopedDb(prisma, tid("t-b"), metas);
    await expect(
      db.dogReminder.create({ data: { id: "r1", entityId: "e-a" } }),
    ).rejects.toBeInstanceOf(ScopedDbError);
    expect(stores.dogReminder.dump()).toHaveLength(0); // nothing written
  });

  it("create referencing the caller's own entity succeeds", async () => {
    const { stores, prisma } = fresh();
    const db = createScopedDb(prisma, tid("t-b"), metas);
    await db.dogReminder.create({ data: { id: "r1", entityId: "e-b" } });
    expect(stores.dogReminder.dump()).toHaveLength(1);
  });

  it("update that repoints an FK to another tenant's entity is rejected", async () => {
    const stores = {
      dogReminder: makeStore([{ id: "r-b", tenantId: "t-b", entityId: "e-b" }]),
      entity: makeStore([
        { id: "e-a", tenantId: "t-a" },
        { id: "e-b", tenantId: "t-b" },
      ]),
    };
    const prisma = makePrisma(stores);
    const db = createScopedDb(prisma, tid("t-b"), metas);
    await expect(
      db.dogReminder.update({ where: { id: "r-b" }, data: { entityId: "e-a" } }),
    ).rejects.toBeInstanceOf(ScopedDbError);
    expect(stores.dogReminder.dump()[0].entityId).toBe("e-b");
  });
});

describe("createScopedDb — nested-write rejection & blocked delegates", () => {
  const metas = buildScopedModelMetas([REMINDER]);
  const prisma = makePrisma({ dogReminder: makeStore([]), entity: makeStore([]) });

  it("throws on a nested connect in create data (d)", async () => {
    const db = createScopedDb(prisma, tid("t-a"), metas);
    await expect(
      db.dogReminder.create({ data: { entity: { connect: { id: "e1" } } } }),
    ).rejects.toBeInstanceOf(ScopedDbError);
  });

  it("blocks a core delegate with no tenant column (activity) fail-closed", async () => {
    const db = createScopedDb(prisma, tid("t-a"), metas);
    await expect(db.activity.findMany({})).rejects.toBeInstanceOf(ScopedDbError);
  });

  it("blocks the non-existent postEntity delegate fail-closed", async () => {
    const db = createScopedDb(prisma, tid("t-a"), metas);
    await expect(db.postEntity.findMany({})).rejects.toBeInstanceOf(ScopedDbError);
  });

  it("blocks a model entirely absent from the scoped surface", async () => {
    const db = createScopedDb(prisma, tid("t-a"), metas);
    await expect(db.user.findMany({})).rejects.toBeInstanceOf(ScopedDbError);
  });
});

describe("createScopedDb — upsert-by-id end-to-end (b,c)", () => {
  const metas = buildScopedModelMetas([REMINDER]);

  function fresh(seed: Row[]) {
    const stores = {
      dogReminder: makeStore(seed),
      entity: makeStore([
        { id: "e-a", tenantId: "t-a" },
        { id: "e-b", tenantId: "t-b" },
      ]),
    };
    return { stores, prisma: makePrisma(stores) };
  }

  it("updates the caller's existing row (update branch)", async () => {
    const { stores, prisma } = fresh([
      { id: "r-b", tenantId: "t-b", entityId: "e-b", status: "scheduled" },
    ]);
    const db = createScopedDb(prisma, tid("t-b"), metas);
    await db.dogReminder.upsert({
      where: { id: "r-b" },
      create: { id: "r-b", entityId: "e-b", status: "scheduled" },
      update: { status: "sent" },
    });
    expect(stores.dogReminder.dump()[0].status).toBe("sent");
  });

  it("creates a stamped row when none exists for the tenant (create branch)", async () => {
    const { stores, prisma } = fresh([]);
    const db = createScopedDb(prisma, tid("t-b"), metas);
    await db.dogReminder.upsert({
      where: { id: "r-new" },
      create: { id: "r-new", entityId: "e-b", status: "scheduled" },
      update: { status: "sent" },
    });
    const dump = stores.dogReminder.dump();
    expect(dump).toHaveLength(1);
    expect(dump[0]).toMatchObject({ id: "r-new", tenantId: "t-b" });
  });

  it("upsert.create referencing another tenant's entity is rejected before any write", async () => {
    const { stores, prisma } = fresh([]);
    const db = createScopedDb(prisma, tid("t-b"), metas);
    await expect(
      db.dogReminder.upsert({
        where: { id: "r-new" },
        create: { id: "r-new", entityId: "e-a", status: "scheduled" },
        update: { status: "sent" },
      }),
    ).rejects.toBeInstanceOf(ScopedDbError);
    expect(stores.dogReminder.dump()).toHaveLength(0);
  });

  it("upsert on another tenant's existing id does not match → creates under the caller (no cross-tenant update)", async () => {
    // r-a belongs to t-a. Caller t-b upserts id r-a: the tenant-merged findFirst
    // misses (r-a is t-a's), so we take the CREATE branch and stamp t-b — never
    // updating t-a's row.
    const { stores, prisma } = fresh([
      { id: "r-a", tenantId: "t-a", entityId: "e-a", status: "scheduled" },
    ]);
    const db = createScopedDb(prisma, tid("t-b"), metas);
    await db.dogReminder.upsert({
      where: { id: "r-a" },
      create: { id: "r-a2", entityId: "e-b", status: "new" },
      update: { status: "HACKED" },
    });
    const dump = stores.dogReminder.dump();
    expect(dump.find((r) => r.id === "r-a")?.status).toBe("scheduled"); // untouched
    expect(dump.find((r) => r.tenantId === "t-b")?.status).toBe("new");
  });
});

describe("createScopedDb — defensive assert branches", () => {
  it("throws when a declared FK target model is absent from the client", async () => {
    // dogReminder declares an FK to `entity`, but the client has no entity delegate.
    const metas = buildScopedModelMetas([REMINDER]);
    const prisma = makePrisma({ dogReminder: makeStore([]) });
    const db = createScopedDb(prisma, tid("t-a"), metas);
    await expect(
      db.dogReminder.create({ data: { id: "r1", entityId: "e1" } }),
    ).rejects.toThrow(/FK target model "entity" is not available/);
  });

  it("blocks a scoped model whose delegate is missing from the client", async () => {
    const metas = buildScopedModelMetas([REMINDER]);
    // Client is missing the dogReminder delegate entirely.
    const prisma = makePrisma({ entity: makeStore([]) });
    const db = createScopedDb(prisma, tid("t-a"), metas);
    await expect(db.dogReminder.findMany({})).rejects.toBeInstanceOf(ScopedDbError);
  });
});

describe("createScopedDb — double-injection idempotency (end-to-end)", () => {
  it("a scoped op still returns only the tenant's rows even if core also scopes", async () => {
    // Simulate a client that has ALSO already tenant-scoped (defense in depth):
    // the store is seeded so both tenants' rows exist and the proxy is the sole
    // filter. Re-running via the proxy twice yields the same tenant-bound set.
    const stores = {
      dogReminder: makeStore([
        { id: "r-a", tenantId: "t-a", entityId: "e-a" },
        { id: "r-b", tenantId: "t-b", entityId: "e-b" },
      ]),
    };
    const prisma = makePrisma(stores);
    const metas = buildScopedModelMetas([
      { ...REMINDER, fkFields: [] },
    ]);
    const db = createScopedDb(prisma, tid("t-a"), metas);
    const first = (await db.dogReminder.findMany({ where: { tenantId: "t-a" } })) as Row[];
    const second = (await db.dogReminder.findMany({
      where: { AND: [{ tenantId: "t-a" }, { tenantId: "t-a" }] },
    })) as Row[];
    expect(first.map((r) => r.id)).toEqual(["r-a"]);
    expect(second.map((r) => r.id)).toEqual(["r-a"]);
  });
});

describe("buildScopedModelMetas — config validation", () => {
  it("includes the tenant-carrying core delegates", () => {
    const map = buildScopedModelMetas([]);
    expect(map.has("entity")).toBe(true);
    expect(map.has("post")).toBe(true);
    // activity + postEntity are intentionally NOT on the surface.
    expect(map.has("activity")).toBe(false);
    expect(map.has("postEntity")).toBe(false);
  });

  it("accepts an FK to a core allowlist model (entity)", () => {
    expect(() => buildScopedModelMetas([REMINDER])).not.toThrow();
  });

  it("accepts an FK to another ext model on the same surface", () => {
    const parent: ScopedModelMeta = {
      model: "dogRecord",
      tenantField: "tenantId",
      fkFields: [],
      jsonFields: [],
    };
    const child: ScopedModelMeta = {
      model: "dogReminder",
      tenantField: "tenantId",
      fkFields: [
        { field: "recordId", targetModel: "dogRecord", targetTenantField: "tenantId" },
      ],
      jsonFields: [],
    };
    expect(() => buildScopedModelMetas([parent, child])).not.toThrow();
  });

  it("throws on an FK to an unknown/off-surface target", () => {
    const bad: ScopedModelMeta = {
      model: "dogReminder",
      tenantField: "tenantId",
      fkFields: [
        { field: "userId", targetModel: "user", targetTenantField: "tenantId" },
      ],
      jsonFields: [],
    };
    expect(() => buildScopedModelMetas([bad])).toThrow(ScopedDbError);
  });

  it("registryToMetas maps registry entries to zero-FK metas", () => {
    const metas = registryToMetas([
      { model: "dogReminder", tenantField: "tenantId", erasureSubjectField: "userId" },
    ]);
    expect(metas).toEqual([
      { model: "dogReminder", tenantField: "tenantId", fkFields: [], jsonFields: [] },
    ]);
  });
});
