/**
 * Reads the synthetic-content provenance marking out of ORIGINAL image bytes,
 * BEFORE the T7 re-encode strips all embedded metadata (AI Act Art. 50).
 *
 * WHY THIS MODULE EXISTS AT ALL. The ingest pipeline re-encodes every image
 * without `.withMetadata()`, which drops EXIF/IPTC/XMP and any C2PA manifest —
 * and `assertNoExif` enforces that. That strip is a privacy control and must
 * stay. But the AI marking lives in exactly the metadata being destroyed, and
 * nothing read it first: extraction runs AFTER the re-encode
 * (routes/media.ts — `reencodeImage` at ~:1020, `extractAll` at ~:1058 reading
 * the ALREADY-STRIPPED `uploadBuffer`). Verified empirically: a JPEG carrying
 * `Iptc4xmpExt:DigitalSourceType` loses it completely after `sharp(...).jpeg()`.
 *
 * So this reads ONE enum's worth of provenance from the original buffer and
 * discards everything else. The strip is unchanged; we just look first.
 *
 * THE RETURN TYPE IS THE PRIVACY CONTROL. {@link ProvenanceReading} cannot carry
 * GPS, camera identity, serial numbers, or free-form metadata. A function that
 * cannot return latitude cannot leak latitude — a stronger guarantee than a code
 * comment or a reviewer's diligence. Do NOT widen it. If you need more metadata,
 * that is a different module with a different review.
 *
 * Spec: trellis-internal analysis/ai-act-transparency/04-provenance-at-ingest.md
 */

import exifr from "exifr";
import type { SyntheticSourceType } from "../provenance/types.js";

/** The ONLY thing this module may return. See the module header. */
export interface ProvenanceReading {
  /** UNKNOWN unless a marking was positively recognised. Never inferred from absence. */
  readonly sourceType: SyntheticSourceType;
  /** True when a provenance container was found, whatever it said. */
  readonly examined: boolean;
  /** Which container carried it (diagnostics only). */
  readonly container?: "xmp" | "c2pa";
}

const NOTHING: ProvenanceReading = { sourceType: "UNKNOWN", examined: false };

/**
 * IPTC `DigitalSourceType` NewsCodes → our vocabulary.
 *
 * ASYMMETRY, ON PURPOSE — this is the fail-closed rule made concrete:
 *
 *  - Values that INCREASE disclosure (the synthetic ones) are accepted from
 *    unsigned XMP. An attacker gains nothing by falsely marking their own
 *    content as AI-generated, and a *generator* marking its own output is the
 *    normal, intended case.
 *  - Values that DECREASE disclosure — notably `digitalCapture`, a claim of
 *    human camera origin — are NOT accepted here. XMP is plain text and trivially
 *    forged, so honouring it would let anyone stamp "this is a real photo" onto
 *    synthetic media. Those map to UNKNOWN with `examined: true`: we looked, and
 *    we decline to assert human origin on an unauthenticated claim.
 *
 * A signed C2PA manifest could justify HUMAN_CREATED, which is precisely why
 * manifest validation is a separate, deferred decision (hub Q1).
 */
const SOURCE_TYPE_BY_NEWSCODE: Readonly<
  Record<string, SyntheticSourceType>
> = {
  // Wholly synthetic.
  trainedAlgorithmicMedia: "AI_GENERATED",
  algorithmicMedia: "AI_GENERATED",
  // Human content with synthetic elements composited in.
  compositeWithTrainedAlgorithmicMedia: "AI_ASSISTED",
  trainedAlgorithmicMediaComposite: "AI_ASSISTED",
  // Captured content altered by an algorithm beyond standard editing.
  algorithmicallyEnhanced: "AI_EDITED",
  // NOTE: digitalCapture / softwareImage / composite are DELIBERATELY absent —
  // see the asymmetry note above. They yield examined:true, sourceType UNKNOWN.
};

/** The NewsCode is the last path segment of the CV URI, or a bare token. */
function newsCodeOf(raw: string): string {
  const trimmed = raw.trim();
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

/**
 * Bounded byte sniff for a C2PA/JUMBF container.
 *
 * Presence only — this does NOT parse or validate a manifest, and therefore never
 * yields a source type. That matters: a C2PA manifest usually attests CAMERA
 * CAPTURE, so mapping "manifest present" to "AI" would mislabel photojournalism
 * from provenance-enabled cameras (Leica/Sony/Nikon ship these). Presence gets us
 * `examined: true`, which is honest, and nothing more.
 *
 * Scans only a prefix: containers sit near the front of the file, and an
 * unbounded scan of an attacker-supplied buffer is a cheap DoS.
 */
function sniffC2pa(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 256 * 1024);
  const head = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    limit,
  ) as unknown as Buffer;
  // JPEG: APP11 JUMBF boxes carry the box type "jumb". PNG: a "caBX" chunk.
  return head.includes("jumb") || head.includes("caBX");
}

/**
 * Read provenance from ORIGINAL (pre-re-encode) image bytes.
 *
 * NEVER THROWS. Malformed, truncated, or hostile metadata resolves to
 * `{ UNKNOWN, examined: false }`. Provenance is a disclosure, not a safety gate —
 * it must never be able to fail an upload.
 */
export async function readProvenance(
  original: Uint8Array,
  mimeType: string,
): Promise<ProvenanceReading> {
  // Images only. Video/audio originals never transit the API (presigned
  // direct-to-S3), so their read belongs in the worker — a later phase.
  if (!mimeType.startsWith("image/")) return NOTHING;

  try {
    const c2paPresent = sniffC2pa(original);

    let parsed: unknown;
    try {
      parsed = await exifr.parse(original, {
        xmp: true,
        mergeOutput: false, // keep the Iptc4xmpExt namespace intact
        tiff: false,
        exif: false,
        gps: false, // never; the return type could not carry it anyway
      });
    } catch {
      parsed = undefined; // unparseable metadata is not an error here
    }

    const raw = (
      parsed as { Iptc4xmpExt?: { DigitalSourceType?: unknown } } | undefined
    )?.Iptc4xmpExt?.DigitalSourceType;

    if (typeof raw === "string" && raw.length > 0 && raw.length < 512) {
      const mapped = SOURCE_TYPE_BY_NEWSCODE[newsCodeOf(raw)];
      if (mapped) return { sourceType: mapped, examined: true, container: "xmp" };
      // Recognised container, unrecognised (or disclosure-reducing) assertion.
      return { sourceType: "UNKNOWN", examined: true, container: "xmp" };
    }

    if (c2paPresent) {
      return { sourceType: "UNKNOWN", examined: true, container: "c2pa" };
    }

    return NOTHING;
  } catch {
    // Belt and braces: the contract is "never throws".
    return NOTHING;
  }
}
