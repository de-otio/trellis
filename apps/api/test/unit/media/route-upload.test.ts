/**
 * Property + example tests for routeUpload.
 *
 * Obligations covered:
 * 1. All REENCODABLE_IMAGE_TYPES → sync-image.
 * 2. video/* and audio/* → async-pending.
 * 3. Unknown / empty / garbage → reject (fail-closed).
 * 4. Case-insensitive matching.
 * 5. Parameters after ";" are stripped.
 * 6. Total (never throws) for arbitrary strings including empty, null-ish,
 *    whitespace, binary-looking strings.
 * 7. Boundary: image/* non-recodable sub-types (svg, heic, tiff, …) → reject.
 * 8. Boundary: "video/" and "audio/" with empty sub-type → reject.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  routeUpload,
  type IngestRoute,
} from "../../../src/lib/media/route-upload.js";

// Seed fast-check for deterministic replays.
const FC = { seed: 0xb1a5, numRuns: 2000 } as const;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isValidKind(r: IngestRoute): boolean {
  return (
    r.kind === "sync-image" || r.kind === "async-pending" || r.kind === "reject"
  );
}

// ---------------------------------------------------------------------------
// Exhaustive example matrix — re-encodable image set
// ---------------------------------------------------------------------------

describe("routeUpload — sync-image examples", () => {
  const reencodeableTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
  ];

  for (const ct of reencodeableTypes) {
    it(`routes '${ct}' to sync-image`, () => {
      expect(routeUpload(ct)).toEqual({ kind: "sync-image" });
    });
  }
});

// ---------------------------------------------------------------------------
// Case-insensitive examples
// ---------------------------------------------------------------------------

describe("routeUpload — case-insensitive", () => {
  const cases: [string, IngestRoute["kind"]][] = [
    ["IMAGE/JPEG", "sync-image"],
    ["Image/Png", "sync-image"],
    ["IMAGE/WEBP", "sync-image"],
    ["IMAGE/GIF", "sync-image"],
    ["IMAGE/JPG", "sync-image"],
    ["VIDEO/MP4", "async-pending"],
    ["AUDIO/MPEG", "async-pending"],
    ["Video/WebM", "async-pending"],
    ["AUDIO/MP4", "async-pending"],
  ];

  for (const [ct, expected] of cases) {
    it(`routes '${ct}' to ${expected}`, () => {
      expect(routeUpload(ct).kind).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Parameter stripping examples
// ---------------------------------------------------------------------------

describe("routeUpload — parameter stripping", () => {
  const cases: [string, IngestRoute["kind"]][] = [
    ["image/jpeg; charset=utf-8", "sync-image"],
    ["image/png;q=0.9", "sync-image"],
    ["video/mp4; codecs=avc1", "async-pending"],
    ["audio/mpeg;bitrate=128", "async-pending"],
    ["image/gif; boundary=something", "sync-image"],
    ["application/octet-stream; charset=binary", "reject"],
  ];

  for (const [ct, expected] of cases) {
    it(`strips params and routes '${ct}' to ${expected}`, () => {
      expect(routeUpload(ct).kind).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Reject examples: empty / whitespace / garbage
// ---------------------------------------------------------------------------

describe("routeUpload — reject examples", () => {
  const rejectCases = [
    "",
    "   ",
    ";",
    ";image/jpeg",
    "application/octet-stream",
    "text/plain",
    "text/html",
    "application/json",
    "multipart/form-data",
    "application/pdf",
    "unknown",
    "not-a-mime",
    "/jpeg",          // missing type
    "image/",         // empty sub-type for non-handled family
    "audio/",         // bare slash, no sub-type
    "video/",         // bare slash, no sub-type
    "image/svg+xml",  // excluded (scripts)
    "image/heic",     // excluded (no libheif)
    "image/heif",     // excluded (no libheif)
    "image/tiff",     // excluded (P0a canonical set)
    "image/bmp",      // not in re-encodable set
    "image/avif",     // not in re-encodable set
    "image/x-icon",   // not in re-encodable set
  ];

  for (const ct of rejectCases) {
    it(`rejects '${ct}'`, () => {
      expect(routeUpload(ct).kind).toBe("reject");
    });
  }
});

// ---------------------------------------------------------------------------
// Video / audio variety examples
// ---------------------------------------------------------------------------

describe("routeUpload — async-pending examples", () => {
  const asyncCases = [
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/ogg",
    "video/mpeg",
    "video/x-msvideo",
    "audio/mpeg",
    "audio/mp4",
    "audio/ogg",
    "audio/wav",
    "audio/aac",
    "audio/flac",
    "audio/webm",
    "audio/x-m4a",
  ];

  for (const ct of asyncCases) {
    it(`routes '${ct}' to async-pending`, () => {
      expect(routeUpload(ct).kind).toBe("async-pending");
    });
  }
});

// ---------------------------------------------------------------------------
// Property: image => sync-image (case-insensitive, with params)
// ---------------------------------------------------------------------------

describe("property — image/* re-encodable set → sync-image", () => {
  const reencodeable = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
  ];

  it("holds for all re-encodable image types with arbitrary casing and params", () => {
    const ctArb = fc.record({
      base: fc.constantFrom(...reencodeable),
      suffix: fc.option(
        fc.stringMatching(/^;[a-zA-Z0-9=\-_.]+$/),
        { nil: undefined },
      ),
    }).map(({ base, suffix }) => {
      // Random-case the base MIME type to test case-insensitivity.
      const randomCased = base
        .split("")
        .map((c) => (Math.random() > 0.5 ? c.toUpperCase() : c))
        .join("");
      return randomCased + (suffix ?? "");
    });

    fc.assert(
      fc.property(ctArb, (ct) => {
        return routeUpload(ct).kind === "sync-image";
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------
// Property: video/* and audio/* with non-empty sub-type → async-pending
// ---------------------------------------------------------------------------

describe("property — video/* and audio/* → async-pending", () => {
  it("holds for all non-empty sub-types", () => {
    // Non-empty sub-type string (no "/" so it stays a single token)
    const subTypeArb = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9\-+.]*$/).filter(s => s.length > 0);
    const familyArb = fc.constantFrom("video", "audio", "VIDEO", "AUDIO", "Video", "Audio");

    fc.assert(
      fc.property(familyArb, subTypeArb, (family, sub) => {
        const ct = `${family}/${sub}`;
        return routeUpload(ct).kind === "async-pending";
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------
// Property: non-image/video/audio types → reject
// ---------------------------------------------------------------------------

describe("property — unknown families → reject (fail-closed)", () => {
  it("rejects all non-image/video/audio families", () => {
    // Generate a type/subtype where the type is NOT image, video, or audio.
    const unknownFamilyArb = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => {
        const lower = s.toLowerCase();
        return (
          lower !== "image" &&
          lower !== "video" &&
          lower !== "audio" &&
          /^[a-zA-Z]/.test(s) &&
          !s.includes("/") &&
          !s.includes(";")
        );
      });
    const subTypeArb = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9\-+.]*$/);

    fc.assert(
      fc.property(unknownFamilyArb, subTypeArb, (family, sub) => {
        return routeUpload(`${family}/${sub}`).kind === "reject";
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------
// Property: total — never throws for any string (including garbage)
// ---------------------------------------------------------------------------

describe("property — total: never throws", () => {
  it("handles any string without throwing", () => {
    fc.assert(
      fc.property(fc.string(), (ct) => {
        let result: IngestRoute;
        try {
          result = routeUpload(ct);
        } catch {
          return false; // must not throw
        }
        return isValidKind(result);
      }),
      FC,
    );
  });

  it("handles ascii strings with arbitrary punctuation", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme-ascii" }), (ct) => {
        let result: IngestRoute;
        try {
          result = routeUpload(ct);
        } catch {
          return false;
        }
        return isValidKind(result);
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------
// Property: fail-closed — unknown image/* sub-types never yield sync-image
// ---------------------------------------------------------------------------

describe("property — fail-closed: non-recodable image/* → reject", () => {
  const reencodeableSet = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
  ]);

  it("rejects image/* sub-types not in the re-encodable set", () => {
    const subTypeArb = fc
      .stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9\-+.]*$/)
      .filter((s) => {
        const normalized = `image/${s.toLowerCase()}`;
        return !reencodeableSet.has(normalized);
      });

    fc.assert(
      fc.property(subTypeArb, (sub) => {
        const ct = `image/${sub}`;
        return routeUpload(ct).kind === "reject";
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------
// Property: result always has exactly one 'kind' key in the union
// ---------------------------------------------------------------------------

describe("property — result is always a valid IngestRoute", () => {
  it("always returns a well-formed IngestRoute object", () => {
    fc.assert(
      fc.property(fc.string(), (ct) => {
        const result = routeUpload(ct);
        return (
          typeof result === "object" &&
          result !== null &&
          "kind" in result &&
          isValidKind(result)
        );
      }),
      FC,
    );
  });
});
