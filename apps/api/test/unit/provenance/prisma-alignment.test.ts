import { describe, expect, it } from "vitest";
import {
  SOURCE_TYPES_BY_STRENGTH,
  SYNTHETIC_BASES,
} from "../../../src/lib/provenance/types.js";
import {
  DISCLOSURE_POSTURES,
  declarationRequirement,
} from "../../../src/lib/provenance/posture.js";

/**
 * Drift guard between the hand-written TS unions (src/lib/provenance/types.ts)
 * and the Prisma enums (prisma/schema.prisma).
 *
 * The vocabulary is declared twice on purpose: the pure core stays free of the
 * Prisma-generated client so it compiles in a worktree that has not run
 * `prisma generate` (the same reasoning as lib/media/media-lifecycle.ts). This
 * test is where the two are reconciled, because importing the generated client
 * in a test costs nothing.
 *
 * BIDIRECTIONAL on purpose. A one-way check would let a Prisma enum grow a
 * member the TS union does not know about — and a row carrying that value would
 * then flow through `resolveProvenance` as an unmapped source type.
 *
 * If this fails: you added an enum member on one side only. Add it to both, and
 * give it a `disclosureStrength` position in SOURCE_TYPES_BY_STRENGTH.
 */
describe("provenance vocabulary — Prisma/TS alignment", () => {
  it("SyntheticSourceType matches the Prisma enum, member for member", async () => {
    const { SyntheticSourceType } = await import("@prisma/client");
    expect(Object.values(SyntheticSourceType).sort()).toEqual(
      [...SOURCE_TYPES_BY_STRENGTH].sort(),
    );
  });

  it("SyntheticBasis matches the Prisma enum, member for member", async () => {
    const { SyntheticBasis } = await import("@prisma/client");
    expect(Object.values(SyntheticBasis).sort()).toEqual(
      [...SYNTHETIC_BASES].sort(),
    );
  });

  it("TenantDisclosurePosture matches the Prisma enum, member for member", async () => {
    // Same trap, third vocabulary (D15): a posture added to the Prisma enum and
    // not to the TS union would arrive from the database as a value
    // `declarationRequirement`'s exhaustive switch has no case for.
    const { TenantDisclosurePosture } = await import("@prisma/client");
    expect(Object.values(TenantDisclosurePosture).sort()).toEqual(
      [...DISCLOSURE_POSTURES].sort(),
    );
  });

  it("every posture has a declaration requirement", () => {
    // The switch in declarationRequirement is exhaustive at compile time, but only
    // over the TS union — this asserts it at runtime over what the DB can hold.
    for (const posture of DISCLOSURE_POSTURES) {
      expect(["none", "prompt", "mandatory"]).toContain(
        declarationRequirement(posture),
      );
    }
  });

  it("every source type has a distinct disclosure-strength position", () => {
    // Guards the ordering array against a duplicated or missing member, which
    // would silently make two states compare equal in the monotonicity check.
    expect(new Set(SOURCE_TYPES_BY_STRENGTH).size).toBe(
      SOURCE_TYPES_BY_STRENGTH.length,
    );
  });
});
