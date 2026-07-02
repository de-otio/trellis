import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  deriveDedupeKey,
  type DedupeKeyInput,
} from "../../../src/lib/media/dedupe-key.js";
import type { Track } from "../../../src/lib/media/track-verdict.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const trackArb: fc.Arbitrary<Track> = fc.constantFrom("VISUAL", "AUDIO");

// A realistic contentHash: 64 lowercase hex chars (SHA-256).
const contentHashArb: fc.Arbitrary<string> = fc
  .string({
    unit: fc.constantFrom(...("0123456789abcdef".split(""))),
    minLength: 64,
    maxLength: 64,
  })
  .map((s) => s.toLowerCase());

// jobId is provider-controlled — can be any non-empty string including
// delimiter characters, whitespace, Unicode, and embedded length patterns.
const jobIdArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 200 });

// Adversarial jobId values that would fool a naive delimiter join.
// E.g. a jobId containing "|" or ":" or a string that looks like
// a length prefix itself.
const adversarialJobIdArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant("|"),
  fc.constant(":"),
  fc.constant("a|b|c"),
  fc.constant("3:abc"),
  fc.constant("0:|0:"),
  fc.constant("1:a|1:b"),
  // A jobId that contains the full encoding of another field.
  fc.constant("64:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  // NUL bytes and special chars.
  fc.constant("\x00"),
  fc.constant("a\x00b"),
  fc.constant("|\x00|"),
  // Embedded length/separator combos.
  fc.constant("5:hello|5:world"),
);

const inputArb: fc.Arbitrary<DedupeKeyInput> = fc.record({
  contentHash: contentHashArb,
  jobId: jobIdArb,
  track: trackArb,
});

// Two inputs that differ in exactly one field (used to assert non-collision).
function differentTrack(input: DedupeKeyInput): DedupeKeyInput {
  return { ...input, track: input.track === "VISUAL" ? "AUDIO" : "VISUAL" };
}

// ---------------------------------------------------------------------------
// Unit tests — determinism and basic shape
// ---------------------------------------------------------------------------

