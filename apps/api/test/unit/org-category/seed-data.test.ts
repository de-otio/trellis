/**
 * Tests for the `PlatformCategory` seed data (`src/lib/org-category/seed-data.ts`).
 *
 * Two layers:
 *
 *   1. Property tests for the four structural invariants the seed loader
 *      depends on (D1.2 in the lane plan) — written against an arbitrary
 *      generator of well-formed seed trees, and then asserted directly
 *      against the shipped `PLATFORM_CATEGORY_SEED`.
 *   2. Example tests pinning the current seed's exact contents, so a future
 *      edit (e.g. lane D2's new nodes) shows up as a diff here rather than
 *      silently changing behaviour.
 *
 * Also exercises the `resolveRootCategoryCode` / `resolveDescendantCategoryIds`
 * tree helpers (`src/lib/org-category/tree.ts`) through a `CategoryNode[]`
 * synthesized from the seed — those helpers walk `id`/`parentCategoryId`,
 * while seed entries carry `code`/`parentCode` and have no ids (ids are
 * `cuid()` values assigned at upsert time).
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  LEAVES,
  PLATFORM_CATEGORY_SEED,
  ROOTS,
  type CategorySeed,
} from "../../../src/lib/org-category/seed-data.js";
import {
  MAX_DEPTH,
  resolveDescendantCategoryIds,
  resolveRootCategoryCode,
  type CategoryNode,
} from "../../../src/lib/org-category/tree.js";

// ---------------------------------------------------------------------------
// Invariant checks — shared between the property test and the shipped-data
// assertion, so both exercise exactly the same rules.
// ---------------------------------------------------------------------------

/** A single colon-free path segment: lowercase letters/digits, hyphen-joined. */
const KEBAB_SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Invariant 1: lowercase-kebab, `:`-separated, no whitespace anywhere. */
function isLowercaseKebabWithColonSeparators(code: string): boolean {
  if (code.length === 0 || /\s/.test(code)) return false;
  return code.split(":").every((segment) => KEBAB_SEGMENT.test(segment));
}

/**
 * Asserts all four invariants from the lane plan over `seed`, in array order:
 *
 *   1. every `code` is lowercase-kebab with `:` separators, no whitespace;
 *   2. every non-root entry's `parentCode` exists and appears earlier;
 *   3. every non-root entry's `code` equals `${parentCode}:${lastSegment}`;
 *   4. no duplicate `code`; depth never exceeds `MAX_DEPTH`.
 */
function assertSeedInvariants(seed: readonly CategorySeed[]): void {
  const seenCodes = new Set<string>();
  const depthByCode = new Map<string, number>();

  for (const entry of seed) {
    expect(
      isLowercaseKebabWithColonSeparators(entry.code),
      `code "${entry.code}" is not lowercase-kebab with colon separators`,
    ).toBe(true);

    expect(seenCodes.has(entry.code), `duplicate code "${entry.code}"`).toBe(false);
    seenCodes.add(entry.code);

    if (entry.parentCode === undefined) {
      depthByCode.set(entry.code, 0);
      continue;
    }

    expect(
      seenCodes.has(entry.parentCode),
      `parentCode "${entry.parentCode}" for "${entry.code}" must exist and appear earlier in the array`,
    ).toBe(true);

    const lastColon = entry.code.lastIndexOf(":");
    const prefixBeforeLastSegment = lastColon === -1 ? "" : entry.code.slice(0, lastColon);
    const lastSegment = lastColon === -1 ? entry.code : entry.code.slice(lastColon + 1);

    expect(
      prefixBeforeLastSegment,
      `code "${entry.code}" must equal "\${parentCode}:\${lastSegment}" — got parent prefix "${prefixBeforeLastSegment}", expected "${entry.parentCode}"`,
    ).toBe(entry.parentCode);
    expect(lastSegment.length, `code "${entry.code}" has an empty last segment`).toBeGreaterThan(0);

    const parentDepth = depthByCode.get(entry.parentCode) as number;
    const depth = parentDepth + 1;
    expect(
      depth,
      `entry "${entry.code}" exceeds MAX_DEPTH (${MAX_DEPTH}): depth ${depth}`,
    ).toBeLessThanOrEqual(MAX_DEPTH);
    depthByCode.set(entry.code, depth);
  }
}

