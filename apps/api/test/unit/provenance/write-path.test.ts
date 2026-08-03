import { describe, expect, it } from "vitest";
import {
  createPostSchema,
  editPostSchema,
} from "../../../src/lib/schemas.js";
import { disclosureStrength } from "../../../src/lib/provenance/resolve.js";

/**
 * Write-path contract for Art. 50 provenance (T2).
 *
 * The schema-level assertions here are the security boundary: a client may
 * declare WHAT the content is, never HOW WE KNOW it. `basis` is minted
 * server-side, so accepting it from a client would let anyone forge
 * `PLATFORM_GENERATED` — our strongest attestation.
 */
describe("provenance write path — schema boundary", () => {
  describe("createPostSchema", () => {
    it("accepts a text declaration", () => {
      const r = createPostSchema.safeParse({
        text: "hello",
        provenance: { sourceType: "AI_ASSISTED" },
      });
      expect(r.success).toBe(true);
    });

    it("REJECTS a client-supplied basis rather than ignoring it", () => {
      // Strict mode is the point: a silently-dropped `basis` would leave the
      // client believing its value was honoured.
      const r = createPostSchema.safeParse({
        text: "hello",
        provenance: {
          sourceType: "AI_GENERATED",
          basis: "PLATFORM_GENERATED",
        },
      });
      expect(r.success).toBe(false);
    });

    it("rejects an explicit UNKNOWN declaration", () => {
      // Absence of a declaration is expressed by omitting the field. Accepting
      // an explicit UNKNOWN would give a client a way to assert "no signal".
      const r = createPostSchema.safeParse({
        text: "hello",
        provenance: { sourceType: "UNKNOWN" },
      });
      expect(r.success).toBe(false);
    });

    it("rejects an unknown source type", () => {
      const r = createPostSchema.safeParse({
        text: "hello",
        provenance: { sourceType: "TOTALLY_HUMAN_PROMISE" },
      });
      expect(r.success).toBe(false);
    });

    it("accepts a per-attachment declaration", () => {
      const r = createPostSchema.safeParse({
        text: "hello",
        media: [{ id: "m1", alt: "a", sourceType: "AI_GENERATED" }],
      });
      expect(r.success).toBe(true);
    });

    it("still accepts media items with no declaration", () => {
      const r = createPostSchema.safeParse({
        text: "hello",
        media: [{ id: "m1", alt: "a" }],
      });
      expect(r.success).toBe(true);
    });

    it("does not tighten existing media validation (back-compat)", () => {
      // `media` items are NOT strict: unknown keys are stripped as before, so
      // requests that are valid today keep working.
      const r = createPostSchema.safeParse({
        text: "hello",
        media: [{ id: "m1", alt: "a", someLegacyField: "x" }],
      });
      expect(r.success).toBe(true);
    });

    it("a post with no provenance field at all is valid", () => {
      expect(createPostSchema.safeParse({ text: "hello" }).success).toBe(true);
    });
  });

  describe("editPostSchema", () => {
    it("accepts a text declaration", () => {
      const r = editPostSchema.safeParse({
        text: "hello",
        provenance: { sourceType: "AI_GENERATED" },
      });
      expect(r.success).toBe(true);
    });

    it("REJECTS a client-supplied basis", () => {
      const r = editPostSchema.safeParse({
        text: "hello",
        provenance: { sourceType: "AI_GENERATED", basis: "AUTHOR_DECLARED" },
      });
      expect(r.success).toBe(false);
    });

    it("does not offer provenance on media items", () => {
      // editPost ignores `media` entirely, so offering a disclosure there would
      // accept it and silently drop it — worse than not offering it. The key is
      // stripped, so the parse succeeds but the value cannot be honoured.
      const r = editPostSchema.safeParse({
        text: "hello",
        media: [{ id: "m1", sourceType: "AI_GENERATED" }],
      });
      expect(r.success).toBe(true);
      const media = (r as { data: { media?: Array<Record<string, unknown>> } })
        .data.media;
      expect(media?.[0]).not.toHaveProperty("sourceType");
    });
  });
});

describe("provenance write path — monotonicity ordering", () => {
  // The handler compares disclosureStrength(next) < disclosureStrength(current)
  // and rejects with 409. These cases pin the ordering that decision rests on.
  const cases: Array<[string, string, "allow" | "reject"]> = [
    ["UNKNOWN", "AI_GENERATED", "allow"],
    ["UNKNOWN", "HUMAN_CREATED", "allow"],
    ["AI_ASSISTED", "AI_GENERATED", "allow"],
    ["AI_EDITED", "AI_ASSISTED", "allow"],
    ["AI_GENERATED", "AI_ASSISTED", "reject"],
    ["AI_GENERATED", "HUMAN_CREATED", "reject"],
    ["AI_ASSISTED", "HUMAN_CREATED", "reject"],
    ["HUMAN_CREATED", "AI_GENERATED", "allow"],
  ];

  for (const [current, next, expected] of cases) {
    it(`${current} -> ${next} is ${expected}ed`, () => {
      const lowers =
        disclosureStrength(next as never) < disclosureStrength(current as never);
      expect(lowers ? "reject" : "allow").toBe(expected);
    });
  }

  it("the strongest disclosure cannot be walked back to anything", () => {
    for (const weaker of ["UNKNOWN", "HUMAN_CREATED", "AI_EDITED", "AI_ASSISTED"]) {
      expect(
        disclosureStrength(weaker as never) <
          disclosureStrength("AI_GENERATED"),
      ).toBe(true);
    }
  });
});
