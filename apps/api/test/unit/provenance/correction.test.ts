import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planCorrection } from "../../../src/lib/provenance/correction.js";
import { disclosureStrength } from "../../../src/lib/provenance/resolve.js";
import {
  SOURCE_TYPES_BY_STRENGTH,
  SYNTHETIC_BASES,
} from "../../../src/lib/provenance/types.js";

const sourceType = () => fc.constantFrom(...SOURCE_TYPES_BY_STRENGTH);
const basis = () => fc.constantFrom(...SYNTHETIC_BASES);
/** Every basis EXCEPT the one that is never correctable. */
const correctableBasis = () =>
  fc.constantFrom(...SYNTHETIC_BASES.filter((b) => b !== "PLATFORM_GENERATED"));

describe("planCorrection — what staff may do that authors may not", () => {
  it("permits a REDUCTION, which is the entire point", () => {
    // The author edit path 409s on this. If this test ever fails, the GDPR
    // Art. 16 gap is back: a mis-declared post becomes permanently wrong.
    const plan = planCorrection(
      { sourceType: "AI_GENERATED", basis: "AUTHOR_DECLARED" },
      "HUMAN_CREATED",
    );
    expect(plan.kind).toBe("apply");
    if (plan.kind === "apply") {
      expect(plan.reducesDisclosure).toBe(true);
      expect(plan.to).toBe("HUMAN_CREATED");
    }
  });

  it("permits erasing a claim entirely, down to UNKNOWN", () => {
    const plan = planCorrection(
      { sourceType: "AI_ASSISTED", basis: "AUTHOR_DECLARED" },
      "UNKNOWN",
    );
    expect(plan.kind).toBe("apply");
  });

  it("nulls the basis when correcting to UNKNOWN", () => {
    // A stale basis under UNKNOWN would make "no signal" look sourced.
    const plan = planCorrection(
      { sourceType: "AI_GENERATED", basis: "EMBEDDED_METADATA" },
      "UNKNOWN",
    );
    expect(plan.kind === "apply" && plan.basis).toBeNull();
  });

  it("permits a raise too, and does not mark it as a reduction", () => {
    const plan = planCorrection(
      { sourceType: "UNKNOWN", basis: null },
      "AI_GENERATED",
    );
    expect(plan.kind).toBe("apply");
    expect(plan.kind === "apply" && plan.reducesDisclosure).toBe(false);
  });
});

describe("planCorrection — what nobody may do", () => {
  it("REFUSES to touch a PLATFORM_GENERATED attestation, in either direction", () => {
    fc.assert(
      fc.property(sourceType(), (requested) => {
        const plan = planCorrection(
          { sourceType: "AI_GENERATED", basis: "PLATFORM_GENERATED" },
          requested,
        );
        expect(plan.kind).toBe("refuse");
        if (plan.kind === "refuse") {
          expect(plan.code).toBe("PROVENANCE_PLATFORM_ATTESTED");
        }
      }),
    );
  });

  it("the platform-attested refusal outranks the no-op refusal", () => {
    // Ordering matters for the error a caller sees: "you cannot correct this"
    // is more informative than "nothing changed" when both are true.
    const plan = planCorrection(
      { sourceType: "AI_GENERATED", basis: "PLATFORM_GENERATED" },
      "AI_GENERATED",
    );
    expect(plan.kind === "refuse" && plan.code).toBe(
      "PROVENANCE_PLATFORM_ATTESTED",
    );
  });

  it("refuses a no-op rather than writing an audit event for nothing", () => {
    fc.assert(
      fc.property(sourceType(), correctableBasis(), (s, b) => {
        const plan = planCorrection({ sourceType: s, basis: b }, s);
        expect(plan.kind).toBe("refuse");
        if (plan.kind === "refuse") expect(plan.code).toBe("PROVENANCE_UNCHANGED");
      }),
    );
  });
});

describe("planCorrection — properties", () => {
  it("is total: every (subject, requested) pair yields a plan, never a throw", () => {
    fc.assert(
      fc.property(
        sourceType(),
        fc.option(basis(), { nil: null }),
        sourceType(),
        (s, b, requested) => {
          expect(() =>
            planCorrection({ sourceType: s, basis: b }, requested),
          ).not.toThrow();
        },
      ),
    );
  });

  it("reducesDisclosure agrees with the one disclosure ordering", () => {
    // Guards against a second, drifting notion of "weaker" inside the correction
    // path — the same trap `weakerThan`/`disclosureStrength` exist to prevent.
    fc.assert(
      fc.property(
        sourceType(),
        correctableBasis(),
        sourceType(),
        (s, b, requested) => {
          const plan = planCorrection({ sourceType: s, basis: b }, requested);
          if (plan.kind !== "apply") return;
          expect(plan.reducesDisclosure).toBe(
            disclosureStrength(requested) < disclosureStrength(s),
          );
        },
      ),
    );
  });

  it("never invents a source type: `to` is always what was requested", () => {
    fc.assert(
      fc.property(
        sourceType(),
        correctableBasis(),
        sourceType(),
        (s, b, requested) => {
          const plan = planCorrection({ sourceType: s, basis: b }, requested);
          if (plan.kind === "apply") {
            expect(plan.to).toBe(requested);
            expect(plan.from).toBe(s);
          }
        },
      ),
    );
  });

  it("only ever produces a null basis for an UNKNOWN target", () => {
    fc.assert(
      fc.property(
        sourceType(),
        correctableBasis(),
        sourceType(),
        (s, b, requested) => {
          const plan = planCorrection({ sourceType: s, basis: b }, requested);
          if (plan.kind !== "apply") return;
          if (plan.basis === null) expect(plan.to).toBe("UNKNOWN");
        },
      ),
    );
  });

  it("does not introduce PLATFORM_GENERATED as a correction's basis", () => {
    // Staff cannot mint the platform's own attestation by correcting into it —
    // that would be forging the strongest claim we have.
    fc.assert(
      fc.property(
        sourceType(),
        correctableBasis(),
        sourceType(),
        (s, b, requested) => {
          const plan = planCorrection({ sourceType: s, basis: b }, requested);
          if (plan.kind === "apply") {
            expect(plan.basis).not.toBe("PLATFORM_GENERATED");
          }
        },
      ),
    );
  });

  it("supplies AUTHOR_DECLARED when the stored basis was null", () => {
    // A corrected row must carry SOME basis, or the response would emit a source
    // type with a null basis outside the one case (UNKNOWN) where that is legal.
    const plan = planCorrection(
      { sourceType: "UNKNOWN", basis: null },
      "AI_EDITED",
    );
    expect(plan.kind === "apply" && plan.basis).toBe("AUTHOR_DECLARED");
  });
});
