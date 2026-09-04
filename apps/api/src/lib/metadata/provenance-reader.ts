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
import { sniffC2paPresence } from "./c2pa-extractor.js";

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
 * Presence sniff for a C2PA/JUMBF container — {@link sniffC2paPresence} in
 * ./c2pa-extractor.ts, imported rather than re-implemented so that "a manifest
 * is present" has exactly one definition. This module's use of it is unchanged:
 * presence only, never a source type, because a manifest usually attests CAMERA
 * CAPTURE and mapping presence to "AI" would mislabel photojournalism from
 * provenance-enabled cameras (Leica/Sony/Nikon ship these).
 *
 * The manifest BYTES are a separate concern with a separate reviewed module:
 * this function's return type is still a boolean, and this function's caller
 * still returns nothing but {@link ProvenanceReading}. The sidecar extraction
 * runs beside this read in routes/media.ts, not inside it — the privacy control
 * described in the module header is that THIS return type cannot widen.
 */

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
  // direct-to-S3), so their read happens in the media-processing worker via
  // {@link readTimedMediaProvenance} — a different function because it takes
  // bounded RANGES of a possibly-enormous object rather than a whole buffer.
  if (!mimeType.startsWith("image/")) return NOTHING;

  try {
    const c2paPresent = sniffC2paPresence(original);

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

// ---------------------------------------------------------------------------
// Video / audio — the worker-side read
// ---------------------------------------------------------------------------

/**
 * The XMP-in-ISOBMFF `uuid` box GUID, from the Adobe XMP specification. An MP4 /
 * MOV / M4A carrying an XMP packet stores it in a top-level `uuid` box prefixed
 * with exactly these 16 bytes.
 */
const XMP_ISOBMFF_UUID = Buffer.from("BE7ACFCB97A942E89C71999491E3AFAC", "hex");

/** `Iptc4xmpExt:DigitalSourceType` as it appears in a raw XMP packet. */
const DIGITAL_SOURCE_TYPE_RE =
  /DigitalSourceType\s*>\s*([^<\s]{1,512})\s*</;

/**
 * Read provenance from bounded RANGES of an original video or audio object.
 *
 * WHY RANGES AND NOT THE WHOLE FILE. A video original can be hundreds of
 * megabytes; the worker must not pull one into memory to look for a few hundred
 * bytes of XMP. Callers pass a head slice and a tail slice. Both are searched
 * because MP4 writers put the `uuid` box in both places in practice — after
 * `ftyp` at the front, or appended after `mdat` at the very end (ffmpeg's own
 * output does the latter).
 *
 * ACCEPTED LIMITATION, stated rather than hidden: a marking that sits in neither
 * the head nor the tail slice — e.g. wedged between huge `mdat` chunks in the
 * middle of a long file — is MISSED, and the result is `examined: false`, which
 * reads as "no marking found", not as "there is no marking". This is a deliberate
 * bound on a resource-unbounded scan of attacker-supplied input, and it fails in
 * the safe direction only for *over*-disclosure (we may miss an AI marking; we can
 * never invent one). Widening it means streaming the container and parsing box
 * headers properly, which is a different module with a different review.
 *
 * Takes no mime type, unlike {@link readProvenance}: the only caller is the
 * media-processing worker, which is already on the timed-media path by
 * construction, and a mime string there would be a parameter that can only ever
 * hold one family of values — an invitation to pass the wrong one.
 *
 * NEVER THROWS, same contract as {@link readProvenance}.
 */
export function readTimedMediaProvenance(
  head: Uint8Array,
  tail: Uint8Array,
): ProvenanceReading {
  try {
    for (const slice of [head, tail]) {
      if (slice.length === 0) continue;
      const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.length);

      // C2PA in ISOBMFF lives in a `uuid` box too, but presence-only: a real
      // manifest usually attests camera capture, so mapping presence to "AI"
      // would mislabel provenance-enabled cameras. Same rule as the image path.
      const c2paPresent = buf.includes("jumb") || buf.includes("c2pa");

      const xmpAt = buf.indexOf(XMP_ISOBMFF_UUID);
      if (xmpAt !== -1) {
        // Search only from the packet start, and only within a bounded window —
        // an XMP packet is small, and scanning the remainder of a big slice for a
        // regex match is the DoS this whole module avoids.
        const window = buf
          .subarray(xmpAt, Math.min(xmpAt + 64 * 1024, buf.length))
          .toString("latin1");
        const match = DIGITAL_SOURCE_TYPE_RE.exec(window);
        if (match?.[1]) {
          const mapped = SOURCE_TYPE_BY_NEWSCODE[newsCodeOf(match[1])];
          if (mapped) {
            return { sourceType: mapped, examined: true, container: "xmp" };
          }
          // Recognised container, unrecognised or disclosure-reducing assertion.
          return { sourceType: "UNKNOWN", examined: true, container: "xmp" };
        }
        return { sourceType: "UNKNOWN", examined: true, container: "xmp" };
      }

      if (c2paPresent) {
        return { sourceType: "UNKNOWN", examined: true, container: "c2pa" };
      }
    }

    return NOTHING;
  } catch {
    return NOTHING;
  }
}
