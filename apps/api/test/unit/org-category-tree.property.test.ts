/**
 * Property-based + deterministic tests for the pure org-category tree helpers
 * (`src/lib/org-category/tree.ts`).
 *
 * The properties that matter for correctness AND safety:
 *   - `resolveRootCategoryCode` ALWAYS terminates and returns either the `code`
 *     of a node whose `parentCategoryId === null`, or `null` — for ANY input,
 *     including cyclic graphs and trees deeper than the depth guard.
 *   - `resolveDescendantCategoryIds` ALWAYS terminates, returns a duplicate-free
 *     subset of existing ids, and includes the start id when it exists.
 *
 * fast-check is a repo dependency (see post-editing.property.test.ts). The
 * generator deliberately allows a node's parent to point at ANY node id
 * (including itself), so cycles are exercised, not just clean trees.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  MAX_DEPTH,
  resolveDescendantCategoryIds,
  resolveRootCategoryCode,
  type CategoryNode,
} from "../../src/lib/org-category/tree.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates an array of category nodes with unique ids (`c0..c{n-1}`, code ===
 * id so a code maps back to exactly one node) where each node's parent is either
 * `null` or the id of some node in the set. Because a parent may be any id
 * (including the node's own or one that forms a cycle), this covers trees,
 * forests, self-loops, and multi-node cycles.
 */
const graphArb: fc.Arbitrary<{ categories: CategoryNode[]; ids: string[] }> = fc
  .integer({ min: 1, max: 15 })
  .chain((n) => {
    const ids = Array.from({ length: n }, (_, i) => `c${i}`);
    // For each node, choose a parent: null, or an index into ids.
    const parentChoices = fc.tuple(
      ...ids.map(() =>
        fc.oneof(
          fc.constant<number | null>(null),
          fc.integer({ min: 0, max: n - 1 }),
        ),
      ),
    );
    return parentChoices.map((parents) => ({
      ids,
      categories: ids.map((id, i) => ({
        id,
        code: id,
        parentCategoryId: parents[i] === null ? null : ids[parents[i] as number],
      })),
    }));
  });

// ---------------------------------------------------------------------------
// resolveRootCategoryCode
// ---------------------------------------------------------------------------

