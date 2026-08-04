import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PROVENANCE_METRICS,
  provenanceMetric,
  type ProvenanceEvent,
} from "../../../src/lib/provenance/metrics.js";
import {
  SOURCE_TYPES_BY_STRENGTH,
  SYNTHETIC_BASES,
} from "../../../src/lib/provenance/types.js";

const events = (): fc.Arbitrary<ProvenanceEvent> =>
  fc.oneof(
    fc.record({
      kind: fc.constant("recognised" as const),
      sourceType: fc.constantFrom(...SOURCE_TYPES_BY_STRENGTH),
      basis: fc.constantFrom(...SYNTHETIC_BASES),
      mediaKind: fc.constantFrom("image" as const, "timed-media" as const, "text" as const),
    }),
    fc.record({
      kind: fc.constant("unrecognised" as const),
      container: fc.constantFrom("xmp" as const, "c2pa" as const),
      mediaKind: fc.constantFrom("image" as const, "timed-media" as const),
    }),
    fc.record({
      kind: fc.constant("discarded" as const),
      reason: fc.constant("no-persistence-port" as const),
      mediaKind: fc.constantFrom("image" as const, "timed-media" as const),
    }),
    fc.record({
      kind: fc.constant("read-failed" as const),
      mediaKind: fc.constantFrom("image" as const, "timed-media" as const),
    }),
    fc.record({
      kind: fc.constant("declared" as const),
      sourceType: fc.constantFrom(...SOURCE_TYPES_BY_STRENGTH),
      surface: fc.constantFrom("post" as const, "comment" as const, "attachment" as const),
    }),
    fc.record({ kind: fc.constant("corrected" as const), reduced: fc.boolean() }),
  );

describe("provenanceMetric", () => {
  it("emits exactly one datum per event, always a count of 1", () => {
    fc.assert(
      fc.property(events(), (event) => {
        const out = provenanceMetric(event);
        expect(out.metrics).toHaveLength(1);
        expect(out.metrics[0]!.value).toBe(1);
      }),
    );
  });

  it("only ever emits a name from the declared set", () => {
    // Guards against a call site inventing a metric name that no alert rule
    // matches — the failure mode where a dashboard is quietly wrong.
    const known = new Set(Object.values(PROVENANCE_METRICS));
    fc.assert(
      fc.property(events(), (event) => {
        expect(known.has(provenanceMetric(event).metrics[0]!.name as never)).toBe(
          true,
        );
      }),
    );
  });

  it("every declared metric name is reachable from some event", () => {
    // The inverse: a name in the constant that nothing emits is a dead alert
    // rule, which reads as "we monitor this" while monitoring nothing.
    const emitted = new Set<string>();
    for (const sourceType of SOURCE_TYPES_BY_STRENGTH) {
      emitted.add(
        provenanceMetric({
          kind: "recognised",
          sourceType,
          basis: "AUTHOR_DECLARED",
          mediaKind: "image",
        }).metrics[0]!.name,
      );
      emitted.add(
        provenanceMetric({ kind: "declared", sourceType, surface: "post" })
          .metrics[0]!.name,
      );
    }
    emitted.add(
      provenanceMetric({
        kind: "unrecognised",
        container: "xmp",
        mediaKind: "image",
      }).metrics[0]!.name,
    );
    emitted.add(
      provenanceMetric({
        kind: "discarded",
        reason: "no-persistence-port",
        mediaKind: "timed-media",
      }).metrics[0]!.name,
    );
    emitted.add(
      provenanceMetric({ kind: "read-failed", mediaKind: "image" }).metrics[0]!
        .name,
    );
    emitted.add(
      provenanceMetric({ kind: "corrected", reduced: true }).metrics[0]!.name,
    );

    expect([...emitted].sort()).toEqual(
      [...new Set(Object.values(PROVENANCE_METRICS))].sort(),
    );
  });

  it("NEVER puts an identifier in a dimension", () => {
    // The load-bearing privacy property. A per-tenant or per-user AI-content
    // counter would turn an Art. 50 disclosure mechanism into a derived dataset
    // about which organisations post AI content — and metric dimensions are not
    // access-controlled the way the audit log is. Dimensions stay categorical.
    const forbidden = [
      "tenantId",
      "tenant",
      "userId",
      "user",
      "mediaId",
      "postId",
      "commentId",
      "authorId",
      "ip",
      "ipAddress",
      "userAgent",
      "email",
    ];
    fc.assert(
      fc.property(events(), (event) => {
        const keys = Object.keys(provenanceMetric(event).dimensions);
        for (const key of keys) {
          expect(forbidden).not.toContain(key);
          // Belt and braces against a renamed-but-still-identifying dimension.
          expect(key.toLowerCase()).not.toMatch(/id$|email|ip|agent/);
        }
      }),
    );
  });

  it("all dimension values are strings (the port's contract)", () => {
    fc.assert(
      fc.property(events(), (event) => {
        for (const value of Object.values(provenanceMetric(event).dimensions)) {
          expect(typeof value).toBe("string");
        }
      }),
    );
  });

  it("distinguishes a reducing correction from a raising one", () => {
    // `reduced=true` removes a published disclosure and is the one worth paging
    // on, so it must be visible in the dimensions rather than collapsed.
    expect(
      provenanceMetric({ kind: "corrected", reduced: true }).dimensions.reduced,
    ).toBe("true");
    expect(
      provenanceMetric({ kind: "corrected", reduced: false }).dimensions.reduced,
    ).toBe("false");
  });

  it("carries no threshold values — those are runtime config, not compiled", () => {
    // CLAUDE.md rule 8: the npm tarball is public, so a compiled threshold is a
    // published threshold. An emission must contain names, categorical dimensions
    // and the count — and no other number, which is what an alert trigger value
    // leaking into this module would look like.
    fc.assert(
      fc.property(events(), (event) => {
        const { dimensions, metrics } = provenanceMetric(event);
        // The only numeric value anywhere is the count itself.
        expect(metrics.map((m) => m.value)).toEqual([1]);
        for (const value of Object.values(dimensions)) {
          expect(value).not.toMatch(/^\d+$/);
        }
      }),
    );
  });
});
