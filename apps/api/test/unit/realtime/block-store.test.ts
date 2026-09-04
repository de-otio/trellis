/**
 * Track D — BlockStore unit + property tests.
 *
 * Covers the in-memory default and the structural Prisma-backed store. The
 * Prisma store is exercised against a mock delegate (no generated client) so it
 * stays unit-testable, mirroring the encrypted-settings store tests. A property
 * test over random block graphs asserts the store answers membership exactly.
 */

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  InMemoryBlockStore,
  PrismaBlockStore,
  type PrismaWithBlockedUser,
} from "../../../src/lib/realtime/block-store.js";

const TENANT = "tenant-a";

describe("InMemoryBlockStore", () => {
  it("returns false when no edge recorded", async () => {
    const store = new InMemoryBlockStore();
    expect(await store.isBlocked(TENANT, "user-a", "user-b")).toBe(false);
  });

  it("returns true only for the exact recorded directed edge", async () => {
    const store = new InMemoryBlockStore();
    store.block(TENANT, "user-a", "user-b");
    expect(await store.isBlocked(TENANT, "user-a", "user-b")).toBe(true);
    // Direction matters.
    expect(await store.isBlocked(TENANT, "user-b", "user-a")).toBe(false);
    // Tenant scoping matters.
    expect(await store.isBlocked("tenant-b", "user-a", "user-b")).toBe(false);
  });
});

describe("PrismaBlockStore", () => {
  function makeDb(row: { id: string } | null): {
    db: PrismaWithBlockedUser;
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  } {
    const findUnique = vi.fn().mockResolvedValue(row);
    const findMany = vi.fn().mockResolvedValue([]);
    return { db: { blockedUser: { findUnique, findMany } }, findUnique, findMany };
  }

  it("isBlocked=true when a row exists, querying the compound unique key", async () => {
    const { db, findUnique } = makeDb({ id: "block-1" });
    const store = new PrismaBlockStore(db);

    expect(await store.isBlocked(TENANT, "user-a", "user-b")).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_blockerId_blockedId: {
          tenantId: TENANT,
          blockerId: "user-a",
          blockedId: "user-b",
        },
      },
      select: { id: true },
    });
  });

  it("isBlocked=false when no row exists", async () => {
    const { db } = makeDb(null);
    const store = new PrismaBlockStore(db);
    expect(await store.isBlocked(TENANT, "user-a", "user-b")).toBe(false);
  });
});