// ---------------------------------------------------------------------------
// Arbitrary — well-formed seed trees
// ---------------------------------------------------------------------------

// Generated depth stays well under the real MAX_DEPTH (20) so the arbitrary
// runs fast while still exercising multi-level nesting; the depth invariant
// itself is checked against the real MAX_DEPTH constant, not this cap.
const GENERATOR_MAX_DEPTH = 6;

const wordArb = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), {
    minLength: 2,
    maxLength: 6,
  })
  .map((chars) => chars.join(""));

/**
 * Builds an array of `CategorySeed` that is well-formed by construction: each
 * node's `code` is a globally-unique word (so two nodes can never collide,
 * see below), every non-root's `parentCode` is an earlier node's `code`, and
 * depth is capped at `GENERATOR_MAX_DEPTH`.
 *
 * Uniqueness argument: every node contributes exactly one word to its own
 * `code` as the final path segment (a root's whole code, or a child's segment
 * after the last `:`), and `wordArb` values are drawn without repetition
 * across the whole node set. Two different nodes can therefore never produce
 * the same full `code` — even a root and a deeply-nested leaf are
 * distinguishable, because only the leaf's code contains `:`.
 */
const wellFormedSeedTreeArb: fc.Arbitrary<CategorySeed[]> = fc
  .integer({ min: 1, max: 16 })
  .chain((count) =>
    fc.tuple(
      fc.uniqueArray(wordArb, { minLength: count, maxLength: count }),
      fc.array(fc.nat({ max: 1000 }), { minLength: count, maxLength: count }),
    ),
  )
  .map(([words, choices]) => {
    interface BuiltNode {
      code: string;
      parentCode?: string;
      depth: number;
    }
    const nodes: BuiltNode[] = [];

    // The first word is always a root, so every generated tree has at least
    // one root and the "roots before leaves" shape is representable.
    nodes.push({ code: words[0], depth: 0 });

    for (let i = 1; i < words.length; i++) {
      const eligibleParents = nodes
        .map((n, idx) => ({ idx, depth: n.depth }))
        .filter((n) => n.depth < GENERATOR_MAX_DEPTH);
      // -1 means "become a new root"; any eligible node's index means "become
      // its child" (only nodes below the depth cap are eligible, so the
      // generator never needs to overflow GENERATOR_MAX_DEPTH).
      const options: number[] = [-1, ...eligibleParents.map((n) => n.idx)];
      const chosen = options[choices[i] % options.length];

      if (chosen === -1) {
        nodes.push({ code: words[i], depth: 0 });
      } else {
        const parent = nodes[chosen];
        nodes.push({
          code: `${parent.code}:${words[i]}`,
          parentCode: parent.code,
          depth: parent.depth + 1,
        });
      }
    }

    return nodes.map(
      (n, i): CategorySeed => ({
        code: n.code,
        displayName: `Generated ${i}`,
        order: i,
        ...(n.parentCode !== undefined ? { parentCode: n.parentCode } : {}),
      }),
    );
  });

// ---------------------------------------------------------------------------
// D1.2 — the invariant properties
// ---------------------------------------------------------------------------

