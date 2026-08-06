import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BASIS_TERM,
  PROVENANCE_CONTEXT,
  SOURCE_TYPE_TERM,
  TRELLIS_NS,
  provenanceFromJsonLd,
  provenanceToJsonLd,
  unknownProvenanceProperties,
  withProvenanceContext,
} from "../../../src/lib/activitypub/provenance-jsonld.js";
import { createActivityDataToActivityStreams } from "../../../src/lib/activitypub/services/fedify-converters.js";
import {
  SOURCE_TYPES_BY_STRENGTH,
  SYNTHETIC_BASES,
} from "../../../src/lib/provenance/types.js";

const AS = "https://www.w3.org/ns/activitystreams";
const sourceType = () => fc.constantFrom(...SOURCE_TYPES_BY_STRENGTH);
const basis = () => fc.constantFrom(...SYNTHETIC_BASES);
const synthetic = () =>
  fc.constantFrom("AI_EDITED" as const, "AI_ASSISTED" as const, "AI_GENERATED" as const);

describe("provenanceToJsonLd — outbound", () => {
  it("emits the source type and basis for a synthetic value", () => {
    expect(
      provenanceToJsonLd({ sourceType: "AI_GENERATED", basis: "AUTHOR_DECLARED" }),
    ).toEqual({
      [SOURCE_TYPE_TERM]: "AI_GENERATED",
      [BASIS_TERM]: "AUTHOR_DECLARED",
    });
  });

  it("emits NOTHING for UNKNOWN — absence must mean absence", () => {
    // An explicit `syntheticSourceType: "UNKNOWN"` reads, to a remote instance,
    // as "we checked and found nothing" — a claim we never made.
    expect(provenanceToJsonLd({ sourceType: "UNKNOWN", basis: null })).toEqual({});
    expect(provenanceToJsonLd(null)).toEqual({});
    expect(provenanceToJsonLd(undefined)).toEqual({});
  });

  it("omits the basis when there is none, rather than emitting null", () => {
    const out = provenanceToJsonLd({ sourceType: "AI_EDITED", basis: null });
    expect(out).toEqual({ [SOURCE_TYPE_TERM]: "AI_EDITED" });
    expect(BASIS_TERM in out).toBe(false);
  });

  it("emits HUMAN_CREATED outbound (we may state what our own author declared)", () => {
    // Asymmetry worth pinning: we DO publish our author's positive claim, but we
    // do NOT honour a remote one. The difference is that we know where ours came
    // from.
    expect(
      provenanceToJsonLd({ sourceType: "HUMAN_CREATED", basis: "AUTHOR_DECLARED" })[
        SOURCE_TYPE_TERM
      ],
    ).toBe("HUMAN_CREATED");
  });
});

describe("withProvenanceContext", () => {
  it("appends the term definitions to a bare string context", () => {
    expect(withProvenanceContext(AS)).toEqual([AS, { ...PROVENANCE_CONTEXT }]);
  });

  it("appends to an array context, preserving what was there", () => {
    const existing = [AS, { toot: "http://joinmastodon.org/ns#" }];
    const out = withProvenanceContext(existing);
    expect(out[0]).toBe(AS);
    expect(out[1]).toEqual({ toot: "http://joinmastodon.org/ns#" });
    expect(out[2]).toEqual({ ...PROVENANCE_CONTEXT });
  });

  it("supplies the ActivityStreams context when there was none", () => {
    expect(withProvenanceContext(undefined)[0]).toBe(AS);
    expect(withProvenanceContext(null)[0]).toBe(AS);
  });

  it("is idempotent — never defines the terms twice", () => {
    const once = withProvenanceContext(AS);
    expect(withProvenanceContext(once)).toEqual(once);
    expect(withProvenanceContext(withProvenanceContext(once))).toEqual(once);
  });
});