describe("resolveRootCategoryCode — properties", () => {
  it("returns either the code of a genuine root (parentCategoryId === null) or null, for any graph and start node", () => {
    fc.assert(
      fc.property(
        graphArb,
        fc.integer({ min: 0, max: 14 }),
        ({ categories, ids }, startIdx) => {
          const startId = ids[startIdx % ids.length];
          const result = resolveRootCategoryCode(startId, categories);

          if (result === null) return true; // null is always an acceptable answer

          // A non-null result must be the code of a node that is an actual root.
          const node = categories.find((c) => c.code === result);
          expect(node).toBeDefined();
          expect(node!.parentCategoryId).toBeNull();
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it("returns null for a start id not present in the set", () => {
    fc.assert(
      fc.property(graphArb, ({ categories }) => {
        expect(resolveRootCategoryCode("does-not-exist", categories)).toBeNull();
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

describe("resolveRootCategoryCode — deterministic guards", () => {
  it("resolves a simple 3-level chain to the root code", () => {
    const cats: CategoryNode[] = [
      { id: "root", code: "business", parentCategoryId: null },
      { id: "mid", code: "business:services", parentCategoryId: "root" },
      { id: "leaf", code: "business:services:legal", parentCategoryId: "mid" },
    ];
    expect(resolveRootCategoryCode("leaf", cats)).toBe("business");
    expect(resolveRootCategoryCode("mid", cats)).toBe("business");
    expect(resolveRootCategoryCode("root", cats)).toBe("business");
  });

  it("returns null (does not hang) on a self-loop", () => {
    const cats: CategoryNode[] = [{ id: "x", code: "x", parentCategoryId: "x" }];
    expect(resolveRootCategoryCode("x", cats)).toBeNull();
  });

  it("returns null (does not hang) on a two-node cycle", () => {
    const cats: CategoryNode[] = [
      { id: "a", code: "a", parentCategoryId: "b" },
      { id: "b", code: "b", parentCategoryId: "a" },
    ];
    expect(resolveRootCategoryCode("a", cats)).toBeNull();
  });

  it("returns null for a legitimate chain deeper than MAX_DEPTH (depth guard)", () => {
    const depth = MAX_DEPTH + 5;
    const cats: CategoryNode[] = Array.from({ length: depth }, (_, i) => ({
      id: `n${i}`,
      code: `n${i}`,
      parentCategoryId: i === 0 ? null : `n${i - 1}`,
    }));
    // Walking up from the deepest node exceeds MAX_DEPTH → guard returns null.
    expect(resolveRootCategoryCode(`n${depth - 1}`, cats)).toBeNull();
    // A node within MAX_DEPTH of the root still resolves.
    expect(resolveRootCategoryCode("n1", cats)).toBe("n0");
  });

  it("returns null on a dangling parent reference", () => {
    const cats: CategoryNode[] = [
      { id: "leaf", code: "leaf", parentCategoryId: "ghost" },
    ];
    expect(resolveRootCategoryCode("leaf", cats)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveDescendantCategoryIds
// ---------------------------------------------------------------------------

describe("resolveDescendantCategoryIds — properties", () => {
  it("returns a duplicate-free subset of existing ids that includes the start id, for any graph", () => {
    fc.assert(
      fc.property(
        graphArb,
        fc.integer({ min: 0, max: 14 }),
        ({ categories, ids }, startIdx) => {
          const startId = ids[startIdx % ids.length];
          const allIds = new Set(ids);
          const result = resolveDescendantCategoryIds(startId, categories);

          // Includes the start id.
          expect(result).toContain(startId);
          // No duplicates.
          expect(new Set(result).size).toBe(result.length);
          // Every returned id exists.
          for (const id of result) expect(allIds.has(id)).toBe(true);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it("returns [] for a start id not present in the set", () => {
    fc.assert(
      fc.property(graphArb, ({ categories }) => {
        expect(resolveDescendantCategoryIds("nope", categories)).toEqual([]);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

describe("resolveDescendantCategoryIds — deterministic", () => {
  it("collects a category plus all its descendants", () => {
    const cats: CategoryNode[] = [
      { id: "np", code: "nonprofit", parentCategoryId: null },
      { id: "aw", code: "nonprofit:animal-welfare", parentCategoryId: "np" },
      { id: "env", code: "nonprofit:environment", parentCategoryId: "np" },
      { id: "awd", code: "nonprofit:animal-welfare:dogs", parentCategoryId: "aw" },
      { id: "biz", code: "business", parentCategoryId: null },
    ];
    const result = resolveDescendantCategoryIds("np", cats).sort();
    expect(result).toEqual(["aw", "awd", "env", "np"].sort());
    // A sibling root is not included.
    expect(result).not.toContain("biz");
  });

  it("returns just the node itself for a leaf", () => {
    const cats: CategoryNode[] = [
      { id: "np", code: "nonprofit", parentCategoryId: null },
      { id: "aw", code: "nonprofit:animal-welfare", parentCategoryId: "np" },
    ];
    expect(resolveDescendantCategoryIds("aw", cats)).toEqual(["aw"]);
  });

  it("terminates (does not hang) on a cycle among descendants", () => {
    const cats: CategoryNode[] = [
      { id: "a", code: "a", parentCategoryId: null },
      { id: "b", code: "b", parentCategoryId: "a" },
      { id: "c", code: "c", parentCategoryId: "b" },
      // c's child points back up to b — a cycle in the child graph.
      { id: "b2", code: "b2", parentCategoryId: "c" },
      { id: "cycle", code: "cycle", parentCategoryId: "b2" },
    ];
    // Force a genuine loop: make b's parent c (so a->b->c and c->b2->cycle, plus
    // an edge cycle) — the visited set must still bound the traversal.
    const withCycle: CategoryNode[] = [
      ...cats,
      { id: "loopy", code: "loopy", parentCategoryId: "loopy" },
    ];
    const result = resolveDescendantCategoryIds("a", withCycle);
    expect(new Set(result).size).toBe(result.length);
    expect(result).toContain("a");
  });
});
