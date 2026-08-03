/**
 * Property-based tests for the extension scoped-DB proxy (O-1 L1).
 *
 * The security invariant, stated as a property over arbitrary tenants, ids, and
 * ops: **no operation issued through a scoped handle bound to tenant T ever
 * reads, writes, or deletes a row owned by a different tenant.** fast-check
 * drives a multi-tenant in-memory store and asserts the invariant across a wide
 * input space (the boundary the example-based tests only sample).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { TenantId } from "@de-otio/trellis-extension-api";
import {
  buildScopedModelMetas,
  createScopedDb,
  planScopedOp,
  ScopedDbError,
  type RawPrismaLike,
  type ScopedModelMeta,
} from "../../src/lib/extension-scoped-db.js";

const tid = (t: string) => t as unknown as TenantId;

const REMINDER: ScopedModelMeta = {
  model: "dogReminder",
  tenantField: "tenantId",
  fkFields: [],
  jsonFields: [],
  protectedFields: [],
};
const metas = buildScopedModelMetas([REMINDER]);

interface Row {
  id: string;
  tenantId: string;
  status: string;
}

function makeStore(seed: Row[]) {
  let rows = seed.map((r) => ({ ...r }));
  const flatten = (where: unknown): Record<string, unknown> => {
    if (where && typeof where === "object" && "AND" in (where as object)) {
      return Object.assign(
        {},
        ...(where as { AND: unknown[] }).AND.map(flatten),
      );
    }
    return (where as Record<string, unknown>) ?? {};
  };
  const matches = (row: Row, where: unknown) => {
    const pred = flatten(where);
    return Object.entries(pred).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
  };
  return {
    delegate: {
      findMany: async (a?: unknown) =>
        rows.filter((r) => matches(r, (a as { where?: unknown })?.where)),
      findFirst: async (a?: unknown) =>
        rows.find((r) => matches(r, (a as { where?: unknown })?.where)) ?? null,
      create: async (a: unknown) => {
        const row = { ...(a as { data: Row }).data };
        rows.push(row);
        return row;
      },
      createMany: async (a: unknown) => {
        const d = (a as { data: Row[] }).data;
        for (const r of d) rows.push({ ...r });
        return { count: d.length };
      },
      updateMany: async (a: unknown) => {
        const { where, data } = a as { where: unknown; data: Record<string, unknown> };
        let count = 0;
        rows = rows.map((r) => (matches(r, where) ? (count++, { ...r, ...data }) : r));
        return { count };
      },
      deleteMany: async (a?: unknown) => {
        const where = (a as { where?: unknown })?.where;
        const before = rows.length;
        rows = rows.filter((r) => !matches(r, where));
        return { count: before - rows.length };
      },
      count: async (a?: unknown) =>
        rows.filter((r) => matches(r, (a as { where?: unknown })?.where)).length,
      aggregate: async () => ({}),
      groupBy: async () => [],
    },
    dump: () => rows,
  };
}

describe("property — a scoped handle never touches another tenant's rows", () => {
  it("reads/writes/deletes stay within the bound tenant for arbitrary inputs", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Two distinct tenants.
        fc.tuple(fc.constantFrom("t-a", "t-b", "t-c"), fc.constantFrom("t-a", "t-b", "t-c")),
        // Seed rows spread across tenants.
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 6 }),
            tenantId: fc.constantFrom("t-a", "t-b", "t-c"),
            status: fc.constantFrom("scheduled", "sent"),
          }),
          { maxLength: 12 },
        ),
        // A by-id target id (may or may not belong to the caller).
        fc.string({ minLength: 1, maxLength: 6 }),
        // Which mutating op to run.
        fc.constantFrom("findMany", "findUnique", "update", "delete", "deleteMany", "updateMany"),
        async ([caller, _other], seedRaw, targetId, op) => {
          // De-dup ids so the store has a well-defined by-id row.
          const seen = new Set<string>();
          const seed: Row[] = [];
          for (const r of seedRaw) {
            if (seen.has(r.id)) continue;
            seen.add(r.id);
            seed.push(r);
          }
          const store = makeStore(seed);
          const prisma: RawPrismaLike = { dogReminder: store.delegate } as RawPrismaLike;
          const db = createScopedDb(prisma, tid(caller), metas);

          const otherTenantsBefore = store
            .dump()
            .filter((r) => r.tenantId !== caller)
            .map((r) => JSON.stringify(r))
            .sort();

          try {
            switch (op) {
              case "findMany": {
                const rows = (await db.dogReminder.findMany({})) as Row[];
                // INVARIANT: every returned row belongs to the caller.
                expect(rows.every((r) => r.tenantId === caller)).toBe(true);
                break;
              }
              case "findUnique": {
                const row = (await db.dogReminder.findUnique({
                  where: { id: targetId },
                })) as Row | null;
                if (row) expect(row.tenantId).toBe(caller);
                break;
              }
              case "update":
                await db.dogReminder.update({
                  where: { id: targetId },
                  data: { status: "MUTATED" },
                });
                break;
              case "delete":
                await db.dogReminder.delete({ where: { id: targetId } });
                break;
              case "deleteMany":
                await db.dogReminder.deleteMany({});
                break;
              case "updateMany":
                await db.dogReminder.updateMany({ data: { status: "MUTATED" } });
                break;
            }
          } catch (err) {
            // A NotFound on a cross-tenant (or missing) by-id target is the
            // CORRECT fail-closed behavior — never a leak.
            expect(err).toBeInstanceOf(ScopedDbError);
          }

          // INVARIANT: no other tenant's rows were mutated or removed.
          const otherTenantsAfter = store
            .dump()
            .filter((r) => r.tenantId !== caller)
            .map((r) => JSON.stringify(r))
            .sort();
          expect(otherTenantsAfter).toEqual(otherTenantsBefore);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("planner never emits a rewrite whose tenant clause differs from the bound tenant", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("t-a", "t-b", "t-c"),
        fc.constantFrom(
          "findMany",
          "findFirst",
          "count",
          "deleteMany",
          "findUnique",
          "update",
          "delete",
          "create",
          "updateMany",
        ),
        fc.string({ minLength: 1, maxLength: 6 }),
        (tenant, operation, id) => {
          const plan = planScopedOp({
            meta: REMINDER,
            operation,
            args:
              operation === "create"
                ? { data: { id, status: "x" } }
                : operation === "update"
                  ? { where: { id }, data: { status: "x" } }
                  : { where: { id } },
            tenantId: tenant,
          });
          // Whatever the plan, the ONLY tenant value it may reference is `tenant`.
          const serialized = JSON.stringify(plan);
          for (const other of ["t-a", "t-b", "t-c"]) {
            if (other !== tenant) {
              expect(serialized.includes(`"tenantId":"${other}"`)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
