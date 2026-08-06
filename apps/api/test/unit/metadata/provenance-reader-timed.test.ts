import { describe, expect, it } from "vitest";
import { readTimedMediaProvenance } from "../../../src/lib/metadata/provenance-reader.js";

/**
 * Video/audio provenance, read from bounded RANGES of an original before the
 * transcode destroys it (AI Act Art. 50).
 *
 * Fixtures are BUILT from explicit bytes rather than committed as binaries: no
 * third-party AI video of unclear licence, deterministic, no ffmpeg dependency in
 * the unit lane, and the construction documents the on-disk format. The XMP-in-
 * ISOBMFF layout is per the Adobe XMP spec — a top-level `uuid` box whose first 16
 * bytes are the XMP GUID, followed by the packet.
 */

const XMP_UUID = Buffer.from("BE7ACFCB97A942E89C71999491E3AFAC", "hex");
const CV = "http://cv.iptc.org/newscodes/digitalsourcetype";

function xmpPacket(digitalSourceType: string): Buffer {
  return Buffer.from(
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ` +
      `xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description rdf:about="" ` +
      `xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">` +
      `<Iptc4xmpExt:DigitalSourceType>${digitalSourceType}` +
      `</Iptc4xmpExt:DigitalSourceType></rdf:Description></rdf:RDF>` +
      `</x:xmpmeta><?xpacket end="w"?>`,
    "utf8",
  );
}

/** A top-level ISOBMFF `uuid` box carrying an XMP packet. */
function xmpUuidBox(digitalSourceType: string): Buffer {
  const payload = Buffer.concat([XMP_UUID, xmpPacket(digitalSourceType)]);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write("uuid", 4, "latin1");
  return Buffer.concat([header, payload]);
}

/** A minimal, plausible MP4 prefix — `ftyp` box, no media data. */
const FTYP = (() => {
  const brands = Buffer.from("isomiso2avc1mp41", "latin1");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + 8 + brands.length, 0);
  header.write("ftyp", 4, "latin1");
  const minor = Buffer.alloc(8);
  minor.write("isom", 0, "latin1");
  minor.writeUInt32BE(512, 4);
  return Buffer.concat([header, minor, brands]);
})();

/** Filler standing in for `mdat` payload — never contains a marking. */
const MDAT = Buffer.alloc(4096, 0x11);

const EMPTY = Buffer.alloc(0);

describe("readTimedMediaProvenance — positive recognition (anti-vacuity)", () => {
  // A reader that returned UNKNOWN unconditionally would pass every negative
  // test in this file. These are the ones that fail if it does nothing.

  it("recognises trainedAlgorithmicMedia in a head-loaded uuid box", () => {
    const head = Buffer.concat([
      FTYP,
      xmpUuidBox(`${CV}/trainedAlgorithmicMedia`),
      MDAT,
    ]);
    expect(readTimedMediaProvenance(head, EMPTY)).toEqual({
      sourceType: "AI_GENERATED",
      examined: true,
      container: "xmp",
    });
  });

  it("recognises a marking in the TAIL slice, which is where ffmpeg puts it", () => {
    // Real MP4 writers — ffmpeg's own muxer included — append the uuid box after
    // mdat. A head-only reader would miss every such file.
    const tail = Buffer.concat([
      MDAT,
      xmpUuidBox(`${CV}/compositeWithTrainedAlgorithmicMedia`),
    ]);
    expect(readTimedMediaProvenance(Buffer.concat([FTYP, MDAT]), tail)).toEqual({
      sourceType: "AI_ASSISTED",
      examined: true,
      container: "xmp",
    });
  });

  it("recognises algorithmicallyEnhanced as AI_EDITED", () => {
    const head = Buffer.concat([FTYP, xmpUuidBox(`${CV}/algorithmicallyEnhanced`)]);
    expect(readTimedMediaProvenance(head, EMPTY).sourceType).toBe("AI_EDITED");
  });

  it("accepts a bare NewsCode token, not just a full CV URI", () => {
    const head = Buffer.concat([FTYP, xmpUuidBox("trainedAlgorithmicMedia")]);
    expect(readTimedMediaProvenance(head, EMPTY).sourceType).toBe("AI_GENERATED");
  });
});

describe("readTimedMediaProvenance — the fail-closed asymmetry", () => {
  it("does NOT honour an unsigned digitalCapture claim of human origin", () => {
    // Same rule as the image path: the XMP is plain text in an attacker-supplied
    // file, so honouring it would let anyone stamp "this is real footage" onto
    // synthetic video. We looked; we decline to assert human origin.
    const head = Buffer.concat([FTYP, xmpUuidBox(`${CV}/digitalCapture`)]);
    const r = readTimedMediaProvenance(head, EMPTY);
    expect(r.sourceType).toBe("UNKNOWN");
    expect(r.examined).toBe(true);
  });

  it("an unrecognised assertion is examined-but-UNKNOWN, never AI", () => {
    const head = Buffer.concat([FTYP, xmpUuidBox(`${CV}/inventedIn2027`)]);
    expect(readTimedMediaProvenance(head, EMPTY)).toEqual({
      sourceType: "UNKNOWN",
      examined: true,
      container: "xmp",
    });
  });

  it("an XMP box with no DigitalSourceType at all is examined-but-UNKNOWN", () => {
    const payload = Buffer.concat([
      XMP_UUID,
      Buffer.from("<x:xmpmeta><rdf:RDF/></x:xmpmeta>", "utf8"),
    ]);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write("uuid", 4, "latin1");
    const r = readTimedMediaProvenance(
      Buffer.concat([FTYP, header, payload]),
      EMPTY,
    );
    expect(r).toEqual({
      sourceType: "UNKNOWN",
      examined: true,
      container: "xmp",
    });
  });
});

