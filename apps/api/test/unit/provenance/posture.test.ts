import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DISCLOSURE_POSTURE,
  DISCLOSURE_POSTURES,
  declarationRequirement,
  parseDisclosurePosture,
  resolveDisclosurePosture,
  validateDeclaration,
  type DisclosurePosture,
} from "../../../src/lib/provenance/posture.js";
import {
  gateDeclarationOrRespond,
  readDeclarationRequirement,
  readDisclosurePosture,
} from "../../../src/lib/provenance/posture-gate.js";
import { toProvenanceView } from "../../../src/lib/provenance/resolve.js";
import { SOURCE_TYPES_BY_STRENGTH } from "../../../src/lib/provenance/types.js";

const posture = () => fc.constantFrom(...DISCLOSURE_POSTURES);

/** A `tenant.findUnique` stub returning a fixed override. */
function fakeDb(disclosurePosture: DisclosurePosture | null) {
  return {
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ disclosurePosture }),
    },
  };
}

describe("parseDisclosurePosture", () => {
  it("accepts every posture, case- and whitespace-insensitively", () => {
    fc.assert(
      fc.property(posture(), (p) => {
        expect(parseDisclosurePosture(p)).toBe(p);
        expect(parseDisclosurePosture(p.toLowerCase())).toBe(p);
        expect(parseDisclosurePosture(`  ${p}  `)).toBe(p);
      }),
    );
  });

  it("returns null for anything else, including null and empty", () => {
    for (const bad of [null, undefined, "", "  ", "STRICT", "optional_", "0"]) {
      expect(parseDisclosurePosture(bad)).toBeNull();
    }
  });

  it("does not accept a source type by accident (the two vocabularies are distinct)", () => {
    for (const s of SOURCE_TYPES_BY_STRENGTH) {
      expect(parseDisclosurePosture(s)).toBeNull();
    }
  });
});

describe("resolveDisclosurePosture — fail-open", () => {
  it("an override always wins", () => {
    fc.assert(
      fc.property(posture(), posture(), (override, fallback) => {
        expect(
          resolveDisclosurePosture({ disclosurePosture: override }, fallback),
        ).toBe(override);
      }),
    );
  });

  it("null / undefined / a missing tenant row all fall back, never throw", () => {
    fc.assert(
      fc.property(posture(), (fallback) => {
        expect(resolveDisclosurePosture(null, fallback)).toBe(fallback);
        expect(resolveDisclosurePosture(undefined, fallback)).toBe(fallback);
        expect(
          resolveDisclosurePosture({ disclosurePosture: null }, fallback),
        ).toBe(fallback);
        expect(resolveDisclosurePosture({}, fallback)).toBe(fallback);
      }),
    );
  });
});

describe("validateDeclaration", () => {
  it("only REQUIRED_FOR_AI can ever reject", () => {
    fc.assert(
      fc.property(
        posture(),
        fc.option(fc.constantFrom(...SOURCE_TYPES_BY_STRENGTH), {
          nil: undefined,
        }),
        (p, declared) => {
          const rejection = validateDeclaration(p, declared);
          if (p !== "REQUIRED_FOR_AI") expect(rejection).toBeNull();
        },
      ),
    );
  });

  it("REQUIRED_FOR_AI distinguishes 'you did not ask' from 'the user declined'", () => {
    expect(validateDeclaration("REQUIRED_FOR_AI", undefined)).toBe(
      "DECLARATION_REQUIRED",
    );
    expect(validateDeclaration("REQUIRED_FOR_AI", "UNKNOWN")).toBe(
      "DECLARATION_MAY_NOT_BE_UNKNOWN",
    );
  });

  it("REQUIRED_FOR_AI accepts every real answer, including HUMAN_CREATED", () => {
    // HUMAN_CREATED must be acceptable: the duty is to state whether AI was
    // used, not to have used it.
    for (const s of ["HUMAN_CREATED", "AI_EDITED", "AI_ASSISTED", "AI_GENERATED"]) {
      expect(validateDeclaration("REQUIRED_FOR_AI", s)).toBeNull();
    }
  });
});

describe("declarationRequirement — the three postures are distinguishable", () => {
  it("maps onto three distinct requirements", () => {
    const seen = new Set(DISCLOSURE_POSTURES.map(declarationRequirement));
    expect(seen.size).toBe(3);
  });
});

