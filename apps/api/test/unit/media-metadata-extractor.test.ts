/**
 * Unit Tests: Media Metadata Extractor
 *
 * Tests for extracting metadata (width, height, duration) from various media file types.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MediaMetadataExtractor,
  type MediaMetadata,
} from "../../src/lib/media-metadata-extractor.js";

describe("MediaMetadataExtractor", () => {
  let extractor: MediaMetadataExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
    extractor = new MediaMetadataExtractor();
  });

  describe("extractMetadata", () => {
    it("should return empty metadata for unsupported mime type", async () => {
      const buffer = new Uint8Array([0x00, 0x01, 0x02]);
      const result = await extractor.extractMetadata(buffer, "application/pdf");

      expect(result).toEqual({});
    });

    it("should accept ArrayBuffer input", async () => {
      // Create a minimal PNG
      const pngBytes = createMinimalPNG(100, 200);
      const arrayBuffer = pngBytes.buffer.slice(
        pngBytes.byteOffset,
        pngBytes.byteOffset + pngBytes.byteLength,
      );

      const result = await extractor.extractMetadata(
        arrayBuffer,
        "image/png",
      );

      expect(result.width).toBe(100);
      expect(result.height).toBe(200);
    });

    it("should accept Uint8Array input", async () => {
      const pngBytes = createMinimalPNG(320, 240);

      const result = await extractor.extractMetadata(pngBytes, "image/png");

      expect(result.width).toBe(320);
      expect(result.height).toBe(240);
    });
  });

  describe("PNG metadata extraction", () => {
    it("should extract width and height from valid PNG", async () => {
      const pngBytes = createMinimalPNG(800, 600);

      const result = await extractor.extractMetadata(pngBytes, "image/png");

      expect(result.width).toBe(800);
      expect(result.height).toBe(600);
    });

    it("should return empty metadata for invalid PNG signature", async () => {
      const bytes = new Uint8Array(30);
      bytes[0] = 0x00; // Invalid signature

      const result = await extractor.extractMetadata(bytes, "image/png");

      expect(result).toEqual({});
    });

    it("should return empty metadata for too-short PNG", async () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

      const result = await extractor.extractMetadata(bytes, "image/png");

      expect(result).toEqual({});
    });
  });

  describe("JPEG metadata extraction", () => {
    it("should extract width and height from valid JPEG with SOF0 marker", async () => {
      const jpegBytes = createMinimalJPEG(1024, 768);

      const result = await extractor.extractMetadata(jpegBytes, "image/jpeg");

      expect(result.width).toBe(1024);
      expect(result.height).toBe(768);
    });

    it("should also work with image/jpg mime type", async () => {
      const jpegBytes = createMinimalJPEG(640, 480);

      const result = await extractor.extractMetadata(jpegBytes, "image/jpg");

      expect(result.width).toBe(640);
      expect(result.height).toBe(480);
    });

    it("should return empty metadata for invalid JPEG", async () => {
      const bytes = new Uint8Array([0x00, 0x00, 0x00]);

      const result = await extractor.extractMetadata(bytes, "image/jpeg");

      expect(result).toEqual({});
    });

    it("should return empty metadata for JPEG without SOF marker", async () => {
      // Valid JPEG start but no SOF marker
      const bytes = new Uint8Array(20);
      bytes[0] = 0xff;
      bytes[1] = 0xd8;
      bytes[2] = 0xff;
      bytes[3] = 0xe0; // APP0, not SOF

      const result = await extractor.extractMetadata(bytes, "image/jpeg");

      expect(result).toEqual({});
    });
  });

  describe("GIF metadata extraction", () => {
    it("should extract width and height from valid GIF", async () => {
      const gifBytes = createMinimalGIF(320, 200);

      const result = await extractor.extractMetadata(gifBytes, "image/gif");

      expect(result.width).toBe(320);
      expect(result.height).toBe(200);
    });

    it("should return empty metadata for invalid GIF", async () => {
      const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00]);

      const result = await extractor.extractMetadata(bytes, "image/gif");

      expect(result).toEqual({});
    });

    it("should return empty metadata for too-short GIF", async () => {
      // Valid GIF header but too short
      const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]);

      const result = await extractor.extractMetadata(bytes, "image/gif");

      expect(result).toEqual({});
    });
  });

  describe("WebP metadata extraction", () => {
    it("should extract width and height from VP8 WebP", async () => {
      const webpBytes = createMinimalWebPVP8(400, 300);

      const result = await extractor.extractMetadata(webpBytes, "image/webp");

      expect(result.width).toBe(400);
      expect(result.height).toBe(300);
    });

    it("should return empty metadata for invalid WebP", async () => {
      const bytes = new Uint8Array(30);

      const result = await extractor.extractMetadata(bytes, "image/webp");

      expect(result).toEqual({});
    });

    it("should return empty metadata for too-short WebP", async () => {
      const bytes = new Uint8Array(10);
      // RIFF header
      bytes[0] = 0x52;
      bytes[1] = 0x49;
      bytes[2] = 0x46;
      bytes[3] = 0x46;

      const result = await extractor.extractMetadata(bytes, "image/webp");

      expect(result).toEqual({});
    });
  });

  describe("Video metadata extraction", () => {
    it("should return empty metadata for WebM (not fully implemented)", async () => {
      // Valid WebM signature
      const bytes = new Uint8Array(30);
      bytes[0] = 0x1a;
      bytes[1] = 0x45;
      bytes[2] = 0xdf;
      bytes[3] = 0xa3;

      const result = await extractor.extractMetadata(bytes, "video/webm");

      expect(result).toEqual({});
    });

    it("should return empty metadata for invalid MP4 signature", async () => {
      const bytes = new Uint8Array(100);

      const result = await extractor.extractMetadata(bytes, "video/mp4");

      expect(result).toEqual({});
    });

    it("should return empty metadata for invalid WebM signature", async () => {
      const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00]);

      const result = await extractor.extractMetadata(bytes, "video/webm");

      expect(result).toEqual({});
    });
  });

  describe("Error handling", () => {
    it("should handle empty buffer gracefully", async () => {
      const bytes = new Uint8Array(0);

      const result = await extractor.extractMetadata(bytes, "image/png");
      expect(result).toEqual({});
    });

    it("should handle corrupted image data gracefully", async () => {
      // PNG signature but corrupted IHDR
      const bytes = new Uint8Array(30);
      bytes[0] = 0x89;
      bytes[1] = 0x50;
      bytes[2] = 0x4e;
      bytes[3] = 0x47;
      bytes[4] = 0x0d;
      bytes[5] = 0x0a;
      bytes[6] = 0x1a;
      bytes[7] = 0x0a;
      // Rest is zeroes - will read 0x0 for width and height

      const result = await extractor.extractMetadata(bytes, "image/png");
      expect(result.width).toBe(0);
      expect(result.height).toBe(0);
    });
  });
});

// Helper functions to create minimal valid file headers

function createMinimalPNG(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  // PNG signature
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  bytes[4] = 0x0d;
  bytes[5] = 0x0a;
  bytes[6] = 0x1a;
  bytes[7] = 0x0a;
  // IHDR chunk length
  bytes[8] = 0x00;
  bytes[9] = 0x00;
  bytes[10] = 0x00;
  bytes[11] = 0x0d;
  // IHDR
  bytes[12] = 0x49;
  bytes[13] = 0x48;
  bytes[14] = 0x44;
  bytes[15] = 0x52;
  // Width (big-endian)
  bytes[16] = (width >> 24) & 0xff;
  bytes[17] = (width >> 16) & 0xff;
  bytes[18] = (width >> 8) & 0xff;
  bytes[19] = width & 0xff;
  // Height (big-endian)
  bytes[20] = (height >> 24) & 0xff;
  bytes[21] = (height >> 16) & 0xff;
  bytes[22] = (height >> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

function createMinimalJPEG(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(20);
  // JPEG SOI
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  // SOF0 marker
  bytes[3] = 0xc0;
  // Frame header length
  bytes[4] = 0x00;
  bytes[5] = 0x11;
  // Sample precision
  bytes[6] = 0x08;
  // NO: SOF is at i+1, so height at i+5,i+6 and width at i+7,i+8
  // The loop finds 0xFF at bytes[2], marker at bytes[3]=0xC0
  // So i=2, height at bytes[2+5]=bytes[7], bytes[2+6]=bytes[8]
  // Width at bytes[2+7]=bytes[9], bytes[2+8]=bytes[10]
  bytes[7] = (height >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (width >> 8) & 0xff;
  bytes[10] = width & 0xff;
  return bytes;
}

function createMinimalGIF(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  // GIF89a signature
  bytes[0] = 0x47; // G
  bytes[1] = 0x49; // I
  bytes[2] = 0x46; // F
  bytes[3] = 0x38; // 8
  bytes[4] = 0x39; // 9
  bytes[5] = 0x61; // a
  // Width (little-endian)
  bytes[6] = width & 0xff;
  bytes[7] = (width >> 8) & 0xff;
  // Height (little-endian)
  bytes[8] = height & 0xff;
  bytes[9] = (height >> 8) & 0xff;
  return bytes;
}

function createMinimalWebPVP8(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  // RIFF header
  bytes[0] = 0x52; // R
  bytes[1] = 0x49; // I
  bytes[2] = 0x46; // F
  bytes[3] = 0x46; // F
  // File size (placeholder)
  bytes[4] = 0x00;
  bytes[5] = 0x00;
  bytes[6] = 0x00;
  bytes[7] = 0x00;
  // WEBP
  bytes[8] = 0x57; // W
  bytes[9] = 0x45; // E
  bytes[10] = 0x42; // B
  bytes[11] = 0x50; // P
  // VP8 chunk type
  bytes[12] = 0x56; // V
  bytes[13] = 0x50; // P
  bytes[14] = 0x38; // 8
  bytes[15] = 0x20; // (space)
  // Chunk size (placeholder)
  bytes[16] = 0x00;
  bytes[17] = 0x00;
  bytes[18] = 0x00;
  bytes[19] = 0x00;
  // VP8 bitstream header (3 bytes signature)
  bytes[20] = 0x9d;
  bytes[21] = 0x01;
  bytes[22] = 0x2a;
  // Padding bytes
  bytes[23] = 0x00;
  bytes[24] = 0x00;
  bytes[25] = 0x00;
  // Width at bytes 26-27 (little-endian, lower 14 bits)
  bytes[26] = width & 0xff;
  bytes[27] = (width >> 8) & 0x3f;
  // Height at bytes 28-29 (little-endian, lower 14 bits)
  bytes[28] = height & 0xff;
  bytes[29] = (height >> 8) & 0x3f;
  return bytes;
}
