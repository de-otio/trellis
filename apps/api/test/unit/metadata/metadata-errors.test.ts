/**
 * Unit Tests: Metadata Errors
 *
 * Tests for custom error classes used in metadata extraction.
 */

import { describe, expect, it } from "vitest";
import {
  MetadataExtractionError,
  MetadataValidationError,
} from "../../../src/lib/metadata/metadata-errors.js";

describe("MetadataExtractionError", () => {
  it("should create an error with code and message", () => {
    const err = new MetadataExtractionError("EXIF failed", {
      code: "extraction_failed",
    });
    expect(err.message).toBe("EXIF failed");
    expect(err.code).toBe("extraction_failed");
    expect(err.name).toBe("MetadataExtractionError");
  });

  it("should accept a cause option", () => {
    const original = new Error("original");
    const err = new MetadataExtractionError("Wrapped", {
      code: "timeout",
      cause: original,
    });
    expect(err.cause).toBe(original);
  });

  it("should be an instance of Error", () => {
    const err = new MetadataExtractionError("test", {
      code: "unsupported_mime",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MetadataExtractionError);
  });

  it("should support all error codes", () => {
    const codes = [
      "timeout",
      "unsupported_mime",
      "extraction_failed",
      "validation_failed",
      "size_exceeded",
    ] as const;

    for (const code of codes) {
      const err = new MetadataExtractionError(`Error: ${code}`, { code });
      expect(err.code).toBe(code);
    }
  });

  it("should have cause as undefined when not provided", () => {
    const err = new MetadataExtractionError("no cause", {
      code: "extraction_failed",
    });
    expect(err.cause).toBeUndefined();
  });
});

describe("MetadataValidationError", () => {
  it("should create an error with default code", () => {
    const err = new MetadataValidationError("Invalid data", {});
    expect(err.message).toBe("Invalid data");
    expect(err.code).toBe("validation_failed");
    expect(err.name).toBe("MetadataValidationError");
  });

  it("should accept a custom code", () => {
    const err = new MetadataValidationError("Too big", {
      code: "size_exceeded",
    });
    expect(err.code).toBe("size_exceeded");
  });

  it("should accept issues option", () => {
    const issues = { fieldErrors: { make: ["too long"] } };
    const err = new MetadataValidationError("Validation failed", { issues });
    expect(err.issues).toEqual(issues);
  });

  it("should be an instance of Error", () => {
    const err = new MetadataValidationError("test", {});
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MetadataValidationError);
  });

  it("should have issues as undefined when not provided", () => {
    const err = new MetadataValidationError("no issues", {});
    expect(err.issues).toBeUndefined();
  });

  it("should serialize issues correctly for complex objects", () => {
    const issues = {
      bytes: 50000,
      maxBytes: 32768,
      nested: { field: "value" },
    };
    const err = new MetadataValidationError("Size exceeded", { issues });
    expect(err.issues).toEqual(issues);
    expect((err.issues as any).bytes).toBe(50000);
  });
});