describe("provenanceFromJsonLd — inbound", () => {
  it("reads the compact term", () => {
    expect(
      provenanceFromJsonLd({ [SOURCE_TYPE_TERM]: "AI_GENERATED" }),
    ).toEqual({ sourceType: "AI_GENERATED", basis: "EMBEDDED_METADATA" });
  });

  it("reads the fully expanded IRI form", () => {
    // Whether a relaying instance compacted the document against our context is
    // outside our control, so both forms have to work.
    expect(
      provenanceFromJsonLd({
        [`${TRELLIS_NS}${SOURCE_TYPE_TERM}`]: "AI_ASSISTED",
      })?.sourceType,
    ).toBe("AI_ASSISTED");
  });

  it("reads the prefixed form", () => {
    expect(
      provenanceFromJsonLd({ [`trellis:${SOURCE_TYPE_TERM}`]: "AI_EDITED" })
        ?.sourceType,
    ).toBe("AI_EDITED");
  });

  it("REFUSES a remote HUMAN_CREATED claim", () => {
    // A peer server can put any JSON in an object. Honouring this would let a
    // hostile instance stamp "this is a real photo" onto synthetic media.
    expect(
      provenanceFromJsonLd({ [SOURCE_TYPE_TERM]: "HUMAN_CREATED" }),
    ).toBeNull();
  });

  it("treats a remote UNKNOWN as no signal", () => {
    expect(provenanceFromJsonLd({ [SOURCE_TYPE_TERM]: "UNKNOWN" })).toBeNull();
  });

  it("IGNORES the remote basis and records EMBEDDED_METADATA", () => {
    // A remote AUTHOR_DECLARED is not a declaration made to us, and a remote
    // PLATFORM_GENERATED is another instance's platform — storing it verbatim
    // would let a peer forge our own strongest attestation.
    fc.assert(
      fc.property(synthetic(), basis(), (s, b) => {
        const out = provenanceFromJsonLd({
          [SOURCE_TYPE_TERM]: s,
          [BASIS_TERM]: b,
        });
        expect(out).toEqual({ sourceType: s, basis: "EMBEDDED_METADATA" });
      }),
    );
  });

  it("never throws on hostile or absent input", () => {
    for (const input of [
      null,
      undefined,
      42,
      "a string",
      [],
      {},
      { [SOURCE_TYPE_TERM]: null },
      { [SOURCE_TYPE_TERM]: 7 },
      { [SOURCE_TYPE_TERM]: { nested: "object" } },
      { [SOURCE_TYPE_TERM]: "NOT_A_MEMBER" },
      { [SOURCE_TYPE_TERM]: "ai_generated" }, // wrong case — not in the vocabulary
    ]) {
      expect(() => provenanceFromJsonLd(input)).not.toThrow();
      expect(provenanceFromJsonLd(input)).toBeNull();
    }
  });

  it("property: only ever returns a synthetic source type, never a claim of human origin", () => {
    fc.assert(
      fc.property(sourceType(), (s) => {
        const out = provenanceFromJsonLd({ [SOURCE_TYPE_TERM]: s });
        if (out !== null) {
          expect(["AI_EDITED", "AI_ASSISTED", "AI_GENERATED"]).toContain(
            out.sourceType,
          );
        }
      }),
    );
  });
});

describe("round trip", () => {
  it("a synthetic value survives serialize -> parse with the basis normalised", () => {
    fc.assert(
      fc.property(synthetic(), basis(), (s, b) => {
        const wire = provenanceToJsonLd({ sourceType: s, basis: b });
        const back = provenanceFromJsonLd(wire);
        expect(back?.sourceType).toBe(s);
        // Not `b`: inbound basis is deliberately not trusted.
        expect(back?.basis).toBe("EMBEDDED_METADATA");
      }),
    );
  });
});

