/**
 * Image re-encode pipeline (T7 — transcode-and-discard).
 *
 * Re-encodes every uploaded image to a canonical safe raster format using
 * sharp. This is the polyglot + pixel-bomb defense: a file that is
 * simultaneously a valid image and valid JS/HTML/script payload is stripped to
 * clean raster pixels by the transcode; a file that claims huge dimensions but
 * tiny bytes is rejected by sharp's `limitInputPixels` guard before it can
 * trigger a decompression bomb.
 *
 * Design constraints:
 * - `.rotate()` bakes EXIF orientation into pixels (so the tag becomes stale
 *   and can safely be dropped — no `.withMetadata()` call).
 * - NO `.withMetadata()` — metadata is intentionally dropped by the re-encode
 *   (T6 owns the post-encode assertion that it is gone).
 * - Runs BEFORE the SHA-256 hash so the CAS hash is of the cleaned bytes.
 * - Accepted MIME types MUST equal the set sharp can write (HEIC/HEIF and SVG
 *   are excluded — HEIC write is not supported without the optional libheif
 *   native module, and SVG cannot be safely transcoded to raster).
 *
 * The async Lambda media-processing-worker (P0b) performs the same transcode
 * for derivatives; this file is the P0a synchronous path in the upload handler.
 */

import type { Env } from "../../env.js";

/**
 * The MIME types that this build of sharp can reliably re-encode to a
 * canonical raster format. Any type outside this set must be rejected at the
 * allowlist boundary.
 *
 * Excluded:
 * - `image/svg+xml` — no safe raster transcode; can embed scripts.
 * - `image/heic` / `image/heif` — sharp write support requires the optional
 *   libheif native module; absent = encode fails at runtime. Full HEIC UX is
 *   deferred to P1/D12.
 * - `image/tiff` — sharp can read but the tiff encoder is rarely needed;
 *   excluded from P0a canonical set.
 */
export const REENCODABLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/jpg",   // alias; normalised to image/jpeg
  "image/png",
  "image/webp",
  "image/gif",   // static raster in P0a (animated → first frame only)
]);

/**
 * Result of a successful re-encode.
 */
export interface ReencodeResult {
  /** Re-encoded image bytes (the bytes to hash and store). */
  buffer: Buffer;
  /**
   * The canonical MIME type of the output bytes.
   * Always one of image/jpeg, image/png, image/webp (canonical set).
   */
  canonicalMimeType: string;
}

/**
 * Re-encode an image buffer to the canonical safe raster format.
 *
 * @param inputBytes - Raw bytes of the uploaded file.
 * @param env        - Application env (reads `env.media.maxPixels`,
 *                     `env.media.canonicalFormat`, `env.media.canonicalQuality`).
 * @returns Re-encoded bytes and the canonical MIME type.
 * @throws If the input cannot be decoded (corrupt / pixel-bomb / unsupported),
 *         or if `env.media.maxPixels` is exceeded.
 */
export async function reencodeImage(
  inputBytes: Buffer | ArrayBuffer | Uint8Array,
  env: Pick<Env, "media">,
): Promise<ReencodeResult> {
  const { default: sharp } = await import("sharp");

  const buf =
    inputBytes instanceof Buffer
      ? inputBytes
      : Buffer.from(
          inputBytes instanceof ArrayBuffer ? inputBytes : inputBytes.buffer,
        );

  const { maxPixels, canonicalFormat, canonicalQuality } = env.media;

  // limitInputPixels MUST NOT be false or 0 — decompression-bomb guard.
  const pipeline = sharp(buf, { limitInputPixels: maxPixels })
    .rotate(); // bake EXIF orientation into pixels; drops orientation tag

  // toFormat — NO withMetadata() so all metadata is dropped
  let outputBuffer: Buffer;
  if (canonicalFormat === "png") {
    outputBuffer = await pipeline.toFormat("png").toBuffer();
  } else if (canonicalFormat === "webp") {
    outputBuffer = await pipeline
      .toFormat("webp", { quality: canonicalQuality })
      .toBuffer();
  } else {
    // Default: jpeg
    outputBuffer = await pipeline
      .toFormat("jpeg", { quality: canonicalQuality })
      .toBuffer();
  }

  const canonicalMimeType =
    canonicalFormat === "png"
      ? "image/png"
      : canonicalFormat === "webp"
        ? "image/webp"
        : "image/jpeg";

  return { buffer: outputBuffer, canonicalMimeType };
}

/**
 * Legacy class kept so the existing import in `media.ts` continues to compile
 * until T9 removes it. The class is now a thin shim over `reencodeImage`.
 *
 * @deprecated Use `reencodeImage` directly. This class will be removed in T9.
 */
export class ImageNormalizer {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_images: unknown, _mediaBucket: unknown) {}

  /** No-op — the re-encode is now done inline in the upload handler. */
  async normalize(_originalKey: string, _contentHash: string): Promise<string | null> {
    return null;
  }
}