describe("BlockStore property — membership is exact over random graphs", () => {
  it("answers true iff the (tenant, blocker, blocked) edge is in the graph", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A set of directed block edges as [tenant, blocker, blocked] triples.
        fc.array(
          fc.tuple(
            fc.constantFrom("tenant-a", "tenant-b"),
            fc.constantFrom("u1", "u2", "u3", "u4"),
            fc.constantFrom("u1", "u2", "u3", "u4"),
          ),
          { maxLength: 20 },
        ),
        // A random query triple.
        fc.tuple(
          fc.constantFrom("tenant-a", "tenant-b"),
          fc.constantFrom("u1", "u2", "u3", "u4"),
          fc.constantFrom("u1", "u2", "u3", "u4"),
        ),
        async (edges, [qt, qb, qd]) => {
          const store = new InMemoryBlockStore();
          const expected = new Set<string>();
          for (const [t, b, d] of edges) {
            store.block(t, b, d);
            expected.add(`${t}|${b}|${d}`);
          }
          const actual = await store.isBlocked(qt, qb, qd);
          expect(actual).toBe(expected.has(`${qt}|${qb}|${qd}`));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("a blocked pair never reports unblocked (PrismaBlockStore mirrors the row presence)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("u1", "u2", "u3"),
        fc.constantFrom("u1", "u2", "u3"),
        fc.boolean(),
        async (blocker, blocked, present) => {
          const findUnique = vi
            .fn()
            .mockResolvedValue(present ? { id: "x" } : null);
          const store = new PrismaBlockStore({
            blockedUser: { findUnique, findMany: vi.fn().mockResolvedValue([]) },
          });
          expect(await store.isBlocked(TENANT, blocker, blocked)).toBe(present);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// M2 — the bidirectional bulk lookup the read paths use.
// ---------------------------------------------------------------------------

describe("listMutualBlockIds", () => {
  it("in-memory: unions both directions and excludes the viewer", async () => {
    const store = new InMemoryBlockStore();
    store.block(TENANT, "viewer", "outgoing"); // viewer blocked them
    store.block(TENANT, "incoming", "viewer"); // they blocked viewer
    store.block(TENANT, "someone", "unrelated"); // nothing to do with viewer
    store.block("tenant-other", "viewer", "elsewhere"); // another tenant

    const ids = await store.listMutualBlockIds(TENANT, "viewer");
    expect([...ids].sort()).toEqual(["incoming", "outgoing"]);
    expect(ids).not.toContain("viewer");
    expect(ids).not.toContain("unrelated");
    expect(ids).not.toContain("elsewhere");
  });

  it("in-memory: an unblock removes the id from the set", async () => {
    const store = new InMemoryBlockStore();
    store.block(TENANT, "viewer", "other");
    expect(await store.listMutualBlockIds(TENANT, "viewer")).toEqual(["other"]);

    store.unblock(TENANT, "viewer", "other");
    expect(await store.listMutualBlockIds(TENANT, "viewer")).toEqual([]);
  });

  it("prisma: ONE query, tenant-scoped, both directions in the predicate", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { blockerId: "viewer", blockedId: "outgoing" },
      { blockerId: "incoming", blockedId: "viewer" },
    ]);
    const store = new PrismaBlockStore({
      blockedUser: { findUnique: vi.fn(), findMany },
    });

    const ids = await store.listMutualBlockIds(TENANT, "viewer");

    expect([...ids].sort()).toEqual(["incoming", "outgoing"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        OR: [{ blockerId: "viewer" }, { blockedId: "viewer" }],
      },
      select: { blockerId: true, blockedId: true },
    });
  });

  it("prisma: de-duplicates a reciprocal block into one id", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { blockerId: "viewer", blockedId: "other" },
      { blockerId: "other", blockedId: "viewer" },
    ]);
    const store = new PrismaBlockStore({
      blockedUser: { findUnique: vi.fn(), findMany },
    });

    expect(await store.listMutualBlockIds(TENANT, "viewer")).toEqual(["other"]);
  });

  it("prisma: never queries with a falsy tenant or viewer", async () => {
    const findMany = vi.fn();
    const store = new PrismaBlockStore({
      blockedUser: { findUnique: vi.fn(), findMany },
    });

    expect(await store.listMutualBlockIds("", "viewer")).toEqual([]);
    expect(await store.listMutualBlockIds(TENANT, "")).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("property: the set is exactly the union of both directions in-tenant", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.constantFrom("tenant-a", "tenant-b"),
            fc.constantFrom("u1", "u2", "u3", "u4"),
            fc.constantFrom("u1", "u2", "u3", "u4"),
          ),
          { maxLength: 20 },
        ),
        fc.constantFrom("tenant-a", "tenant-b"),
        fc.constantFrom("u1", "u2", "u3", "u4"),
        async (edges, queryTenant, viewer) => {
          const store = new InMemoryBlockStore();
          const expected = new Set<string>();
          for (const [t, b, d] of edges) {
            store.block(t, b, d);
            if (t !== queryTenant) continue;
            if (b === viewer) expected.add(d);
            else if (d === viewer) expected.add(b);
          }
          expected.delete(viewer);

          const actual = await store.listMutualBlockIds(queryTenant, viewer);
          expect([...actual].sort()).toEqual([...expected].sort());
        },
      ),
      { numRuns: 200 },
    );
  });

  it("property: every id in the set is `isBlocked` in at least one direction", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.constantFrom("u1", "u2", "u3", "u4"),
            fc.constantFrom("u1", "u2", "u3", "u4"),
          ),
          { maxLength: 20 },
        ),
        fc.constantFrom("u1", "u2", "u3", "u4"),
        async (edges, viewer) => {
          const store = new InMemoryBlockStore();
          for (const [b, d] of edges) store.block(TENANT, b, d);

          for (const id of await store.listMutualBlockIds(TENANT, viewer)) {
            const either =
              (await store.isBlocked(TENANT, viewer, id)) ||
              (await store.isBlocked(TENANT, id, viewer));
            expect(either).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