describe("unknownProvenanceProperties — do not destroy other people's markings", () => {
  it("captures a provenance-ish term from a vocabulary we do not know", () => {
    const out = unknownProvenanceProperties({
      content: "hello",
      "someOtherNs:aiGenerated": true,
      "https://example.org/ns#provenanceChain": ["a", "b"],
    });
    expect(Object.keys(out).sort()).toEqual([
      "https://example.org/ns#provenanceChain",
      "someOtherNs:aiGenerated",
    ]);
  });

  it("recognises the IPTC term name if a peer used it directly", () => {
    const out = unknownProvenanceProperties({
      "Iptc4xmpExt:digitalSourceType": "trainedAlgorithmicMedia",
    });
    expect(Object.keys(out)).toHaveLength(1);
  });

  it("excludes our OWN terms — those are handled, not unknown", () => {
    const out = unknownProvenanceProperties({
      [SOURCE_TYPE_TERM]: "AI_GENERATED",
      [BASIS_TERM]: "AUTHOR_DECLARED",
      [`${TRELLIS_NS}${SOURCE_TYPE_TERM}`]: "AI_GENERATED",
      [`trellis:${BASIS_TERM}`]: "AUTHOR_DECLARED",
    });
    expect(out).toEqual({});
  });

  it("does not sweep up ordinary ActivityStreams properties", () => {
    // The matcher is a name heuristic, so the failure mode to guard is
    // over-capture: hoovering up unrelated fields would turn a preservation
    // mechanism into an arbitrary-data store.
    const out = unknownProvenanceProperties({
      id: "https://example.org/1",
      type: "Note",
      content: "generated a lot of interest",
      attributedTo: "https://example.org/u",
      summary: "ai is mentioned in this summary",
      published: "2026-08-03T00:00:00Z",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
    });
    expect(out).toEqual({});
  });

  it("never throws on hostile input", () => {
    for (const input of [null, undefined, 42, "s", []]) {
      expect(() => unknownProvenanceProperties(input)).not.toThrow();
      expect(unknownProvenanceProperties(input)).toEqual({});
    }
  });
});

describe("the outbound Create activity actually carries it", () => {
  const base = {
    id: "https://local/act/1",
    actor: "https://local/u/a",
    published: "2026-08-03T00:00:00Z",
    object: {
      id: "https://local/obj/1",
      attributedTo: "https://local/u/a",
      content: "hi",
      published: "2026-08-03T00:00:00Z",
    },
  };

  it("puts the terms AND their @context on the object", () => {
    const out = createActivityDataToActivityStreams({
      ...base,
      object: {
        ...base.object,
        provenance: { sourceType: "AI_GENERATED", basis: "AUTHOR_DECLARED" },
      },
    });
    const object = out.object as Record<string, unknown>;
    expect(object[SOURCE_TYPE_TERM]).toBe("AI_GENERATED");
    expect(object[BASIS_TERM]).toBe("AUTHOR_DECLARED");
    // The definition must travel WITH the terms: a relaying instance may forward
    // the object alone, and a term defined only on the wrapper is undefined.
    expect(Array.isArray(object["@context"])).toBe(true);
    expect(object["@context"]).toContainEqual({ ...PROVENANCE_CONTEXT });
  });

  it("leaves an undeclared post's JSON-LD byte-identical to before", () => {
    // The regression guard: this work must not change the wire format of the
    // overwhelming majority of posts, which carry no declaration.
    const withNull = createActivityDataToActivityStreams({
      ...base,
      object: { ...base.object, provenance: null },
    });
    const withoutField = createActivityDataToActivityStreams(base);
    expect(withNull).toEqual(withoutField);

    const object = withNull.object as Record<string, unknown>;
    expect(object["@context"]).toBe(AS);
    expect(SOURCE_TYPE_TERM in object).toBe(false);
  });

  it("an UNKNOWN provenance adds neither terms nor context", () => {
    const out = createActivityDataToActivityStreams({
      ...base,
      object: {
        ...base.object,
        provenance: { sourceType: "UNKNOWN", basis: null },
      },
    });
    const object = out.object as Record<string, unknown>;
    expect(object["@context"]).toBe(AS);
    expect(SOURCE_TYPE_TERM in object).toBe(false);
  });

  it("a federated object round-trips back through the inbound parser", () => {
    // End to end across the boundary: what we emit, another Trellis reads.
    const out = createActivityDataToActivityStreams({
      ...base,
      object: {
        ...base.object,
        provenance: { sourceType: "AI_ASSISTED", basis: "PLATFORM_GENERATED" },
      },
    });
    const back = provenanceFromJsonLd(out.object);
    expect(back?.sourceType).toBe("AI_ASSISTED");
    // Not PLATFORM_GENERATED: a peer's platform attestation is not ours.
    expect(back?.basis).toBe("EMBEDDED_METADATA");
  });
});
