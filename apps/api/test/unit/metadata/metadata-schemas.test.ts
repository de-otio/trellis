/**
 * Unit Tests: Metadata Schemas
 *
 * Tests for Zod schemas that validate EXIF, IPTC, video metadata,
 * and metadata visibility settings.
 */

import { describe, expect, it } from "vitest";
import {
  GPSCoordsSchema,
  EXIFDataSchema,
  IPTCDataSchema,
  VideoMetadataSchema,
  MetadataVisibilitySchema,
} from "../../../src/lib/metadata/metadata-schemas.js";

describe("GPSCoordsSchema", () => {
  it("should accept valid coordinates", () => {
    const result = GPSCoordsSchema.safeParse({ latitude: 45.5, longitude: -73.6 });
    expect(result.success).toBe(true);
  });

  it("should accept boundary values", () => {
    expect(GPSCoordsSchema.safeParse({ latitude: 90, longitude: 180 }).success).toBe(true);
    expect(GPSCoordsSchema.safeParse({ latitude: -90, longitude: -180 }).success).toBe(true);
    expect(GPSCoordsSchema.safeParse({ latitude: 0, longitude: 0 }).success).toBe(true);
  });

  it("should reject latitude out of range", () => {
    expect(GPSCoordsSchema.safeParse({ latitude: 91, longitude: 0 }).success).toBe(false);
    expect(GPSCoordsSchema.safeParse({ latitude: -91, longitude: 0 }).success).toBe(false);
  });

  it("should reject longitude out of range", () => {
    expect(GPSCoordsSchema.safeParse({ latitude: 0, longitude: 181 }).success).toBe(false);
    expect(GPSCoordsSchema.safeParse({ latitude: 0, longitude: -181 }).success).toBe(false);
  });

  it("should reject NaN values", () => {
    expect(GPSCoordsSchema.safeParse({ latitude: NaN, longitude: 0 }).success).toBe(false);
  });

  it("should reject Infinity values", () => {
    expect(GPSCoordsSchema.safeParse({ latitude: Infinity, longitude: 0 }).success).toBe(false);
  });

  it("should reject extra properties (strict mode)", () => {
    const result = GPSCoordsSchema.safeParse({
      latitude: 45,
      longitude: -73,
      altitude: 100,
    });
    expect(result.success).toBe(false);
  });
});

describe("EXIFDataSchema", () => {
  it("should accept valid EXIF data", () => {
    const result = EXIFDataSchema.safeParse({
      make: "Canon",
      model: "EOS R5",
      iso: 800,
      fNumber: 2.8,
      exposureTime: 0.001,
      focalLength: 50,
    });
    expect(result.success).toBe(true);
  });

  it("should accept empty object (all fields optional)", () => {
    const result = EXIFDataSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should accept EXIF with GPS data", () => {
    const result = EXIFDataSchema.safeParse({
      make: "Nikon",
      gps: { latitude: 48.8566, longitude: 2.3522 },
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid dateTimeOriginal", () => {
    const result = EXIFDataSchema.safeParse({
      dateTimeOriginal: "2024-06-15T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("should reject string longer than 1024 chars", () => {
    const result = EXIFDataSchema.safeParse({
      make: "x".repeat(1025),
    });
    expect(result.success).toBe(false);
  });

  it("should reject non-positive ISO", () => {
    expect(EXIFDataSchema.safeParse({ iso: 0 }).success).toBe(false);
    expect(EXIFDataSchema.safeParse({ iso: -100 }).success).toBe(false);
  });

  it("should reject non-integer ISO", () => {
    expect(EXIFDataSchema.safeParse({ iso: 100.5 }).success).toBe(false);
  });

  it("should reject extra properties (strict mode)", () => {
    const result = EXIFDataSchema.safeParse({
      make: "Canon",
      unknownField: "value",
    });
    expect(result.success).toBe(false);
  });
});

describe("IPTCDataSchema", () => {
  it("should accept valid IPTC data", () => {
    const result = IPTCDataSchema.safeParse({
      keywords: ["dog", "puppy"],
      copyrightNotice: "2024 Test",
      creator: "Photographer",
      caption: "A cute dog",
    });
    expect(result.success).toBe(true);
  });

  it("should accept empty object", () => {
    expect(IPTCDataSchema.safeParse({}).success).toBe(true);
  });

  it("should reject keywords array exceeding 100 items", () => {
    const keywords = Array.from({ length: 101 }, (_, i) => `kw${i}`);
    expect(IPTCDataSchema.safeParse({ keywords }).success).toBe(false);
  });

  it("should reject keyword longer than 64 chars", () => {
    const result = IPTCDataSchema.safeParse({
      keywords: ["x".repeat(65)],
    });
    expect(result.success).toBe(false);
  });

  it("should reject extra properties (strict mode)", () => {
    const result = IPTCDataSchema.safeParse({
      keywords: ["dog"],
      extraField: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("VideoMetadataSchema", () => {
  it("should accept valid video metadata", () => {
    const result = VideoMetadataSchema.safeParse({
      width: 1920,
      height: 1080,
      duration: 120,
      codec: "h264",
      bitrate: 5000000,
    });
    expect(result.success).toBe(true);
  });

  it("should accept empty object", () => {
    expect(VideoMetadataSchema.safeParse({}).success).toBe(true);
  });

  it("should reject non-integer width", () => {
    expect(VideoMetadataSchema.safeParse({ width: 1920.5 }).success).toBe(false);
  });

  it("should reject non-positive height", () => {
    expect(VideoMetadataSchema.safeParse({ height: 0 }).success).toBe(false);
    expect(VideoMetadataSchema.safeParse({ height: -1 }).success).toBe(false);
  });

  it("should accept optional GPS and dateTaken", () => {
    const result = VideoMetadataSchema.safeParse({
      dateTaken: "2024-06-15T12:00:00.000Z",
      gps: { latitude: 40.7128, longitude: -74.006 },
    });
    expect(result.success).toBe(true);
  });

  it("should reject codec string longer than 128 chars", () => {
    expect(
      VideoMetadataSchema.safeParse({ codec: "x".repeat(129) }).success,
    ).toBe(false);
  });
});

describe("MetadataVisibilitySchema", () => {
  it("should accept valid visibility settings", () => {
    const result = MetadataVisibilitySchema.safeParse({
      metadataVisible: true,
      locationVisible: false,
    });
    expect(result.success).toBe(true);
  });

  it("should reject missing metadataVisible", () => {
    const result = MetadataVisibilitySchema.safeParse({
      locationVisible: true,
    });
    expect(result.success).toBe(false);
  });

  it("should reject missing locationVisible", () => {
    const result = MetadataVisibilitySchema.safeParse({
      metadataVisible: true,
    });
    expect(result.success).toBe(false);
  });

  it("should reject non-boolean values", () => {
    expect(
      MetadataVisibilitySchema.safeParse({
        metadataVisible: "yes",
        locationVisible: 1,
      }).success,
    ).toBe(false);
  });

  it("should reject extra properties (strict mode)", () => {
    const result = MetadataVisibilitySchema.safeParse({
      metadataVisible: true,
      locationVisible: false,
      extra: "field",
    });
    expect(result.success).toBe(false);
  });
});
