import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  disclosureStrength,
  isSynthetic,
  mergeProvenance,
  resolveProvenance,
  toProvenanceView,
} from "../../../src/lib/provenance/resolve.js";
import {
  SOURCE_TYPES_BY_STRENGTH,
  SYNTHETIC_BASES,
  type Provenance,
} from "../../../src/lib/provenance/types.js";

const sourceType = fc.constantFrom(...SOURCE_TYPES_BY_STRENGTH);
const basis = fc.constantFrom(...SYNTHETIC_BASES);

/** A provenance value, or null (no row / no reading). */
const provenance: fc.Arbitrary<Provenance | null> = fc.option(
  fc.record({ sourceType, basis: fc.option(basis, { nil: null }) }),
  { nil: null },
);

describe("provenance pure core — properties", () => {
  it("is total: every input pair resolves to a value in the vocabulary", () => {
    fc.assert(
      fc.property(provenance, provenance, (declared, embedded) => {
        const r = resolveProvenance(declared, embedded);
        expect(SOURCE_TYPES_BY_STRENGTH).toContain(r.sourceType);
        // basis is null exactly when we have nothing to attribute
        if (r.sourceType === "UNKNOWN") expect(r.basis).toBeNull();
      }),
    );
  });

  it("resolves to at least the strongest input's disclosure (fail-closed)", () => {
    fc.assert(
      fc.property(provenance, provenance, (declared, embedded) => {
        const r = resolveProvenance(declared, embedded);
        const inputs = [declared, embedded].filter(
          (p): p is Provenance => p !== null,
        );
        for (const input of inputs) {
          expect(disclosureStrength(r.sourceType)).toBeGreaterThanOrEqual(
            disclosureStrength(input.sourceType),
          );
        }
      }),
    );
  });

  it("never fabricates human origin", () => {
    fc.assert(
      fc.property(provenance, provenance, (declared, embedded) => {
        const claimed =
          declared?.sourceType === "HUMAN_CREATED" ||
          embedded?.sourceType === "HUMAN_CREATED";
        if (!claimed) {
          expect(resolveProvenance(declared, embedded).sourceType).not.toBe(
            "HUMAN_CREATED",
          );
        }
      }),
    );
  });

  it("an UNKNOWN or absent declaration never masks an embedded marking", () => {
    fc.assert(
      fc.property(sourceType, (embeddedType) => {
        const embedded: Provenance = {
          sourceType: embeddedType,
          basis: "EMBEDDED_METADATA",
        };
        for (const declared of [
          null,
          { sourceType: "UNKNOWN" as const, basis: null },
        ]) {
          expect(resolveProvenance(declared, embedded).sourceType).toBe(
            embeddedType,
          );
        }
      }),
    );
  });

  it("raising an input's source type never lowers the resolved disclosure", () => {
    fc.assert(
      fc.property(
        provenance,
        provenance,
        fc.nat({ max: SOURCE_TYPES_BY_STRENGTH.length - 1 }),
        (declared, embedded, bump) => {
          const before = resolveProvenance(declared, embedded);
          const raised: Provenance = {
            sourceType: SOURCE_TYPES_BY_STRENGTH[bump]!,
            basis: declared?.basis ?? "AUTHOR_DECLARED",
          };
          const stronger =
            disclosureStrength(raised.sourceType) >=
            disclosureStrength(declared?.sourceType ?? "UNKNOWN")
              ? raised
              : declared;
          const after = resolveProvenance(stronger, embedded);
          expect(disclosureStrength(after.sourceType)).toBeGreaterThanOrEqual(
            disclosureStrength(before.sourceType),
          );
        },
      ),
    );
  });

  it("mergeProvenance never lowers an existing value (dedup + re-attachment)", () => {
    fc.assert(
      fc.property(provenance, provenance, (existing, incoming) => {
        const merged = mergeProvenance(existing, incoming);
        if (existing !== null) {
          expect(disclosureStrength(merged.sourceType)).toBeGreaterThanOrEqual(
            disclosureStrength(existing.sourceType),
          );
        }
        // never writes UNKNOWN over something recognised
        if (existing !== null && existing.sourceType !== "UNKNOWN") {
          expect(merged.sourceType).not.toBe("UNKNOWN");
        }
      }),
    );
  });

  it("view: disclosureRequired iff synthetic, and both i18n keys are present", () => {
    fc.assert(
      fc.property(provenance, provenance, (declared, embedded) => {
        const view = toProvenanceView(resolveProvenance(declared, embedded));
        expect(view.disclosureRequired).toBe(isSynthetic(view.sourceType));
        expect(view.labelKey).toBe(
          `provenance.${view.sourceType.toLowerCase()}`,
        );
        expect(view.labelDetailKey).toBe(`${view.labelKey}.detail`);
      }),
    );
  });

  it("view: never exposes a confidence (anti-oracle, D6)", () => {
    const view = toProvenanceView({
      sourceType: "AI_GENERATED",
      basis: "CLASSIFIER_INFERRED",
    });
    expect(Object.keys(view)).not.toContain("confidence");
    expect(Object.keys(view).sort()).toEqual([
      "basis",
      "disclosureRequired",
      "labelDetailKey",
      "labelKey",
      "sourceType",
    ]);
  });
});

describe("provenance pure core — worked examples", () => {
  it("an author declaration cannot suppress an embedded AI marking (D10)", () => {
    const r = resolveProvenance(
      { sourceType: "HUMAN_CREATED", basis: "AUTHOR_DECLARED" },
      { sourceType: "AI_GENERATED", basis: "EMBEDDED_METADATA" },
    );
    expect(r).toEqual({
      sourceType: "AI_GENERATED",
      basis: "EMBEDDED_METADATA",
    });
  });

  it("at equal strength, the stronger basis wins the attribution", () => {
    const r = resolveProvenance(
      { sourceType: "AI_GENERATED", basis: "EMBEDDED_METADATA" },
      { sourceType: "AI_GENERATED", basis: "PLATFORM_GENERATED" },
    );
    expect(r.basis).toBe("PLATFORM_GENERATED");
  });

  it("a C2PA container that asserts nothing recognised stays UNKNOWN", () => {
    // T1 yields {UNKNOWN, examined:true} for an unparsed manifest — it must NOT
    // become an AI claim, or provenance-enabled cameras get mislabelled.
    const r = resolveProvenance(null, {
      sourceType: "UNKNOWN",
      basis: "EMBEDDED_METADATA",
    });
    expect(r.sourceType).toBe("UNKNOWN");
    expect(toProvenanceView(r).disclosureRequired).toBe(false);
  });

  it("nothing known anywhere resolves to UNKNOWN, not HUMAN_CREATED", () => {
    expect(resolveProvenance(null, null)).toEqual({
      sourceType: "UNKNOWN",
      basis: null,
    });
  });
});