describe("deriveDedupeKey", () => {
  it("returns a 64-character lowercase hex string", () => {
    const key = deriveDedupeKey({
      contentHash: "a".repeat(64),
      jobId: "job-001",
      track: "VISUAL",
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input always yields the same key", () => {
    const input: DedupeKeyInput = {
      contentHash: "b".repeat(64),
      jobId: "my-provider-job-xyz",
      track: "AUDIO",
    };
    expect(deriveDedupeKey(input)).toBe(deriveDedupeKey(input));
  });

  it("differs when track changes", () => {
    const base: DedupeKeyInput = {
      contentHash: "c".repeat(64),
      jobId: "job-abc",
      track: "VISUAL",
    };
    expect(deriveDedupeKey(base)).not.toBe(
      deriveDedupeKey({ ...base, track: "AUDIO" }),
    );
  });

  it("differs when jobId changes", () => {
    const base: DedupeKeyInput = {
      contentHash: "d".repeat(64),
      jobId: "job-001",
      track: "VISUAL",
    };
    expect(deriveDedupeKey(base)).not.toBe(
      deriveDedupeKey({ ...base, jobId: "job-002" }),
    );
  });

  it("differs when contentHash changes", () => {
    const base: DedupeKeyInput = {
      contentHash: "e".repeat(64),
      jobId: "job-001",
      track: "VISUAL",
    };
    expect(deriveDedupeKey(base)).not.toBe(
      deriveDedupeKey({ ...base, contentHash: "f".repeat(64) }),
    );
  });

  // Verify that adversarial delimiter-containing jobIds do not collide with
  // legitimate inputs.
  it("does not collide when jobId contains delimiter chars (|, :)", () => {
    const base: DedupeKeyInput = {
      contentHash: "0".repeat(64),
      jobId: "clean-job",
      track: "VISUAL",
    };
    const adversarial: DedupeKeyInput = {
      // This jobId contains the canonical encoding of the base contentHash+track
      // field boundaries — a naive join could absorb across field edges.
      contentHash: "0".repeat(64),
      jobId: "|" + "0".repeat(64) + "|6:VISUAL",
      track: "VISUAL",
    };
    expect(deriveDedupeKey(base)).not.toBe(deriveDedupeKey(adversarial));
  });

  it("does not collide when jobId contains a colon-prefixed length pattern", () => {
    // jobId = "5:hello" should not collide with jobId = "5" + hash="hello..."
    const a: DedupeKeyInput = {
      contentHash: "a".repeat(64),
      jobId: "5:hello",
      track: "AUDIO",
    };
    // Shift the boundary: different contentHash, jobId crafted to produce same
    // naive join if the encoder is not length-prefixing correctly.
    const b: DedupeKeyInput = {
      contentHash: "a".repeat(63) + "b",
      jobId: ":hello",
      track: "AUDIO",
    };
    expect(deriveDedupeKey(a)).not.toBe(deriveDedupeKey(b));
  });

  it("never returns an empty string", () => {
    expect(
      deriveDedupeKey({ contentHash: "0".repeat(64), jobId: "", track: "VISUAL" }),
    ).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("deriveDedupeKey — properties", () => {
  it("IDEMPOTENCE: f(x) === f(x) for all inputs", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(deriveDedupeKey(input)).toBe(deriveDedupeKey(input));
      }),
    );
  });

  it("OUTPUT SHAPE: always returns a 64-char lowercase hex string", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const key = deriveDedupeKey(input);
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(key).toHaveLength(64);
      }),
    );
  });

  it("TRACK INJECTIVITY: different tracks produce different keys (same contentHash + jobId)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const other = differentTrack(input);
        expect(deriveDedupeKey(input)).not.toBe(deriveDedupeKey(other));
      }),
    );
  });

  it("CONTENT HASH INJECTIVITY: different contentHashes produce different keys (same jobId + track)", () => {
    fc.assert(
      fc.property(
        fc.record({
          contentHash: contentHashArb,
          contentHash2: contentHashArb,
          jobId: jobIdArb,
          track: trackArb,
        }).filter(({ contentHash, contentHash2 }) => contentHash !== contentHash2),
        ({ contentHash, contentHash2, jobId, track }) => {
          const a = deriveDedupeKey({ contentHash, jobId, track });
          const b = deriveDedupeKey({ contentHash: contentHash2, jobId, track });
          expect(a).not.toBe(b);
        },
      ),
    );
  });

  it("JOB ID INJECTIVITY: different jobIds produce different keys (same contentHash + track)", () => {
    fc.assert(
      fc.property(
        fc.record({
          contentHash: contentHashArb,
          jobId: jobIdArb,
          jobId2: jobIdArb,
          track: trackArb,
        }).filter(({ jobId, jobId2 }) => jobId !== jobId2),
        ({ contentHash, jobId, jobId2, track }) => {
          const a = deriveDedupeKey({ contentHash, jobId, track });
          const b = deriveDedupeKey({ contentHash, jobId: jobId2, track });
          expect(a).not.toBe(b);
        },
      ),
    );
  });

  it("ADVERSARIAL JOB ID INJECTIVITY: delimiter-containing jobIds do not collide", () => {
    fc.assert(
      fc.property(
        fc.record({
          contentHash: contentHashArb,
          jobId: adversarialJobIdArb,
          jobId2: adversarialJobIdArb,
          track: trackArb,
        }).filter(({ jobId, jobId2 }) => jobId !== jobId2),
        ({ contentHash, jobId, jobId2, track }) => {
          const a = deriveDedupeKey({ contentHash, jobId, track });
          const b = deriveDedupeKey({ contentHash, jobId: jobId2, track });
          expect(a).not.toBe(b);
        },
      ),
    );
  });

  it("TOTALITY: never throws for any string input", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(() => deriveDedupeKey(input)).not.toThrow();
      }),
    );
  });

  it("FULL INJECTIVITY: any change to any field changes the key", () => {
    // Sample two inputs and assert: if they are not equal, their keys differ.
    fc.assert(
      fc.property(inputArb, inputArb, (a, b) => {
        const sameInput =
          a.contentHash === b.contentHash &&
          a.jobId === b.jobId &&
          a.track === b.track;
        if (!sameInput) {
          expect(deriveDedupeKey(a)).not.toBe(deriveDedupeKey(b));
        } else {
          expect(deriveDedupeKey(a)).toBe(deriveDedupeKey(b));
        }
      }),
    );
  });
});
