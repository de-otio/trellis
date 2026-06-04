/**
 * Unit Tests: EXIF Stripper
 *
 * Tests for the EXIF stripping utility.
 *
 * NOTE: The current implementation is a placeholder that returns the buffer as-is
 * when enabled (actual EXIF removal is not yet implemented). These tests verify
 * the current placeholder behavior.
 *
 * When the actual EXIF stripping is implemented, the "placeholder behavior" tests
 * should be replaced with tests that assert actual EXIF removal.
 */

import { describe, expect, it } from "vitest";
import { stripEXIF, type EXIFStripperConfig } from "../../src/lib/exif-stripper.js";

/**
 * Helper: build a minimal JPEG buffer from segments.
 * SOI (FF D8) is always prepended; EOI (FF D9) is always appended.
 */
function buildJPEG(...segments: Uint8Array[]): ArrayBuffer {
  const parts: number[] = [0xff, 0xd8]; // SOI
  for (const seg of segments) {
    parts.push(...seg);
  }
  parts.push(0xff, 0xd9); // EOI
  return new Uint8Array(parts).buffer;
}

/**
 * Helper: create a JPEG APP segment (marker + length + payload).
 */
function makeSegment(marker: number, payloadSize: number): Uint8Array {
  const totalLength = 2 + payloadSize;
  const arr = new Uint8Array(2 + totalLength);
  arr[0] = 0xff;
  arr[1] = marker;
  arr[2] = (totalLength >> 8) & 0xff;
  arr[3] = totalLength & 0xff;
  for (let i = 4; i < arr.length; i++) {
    arr[i] = 0xab;
  }
  return arr;
}

describe("stripEXIF", () => {
  describe("placeholder behavior (returns buffer as-is when enabled)", () => {
    it("should return buffer unchanged for JPEG with EXIF (placeholder)", async () => {
      const app1 = makeSegment(0xe1, 20);
      const jpeg = buildJPEG(app1);
      const inputBytes = new Uint8Array(jpeg);

      const result = await stripEXIF(jpeg);
      const resultBytes = new Uint8Array(result);

      // Placeholder: returns same buffer
      expect(resultBytes.length).toBe(inputBytes.length);
    });

    it("should return buffer unchanged for JPEG with multiple segments (placeholder)", async () => {
      const app0 = makeSegment(0xe0, 10);
      const app1 = makeSegment(0xe1, 20);
      const sof = makeSegment(0xc0, 8);
      const jpeg = buildJPEG(app0, app1, sof);
      const inputBytes = new Uint8Array(jpeg);

      const result = await stripEXIF(jpeg);
      const resultBytes = new Uint8Array(result);

      expect(resultBytes.length).toBe(inputBytes.length);
    });

    it("should handle JPEG with no EXIF data", async () => {
      const app0 = makeSegment(0xe0, 10);
      const jpeg = buildJPEG(app0);
      const inputBytes = new Uint8Array(jpeg);

      const result = await stripEXIF(jpeg);
      const resultBytes = new Uint8Array(result);

      expect(resultBytes.length).toBe(inputBytes.length);
      for (let i = 0; i < inputBytes.length; i++) {
        expect(resultBytes[i]).toBe(inputBytes[i]);
      }
    });
  });

  describe("non-JPEG passthrough", () => {
    it("should return PNG files unchanged", async () => {
      const pngBuffer = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
      ]).buffer;

      const result = await stripEXIF(pngBuffer);
      // Placeholder returns same reference
      expect(result).toBe(pngBuffer);
    });

    it("should return empty ArrayBuffer unchanged", async () => {
      const emptyBuffer = new ArrayBuffer(0);

      const result = await stripEXIF(emptyBuffer);
      expect(result).toBe(emptyBuffer);
    });

    it("should return buffer smaller than 2 bytes unchanged", async () => {
      const tinyBuffer = new Uint8Array([0xff]).buffer;

      const result = await stripEXIF(tinyBuffer);
      expect(result).toBe(tinyBuffer);
    });

    it("should return GIF files unchanged", async () => {
      const gifBuffer = new Uint8Array([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      ]).buffer;

      const result = await stripEXIF(gifBuffer);
      expect(result).toBe(gifBuffer);
    });
  });

  describe("configuration", () => {
    it("should return buffer unchanged when config.enabled is false", async () => {
      const app1 = makeSegment(0xe1, 20);
      const jpeg = buildJPEG(app1);

      const config: EXIFStripperConfig = {
        enabled: false,
        removeLocation: true,
        removeDeviceInfo: true,
        removeTimestamp: true,
      };

      const result = await stripEXIF(jpeg, config);
      expect(result).toBe(jpeg);
    });

    it("should accept default config with no argument", async () => {
      const app1 = makeSegment(0xe1, 20);
      const jpeg = buildJPEG(app1);

      // Should not throw
      const result = await stripEXIF(jpeg);
      expect(result).toBeDefined();
    });
  });

  describe("interface", () => {
    it("should export EXIFStripperConfig interface with correct shape", () => {
      const config: EXIFStripperConfig = {
        enabled: true,
        removeLocation: true,
        removeDeviceInfo: true,
        removeTimestamp: false,
      };
      expect(config.enabled).toBe(true);
      expect(config.removeLocation).toBe(true);
      expect(config.removeDeviceInfo).toBe(true);
      expect(config.removeTimestamp).toBe(false);
    });

    it("should return a Promise<ArrayBuffer>", async () => {
      const buffer = new ArrayBuffer(0);
      const result = stripEXIF(buffer);
      expect(result).toBeInstanceOf(Promise);
      const resolved = await result;
      expect(resolved).toBeInstanceOf(ArrayBuffer);
    });

    it("should return ArrayBuffer for valid JPEG input", async () => {
      const jpeg = buildJPEG(makeSegment(0xe0, 4));
      const result = await stripEXIF(jpeg);
      expect(result).toBeInstanceOf(ArrayBuffer);
    });
  });
});