describe("posture does NOT change what is rendered", () => {
  // The load-bearing negative claim from posture.ts: all three postures render
  // identically, which is WHY toProvenanceView takes no posture argument. If a
  // future change makes posture affect rendering, this test is the thing that
  // says the comment is now a lie.
  it("disclosureRequired depends only on the resolved source type", () => {
    fc.assert(
      fc.property(fc.constantFrom(...SOURCE_TYPES_BY_STRENGTH), (sourceType) => {
        const view = toProvenanceView({ sourceType, basis: "AUTHOR_DECLARED" });
        const synthetic =
          sourceType === "AI_EDITED" ||
          sourceType === "AI_ASSISTED" ||
          sourceType === "AI_GENERATED";
        expect(view.disclosureRequired).toBe(synthetic);
      }),
    );
  });

  it("UNKNOWN never requires disclosure under any posture", () => {
    expect(
      toProvenanceView({ sourceType: "UNKNOWN", basis: null })
        .disclosureRequired,
    ).toBe(false);
  });
});

describe("readDisclosurePosture — the imperative shell", () => {
  it("reads the override", async () => {
    expect(
      await readDisclosurePosture(fakeDb("REQUIRED_FOR_AI"), "t1", "OPTIONAL"),
    ).toBe("REQUIRED_FOR_AI");
  });

  it("falls back when the tenant has no override", async () => {
    expect(await readDisclosurePosture(fakeDb(null), "t1", "OPTIONAL")).toBe(
      "OPTIONAL",
    );
  });

  it("falls back when the tenant row is missing entirely", async () => {
    const db = { tenant: { findUnique: vi.fn().mockResolvedValue(null) } };
    expect(await readDisclosurePosture(db, "nope", "PROMPTED")).toBe("PROMPTED");
  });

  it("FAILS OPEN on a database error rather than throwing", async () => {
    const db = {
      tenant: { findUnique: vi.fn().mockRejectedValue(new Error("pool dead")) },
    };
    await expect(
      readDisclosurePosture(db, "t1", "REQUIRED_FOR_AI"),
    ).resolves.toBe("REQUIRED_FOR_AI");
  });

  it("uses DEFAULT_DISCLOSURE_POSTURE when no default is supplied", async () => {
    expect(await readDisclosurePosture(fakeDb(null), "t1")).toBe(
      DEFAULT_DISCLOSURE_POSTURE,
    );
  });
});

describe("gateDeclarationOrRespond", () => {
  it("passes a declared post under every posture", async () => {
    for (const p of DISCLOSURE_POSTURES) {
      expect(
        await gateDeclarationOrRespond(fakeDb(p), "t1", "AI_GENERATED", p),
      ).toBeNull();
    }
  });

  it("skips the tenant read entirely when the declaration is already acceptable", async () => {
    const db = fakeDb("REQUIRED_FOR_AI");
    expect(
      await gateDeclarationOrRespond(db, "t1", "HUMAN_CREATED", "OPTIONAL"),
    ).toBeNull();
    expect(db.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("refuses an undeclared post for a REQUIRED_FOR_AI tenant, with a 400", async () => {
    const res = await gateDeclarationOrRespond(
      fakeDb("REQUIRED_FOR_AI"),
      "t1",
      undefined,
      "OPTIONAL",
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toBe("DECLARATION_REQUIRED");
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("lets an undeclared post through for a tenant that is not REQUIRED_FOR_AI", async () => {
    for (const p of ["OPTIONAL", "PROMPTED"] as const) {
      expect(
        await gateDeclarationOrRespond(fakeDb(p), "t1", undefined, p),
      ).toBeNull();
    }
  });

  it("a tenant override can make a permissive platform default strict", async () => {
    const res = await gateDeclarationOrRespond(
      fakeDb("REQUIRED_FOR_AI"),
      "t1",
      undefined,
      "OPTIONAL",
    );
    expect(res?.status).toBe(400);
  });

  it("a tenant override can relax a strict platform default", async () => {
    expect(
      await gateDeclarationOrRespond(
        fakeDb("OPTIONAL"),
        "t1",
        undefined,
        "REQUIRED_FOR_AI",
      ),
    ).toBeNull();
  });

  it("does NOT block the write when the posture read fails", async () => {
    // Fail-open: a policy-lookup outage must not become a posting outage. The
    // platform default still applies, so a REQUIRED_FOR_AI *default* still bites.
    const db = {
      tenant: { findUnique: vi.fn().mockRejectedValue(new Error("pool dead")) },
    };
    expect(
      await gateDeclarationOrRespond(db, "t1", undefined, "OPTIONAL"),
    ).toBeNull();
  });
});

describe("readDeclarationRequirement — the compose hint", () => {
  it("maps the tenant's effective posture onto a requirement", async () => {
    expect(
      await readDeclarationRequirement(fakeDb("REQUIRED_FOR_AI"), "t1"),
    ).toBe("mandatory");
    expect(await readDeclarationRequirement(fakeDb("PROMPTED"), "t1")).toBe(
      "prompt",
    );
    expect(await readDeclarationRequirement(fakeDb("OPTIONAL"), "t1")).toBe(
      "none",
    );
  });
});
