/**
 * Unit Tests: scoped-DB tenant BINDING (quality sweep 2026-09-05, finding C1).
 *
 * The sibling suites prove that a scoped delegate bound to tenant B never sees
 * tenant A's rows. They all bind a *valid* tenant id first. This suite asks the
 * prior question: what binds the binding?
 *
 * `createScopedDb(prisma, tenantId, metas)` types `tenantId` as the branded
 * `TenantId`, and `ctx.db.tenant(id)` (extension-context.ts) hands it straight
 * through — no mint, no validate, no compare against the tenant the route
 * wrapper already resolved. The brand is a TypeScript brand: it erases at
 * `tsc`, and `@de-otio/trellis-extension-api` is consumed as compiled JS by
 * third parties. So at runtime `tenant(undefined)` is reachable, and
 * `andTenant` then builds `{ tenantId: undefined }`.
 *
 * That clause is the whole finding: **Prisma ignores an `undefined` field in a
 * `where`** — it is "no filter", not "match null". A scoped `findMany` becomes
 * a platform-wide read and a scoped `deleteMany` a platform-wide delete. There
 * is no backstop: `TENANT_SCOPE_MODE` is off by default and RLS is installed
 * inert.
 *
 * The fake delegate below therefore reproduces Prisma's `undefined` semantics
 * exactly (skip undefined predicates). The fake in `extension-scoped-db.test.ts`
 * compares with `===`, which makes an undefined tenant match *zero* rows and
 * would hide this bug — the accuracy of this fake is the load-bearing part of
 * the test, so it is spelled out rather than shared.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { TenantId } from "@de-otio/trellis-extension-api";
import {
  buildScopedModelMetas,
  createScopedDb,
  planScopedOp,
  type RawPrismaLike,
  type ScopedModelMeta,
} from "../../src/lib/extension-scoped-db.js";

const tid = (t: unknown) => t as TenantId;

const REMINDER: ScopedModelMeta = {
  model: "dogReminder",
  tenantField: "tenantId",
  fkFields: [],
  jsonFields: ["payload"],
  protectedFields: [],
};

interface Row {
  id: string;
  tenantId: string;
  [k: string]: unknown;
}

/**
 * Prisma-accurate delegate: an `undefined` value in a `where` is NOT a
 * predicate. `{ tenantId: undefined }` matches every row, exactly as the real
 * client does.
 */
function makeStore(seed: Row[]) {
  let rows: Row[] = seed.map((r) => ({ ...r }));

  const flatten = (where: unknown): Record<string, unknown> => {
    if (where && typeof where === "object" && "AND" in (where as object)) {
      const parts = (where as { AND: unknown[] }).AND;
      return Object.assign({}, ...parts.map(flatten));
    }
    return (where as Record<string, unknown>) ?? {};
  };

  const matches = (row: Row, where: unknown): boolean =>
    Object.entries(flatten(where)).every(
      ([k, v]) => v === undefined || row[k] === v,
    );

  return {
    delegate: {
      findMany: async (args?: unknown) =>
        rows.filter((r) => matches(r, (args as { where?: unknown })?.where)),
      findFirst: async (args?: unknown) =>
        rows.find((r) => matches(r, (args as { where?: unknown })?.where)) ?? null,
      count: async (args?: unknown) =>
        rows.filter((r) => matches(r, (args as { where?: unknown })?.where)).length,
      deleteMany: async (args?: unknown) => {
        const where = (args as { where?: unknown })?.where;
        const before = rows.length;
        rows = rows.filter((r) => !matches(r, where));
        return { count: before - rows.length };
      },
      create: async (args: unknown) => (args as { data: Row }).data,
      createMany: async (args: unknown) => ({
        count: (args as { data: Row[] }).data.length,
      }),
      updateMany: async () => ({ count: 0 }),
      aggregate: async () => ({}),
      groupBy: async () => [],
    },
    dump: () => rows,
  };
}

function makePrisma(stores: Record<string, ReturnType<typeof makeStore>>): RawPrismaLike {
  const client: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(stores)) client[k] = s.delegate;
  return client as RawPrismaLike;
}

// ---------------------------------------------------------------------------
// The planner must not build an unfiltered where
// ---------------------------------------------------------------------------

describe("planScopedOp — the tenant id is validated, not trusted", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["the empty string", ""],
    ["a non-string", 42],
  ];

  for (const [label, value] of cases) {
    it(`rejects ${label} as a tenant id on findMany`, () => {
      const plan = planScopedOp({
        meta: REMINDER,
        operation: "findMany",
        args: {},
        tenantId: value as string,
      });
      expect(plan.kind).toBe("reject");
    });

    it(`rejects ${label} as a tenant id on deleteMany`, () => {
      const plan = planScopedOp({
        meta: REMINDER,
        operation: "deleteMany",
        args: {},
        tenantId: value as string,
      });
      expect(plan.kind).toBe("reject");
    });
  }

  it("still scopes normally for a valid tenant id", () => {
    const plan = planScopedOp({
      meta: REMINDER,
      operation: "findMany",
      args: {},
      tenantId: "t-a",
    });
    expect(plan).toMatchObject({ kind: "call", args: { where: { tenantId: "t-a" } } });
  });
});

// ---------------------------------------------------------------------------
// End to end: an unbound scoped db reads and deletes nothing
// ---------------------------------------------------------------------------

describe("createScopedDb — an invalid binding cannot read or delete platform-wide", () => {
  let stores: Record<string, ReturnType<typeof makeStore>>;
  let prisma: RawPrismaLike;
  const metas = buildScopedModelMetas([REMINDER]);

  beforeEach(() => {
    stores = {
      dogReminder: makeStore([
        { id: "r-a", tenantId: "t-a", status: "scheduled" },
        { id: "r-b", tenantId: "t-b", status: "scheduled" },
        { id: "r-c", tenantId: "t-c", status: "scheduled" },
      ]),
    };
    prisma = makePrisma(stores);
  });

  it("findMany with an undefined binding does not return every tenant's rows", async () => {
    const db = createScopedDb(prisma, tid(undefined), metas);
    await expect(db.dogReminder.findMany({})).rejects.toThrow();
    // The assertion that matters even if the throw changes shape: no leak.
    const rows = await db.dogReminder
      .findMany({})
      .catch(() => [] as Row[]);
    expect(rows).toEqual([]);
  });

  it("deleteMany with an undefined binding does not empty the table", async () => {
    const db = createScopedDb(prisma, tid(undefined), metas);
    await db.dogReminder.deleteMany({}).catch(() => undefined);
    expect(stores.dogReminder.dump().map((r) => r.id)).toEqual(["r-a", "r-b", "r-c"]);
  });

  it("a valid binding still sees exactly its own rows", async () => {
    const db = createScopedDb(prisma, tid("t-b"), metas);
    const rows = (await db.dogReminder.findMany({})) as Row[];
    expect(rows.map((r) => r.id)).toEqual(["r-b"]);
  });
});
