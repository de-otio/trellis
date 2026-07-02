/**
 * Pure, synchronous tree helpers over already-fetched `PlatformCategory` rows.
 *
 * No I/O happens inside these functions (functional-core default) — the caller
 * fetches the category rows once and passes them in. Two operations:
 *
 *   - `resolveRootCategoryCode` — walk `parentCategoryId` to the root and return
 *     the root's `code`. Runs on the post-creation hot path (feed-declutter
 *     denormalization onto `Post.authorOrgRootCategoryCode`).
 *   - `resolveDescendantCategoryIds` — collect a category and everything under
 *     it (for directory category-browse, "everything under `nonprofit`").
 *
 * The tree is acyclic by construction (platform-curated, SUPER_ADMIN-only
 * writes). Even so, both functions are hardened against a cycle or a dangling
 * parent reference: `resolveRootCategoryCode` bails out after `MAX_DEPTH`
 * ancestor hops (defense-in-depth — an infinite loop on the write path would be
 * a platform-wide outage), and `resolveDescendantCategoryIds` uses a visited set
 * so a cycle can never make it loop forever. The reparent operation is exactly
 * the maintenance surface where a cycle could slip in via a bug, so these guards
 * are load-bearing, not theoretical.
 */

/**
 * The minimal shape these functions need from a `PlatformCategory` row. Accepts
 * the full Prisma model as well (structural typing) — callers can pass
 * `PlatformCategory[]` directly.
 */
export interface CategoryNode {
  id: string;
  code: string;
  parentCategoryId: string | null;
}

/**
 * Maximum number of ancestor hops `resolveRootCategoryCode` will take before
 * giving up and returning `null`. The real tree is a handful of roots, rarely
 * more than 2–3 levels deep, so this is a generous defense-in-depth ceiling, not
 * a functional limit — it exists only to guarantee termination if a bug ever
 * introduces a cycle.
 */
export const MAX_DEPTH = 20;

/**
 * Walk `parentCategoryId` from `categoryId` to the root and return the root
 * node's `code`.
 *
 * Returns `null` when:
 *   - `categoryId` is not present in `allCategories`;
 *   - a `parentCategoryId` references a node not present in `allCategories`
 *     (dangling reference — unresolvable);
 *   - the walk exceeds `MAX_DEPTH` hops (cycle / pathological depth guard).
 *
 * Guaranteed to terminate for any input. A non-null result is always the `code`
 * of a node whose `parentCategoryId === null`.
 */
export function resolveRootCategoryCode(
  categoryId: string,
  allCategories: readonly CategoryNode[],
): string | null {
  const byId = new Map<string, CategoryNode>();
  for (const c of allCategories) byId.set(c.id, c);

  let current = byId.get(categoryId);
  if (current === undefined) return null;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (current.parentCategoryId === null) return current.code;
    const parent = byId.get(current.parentCategoryId);
    if (parent === undefined) return null; // dangling parent ref — unresolvable
    current = parent;
  }

  return null; // depth guard tripped (cycle or tree deeper than MAX_DEPTH)
}

/**
 * Collect `categoryId` and the ids of every category reachable beneath it via
 * `parentCategoryId` edges (i.e. `categoryId` plus all descendants).
 *
 * Returns `[]` when `categoryId` is not present in `allCategories`. The returned
 * array always includes `categoryId` itself (when present), contains no
 * duplicates, and every id in it exists in `allCategories`. A `visited` set makes
 * termination guaranteed even if the input graph contains a cycle.
 */
export function resolveDescendantCategoryIds(
  categoryId: string,
  allCategories: readonly CategoryNode[],
): string[] {
  const childrenByParent = new Map<string, string[]>();
  const allIds = new Set<string>();
  for (const c of allCategories) {
    allIds.add(c.id);
    if (c.parentCategoryId !== null) {
      const siblings = childrenByParent.get(c.parentCategoryId);
      if (siblings === undefined) {
        childrenByParent.set(c.parentCategoryId, [c.id]);
      } else {
        siblings.push(c.id);
      }
    }
  }

  if (!allIds.has(categoryId)) return [];

  const result: string[] = [];
  const visited = new Set<string>();
  const stack: string[] = [categoryId];

  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);

    const children = childrenByParent.get(id);
    if (children !== undefined) {
      for (const child of children) {
        if (!visited.has(child)) stack.push(child);
      }
    }
  }

  return result;
}
