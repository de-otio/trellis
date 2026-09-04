/**
 * C2PA manifest-store extraction from ORIGINAL image bytes.
 *
 * Fixtures are BUILT here rather than committed as binaries — the same rule the
 * XMP provenance suite follows next door. Constructing the container documents
 * the on-disk format, and there is no third-party Content Credentials sample of
 * unclear provenance sitting in the repo.
 *
 * ANTI-VACUITY. An extractor that returned `absent` unconditionally would pass
 * every negative test here, so the load-bearing assertions are the ones that
 * compare recovered bytes to the exact bytes that were embedded. Those are the
 * tests that fail if the parser does nothing.
 *
 * The JPEG layout is ISO/IEC 19566-5 Annex B as the C2PA spec uses it: APP11
 * (0xFFEB) segments whose payload is 'JP' | En | Z | LBox | TBox | fragment,
 * with LBox/TBox repeated in every packet of a box instance. The PNG layout is
 * a private ancillary `caBX` chunk in ordinary PNG chunk framing.
 */

import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import {
  extractC2pa,
  sniffC2paPresence,
} from "../../../src/lib/metadata/c2pa-extractor.js";
import { reencodeImage } from "../../../src/lib/services/image-normalizer.js";
import { assertNoExif } from "../../../src/lib/exif-stripper.js";
import type { Env } from "../../../src/env.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** A recognisable, non-repeating manifest body so a mis-ordered reassembly
 *  cannot accidentally produce the right bytes. */
function manifestBody(length: number): Buffer {
  const b = Buffer.alloc(length);
  for (let i = 0; i < length; i++) b[i] = (i * 37 + 11) & 0xff;
  return b;
}

/** `LBox || 'jumb' || body` — the box as it must come back out. */
function jumbfBox(body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write("jumb", 4, "latin1");
  return Buffer.concat([header, body]);
}

/**
 * One APP11 segment carrying packet `z` of box instance `en`.
 * `header` is the repeated LBox||TBox; `fragment` is this packet's slice.
 */
function app11Segment(
  en: number,
  z: number,
  header: Buffer,
  fragment: Buffer,
): Buffer {
  const framing = Buffer.alloc(8);
  framing.write("JP", 0, "latin1");
  framing.writeUInt16BE(en, 2);
  framing.writeUInt32BE(z, 4);
  const payload = Buffer.concat([framing, header, fragment]);
  const marker = Buffer.alloc(4);
  marker[0] = 0xff;
  marker[1] = 0xeb;
  marker.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([marker, payload]);
}

/** Splice segments in immediately after SOI, where a real writer puts them. */
function injectAfterSoi(jpeg: Buffer, ...segments: Buffer[]): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

/** A JPEG carrying `box` in `packetCount` APP11 packets of one box instance. */
function jpegWithJumbf(
  jpeg: Buffer,
  box: Buffer,
  packetCount: number,
  opts?: { en?: number; corruptZ?: boolean; corruptLBox?: boolean },
): Buffer {
  const header = Buffer.from(box.subarray(0, 8));
  if (opts?.corruptLBox) header.writeUInt32BE(0xffff, 0);
  const body = box.subarray(8);
  const chunk = Math.ceil(body.length / packetCount);
  const segments: Buffer[] = [];
  for (let i = 0; i < packetCount; i++) {
    const z = opts?.corruptZ && i === packetCount - 1 ? i + 2 : i + 1; // skip one
    segments.push(
      app11Segment(
        opts?.en ?? 1,
        z,
        header,
        body.subarray(i * chunk, Math.min((i + 1) * chunk, body.length)),
      ),
    );
  }
  return injectAfterSoi(jpeg, ...segments);
}

/** One PNG chunk. The CRC is zeroed — the extractor deliberately does not
 *  check it (a corrupt manifest is exactly as unverified as an intact one). */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

/** Splice chunks in after the signature + IHDR (8 + 4 + 4 + 13 + 4 = 33). */
function injectPngChunks(png: Buffer, ...chunks: Buffer[]): Buffer {
  const at = 33;
  return Buffer.concat([png.subarray(0, at), ...chunks, png.subarray(at)]);
}

// ---------------------------------------------------------------------------

let cleanJpeg: Buffer;
let cleanPng: Buffer;
let cleanWebp: Buffer;

beforeAll(async () => {
  const create = {
    create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 8, b: 7 } },
  } as const;
  cleanJpeg = await sharp(create).jpeg().toBuffer();
  cleanPng = await sharp(create).png().toBuffer();
  cleanWebp = await sharp(create).webp().toBuffer();
});

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

