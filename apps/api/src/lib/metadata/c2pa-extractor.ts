/**
 * Extracts the raw C2PA manifest-store bytes (the JUMBF box) out of ORIGINAL
 * image bytes, at the same read-before-strip point as
 * {@link ../metadata/provenance-reader.js readProvenance}.
 *
 * WHY THIS EXISTS. The T7 re-encode destroys the manifest along with all other
 * metadata, and that strip is a privacy control that must stay: a C2PA manifest
 * carries camera model, serial numbers, capture times, editing history, and
 * often an identity claim. But once the original bytes are gone the manifest is
 * unreconstructable, and a viewer can never check a Content Credentials claim
 * against anything. So we copy the manifest out before the strip and keep it as
 * a sidecar object; the served pixels stay clean.
 *
 * WHAT THIS IS NOT. It does not parse the manifest, does not read a single
 * assertion out of it, and above all does NOT check the signature. The bytes are
 * copied verbatim and recorded as unverified. Nothing here may ever be read as
 * "this claim is true" — see `docs/reference/provenance-api.md`.
 *
 * NO NEW DEPENDENCY. The two embeddings we can locate exactly (JPEG APP11 and
 * PNG `caBX`) are byte-level container structures, so they are parsed here in a
 * few dozen lines rather than by pulling in the c2pa native toolkit. Every other
 * container is reported PRESENCE-ONLY and says so, which is the honest answer.
 *
 * NEVER THROWS. Malformed, truncated, or hostile input resolves to `absent` or
 * `presence-only`. Provenance is a disclosure, not a safety gate — it must never
 * be able to fail an upload.
 */

/** How the manifest store was carried, or that we could not locate it. */
export type C2paContainer = "jpeg-app11" | "png-cabx" | "unidentified";

export type C2paScan =
  /** No C2PA/JUMBF container found. */
  | { readonly kind: "absent" }
  /**
   * A container was detected but its bytes could not be located cleanly — an
   * embedding we do not parse (WebP/GIF/…), or a JPEG/PNG whose boxes did not
   * reassemble. We record that a manifest existed and nothing more.
   */
  | { readonly kind: "presence-only"; readonly container: "unidentified" }
  /** Manifest-store bytes recovered verbatim. NOT validated, NOT verified. */
  | {
      readonly kind: "extracted";
      readonly container: "jpeg-app11" | "png-cabx";
      readonly bytes: Uint8Array;
    };

/**
 * Prefix scanned by the presence sniff. Containers sit near the front of a
 * file, and an unbounded scan of an attacker-supplied buffer is a cheap DoS.
 */
const SNIFF_LIMIT = 256 * 1024;

/** Loop guards (repo rule: every loop declares a maximum iteration count). */
const MAX_JPEG_SEGMENTS = 4096;
const MAX_PNG_CHUNKS = 4096;
const MAX_JUMBF_PACKETS = 1024;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Bounded byte sniff for a C2PA/JUMBF container. Presence only — it never
 * yields a source type, because a manifest usually attests CAMERA CAPTURE and
 * mapping presence to "AI" would mislabel photojournalism from
 * provenance-enabled cameras.
 *
 * THE ONE DEFINITION of "a manifest is present"; `provenance-reader.ts` calls
 * this rather than keeping a second copy that could drift from it.
 */
export function sniffC2paPresence(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, SNIFF_LIMIT);
  const head = asBuffer(bytes, 0, limit);
  // JPEG: APP11 JUMBF boxes carry the box type "jumb". PNG: a "caBX" chunk.
  return head.includes("jumb") || head.includes("caBX");
}

/**
 * Locate and copy the C2PA manifest store out of original image bytes.
 *
 * DISPATCHES ON MAGIC BYTES, NOT THE DECLARED MIME TYPE. The mime string is
 * attacker-supplied and a polyglot can carry two plausible ones; the container
 * parser must agree with the bytes it is actually walking.
 */
export function extractC2pa(original: Uint8Array): C2paScan {
  try {
    const buf = asBuffer(original, 0, original.length);

    let located: C2paScan | null = null;
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      located = extractFromJpeg(buf);
    } else if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
      located = extractFromPng(buf);
    }

    if (located !== null) return located;

    // Either a container we do not parse, or a JPEG/PNG whose boxes did not
    // reassemble. Presence is still the honest answer when the sniff sees one.
    return sniffC2paPresence(original)
      ? { kind: "presence-only", container: "unidentified" }
      : { kind: "absent" };
  } catch {
    // Belt and braces: the contract is "never throws".
    return sniffC2paPresence(original)
      ? { kind: "presence-only", container: "unidentified" }
      : { kind: "absent" };
  }
}

// ---------------------------------------------------------------------------
// JPEG — APP11 JUMBF reassembly (ISO/IEC 19566-5 Annex B)
// ---------------------------------------------------------------------------

/**
 * A JUMBF box larger than one 64 KiB APP11 segment is split across several, so
 * the box is REASSEMBLED, not just found. Each APP11 payload is
 *
 *   'J' 'P' | En (2, box instance) | Z (4, 1-based packet sequence)
 *           | LBox (4) | TBox (4) | fragment…
 *
 * with LBox/TBox repeated in every packet of the same instance. The box is
 * `LBox || TBox || concat(fragments in Z order)`, and `LBox` must equal its
 * total length — which is the check that tells a clean reassembly from a
 * mangled one.
 *
 * Returns null (→ caller falls back to presence-only) on ANY irregularity:
 * a gap in the Z sequence, a TBox that is not `jumb`, an LBox that disagrees
 * with the bytes, or the 64-bit extended-length form we do not implement.
 */
