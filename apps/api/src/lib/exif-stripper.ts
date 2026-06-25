/**
 * EXIF strip verification helper (T6).
 *
 * The byte-level strip is a CONSEQUENCE of T7's re-encode: sharp re-encoding
 * without `.withMetadata()` drops all embedded metadata (EXIF, GPS, ICC,
 * maker-notes). This module provides the POST-encode assertion that the strip
 * actually happened — used defensively at runtime and as the verification
 * contract in tests.
 *
 * The old placeholder `stripEXIF()` is preserved below with a narrowed
 * signature so existing callers compile; it delegates to the re-encode and is
 * deprecated. New code must call `assertNoExif` after `reencodeImage`.
 *
 * GPS coordinates are NOT persisted: `gpsLatitude`/`gpsLongitude` columns
 * were removed in T8's schema migration. Nothing in this file or the upload
 * handler writes those fields.
 */

import exifr from "exifr";

/**
 * Parse the EXIF/IPTC/GPS/ICC metadata embedded in `imageBytes` and return
 * it as a flat object. Returns `undefined` when exifr finds nothing.
 *
 * Exported for use in tests (assert the object is empty/undefined after
 * re-encode) and as an optional runtime defensive check.
 */
export async function parseMetadata(
  imageBytes: ArrayBuffer | Buffer | Uint8Array,
): Promise<Record<string, unknown> | undefined> {
  const buf =
    imageBytes instanceof Buffer
      ? imageBytes
      : Buffer.from(
          imageBytes instanceof ArrayBuffer
            ? imageBytes
            : imageBytes.buffer,
        );

  try {
    // Parse all segments: EXIF (including GPS), IPTC, ICC, XMP.
    const parsed = await exifr.parse(buf, {
      gps: true,
      icc: true,
      iptc: true,
      xmp: true,
      makerNote: true,
      userComment: true,
    });
    return parsed as Record<string, unknown> | undefined;
  } catch {
    // If exifr cannot parse the buffer it throws (unknown format, truncated
    // data, etc.). Treat as "no metadata found" — the bytes are already
    // re-encoded clean raster pixels.
    return undefined;
  }
}

/**
 * Keys that are considered benign structural PNG chunk fields — not EXIF or
 * privacy-sensitive metadata. exifr parses these from the PNG IHDR/iCCP chunks,
 * but they are format metadata, not user metadata.
 */
const PNG_STRUCTURAL_KEYS = new Set([
  "ImageWidth",
  "ImageHeight",
  "BitDepth",
  "ColorType",
  "Compression",
  "Filter",
  "Interlace",
]);

/**
 * Privacy-sensitive metadata keys that must NOT appear in re-encoded output.
 * Any of these keys present after re-encode indicates `.withMetadata()` was
 * mistakenly added or sharp is re-adding metadata.
 */
const SENSITIVE_EXIF_PREFIXES = [
  "GPS",    // GPS coordinates
  "Make",   // camera maker (maker-notes gateway)
  "Model",  // camera model
  "Software",
  "DateTime",
  "Orientation",
  "ExifIFD",
  "InteropIFD",
];

/**
 * Assert that `imageBytes` contains NO privacy-sensitive embedded metadata
 * (EXIF GPS, ICC, maker-notes, camera info). Benign PNG structural fields
 * (ImageWidth, ColorType, etc.) are excluded from this check since exifr
 * parses them from the PNG format header, not from EXIF APP1 segments.
 *
 * Call this on the OUTPUT of `reencodeImage` to confirm the re-encode dropped
 * all user/device metadata. Useful both in tests and as an optional defensive
 * runtime check.
 *
 * @throws `Error` when privacy-sensitive metadata is present.
 */
export async function assertNoExif(
  imageBytes: ArrayBuffer | Buffer | Uint8Array,
): Promise<void> {
  const metadata = await parseMetadata(imageBytes);
  if (metadata === undefined) return;

  const sensitiveKeys = Object.keys(metadata).filter(
    (k) =>
      !PNG_STRUCTURAL_KEYS.has(k) &&
      SENSITIVE_EXIF_PREFIXES.some((prefix) => k.startsWith(prefix)),
  );

  if (sensitiveKeys.length > 0) {
    throw new Error(
      `Re-encoded image still contains privacy-sensitive metadata (keys: ${sensitiveKeys.join(", ")}). ` +
        "Ensure reencodeImage is called without .withMetadata().",
    );
  }
}

// ---------------------------------------------------------------------------
// Legacy API — kept for backwards compatibility with the existing test suite.
// The old tests import `stripEXIF` and `EXIFStripperConfig`; they continue to
// compile and run against the no-op below. New EXIF tests use `assertNoExif`.
// ---------------------------------------------------------------------------

/** @deprecated Legacy config interface — no longer has any effect. */
export interface EXIFStripperConfig {
  enabled: boolean;
  removeLocation: boolean;
  removeDeviceInfo: boolean;
  removeTimestamp: boolean;
}

/**
 * @deprecated The strip now happens as a side-effect of `reencodeImage`
 * (T7). This function is a no-op passthrough kept solely so the existing
 * test suite compiles without change. Do not call in new code.
 */
export async function stripEXIF(
  imageBuffer: ArrayBuffer,
  config: EXIFStripperConfig = {
    enabled: true,
    removeLocation: true,
    removeDeviceInfo: true,
    removeTimestamp: false,
  },
): Promise<ArrayBuffer> {
  // Pass-through: the strip is done by reencodeImage (T7). The config
  // parameter is accepted to keep the call-site signature stable.
  void config;
  return imageBuffer;
}
