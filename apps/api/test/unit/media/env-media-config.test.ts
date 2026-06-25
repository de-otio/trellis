/**
 * T4 — Env.media config block: parse + default behaviour tests.
 *
 * Verifies:
 *   - Conservative defaults are used when env vars are absent.
 *   - Valid env overrides are parsed and returned.
 *   - Out-of-range threshold entries are rejected (fail-closed).
 *   - Absence of a threshold entry ⇒ empty record (caller treats as "review").
 *   - Malformed JSON input yields empty / fallback values (fail-closed).
 *
 * Uses fast-check (seeded) for property coverage of the threshold parser.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  resolveMediaEnv,
  parseMediaThresholds,
} from "../../../src/env.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MEDIA_ENV_KEYS = [
  "MEDIA_MAX_BYTES_IMAGE",
  "MEDIA_MAX_BYTES_VIDEO",
  "MEDIA_MAX_BYTES_AUDIO",
  "MEDIA_MAX_PIXELS",
  "MEDIA_RATE_UPLOAD_PER_MIN",
  "MEDIA_RATE_BATCH_PER_MIN",
  "MEDIA_RATE_SERVE_PER_MIN",
  "MEDIA_ALLOWLIST_IMAGE_JSON",
  "MEDIA_ALLOWLIST_VIDEO_JSON",
  "MEDIA_ALLOWLIST_AUDIO_JSON",
  "MEDIA_PRESETS_JSON",
  "MEDIA_THRESHOLDS_JSON",
  "MEDIA_CANONICAL_FORMAT",
  "MEDIA_CANONICAL_QUALITY",
] as const;

function clearMediaEnv(): void {
  for (const key of MEDIA_ENV_KEYS) {
    delete process.env[key];
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("resolveMediaEnv — defaults", () => {
  beforeEach(clearMediaEnv);
  afterEach(clearMediaEnv);

  it("returns a media block with all required keys when no env vars are set", () => {
    const { media } = resolveMediaEnv();

    expect(media).toMatchObject({
      maxBytes: expect.objectContaining({
        image: expect.any(Number),
        video: expect.any(Number),
        audio: expect.any(Number),
      }),
      maxPixels: expect.any(Number),
      rateLimits: expect.objectContaining({
        uploadPerMin: expect.any(Number),
        batchPerMin: expect.any(Number),
        servePerMin: expect.any(Number),
      }),
      allowlist: expect.objectContaining({
        image: expect.any(Array),
        video: expect.any(Array),
        audio: expect.any(Array),
      }),
      presets: expect.any(Array),
      thresholds: expect.any(Object),
    });
  });

  it("default maxBytes.image is positive", () => {
    const { media } = resolveMediaEnv();
    expect(media.maxBytes.image).toBeGreaterThan(0);
  });

  it("default maxBytes.video is positive", () => {
    const { media } = resolveMediaEnv();
    expect(media.maxBytes.video).toBeGreaterThan(0);
  });

  it("default maxPixels is positive", () => {
    const { media } = resolveMediaEnv();
    expect(media.maxPixels).toBeGreaterThan(0);
  });

  it("default rateLimits.uploadPerMin is positive", () => {
    const { media } = resolveMediaEnv();
    expect(media.rateLimits.uploadPerMin).toBeGreaterThan(0);
  });

  it("default thresholds is empty — absence ⇒ fail-closed (caller treats as review)", () => {
    const { media } = resolveMediaEnv();
    expect(Object.keys(media.thresholds)).toHaveLength(0);
  });

  it("default presets is empty (no derivatives in P0a)", () => {
    const { media } = resolveMediaEnv();
    expect(media.presets).toHaveLength(0);
  });

  it("default image allowlist is non-empty and contains only strings", () => {
    const { media } = resolveMediaEnv();
    expect(media.allowlist.image.length).toBeGreaterThan(0);
    for (const mime of media.allowlist.image) {
      expect(typeof mime).toBe("string");
    }
  });
});

describe("resolveMediaEnv — env overrides", () => {
  beforeEach(clearMediaEnv);
  afterEach(clearMediaEnv);

  it("parses MEDIA_MAX_BYTES_IMAGE from env", () => {
    process.env.MEDIA_MAX_BYTES_IMAGE = "5242880"; // 5 MiB
    const { media } = resolveMediaEnv();
    expect(media.maxBytes.image).toBe(5_242_880);
  });

  it("parses MEDIA_MAX_BYTES_VIDEO from env", () => {
    process.env.MEDIA_MAX_BYTES_VIDEO = "209715200"; // 200 MiB
    const { media } = resolveMediaEnv();
    expect(media.maxBytes.video).toBe(209_715_200);
  });

  it("parses MEDIA_MAX_BYTES_AUDIO from env", () => {
    process.env.MEDIA_MAX_BYTES_AUDIO = "52428800"; // 50 MiB
    const { media } = resolveMediaEnv();
    expect(media.maxBytes.audio).toBe(52_428_800);
  });

  it("parses MEDIA_MAX_PIXELS from env", () => {
    process.env.MEDIA_MAX_PIXELS = "16000000"; // 16 MP
    const { media } = resolveMediaEnv();
    expect(media.maxPixels).toBe(16_000_000);
  });

  it("parses MEDIA_RATE_UPLOAD_PER_MIN from env", () => {
    process.env.MEDIA_RATE_UPLOAD_PER_MIN = "30";
    const { media } = resolveMediaEnv();
    expect(media.rateLimits.uploadPerMin).toBe(30);
  });

  it("parses MEDIA_RATE_BATCH_PER_MIN from env", () => {
    process.env.MEDIA_RATE_BATCH_PER_MIN = "15";
    const { media } = resolveMediaEnv();
    expect(media.rateLimits.batchPerMin).toBe(15);
  });

  it("parses MEDIA_RATE_SERVE_PER_MIN from env", () => {
    process.env.MEDIA_RATE_SERVE_PER_MIN = "120";
    const { media } = resolveMediaEnv();
    expect(media.rateLimits.servePerMin).toBe(120);
  });

  it("parses MEDIA_ALLOWLIST_IMAGE_JSON from env", () => {
    process.env.MEDIA_ALLOWLIST_IMAGE_JSON = '["image/jpeg","image/png"]';
    const { media } = resolveMediaEnv();
    expect(media.allowlist.image).toEqual(["image/jpeg", "image/png"]);
  });

  it("parses MEDIA_ALLOWLIST_VIDEO_JSON from env", () => {
    process.env.MEDIA_ALLOWLIST_VIDEO_JSON = '["video/mp4","video/webm"]';
    const { media } = resolveMediaEnv();
    expect(media.allowlist.video).toEqual(["video/mp4", "video/webm"]);
  });

  it("parses MEDIA_ALLOWLIST_AUDIO_JSON from env", () => {
    process.env.MEDIA_ALLOWLIST_AUDIO_JSON = '["audio/mpeg"]';
    const { media } = resolveMediaEnv();
    expect(media.allowlist.audio).toEqual(["audio/mpeg"]);
  });

  it("parses MEDIA_PRESETS_JSON from env", () => {
    process.env.MEDIA_PRESETS_JSON = '["thumb","preview"]';
    const { media } = resolveMediaEnv();
    expect(media.presets).toEqual(["thumb", "preview"]);
  });

  it("parses valid MEDIA_THRESHOLDS_JSON from env", () => {
    process.env.MEDIA_THRESHOLDS_JSON = JSON.stringify({
      category_a: { review: 0.7, quarantine: 0.9 },
    });
    const { media } = resolveMediaEnv();
    expect(media.thresholds["category_a"]).toEqual({
      review: 0.7,
      quarantine: 0.9,
    });
  });
});

describe("resolveMediaEnv — canonicalFormat", () => {
  beforeEach(clearMediaEnv);
  afterEach(clearMediaEnv);

  it("defaults to jpeg when MEDIA_CANONICAL_FORMAT is unset", () => {
    const { media } = resolveMediaEnv();
    expect(media.canonicalFormat).toBe("jpeg");
  });

  it("accepts MEDIA_CANONICAL_FORMAT=png", () => {
    process.env.MEDIA_CANONICAL_FORMAT = "png";
    const { media } = resolveMediaEnv();
    expect(media.canonicalFormat).toBe("png");
  });

  it("accepts MEDIA_CANONICAL_FORMAT=webp", () => {
    process.env.MEDIA_CANONICAL_FORMAT = "webp";
    const { media } = resolveMediaEnv();
    expect(media.canonicalFormat).toBe("webp");
  });

  it("falls back to jpeg for an unsupported MEDIA_CANONICAL_FORMAT value", () => {
    // gif/avif/etc. are not in the canonical-output whitelist → jpeg.
    process.env.MEDIA_CANONICAL_FORMAT = "gif";
    const { media } = resolveMediaEnv();
    expect(media.canonicalFormat).toBe("jpeg");
  });
});

describe("resolveMediaEnv — canonicalQuality", () => {
  beforeEach(clearMediaEnv);
  afterEach(clearMediaEnv);

  it("defaults to a sane quality when MEDIA_CANONICAL_QUALITY is unset", () => {
    const { media } = resolveMediaEnv();
    expect(media.canonicalQuality).toBe(85);
  });

  it("parses a valid in-range MEDIA_CANONICAL_QUALITY", () => {
    process.env.MEDIA_CANONICAL_QUALITY = "70";
    const { media } = resolveMediaEnv();
    expect(media.canonicalQuality).toBe(70);
  });

  it("accepts the boundary value 1", () => {
    process.env.MEDIA_CANONICAL_QUALITY = "1";
    const { media } = resolveMediaEnv();
    expect(media.canonicalQuality).toBe(1);
  });

  it("accepts the boundary value 100", () => {
    process.env.MEDIA_CANONICAL_QUALITY = "100";
    const { media } = resolveMediaEnv();
    expect(media.canonicalQuality).toBe(100);
  });

  it("falls back to default when MEDIA_CANONICAL_QUALITY is below 1", () => {
    process.env.MEDIA_CANONICAL_QUALITY = "0";
    const { media } = resolveMediaEnv();
    expect(media.canonicalQuality).toBe(85);
  });

  it("falls back to default when MEDIA_CANONICAL_QUALITY is above 100", () => {
    process.env.MEDIA_CANONICAL_QUALITY = "101";
    const { media } = resolveMediaEnv();
    expect(media.canonicalQuality).toBe(85);
  });

  it("falls back to default when MEDIA_CANONICAL_QUALITY is not a number", () => {
    process.env.MEDIA_CANONICAL_QUALITY = "high";
    const { media } = resolveMediaEnv();
    expect(media.canonicalQuality).toBe(85);
  });
});

describe("resolveMediaEnv — fail-closed on invalid input", () => {
  beforeEach(clearMediaEnv);
  afterEach(clearMediaEnv);

  it("falls back to default when MEDIA_MAX_BYTES_IMAGE is not a number", () => {
    process.env.MEDIA_MAX_BYTES_IMAGE = "not-a-number";
    const { media } = resolveMediaEnv();
    expect(media.maxBytes.image).toBeGreaterThan(0); // uses dev default
  });

  it("falls back to default when MEDIA_MAX_BYTES_IMAGE is zero", () => {
    process.env.MEDIA_MAX_BYTES_IMAGE = "0";
    const { media } = resolveMediaEnv();
    expect(media.maxBytes.image).toBeGreaterThan(0);
  });

  it("falls back to default when MEDIA_MAX_BYTES_IMAGE is negative", () => {
    process.env.MEDIA_MAX_BYTES_IMAGE = "-1";
    const { media } = resolveMediaEnv();
    expect(media.maxBytes.image).toBeGreaterThan(0);
  });

  it("falls back to default allowlist when MEDIA_ALLOWLIST_IMAGE_JSON is malformed JSON", () => {
    process.env.MEDIA_ALLOWLIST_IMAGE_JSON = "not-json";
    const { media } = resolveMediaEnv();
    expect(media.allowlist.image.length).toBeGreaterThan(0);
  });

  it("falls back to default allowlist when MEDIA_ALLOWLIST_IMAGE_JSON is a JSON object (not array)", () => {
    process.env.MEDIA_ALLOWLIST_IMAGE_JSON = '{"type":"image/jpeg"}';
    const { media } = resolveMediaEnv();
    expect(media.allowlist.image.length).toBeGreaterThan(0);
  });

  it("falls back to empty presets when MEDIA_PRESETS_JSON is malformed", () => {
    process.env.MEDIA_PRESETS_JSON = "invalid";
    const { media } = resolveMediaEnv();
    expect(media.presets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseMediaThresholds — unit + property tests
// ---------------------------------------------------------------------------

describe("parseMediaThresholds — defaults and examples", () => {
  it("returns empty record when raw is undefined", () => {
    expect(parseMediaThresholds(undefined)).toEqual({});
  });

  it("returns empty record when raw is empty string", () => {
    expect(parseMediaThresholds("")).toEqual({});
  });

  it("returns empty record when raw is not JSON", () => {
    expect(parseMediaThresholds("not-json")).toEqual({});
  });

  it("returns empty record when raw is a JSON array (not object)", () => {
    expect(parseMediaThresholds("[1,2,3]")).toEqual({});
  });

  it("returns empty record when raw is JSON null", () => {
    expect(parseMediaThresholds("null")).toEqual({});
  });

  it("accepts an entry with valid in-range values", () => {
    const result = parseMediaThresholds(
      JSON.stringify({ category_a: { review: 0.6, quarantine: 0.85 } }),
    );
    expect(result["category_a"]).toEqual({ review: 0.6, quarantine: 0.85 });
  });

  it("accepts boundary values: 0 and 1", () => {
    const result = parseMediaThresholds(
      JSON.stringify({ boundary: { review: 0, quarantine: 1 } }),
    );
    expect(result["boundary"]).toEqual({ review: 0, quarantine: 1 });
  });

  it("drops an entry whose review value is above 1", () => {
    const result = parseMediaThresholds(
      JSON.stringify({ bad: { review: 1.1, quarantine: 0.9 } }),
    );
    expect(result["bad"]).toBeUndefined();
  });

  it("drops an entry whose quarantine value is above 1", () => {
    const result = parseMediaThresholds(
      JSON.stringify({ bad: { review: 0.7, quarantine: 1.01 } }),
    );
    expect(result["bad"]).toBeUndefined();
  });

  it("drops an entry whose review value is below 0", () => {
    const result = parseMediaThresholds(
      JSON.stringify({ bad: { review: -0.1, quarantine: 0.9 } }),
    );
    expect(result["bad"]).toBeUndefined();
  });

  it("drops an entry whose review field is not a number", () => {
    const result = parseMediaThresholds(
      JSON.stringify({ bad: { review: "high", quarantine: 0.9 } }),
    );
    expect(result["bad"]).toBeUndefined();
  });

  it("drops an entry that is missing the quarantine field", () => {
    const result = parseMediaThresholds(
      JSON.stringify({ bad: { review: 0.7 } }),
    );
    expect(result["bad"]).toBeUndefined();
  });

  it("keeps valid entries and drops invalid entries from the same object", () => {
    const result = parseMediaThresholds(
      JSON.stringify({
        good: { review: 0.6, quarantine: 0.85 },
        bad: { review: 2.0, quarantine: 0.9 },
      }),
    );
    expect(result["good"]).toEqual({ review: 0.6, quarantine: 0.85 });
    expect(result["bad"]).toBeUndefined();
  });
});

describe("parseMediaThresholds — property tests (fast-check, seeded)", () => {
  /**
   * Property: any threshold pair with review or quarantine outside [0, 1] is
   * rejected — the gate remains fail-closed regardless of attacker-controlled
   * input in the env var.
   *
   * fc.double with noNaN + noDefaultInfinity keeps values representable in JSON
   * (JSON.stringify(NaN/Infinity) ⇒ "null", which would be a different code path).
   */
  it("rejects all entries with out-of-range values (property, seeded)", () => {
    const aboveOne = fc.double({
      min: Math.fround(1.0001),
      max: 1e6,
      noNaN: true,
      noDefaultInfinity: true,
    });
    const belowZero = fc.double({
      min: -1e6,
      max: Math.fround(-0.0001),
      noNaN: true,
      noDefaultInfinity: true,
    });
    const outOfRange = fc.oneof(aboveOne, belowZero);

    // A valid quarantine companion so we can isolate the bad review value.
    const validQuarantine = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }), // category key
        outOfRange,       // bad review value
        validQuarantine,  // quarantine value (valid — isolates the review check)
        (category, badReview, quarantine) => {
          const raw = JSON.stringify({ [category]: { review: badReview, quarantine } });
          const result = parseMediaThresholds(raw);
          // The entry must be absent — out-of-range review ⇒ fail-closed
          return result[category] === undefined;
        },
      ),
      { seed: 20260624, numRuns: 200 },
    );
  });

  it("accepts all entries with in-range values (property, seeded)", () => {
    // noNaN + noDefaultInfinity: JSON.stringify(NaN) → "null" (a different path);
    // limit to finite representable values within [0,1] for a clean round-trip.
    const inRange = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }), // category key
        inRange,  // review
        inRange,  // quarantine
        (category, review, quarantine) => {
          const raw = JSON.stringify({ [category]: { review, quarantine } });
          const result = parseMediaThresholds(raw);
          // The entry must be present and values must match
          if (result[category] === undefined) return false;
          return (
            result[category].review === review &&
            result[category].quarantine === quarantine
          );
        },
      ),
      { seed: 20260624, numRuns: 200 },
    );
  });

  /**
   * Property: parsing is deterministic — calling parseMediaThresholds twice with
   * the same input always produces the same result.
   */
  it("parse is deterministic for any input string (property, seeded)", () => {
    fc.assert(
      fc.property(
        fc.string(), // arbitrary raw input — could be anything
        (raw) => {
          const a = parseMediaThresholds(raw);
          const b = parseMediaThresholds(raw);
          return JSON.stringify(a) === JSON.stringify(b);
        },
      ),
      { seed: 20260624, numRuns: 500 },
    );
  });

  /**
   * Property: a JSON object whose top-level values are all non-objects (strings,
   * numbers, arrays, null) yields an empty record — no type coercion opens a gate.
   */
  it("non-object threshold values always yield empty record (property, seeded)", () => {
    const nonObjectValue = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.float({ min: 0, max: 1 })),
    );

    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }),
        nonObjectValue,
        (category, badValue) => {
          const raw = JSON.stringify({ [category]: badValue });
          const result = parseMediaThresholds(raw);
          return result[category] === undefined;
        },
      ),
      { seed: 20260624, numRuns: 300 },
    );
  });
});