describe("extractC2pa — JPEG APP11 JUMBF", () => {
  it("recovers a single-segment manifest byte for byte", () => {
    const box = jumbfBox(manifestBody(300));
    const scan = extractC2pa(jpegWithJumbf(cleanJpeg, box, 1));

    expect(scan.kind).toBe("extracted");
    if (scan.kind !== "extracted") return;
    expect(scan.container).toBe("jpeg-app11");
    expect(Buffer.from(scan.bytes).equals(box)).toBe(true);
  });

  it("reassembles a manifest split across several APP11 packets", () => {
    // The case that makes this worth parsing at all: a real manifest exceeds
    // one 64 KiB segment, so a "find the box" implementation returns a fragment
    // and calls it a manifest.
    const box = jumbfBox(manifestBody(5000));
    const scan = extractC2pa(jpegWithJumbf(cleanJpeg, box, 4));

    expect(scan.kind).toBe("extracted");
    if (scan.kind !== "extracted") return;
    expect(scan.bytes.byteLength).toBe(box.length);
    expect(Buffer.from(scan.bytes).equals(box)).toBe(true);
  });

  it("reassembles regardless of the order the packets appear in", () => {
    const box = jumbfBox(manifestBody(400));
    const header = Buffer.from(box.subarray(0, 8));
    const body = box.subarray(8);
    // Packets emitted Z=2 then Z=1 — ordering is by Z, not by position.
    const bytes = injectAfterSoi(
      cleanJpeg,
      app11Segment(1, 2, header, body.subarray(200)),
      app11Segment(1, 1, header, body.subarray(0, 200)),
    );

    const scan = extractC2pa(bytes);
    expect(scan.kind).toBe("extracted");
    if (scan.kind !== "extracted") return;
    expect(Buffer.from(scan.bytes).equals(box)).toBe(true);
  });

  it("falls back to presence-only when the packet sequence has a gap", () => {
    // Missing bytes must never be silently concatenated into a shorter
    // "manifest" — a partial manifest is worse than no manifest.
    const box = jumbfBox(manifestBody(600));
    const scan = extractC2pa(
      jpegWithJumbf(cleanJpeg, box, 3, { corruptZ: true }),
    );
    expect(scan).toEqual({ kind: "presence-only", container: "unidentified" });
  });

  it("falls back to presence-only when LBox disagrees with the bytes", () => {
    const box = jumbfBox(manifestBody(600));
    const scan = extractC2pa(
      jpegWithJumbf(cleanJpeg, box, 2, { corruptLBox: true }),
    );
    expect(scan).toEqual({ kind: "presence-only", container: "unidentified" });
  });

  it("reports absent for a JPEG with no manifest", () => {
    expect(extractC2pa(cleanJpeg)).toEqual({ kind: "absent" });
  });
});

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

describe("extractC2pa — PNG caBX", () => {
  it("recovers a caBX manifest byte for byte", () => {
    const box = jumbfBox(manifestBody(256));
    const scan = extractC2pa(injectPngChunks(cleanPng, pngChunk("caBX", box)));

    expect(scan.kind).toBe("extracted");
    if (scan.kind !== "extracted") return;
    expect(scan.container).toBe("png-cabx");
    expect(Buffer.from(scan.bytes).equals(box)).toBe(true);
  });

  it("ignores other chunks around it", () => {
    const box = jumbfBox(manifestBody(64));
    const bytes = injectPngChunks(
      cleanPng,
      pngChunk("tEXt", Buffer.from("Comment\0not a manifest", "latin1")),
      pngChunk("caBX", box),
    );

    const scan = extractC2pa(bytes);
    expect(scan.kind).toBe("extracted");
    if (scan.kind !== "extracted") return;
    expect(Buffer.from(scan.bytes).equals(box)).toBe(true);
  });

  it("reports absent for a PNG with no manifest", () => {
    expect(extractC2pa(cleanPng)).toEqual({ kind: "absent" });
  });
});

// ---------------------------------------------------------------------------
// Containers we do not parse, and hostile input
// ---------------------------------------------------------------------------

