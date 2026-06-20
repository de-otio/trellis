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
  } {
    const findUnique = vi.fn().mockResolvedValue(row);
    return { db: { blockedUser: { findUnique } }, findUnique };
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
          const store = new PrismaBlockStore({ blockedUser: { findUnique } });
          expect(await store.isBlocked(TENANT, blocker, blocked)).toBe(present);
        },
      ),
      { numRuns: 100 },
    );
  });
});
