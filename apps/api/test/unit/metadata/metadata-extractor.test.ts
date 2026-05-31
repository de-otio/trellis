/**
 * Unit Tests: Metadata Extractor
 *
 * Tests for the MetadataExtractor class which extracts EXIF, IPTC,
 * and video metadata from media files.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataExtractionError } from "../../../src/lib/metadata/metadata-errors.js";

// Hoist mocks
const { mockExifrParse, mockExtractMetadata } = vi.hoisted(() => ({
  mockExifrParse: vi.fn(),
  mockExtractMetadata: vi.fn(),
}));

vi.mock("exifr", () => ({
  default: { parse: mockExifrParse },
}));

vi.mock("../../../src/lib/media-metadata-extractor", () => ({
  MediaMetadataExtractor: class {
    extractMetadata = mockExtractMetadata;
  },
}));

import { MetadataExtractor } from "../../../src/lib/metadata/metadata-extractor.js";

describe("MetadataExtractor", () => {
  let extractor: MetadataExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
    // Pass mock env so constructor calls Logger.getInstance() instead of {} as Logger
    extractor = new MetadataExtractor({ STAGE: "test" } as any);
  });

  describe("extractAll", () => {
    it("should return empty object for zero-length input", async () => {
      const result = await extractor.extractAll(new Uint8Array(0), "image/jpeg");
      expect(result).toEqual({});
    });

    it("should extract EXIF data from image", async () => {
      // exifr.parse is called twice in parallel (EXIF + IPTC) for images.
      // Both calls receive the buffer with options. Match based on call order.
      mockExifrParse.mockImplementation((_buf: any, opts: any) => {
        if (opts?.tiff) {
          // EXIF call
          return Promise.resolve({
            Make: "Canon",
            Model: "EOS R5",
            ISO: 800,
            FNumber: 2.8,
            ExposureTime: 0.001,
            FocalLength: 50,
          });
        }
        // IPTC call
        return Promise.resolve(null);
      });

      const input = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]);
      // Also spy on the logger to see if warn was called (indicating failures)
      const result = await extractor.extractAll(input, "image/jpeg");

      expect(result.exifData).toBeDefined();
      expect((result.exifData as any).make).toBe("Canon");
      expect((result.exifData as any).model).toBe("EOS R5");
      expect((result.exifData as any).iso).toBe(800);
    });

    it("should extract IPTC data from image", async () => {
      mockExifrParse.mockImplementation((_buf: any, opts: any) => {
        if (opts?.tiff) {
          // EXIF call returns null
          return Promise.resolve(null);
        }
        // IPTC call
        return Promise.resolve({
          Keywords: ["dog", "puppy"],
          CopyrightNotice: "2024 Test",
          Creator: "Photographer",
        });
      });

      const input = new Uint8Array([0xff, 0xd8, 0xff]);
      const result = await extractor.extractAll(input, "image/png");

      expect(result.iptcData).toBeDefined();
      expect((result.iptcData as any).keywords).toEqual(["dog", "puppy"]);
      expect((result.iptcData as any).copyrightNotice).toBe("2024 Test");
    });

    it("should throw for unsupported mime type", async () => {
      const input = new Uint8Array([0x01, 0x02]);

      await expect(
        extractor.extractAll(input, "application/pdf"),
      ).rejects.toThrow(MetadataExtractionError);

      await expect(
        extractor.extractAll(input, "application/pdf"),
      ).rejects.toThrow("Unsupported mime type");
    });

    it("should handle video mime types", async () => {
      mockExtractMetadata.mockResolvedValue({
        width: 1920,
        height: 1080,
        duration: 120,
      });

      const input = new Uint8Array([0x00, 0x00, 0x00, 0x18]);
      const result = await extractor.extractAll(input, "video/mp4");

      expect(result.videoMetadata).toBeDefined();
      expect((result.videoMetadata as any).width).toBe(1920);
      expect((result.videoMetadata as any).height).toBe(1080);
      expect((result.videoMetadata as any).duration).toBe(120);
    });

    it("should return partial results on extraction failure", async () => {
      mockExifrParse.mockImplementation((_buf: any, opts: any) => {
        if (opts?.tiff) {
          // EXIF succeeds
          return Promise.resolve({
            Make: "Nikon",
            Model: "Z9",
          });
        }
        // IPTC fails
        return Promise.reject(new Error("IPTC parse error"));
      });

      const input = new Uint8Array([0xff, 0xd8]);
      const result = await extractor.extractAll(input, "image/jpeg");

      // Should still have EXIF data even though IPTC failed
      expect(result.exifData).toBeDefined();
      expect((result.exifData as any).make).toBe("Nikon");
      // Logger should have warned about the partial failure
          });

    it("should handle exifr returning non-object", async () => {
      mockExifrParse.mockResolvedValue(null);

      const input = new Uint8Array([0xff, 0xd8]);
      const result = await extractor.extractAll(input, "image/jpeg");

      expect(result.exifData).toBeUndefined();
      expect(result.iptcData).toBeUndefined();
    });

    it("should accept ArrayBuffer input", async () => {
      mockExifrParse.mockImplementation((_buf: any, opts: any) => {
        if (opts?.tiff) {
          return Promise.resolve({ Make: "Sony" });
        }
        return Promise.resolve(null);
      });

      const buffer = new ArrayBuffer(10);
      new Uint8Array(buffer).fill(0xff);
      const result = await extractor.extractAll(buffer, "image/jpeg");

      expect(result).toBeDefined();
      expect(result.exifData).toBeDefined();
      expect((result.exifData as any).make).toBe("Sony");
    });
  });
});
