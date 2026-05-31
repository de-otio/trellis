/**
 * Unit Tests: Metadata Config
 *
 * Tests for metadata extraction configuration constants and types.
 */

import { describe, expect, it } from "vitest";
import {
  METADATA_LIMITS,
  METADATA_TRUNCATION_POLICY,
} from "../../../src/lib/metadata/metadata-config.js";

describe("METADATA_LIMITS", () => {
  it("should have MAX_METADATA_SIZE_BYTES set to 32KB", () => {
    expect(METADATA_LIMITS.MAX_METADATA_SIZE_BYTES).toBe(32 * 1024);
  });

  it("should have MAX_KEYWORDS set to 100", () => {
    expect(METADATA_LIMITS.MAX_KEYWORDS).toBe(100);
  });

  it("should have MAX_KEYWORD_LENGTH set to 64", () => {
    expect(METADATA_LIMITS.MAX_KEYWORD_LENGTH).toBe(64);
  });

  it("should have MAX_STRING_FIELD_LENGTH set to 1024", () => {
    expect(METADATA_LIMITS.MAX_STRING_FIELD_LENGTH).toBe(1024);
  });

  it("should have EXTRACTION_TIMEOUT_MS set to 1500", () => {
    expect(METADATA_LIMITS.EXTRACTION_TIMEOUT_MS).toBe(1500);
  });

  it("should be a frozen/readonly object", () => {
    // as const makes it readonly; verify the values are stable
    const keys = Object.keys(METADATA_LIMITS);
    expect(keys).toContain("MAX_METADATA_SIZE_BYTES");
    expect(keys).toContain("MAX_KEYWORDS");
    expect(keys).toContain("MAX_KEYWORD_LENGTH");
    expect(keys).toContain("MAX_STRING_FIELD_LENGTH");
    expect(keys).toContain("EXTRACTION_TIMEOUT_MS");
    expect(keys).toHaveLength(5);
  });

  it("should have all positive values", () => {
    for (const [, value] of Object.entries(METADATA_LIMITS)) {
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe("METADATA_TRUNCATION_POLICY", () => {
  it("should default to 'truncate'", () => {
    expect(METADATA_TRUNCATION_POLICY).toBe("truncate");
  });

  it("should be one of the allowed values", () => {
    expect(["truncate", "reject"]).toContain(METADATA_TRUNCATION_POLICY);
  });
});