describe("readTimedMediaProvenance — absence and hostility", () => {
  it("a clean video is UNKNOWN and NOT examined", () => {
    expect(
      readTimedMediaProvenance(Buffer.concat([FTYP, MDAT]), MDAT),
    ).toEqual({ sourceType: "UNKNOWN", examined: false });
  });

  it("never infers HUMAN_CREATED from the absence of a marking", () => {
    expect(
      readTimedMediaProvenance(Buffer.concat([FTYP, MDAT]), EMPTY).sourceType,
    ).not.toBe("HUMAN_CREATED");
  });

  it("two empty slices do not throw", () => {
    expect(readTimedMediaProvenance(EMPTY, EMPTY)).toEqual({
      sourceType: "UNKNOWN",
      examined: false,
    });
  });

  it("garbage bytes do not throw", () => {
    const junk = Buffer.from("not a container, just text");
    expect(readTimedMediaProvenance(junk, junk).sourceType).toBe("UNKNOWN");
  });

  it("a truncated uuid box does not throw", () => {
    const truncated = Buffer.concat([FTYP, XMP_UUID.subarray(0, 9)]);
    expect(() => readTimedMediaProvenance(truncated, EMPTY)).not.toThrow();
  });

  it("an absurdly long declared value is ignored", () => {
    const head = Buffer.concat([FTYP, xmpUuidBox("x".repeat(2000))]);
    expect(readTimedMediaProvenance(head, EMPTY).sourceType).toBe("UNKNOWN");
  });

  it("does not scan unboundedly past the packet for a match", () => {
    // The DoS bound: a uuid box followed by megabytes of filler with a
    // marking-looking string far beyond the window must not be found by walking
    // the whole buffer.
    const far = Buffer.concat([
      FTYP,
      XMP_UUID,
      Buffer.alloc(200 * 1024, 0x20),
      Buffer.from(`DigitalSourceType>${CV}/trainedAlgorithmicMedia<`, "utf8"),
    ]);
    const r = readTimedMediaProvenance(far, EMPTY);
    // Examined (the container was found) but the far-away value is not honoured.
    expect(r.examined).toBe(true);
    expect(r.sourceType).toBe("UNKNOWN");
  });
});

describe("readTimedMediaProvenance — C2PA container presence", () => {
  it("detects a JUMBF container without asserting AI", () => {
    // Presence only. A real C2PA manifest usually attests CAMERA CAPTURE, so
    // mapping presence to "AI" would mislabel provenance-enabled cameras.
    const head = Buffer.concat([
      FTYP,
      Buffer.from("jumb", "latin1"),
      MDAT,
    ]);
    const r = readTimedMediaProvenance(head, EMPTY);
    expect(r.examined).toBe(true);
    expect(r.container).toBe("c2pa");
    expect(r.sourceType).toBe("UNKNOWN");
  });

  it("prefers an XMP reading over bare C2PA presence", () => {
    // Both present: the XMP actually says something, so it wins. Presence alone
    // can never produce a source type, so preferring it would lose information.
    const head = Buffer.concat([
      FTYP,
      Buffer.from("jumb", "latin1"),
      xmpUuidBox(`${CV}/trainedAlgorithmicMedia`),
    ]);
    const r = readTimedMediaProvenance(head, EMPTY);
    expect(r.sourceType).toBe("AI_GENERATED");
    expect(r.container).toBe("xmp");
  });
});

describe("the documented limitation is real, and fails safe", () => {
  it("MISSES a marking that is in neither slice, reporting not-examined", () => {
    // Stated in the function doc rather than hidden: a marking wedged between
    // huge mdat chunks, outside both ranges, is not found. The result is
    // `examined: false` — which reads as "no marking found", NOT as "there is no
    // marking". It fails only toward under-disclosure of something we never saw,
    // and can never invent a label.
    const middleOnly = xmpUuidBox(`${CV}/trainedAlgorithmicMedia`);
    const head = Buffer.concat([FTYP, MDAT]);
    const tail = MDAT;
    expect(readTimedMediaProvenance(head, tail)).toEqual({
      sourceType: "UNKNOWN",
      examined: false,
    });
    // Sanity: the marking IS recognisable when it lands in a slice, so this test
    // is about the ranging, not a broken reader.
    expect(
      readTimedMediaProvenance(Buffer.concat([head, middleOnly]), tail)
        .sourceType,
    ).toBe("AI_GENERATED");
  });
});