function extractFromJpeg(buf: Buffer): C2paScan | null {
  /** box instance (En) → packets seen for it */
  const instances = new Map<number, Array<{ z: number; fragment: Buffer; header: Buffer }>>();

  let offset = 2; // past SOI
  for (let seg = 0; seg < MAX_JPEG_SEGMENTS; seg++) {
    if (offset + 1 >= buf.length) break;
    if (buf[offset] !== 0xff) break; // desynchronised — stop, do not guess
    const marker = buf[offset + 1]!;
    offset += 2;

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue; // standalone markers carry no length
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan

    if (offset + 2 > buf.length) break;
    const segLength = buf.readUInt16BE(offset);
    if (segLength < 2) break;
    const payloadStart = offset + 2;
    const payloadEnd = offset + segLength;
    if (payloadEnd > buf.length) break;
    offset = payloadEnd;

    if (marker !== 0xeb) continue; // not APP11
    const payload = buf.subarray(payloadStart, payloadEnd);
    // 'JP' + En(2) + Z(4) + LBox(4) + TBox(4) = 16 bytes of framing.
    if (payload.length < 16) continue;
    if (payload[0] !== 0x4a || payload[1] !== 0x50) continue; // CI != 'JP'

    const en = payload.readUInt16BE(2);
    const z = payload.readUInt32BE(4);
    const header = payload.subarray(8, 16); // LBox || TBox
    const fragment = payload.subarray(16);

    const packets = instances.get(en) ?? [];
    packets.push({ z, fragment, header });
    instances.set(en, packets);
  }

  if (instances.size === 0) return null;

  const boxes: Buffer[] = [];
  let total = 0;
  for (const en of [...instances.keys()].sort((a, b) => a - b)) {
    const box = reassembleInstance(instances.get(en)!);
    if (box === null) return null; // an irregular instance poisons the whole read
    boxes.push(box);
    total += box.length;
    // A reassembled store can never exceed the file it came from.
    if (total > buf.length) return null;
  }

  if (boxes.length === 0) return null;
  return {
    kind: "extracted",
    container: "jpeg-app11",
    bytes: new Uint8Array(Buffer.concat(boxes)),
  };
}

function reassembleInstance(
  packets: Array<{ z: number; fragment: Buffer; header: Buffer }>,
): Buffer | null {
  if (packets.length === 0 || packets.length > MAX_JUMBF_PACKETS) return null;

  const ordered = [...packets].sort((a, b) => a.z - b.z);
  // Z is 1-based and contiguous; a gap or a duplicate means we are missing or
  // double-counting bytes, and a manifest assembled from those is worthless.
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.z !== i + 1) return null;
  }

  const header = ordered[0]!.header;
  if (header.subarray(4, 8).toString("latin1") !== "jumb") return null;

  const lbox = header.readUInt32BE(0);
  // LBox 0 ("to end of file") and 1 (64-bit XLBox follows) are legal JUMBF but
  // are not produced by the C2PA JPEG embedding; we decline rather than guess.
  if (lbox < 8) return null;

  const body = Buffer.concat(ordered.map((p) => p.fragment));
  if (lbox !== 8 + body.length) return null;

  return Buffer.concat([header, body]);
}

// ---------------------------------------------------------------------------
// PNG — the `caBX` chunk
// ---------------------------------------------------------------------------

/**
 * The C2PA PNG embedding puts the JUMBF manifest store in a private ancillary
 * chunk named `caBX`. Chunk framing is length(4) | type(4) | data | crc(4), so
 * the data needs no reassembly — only a walk.
 *
 * The CRC is deliberately NOT checked: a wrong CRC would mean corrupt bytes,
 * and a corrupt manifest is exactly as unverified as an intact one. Skipping it
 * keeps this parser honest about how little it establishes.
 */
function extractFromPng(buf: Buffer): C2paScan | null {
  const parts: Buffer[] = [];
  let offset = 8; // past the signature
  let total = 0;

  for (let chunk = 0; chunk < MAX_PNG_CHUNKS; chunk++) {
    if (offset + 8 > buf.length) break;
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("latin1");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > buf.length || dataEnd + 4 > buf.length) break;

    if (type === "caBX") {
      parts.push(buf.subarray(dataStart, dataEnd));
      total += length;
      if (total > buf.length) return null;
    }

    if (type === "IEND") break;
    offset = dataEnd + 4; // past the CRC
  }

  if (parts.length === 0) return null;
  return {
    kind: "extracted",
    container: "png-cabx",
    bytes: new Uint8Array(Buffer.concat(parts)),
  };
}

// ---------------------------------------------------------------------------

/** View a slice of a Uint8Array as a Buffer without copying it. */
function asBuffer(bytes: Uint8Array, from: number, length: number): Buffer {
  return Buffer.from(
    bytes.buffer,
    bytes.byteOffset + from,
    length,
  ) as unknown as Buffer;
}
