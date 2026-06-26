/**
 * Unit Tests: assertNoExif / parseMetadata (T6)
 *
 * Branch coverage for the post-re-encode EXIF assertion helper. The byte-level
 * strip is verified by asserting that no privacy-sensitive metadata survives a
 * re-encode. These tests exercise:
 *  - the buffer-normalization ternary (Buffer / ArrayBuffer / Uint8Array inputs)
 *  - the exifr-returns-undefined fast path (assertNoExif resolves)
 *  - the exifr-throws catch (parseMetadata returns undefined)
 *  - the sensitive-key filter: structural PNG fields excluded (passes),
 *    privacy-sensitive keys (GPS/Make/...) present (throws)
 *
 * Fixtures are synthetic and tokens abstract — no real device/location data.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// exifr is mocked so parseMetadata is deterministic and does not attempt the
// dynamic native-module loads that real exifr does on unknown buffers. The
// mock is per-test-controllable via mockExifrParse.
const { mockExifrParse } = vi.hoisted(() => ({ mockExifrParse: vi.fn() }));
vi.mock("exifr", () => ({
  default: { parse: (...args: any[]) => mockExifrParse(...args) },
}));

import {
  assertNoExif,
  parseMetadata,
} from "../../src/lib/exif-stripper.js";

describe("parseMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a Buffer input (no extra copy) and returns the parsed object", async () => {
    mockExifrParse.mockResolvedValue({ ImageWidth: 1 });
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await parseMetadata(buf);
    expect(result).toEqual({ ImageWidth: 1 });
    // The buffer passed to exifr is the same Buffer instance (Buffer branch).
    expect(mockExifrParse).toHaveBeenCalledWith(buf, expect.any(Object));
  });

  it("accepts an ArrayBuffer input (ArrayBuffer ternary branch)", async () => {
    mockExifrParse.mockResolvedValue(undefined);
    const ab = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = await parseMetadata(ab);
    expect(result).toBeUndefined();
    // exifr received a Buffer constructed from the ArrayBuffer.
    const passed = mockExifrParse.mock.calls[0][0];
    expect(Buffer.isBuffer(passed)).toBe(true);
  });

  it("accepts a Uint8Array input (non-Buffer typed-array branch)", async () => {
    mockExifrParse.mockResolvedValue({ ColorType: "Grayscale" });
    const u8 = new Uint8Array([5, 6, 7, 8]);
    const result = await parseMetadata(u8);
    expect(result).toEqual({ ColorType: "Grayscale" });
    const passed = mockExifrParse.mock.calls[0][0];
    expect(Buffer.isBuffer(passed)).toBe(true);
  });

  it("returns undefined when exifr throws (unparseable/truncated bytes)", async () => {
    mockExifrParse.mockRejectedValue(new Error("unknown file format"));
    const result = await parseMetadata(new Uint8Array([0, 1, 2, 3]));
    expect(result).toBeUndefined();
  });
});

describe("assertNoExif", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes when exifr finds no metadata (undefined → early return)", async () => {
    mockExifrParse.mockResolvedValue(undefined);
    await expect(
      assertNoExif(new Uint8Array([0xff, 0xd8, 0xff])),
    ).resolves.toBeUndefined();
  });

  it("passes when only benign PNG structural fields are present", async () => {
    // Structural keys are explicitly excluded from the sensitive filter, so a
    // re-encoded PNG that exposes only IHDR fields must NOT throw.
    mockExifrParse.mockResolvedValue({
      ImageWidth: 800,
      ImageHeight: 600,
      BitDepth: 8,
      ColorType: "RGB",
      Compression: "Deflate/Inflate",
      Filter: "Adaptive",
      Interlace: "Noninterlaced",
    });
    await expect(
      assertNoExif(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    ).resolves.toBeUndefined();
  });

  it("passes when metadata contains only non-sensitive, non-structural keys", async () => {
    // A key that is neither structural nor sensitive-prefixed is ignored.
    mockExifrParse.mockResolvedValue({ SomeHarmlessField: "x" });
    await expect(
      assertNoExif(new Uint8Array([1, 2, 3])),
    ).resolves.toBeUndefined();
  });

  it("throws when privacy-sensitive GPS metadata survives the re-encode", async () => {
    mockExifrParse.mockResolvedValue({
      ImageWidth: 1, // structural — excluded
      GPSLatitude: [1, 2, 3], // sensitive — must trigger throw
    });
    await expect(
      assertNoExif(new Uint8Array([0xff, 0xd8, 0xff])),
    ).rejects.toThrow(/privacy-sensitive metadata/);
  });

  it("names every sensitive key in the thrown error", async () => {
    mockExifrParse.mockResolvedValue({
      Make: "abstract-maker",
      Model: "abstract-model",
      Software: "abstract-software",
      DateTimeOriginal: "2020:01:01",
      Orientation: 1,
      ImageHeight: 480, // structural — excluded from the message
    });
    await expect(
      assertNoExif(Buffer.from([0xff, 0xd8])),
    ).rejects.toThrow(/Make.*Model.*Software.*DateTimeOriginal.*Orientation/s);
  });
});