describe("extractC2pa — presence-only and failure modes", () => {
  it("records presence, not bytes, for a container it cannot parse", () => {
    // WebP carries C2PA in a RIFF chunk this module does not implement. The
    // honest answer is "a manifest was here", never a guessed byte range.
    const bytes = Buffer.concat([cleanWebp, Buffer.from("jumb", "latin1")]);
    expect(extractC2pa(bytes)).toEqual({
      kind: "presence-only",
      container: "unidentified",
    });
  });

  it("dispatches on magic bytes, not on anything the uploader claims", () => {
    // A PNG-signature file whose caBX chunk is real still parses as PNG even
    // though the upload declared image/jpeg — extractC2pa takes no mime type
    // at all, which is the point.
    const box = jumbfBox(manifestBody(32));
    const scan = extractC2pa(injectPngChunks(cleanPng, pngChunk("caBX", box)));
    expect(scan.kind).toBe("extracted");
  });

  it("never throws on truncated or hostile bytes", () => {
    const box = jumbfBox(manifestBody(2000));
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0xff, 0xd8]),
      new Uint8Array([0xff, 0xd8, 0xff]),
      jpegWithJumbf(cleanJpeg, box, 3).subarray(0, 40), // truncated mid-segment
      cleanPng.subarray(0, 20),
      Buffer.from("not an image at all", "utf8"),
      Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.from([0xff, 0xeb, 0xff, 0xff]), // APP11 claiming 64 KiB it lacks
      ]),
    ];
    for (const bytes of cases) {
      expect(() => extractC2pa(bytes)).not.toThrow();
    }
  });

  it("caps a reassembled store at the size of the file it came from", () => {
    // An LBox that agrees with a body larger than the whole input cannot be
    // real; accepting it would let a small upload allocate a large sidecar.
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + 16, 0);
    header.write("jumb", 4, "latin1");
    const bytes = injectAfterSoi(
      cleanJpeg,
      app11Segment(1, 1, header, Buffer.alloc(16)),
    );
    const scan = extractC2pa(bytes);
    expect(scan.kind).toBe("extracted");
    if (scan.kind !== "extracted") return;
    expect(scan.bytes.byteLength).toBeLessThanOrEqual(bytes.length);
  });
});

describe("sniffC2paPresence", () => {
  it("is the one definition of presence, shared with the provenance reader", () => {
    expect(sniffC2paPresence(cleanJpeg)).toBe(false);
    expect(
      sniffC2paPresence(jpegWithJumbf(cleanJpeg, jumbfBox(manifestBody(64)), 1)),
    ).toBe(true);
    expect(
      sniffC2paPresence(
        injectPngChunks(cleanPng, pngChunk("caBX", jumbfBox(manifestBody(64)))),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The strip is unchanged — extraction happens BESIDE it, never instead of it
// ---------------------------------------------------------------------------

function testEnv(): Pick<Env, "media"> {
  return {
    media: {
      maxBytes: { image: 10 * 1024 * 1024, video: 0, audio: 0 },
      maxPixels: 25_000_000,
      rateLimits: { uploadPerMin: 10, batchPerMin: 5, servePerMin: 60 },
      allowlist: { image: ["image/jpeg", "image/png"], video: [], audio: [] },
      presets: [],
      thresholds: {},
      canonicalFormat: "jpeg",
      canonicalQuality: 85,
    },
  } as unknown as Pick<Env, "media">;
}

describe("the re-encode still destroys the manifest (T6/T7 unchanged)", () => {
  it("leaves no manifest in the stored bytes after the strip", async () => {
    const box = jumbfBox(manifestBody(3000));
    const original = jpegWithJumbf(cleanJpeg, box, 2);

    // Pre-condition: the manifest really is in the input, so a green result
    // below cannot come from a fixture that never carried one.
    expect(extractC2pa(original).kind).toBe("extracted");

    const { buffer } = await reencodeImage(original, testEnv());

    await expect(assertNoExif(buffer)).resolves.toBeUndefined();
    expect(extractC2pa(buffer)).toEqual({ kind: "absent" });
    expect(buffer.includes("jumb")).toBe(false);
    expect(buffer.includes("caBX")).toBe(false);
  });

  it("keeps the sidecar bytes independent of the stripped output", async () => {
    // The whole point: the manifest survives OUTSIDE the file, the file itself
    // is clean. Both halves have to be true at once.
    const box = jumbfBox(manifestBody(1200));
    const original = injectPngChunks(cleanPng, pngChunk("caBX", box));

    const scan = extractC2pa(original);
    expect(scan.kind).toBe("extracted");
    if (scan.kind !== "extracted") return;

    const { buffer } = await reencodeImage(original, testEnv());
    expect(Buffer.from(scan.bytes).equals(box)).toBe(true);
    expect(extractC2pa(buffer)).toEqual({ kind: "absent" });
  });
});
