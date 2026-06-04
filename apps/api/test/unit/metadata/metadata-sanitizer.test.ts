/**
 * Unit Tests: Metadata Sanitizer
 *
 * Tests for metadata sanitization functions used to validate and clean
 * image metadata before storage.
 */

import { describe, expect, it } from "vitest";
import {
  sanitizeString,
  validateGPS,
  validateKeywords,
  validateDate,
  validateMetadataSize,
} from "../../../src/lib/metadata/metadata-sanitizer.js";
import { METADATA_LIMITS } from "../../../src/lib/metadata/metadata-config.js";
import { MetadataValidationError } from "../../../src/lib/metadata/metadata-errors.js";

describe("sanitizeString", () => {
  it("should trim whitespace", () => {
    expect(sanitizeString("  hello  ")).toBe("hello");
  });

  it("should remove NUL characters", () => {
    expect(sanitizeString("hel\u0000lo")).toBe("hello");
  });

  it("should remove control characters", () => {
    expect(sanitizeString("hel\u0001lo\u001Fworld")).toBe("helloworld");
  });

  it("should preserve common whitespace (newlines, tabs)", () => {
    const result = sanitizeString("hello\tworld\nfoo");
    expect(result).toBe("hello\tworld\nfoo");
  });

  it("should return undefined for non-string input", () => {
    expect(sanitizeString(123)).toBeUndefined();
    expect(sanitizeString(null)).toBeUndefined();
    expect(sanitizeString(undefined)).toBeUndefined();
    expect(sanitizeString(true)).toBeUndefined();
    expect(sanitizeString({})).toBeUndefined();
  });

  it("should return undefined for empty string", () => {
    expect(sanitizeString("")).toBeUndefined();
  });

  it("should return undefined for string that becomes empty after cleaning", () => {
    expect(sanitizeString("   ")).toBeUndefined();
    expect(sanitizeString("\u0000\u0001")).toBeUndefined();
  });

  it("should truncate at MAX_STRING_FIELD_LENGTH", () => {
    const long = "a".repeat(METADATA_LIMITS.MAX_STRING_FIELD_LENGTH + 100);
    const result = sanitizeString(long);
    expect(result).toBeDefined();
    expect(result!.length).toBe(METADATA_LIMITS.MAX_STRING_FIELD_LENGTH);
  });

  it("should return string as-is when within length limit", () => {
    const exact = "a".repeat(METADATA_LIMITS.MAX_STRING_FIELD_LENGTH);
    expect(sanitizeString(exact)).toBe(exact);
  });
});

describe("validateGPS", () => {
  it("should accept valid lat/lng within range", () => {
    const result = validateGPS(45.5, -73.6);
    expect(result).toEqual({ latitude: 45.5, longitude: -73.6 });
  });

  it("should accept boundary values", () => {
    expect(validateGPS(90, 180)).toEqual({ latitude: 90, longitude: 180 });
    expect(validateGPS(-90, -180)).toEqual({ latitude: -90, longitude: -180 });
    expect(validateGPS(0, 0)).toEqual({ latitude: 0, longitude: 0 });
  });

  it("should reject latitude > 90", () => {
    expect(validateGPS(91, 0)).toBeUndefined();
  });

  it("should reject latitude < -90", () => {
    expect(validateGPS(-91, 0)).toBeUndefined();
  });

  it("should reject longitude > 180", () => {
    expect(validateGPS(0, 181)).toBeUndefined();
  });

  it("should reject longitude < -180", () => {
    expect(validateGPS(0, -181)).toBeUndefined();
  });

  it("should reject non-numeric inputs", () => {
    expect(validateGPS("45", "-73")).toBeUndefined();
    expect(validateGPS(true, false)).toBeUndefined();
    expect(validateGPS({}, [])).toBeUndefined();
  });

  it("should reject NaN values", () => {
    expect(validateGPS(NaN, 0)).toBeUndefined();
    expect(validateGPS(0, NaN)).toBeUndefined();
    expect(validateGPS(NaN, NaN)).toBeUndefined();
  });

  it("should reject Infinity values", () => {
    expect(validateGPS(Infinity, 0)).toBeUndefined();
    expect(validateGPS(0, -Infinity)).toBeUndefined();
    expect(validateGPS(Infinity, Infinity)).toBeUndefined();
  });

  it("should return undefined when lat or lng is null/undefined", () => {
    expect(validateGPS(null, 0)).toBeUndefined();
    expect(validateGPS(0, undefined)).toBeUndefined();
    expect(validateGPS(null, null)).toBeUndefined();
  });
});