describe("PLATFORM_CATEGORY_SEED — structural invariants", () => {
  it("hold for arbitrary well-formed seed trees", () => {
    fc.assert(
      fc.property(wellFormedSeedTreeArb, (seed) => {
        assertSeedInvariants(seed);
      }),
      { numRuns: 300 },
    );
  });

  it("hold for the shipped PLATFORM_CATEGORY_SEED", () => {
    assertSeedInvariants(PLATFORM_CATEGORY_SEED);
  });

  it("ships roots before any leaf (the script's upsert precondition)", () => {
    const rootCount = ROOTS.length;
    for (let i = 0; i < rootCount; i++) {
      expect(PLATFORM_CATEGORY_SEED[i].parentCode).toBeUndefined();
    }
    for (let i = rootCount; i < PLATFORM_CATEGORY_SEED.length; i++) {
      expect(PLATFORM_CATEGORY_SEED[i].parentCode).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// D1's "no entry added, removed or edited" contract — example tests pinning
// the current, exact seed contents.
// ---------------------------------------------------------------------------

describe("ROOTS — exact contents", () => {
  it("has exactly the six current root categories, in order", () => {
    expect(ROOTS).toEqual<CategorySeed[]>([
      { code: "business", displayName: "Business", order: 0, description: "For-profit companies, sole traders, and commercial services." },
      { code: "nonprofit", displayName: "Nonprofit", order: 1, description: "Charities, NGOs, foundations, and other not-for-profit organizations." },
      { code: "community-group", displayName: "Community Group", order: 2, description: "Informal community groups, clubs, and grassroots collectives." },
      { code: "government", displayName: "Government", order: 3, description: "Public bodies, agencies, and government services." },
      { code: "educational", displayName: "Educational", order: 4, description: "Schools, universities, and other educational institutions." },
      { code: "other", displayName: "Other", order: 5, description: "Fallback root for organizations that fit none of the above." },
    ]);
  });
});

describe("LEAVES — exact contents", () => {
  it("has exactly the six current illustrative leaves, in order", () => {
    expect(LEAVES).toEqual<CategorySeed[]>([
      { code: "business:retail", displayName: "Retail", order: 0, parentCode: "business" },
      { code: "business:hospitality", displayName: "Hospitality", order: 1, parentCode: "business" },
      { code: "business:professional-services", displayName: "Professional Services", order: 2, parentCode: "business" },
      { code: "nonprofit:animal-welfare", displayName: "Animal Welfare", order: 0, parentCode: "nonprofit" },
      { code: "nonprofit:environment", displayName: "Environment", order: 1, parentCode: "nonprofit" },
      { code: "nonprofit:education", displayName: "Education & Youth", order: 2, parentCode: "nonprofit" },
    ]);
  });
});

describe("PLATFORM_CATEGORY_SEED — assembly", () => {
  it("is exactly ROOTS followed by LEAVES, twelve entries total", () => {
    expect(PLATFORM_CATEGORY_SEED).toEqual([...ROOTS, ...LEAVES]);
    expect(PLATFORM_CATEGORY_SEED).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// D1.3 — the tree-helper bridge
// ---------------------------------------------------------------------------

/**
 * Synthesizes `CategoryNode[]` from seed entries: `id = code` (seed entries
 * have no id — ids are `cuid()` values assigned at upsert) and
 * `parentCategoryId = parentCode ?? null`. Lane D2 extends this same helper
 * for its new nodes.
 */
export function synthesizeCategoryNodes(seed: readonly CategorySeed[]): CategoryNode[] {
  return seed.map((entry) => ({
    id: entry.code,
    code: entry.code,
    parentCategoryId: entry.parentCode ?? null,
  }));
}

describe("tree-helper bridge over the seed", () => {
  const nodes = synthesizeCategoryNodes(PLATFORM_CATEGORY_SEED);

  it("resolveRootCategoryCode returns \"business\" for business:hospitality", () => {
    expect(resolveRootCategoryCode("business:hospitality", nodes)).toBe("business");
  });

  it("resolveRootCategoryCode resolves every leaf back to its declared parentCode", () => {
    for (const leaf of LEAVES) {
      expect(resolveRootCategoryCode(leaf.code, nodes)).toBe(leaf.parentCode);
    }
  });

  it('resolveDescendantCategoryIds("business", …) contains the three existing business leaves', () => {
    const result = resolveDescendantCategoryIds("business", nodes);
    expect(result).toContain("business");
    expect(result).toContain("business:retail");
    expect(result).toContain("business:hospitality");
    expect(result).toContain("business:professional-services");
    expect(result).toHaveLength(4);
  });

  it('resolveDescendantCategoryIds("nonprofit", …) contains the three existing nonprofit leaves', () => {
    const result = resolveDescendantCategoryIds("nonprofit", nodes);
    expect(result).toContain("nonprofit");
    expect(result).toContain("nonprofit:animal-welfare");
    expect(result).toContain("nonprofit:environment");
    expect(result).toContain("nonprofit:education");
    expect(result).toHaveLength(4);
  });
});