describe("validateKeywords", () => {
  it("should accept valid keyword array", () => {
    const result = validateKeywords(["dog", "puppy", "golden"]);
    expect(result).toEqual(["dog", "puppy", "golden"]);
  });

  it("should sanitize individual keywords", () => {
    const result = validateKeywords(["  hello  ", "wor\u0000ld"]);
    expect(result).toEqual(["hello", "world"]);
  });

  it("should enforce MAX_KEYWORDS limit", () => {
    const many = Array.from({ length: 200 }, (_, i) => `keyword${i}`);
    const result = validateKeywords(many);
    expect(result).toBeDefined();
    expect(result!.length).toBe(METADATA_LIMITS.MAX_KEYWORDS);
  });

  it("should enforce MAX_KEYWORD_LENGTH per keyword", () => {
    const longKeyword = "a".repeat(METADATA_LIMITS.MAX_KEYWORD_LENGTH + 50);
    const result = validateKeywords([longKeyword]);
    expect(result).toBeDefined();
    expect(result![0].length).toBe(METADATA_LIMITS.MAX_KEYWORD_LENGTH);
  });

  it("should return undefined for non-array input", () => {
    expect(validateKeywords("not an array")).toBeUndefined();
    expect(validateKeywords(123)).toBeUndefined();
    expect(validateKeywords({})).toBeUndefined();
    expect(validateKeywords(null)).toBeUndefined();
  });

  it("should return undefined for empty array", () => {
    expect(validateKeywords([])).toBeUndefined();
  });

  it("should filter out empty keywords after sanitization", () => {
    const result = validateKeywords(["\u0000", "  ", "valid", ""]);
    expect(result).toEqual(["valid"]);
  });

  it("should return undefined when all keywords become empty", () => {
    expect(validateKeywords(["\u0000", "  ", ""])).toBeUndefined();
  });
});

describe("validateDate", () => {
  it("should accept ISO date string", () => {
    const result = validateDate("2024-06-15T12:00:00.000Z");
    expect(result).toBe("2024-06-15T12:00:00.000Z");
  });

  it("should accept Date object", () => {
    const d = new Date("2024-06-15T12:00:00.000Z");
    const result = validateDate(d);
    expect(result).toBe("2024-06-15T12:00:00.000Z");
  });

  it("should accept 13-digit epoch milliseconds", () => {
    const ms = new Date("2024-06-15T12:00:00.000Z").getTime(); // 13-digit
    const result = validateDate(ms);
    expect(result).toBe("2024-06-15T12:00:00.000Z");
  });

  it("should accept 10-digit epoch seconds", () => {
    const secs = Math.floor(
      new Date("2024-06-15T12:00:00.000Z").getTime() / 1000,
    ); // 10-digit
    const result = validateDate(secs);
    expect(result).toBe("2024-06-15T12:00:00.000Z");
  });

  it("should reject date before 1900", () => {
    const result = validateDate("1899-12-31T00:00:00.000Z");
    expect(result).toBeUndefined();
  });

  it("should reject date > 365 days in future", () => {
    const farFuture = new Date(
      Date.now() + 400 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = validateDate(farFuture);
    expect(result).toBeUndefined();
  });

  it("should accept date within 365 days in future", () => {
    const nearFuture = new Date(
      Date.now() + 100 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = validateDate(nearFuture);
    expect(result).toBeDefined();
  });

  it("should return undefined for non-date input", () => {
    expect(validateDate("not a date")).toBeUndefined();
    expect(validateDate(true)).toBeUndefined();
    expect(validateDate(null)).toBeUndefined();
    expect(validateDate(undefined)).toBeUndefined();
    expect(validateDate({})).toBeUndefined();
    expect(validateDate([])).toBeUndefined();
  });

  it("should return ISO string format", () => {
    const result = validateDate("2024-06-15");
    expect(result).toBeDefined();
    // ISO format ends with Z and contains T
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });

  it("should reject NaN numeric input", () => {
    expect(validateDate(NaN)).toBeUndefined();
  });

  it("should reject Infinity numeric input", () => {
    expect(validateDate(Infinity)).toBeUndefined();
  });
});

describe("validateMetadataSize", () => {
  it("should pass for small metadata objects", () => {
    const small = { title: "Hello", description: "World" };
    expect(() => validateMetadataSize(small)).not.toThrow();
  });

  it("should pass for null/undefined", () => {
    expect(() => validateMetadataSize(null)).not.toThrow();
    expect(() => validateMetadataSize(undefined)).not.toThrow();
  });

  it("should throw MetadataValidationError for oversized metadata", () => {
    // Create an object larger than MAX_METADATA_SIZE_BYTES (32KB)
    const huge = { data: "x".repeat(METADATA_LIMITS.MAX_METADATA_SIZE_BYTES + 1000) };
    expect(() => validateMetadataSize(huge)).toThrow(MetadataValidationError);
  });

  it("should include size info in the error", () => {
    const huge = { data: "x".repeat(METADATA_LIMITS.MAX_METADATA_SIZE_BYTES + 1000) };
    try {
      validateMetadataSize(huge);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MetadataValidationError);
      const err = e as MetadataValidationError;
      expect(err.message).toContain("exceeds maximum size");
      expect((err.issues as any).maxBytes).toBe(
        METADATA_LIMITS.MAX_METADATA_SIZE_BYTES,
      );
    }
  });

  it("should pass for object just under the size limit", () => {
    // Create an object that serializes to just under the limit
    const justUnder = {
      data: "x".repeat(METADATA_LIMITS.MAX_METADATA_SIZE_BYTES - 20),
    };
    expect(() => validateMetadataSize(justUnder)).not.toThrow();
  });
});
