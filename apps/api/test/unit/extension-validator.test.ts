import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

// Mock the logger: suppresses warn noise AND makes the boot warnings
// (undeclared extensionApiVersion, version drift) assertable.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), trace: vi.fn() },
}));
vi.mock("../../src/lib/logger", () => ({
  getLogger: () => mockLogger,
  Logger: class {},
}));

import {
  validateExtensions,
  parseApiVersion,
  classifyApiVersion,
  MAX_API_VERSION_LENGTH,
} from "../../src/lib/extension-validator.js";
import { EXTENSION_API_VERSION } from "@de-otio/trellis-extension-api";
import type { TrellisExtension } from "@de-otio/trellis-extension-api";
import { z } from "zod";

beforeEach(() => {
  vi.clearAllMocks();
});

/** Every warn message emitted during the call, joined for substring matching. */
function warnedMessages(): string {
  return mockLogger.warn.mock.calls.map((c) => String(c[0])).join("\n");
}

function makeExtension(overrides: Partial<TrellisExtension> = {}): TrellisExtension {
  return {
    id: "test",
    terminology: { entity: "test", entityPlural: "tests" },
    routes: [],
    metadataSchema: z.object({}),
    ...overrides,
  };
}

describe("validateExtensions", () => {
  describe("crossTenantRead validation (05a Part B)", () => {
    it("accepts a declaration within the core discover allow-list", () => {
      expect(() =>
        validateExtensions([
          makeExtension({ id: "dog", crossTenantRead: ["post", "postTaxonomyTag", "taxonomyTaxon"] }),
        ]),
      ).not.toThrow();
    });

    it("fails startup on a model outside the allow-list", () => {
      expect(() =>
        validateExtensions([makeExtension({ id: "dog", crossTenantRead: ["user"] })]),
      ).toThrow(/not permitted for cross-tenant discovery: user/);
    });

    it("accepts an absent declaration", () => {
      expect(() => validateExtensions([makeExtension({ id: "dog" })])).not.toThrow();
    });
  });

  describe("ID validation", () => {
    it("accepts valid extension IDs", () => {
      expect(() => validateExtensions([makeExtension({ id: "dog" })])).not.toThrow();
      expect(() => validateExtensions([makeExtension({ id: "plant-care" })])).not.toThrow();
      expect(() => validateExtensions([makeExtension({ id: "my_ext_01" })])).not.toThrow();
    });

    it("rejects IDs that are too short", () => {
      expect(() => validateExtensions([makeExtension({ id: "a" })])).toThrow(
        /must be lowercase alphanumeric/,
      );
    });

    it("rejects IDs with uppercase", () => {
      expect(() => validateExtensions([makeExtension({ id: "Dog" })])).toThrow(
        /must be lowercase alphanumeric/,
      );
    });

    it("rejects IDs starting with a number", () => {
      expect(() => validateExtensions([makeExtension({ id: "1dog" })])).toThrow(
        /must be lowercase alphanumeric/,
      );
    });

    it("rejects reserved IDs", () => {
      for (const reserved of ["user", "admin", "system", "internal"]) {
        expect(() => validateExtensions([makeExtension({ id: reserved })])).toThrow(
          /is reserved/,
        );
      }
    });

    it("rejects duplicate IDs", () => {
      expect(() =>
        validateExtensions([
          makeExtension({ id: "dog" }),
          makeExtension({ id: "dog" }),
        ]),
      ).toThrow(/Duplicate extension ID/);
    });

    it("allows multiple unique IDs", () => {
      expect(() =>
        validateExtensions([
          makeExtension({ id: "dog" }),
          makeExtension({ id: "plant" }),
        ]),
      ).not.toThrow();
    });
  });

  describe("route validation", () => {
    it("rejects routes with reserved prefixes", () => {
      const ext = makeExtension({
        id: "evil",
        routes: [
          {
            path: "/api/auth/hijack",
            handler: async () => new Response(""),
          },
        ],
      });
      expect(() => validateExtensions([ext])).toThrow(/reserved prefix/);
    });

    it("rejects /api/admin routes", () => {
      const ext = makeExtension({
        id: "evil",
        routes: [
          {
            path: "/api/admin/takeover",
            handler: async () => new Response(""),
          },
        ],
      });
      expect(() => validateExtensions([ext])).toThrow(/reserved prefix/);
    });

    it("rejects /.well-known routes", () => {
      const ext = makeExtension({
        id: "evil",
        routes: [
          {
            path: "/.well-known/webfinger",
            handler: async () => new Response(""),
          },
        ],
      });
      expect(() => validateExtensions([ext])).toThrow(/reserved prefix/);
    });

    it("allows non-reserved route paths", () => {
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs/breeds",
            handler: async () => new Response(""),
          },
        ],
      });
      expect(() => validateExtensions([ext])).not.toThrow();
    });

    it("allows regex route paths that don't match reserved prefixes", () => {
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: /^\/entities\/dog\/[^/]+$/,
            handler: async () => new Response(""),
          },
        ],
      });
      expect(() => validateExtensions([ext])).not.toThrow();
    });
  });

  describe("auth middleware warnings", () => {
    it("does not throw for routes without auth middleware", () => {
      // The validator warns but doesn't throw for missing auth middleware
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs",
            handler: async () => new Response(""),
            description: "List dogs",
          },
        ],
      });
      expect(() => validateExtensions([ext])).not.toThrow();
    });

    it("does not warn for routes with auth middleware", () => {
      // Named function so .name === "authMiddleware"
      async function authMiddleware(_ctx: any, next: () => Promise<Response>) {
        return next();
      }
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs",
            handler: async () => new Response(""),
            middleware: [authMiddleware as any],
            description: "List dogs",
          },
        ],
      });
      // Should pass without any warnings or throws
      expect(() => validateExtensions([ext])).not.toThrow();
    });
  });

  describe("empty extensions", () => {
    it("accepts empty extension list", () => {
      expect(() => validateExtensions([])).not.toThrow();
    });

    it("emits no undeclared-version warning when there are no extensions", () => {
      validateExtensions([]);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// extensionApiVersion startup check (plan §4-T5)
// ---------------------------------------------------------------------------

describe("parseApiVersion (bounded semver rule, plan §2.1)", () => {
  it("parses a plain triple", () => {
    expect(parseApiVersion("0.8.0")).toEqual({ major: 0, minor: 8, patch: 0 });
    expect(parseApiVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseApiVersion("9999.9999.9999")).toEqual({
      major: 9999,
      minor: 9999,
      patch: 9999,
    });
  });

  it("ignores a pre-release or build suffix", () => {
    expect(parseApiVersion("0.8.0-alpha.1")).toEqual({ major: 0, minor: 8, patch: 0 });
    expect(parseApiVersion("0.8.0+build.7")).toEqual({ major: 0, minor: 8, patch: 0 });
  });

  it("rejects malformed shapes without throwing", () => {
    for (const bad of [
      "",
      "0.8",
      "0.8.0.0",
      "v0.8.0",
      "0.8.x",
      "00000.1.1", // 5 digits — outside the bounded group
      " 0.8.0",
      "0.8.0 ",
      "0.8.0\n1.0.0", // anchors must defeat a multiline injection
      "0.8.0alpha",
      "latest",
    ]) {
      expect(parseApiVersion(bad), `expected null for ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("rejects non-string input without throwing", () => {
    for (const bad of [undefined, null, 8, {}, [], true, Symbol("x")]) {
      expect(parseApiVersion(bad)).toBeNull();
    }
  });

  it("accepts a suffixed version exactly at the cap", () => {
    const atCap = `0.8.0-${"a".repeat(MAX_API_VERSION_LENGTH - 6)}`;
    expect(atCap.length).toBe(MAX_API_VERSION_LENGTH);
    expect(parseApiVersion(atCap)).toEqual({ major: 0, minor: 8, patch: 0 });
  });

  it("rejects one character past the cap, on length alone", () => {
    const overCap = `0.8.0-${"a".repeat(MAX_API_VERSION_LENGTH - 5)}`;
    expect(overCap.length).toBe(MAX_API_VERSION_LENGTH + 1);
    expect(parseApiVersion(overCap)).toBeNull();
  });

  it("does not throw on a pathologically long input", () => {
    expect(parseApiVersion("9".repeat(100_000))).toBeNull();
    expect(parseApiVersion(`0.8.0-${"a-+.".repeat(50_000)}`)).toBeNull();
  });

  it("property: never throws and terminates fast for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const started = Date.now();
        const parsed = parseApiVersion(s);
        expect(Date.now() - started).toBeLessThan(50);
        if (parsed !== null) {
          expect(s.length).toBeLessThanOrEqual(MAX_API_VERSION_LENGTH);
          expect(Number.isInteger(parsed.major)).toBe(true);
          expect(Number.isInteger(parsed.minor)).toBe(true);
          expect(Number.isInteger(parsed.patch)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("property: a well-formed triple always round-trips to its numbers", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9999 }),
        fc.integer({ min: 0, max: 9999 }),
        fc.integer({ min: 0, max: 9999 }),
        (major, minor, patch) => {
          expect(parseApiVersion(`${major}.${minor}.${patch}`)).toEqual({
            major,
            minor,
            patch,
          });
        },
      ),
    );
  });
});

describe("classifyApiVersion (pure compatibility decision)", () => {
  it("reports absent for undefined and null", () => {
    expect(classifyApiVersion(undefined, "0.8.0")).toEqual({ kind: "absent" });
    expect(classifyApiVersion(null, "0.8.0")).toEqual({ kind: "absent" });
  });

  it("reports match for an identical version", () => {
    expect(classifyApiVersion("0.8.0", "0.8.0")).toEqual({ kind: "match" });
  });

  it("treats a suffix difference as a match (suffixes are ignored)", () => {
    expect(classifyApiVersion("0.8.0-alpha.1", "0.8.0")).toEqual({ kind: "match" });
  });

  it("reports incompatible on a major mismatch", () => {
    const v = classifyApiVersion("1.0.0", "2.0.0");
    expect(v.kind).toBe("incompatible");
    expect(v).toMatchObject({ declared: "1.0.0", core: "2.0.0" });
  });

  it("reports incompatible on a minor mismatch while core is 0.x", () => {
    expect(classifyApiVersion("0.7.0", "0.8.0").kind).toBe("incompatible");
    expect(classifyApiVersion("0.9.0", "0.8.0").kind).toBe("incompatible");
  });

  it("reports drift (not incompatible) on a minor mismatch once core is 1.x", () => {
    expect(classifyApiVersion("1.2.0", "1.5.0").kind).toBe("drift");
  });

  it("reports drift on a patch mismatch", () => {
    expect(classifyApiVersion("0.8.1", "0.8.0").kind).toBe("drift");
    expect(classifyApiVersion("1.2.3", "1.2.9").kind).toBe("drift");
  });

  it("reports unparseable for garbage, carrying the raw value", () => {
    expect(classifyApiVersion("not-a-version", "0.8.0")).toEqual({
      kind: "unparseable",
      raw: "not-a-version",
    });
    expect(classifyApiVersion(8 as unknown as string, "0.8.0").kind).toBe("unparseable");
  });

  it("reports core-unparseable when core's own constant is malformed", () => {
    expect(classifyApiVersion("0.8.0", "not-a-version")).toEqual({
      kind: "core-unparseable",
      core: "not-a-version",
    });
  });

  it("prefers core-unparseable over a garbage declaration", () => {
    // A core packaging bug must not be reported as the extension's fault.
    expect(classifyApiVersion("garbage", "garbage").kind).toBe("core-unparseable");
  });
});

describe("validateExtensions: extensionApiVersion", () => {
  it("accepts an extension declaring the exact core version", () => {
    expect(() =>
      validateExtensions([
        makeExtension({ id: "dog", extensionApiVersion: EXTENSION_API_VERSION }),
      ]),
    ).not.toThrow();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("warns once — naming every undeclared extension — when the field is absent", () => {
    validateExtensions([
      makeExtension({ id: "dog" }),
      makeExtension({ id: "plant" }),
    ]);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const msg = warnedMessages();
    expect(msg).toContain('"dog"');
    expect(msg).toContain('"plant"');
    expect(msg).toContain("extensionApiVersion");
  });

  it("does not fail startup when the field is absent", () => {
    expect(() => validateExtensions([makeExtension({ id: "dog" })])).not.toThrow();
  });

  it("fails startup on a major mismatch, naming both versions", () => {
    expect(() =>
      validateExtensions(
        [makeExtension({ id: "dog", extensionApiVersion: "1.8.0" })],
        "2.8.0",
      ),
    ).toThrow(/built against extension-api 1\.8\.0.*core provides extension-api 2\.8\.0/s);
  });

  it("fails startup on a minor mismatch while core is 0.x, naming both versions", () => {
    expect(() =>
      validateExtensions(
        [makeExtension({ id: "dog", extensionApiVersion: "0.7.0" })],
        "0.8.0",
      ),
    ).toThrow(/0\.7\.0.*0\.8\.0.*0\.x.*minor/s);
  });

  it("allows a minor mismatch once core is 1.x, logging the drift", () => {
    expect(() =>
      validateExtensions(
        [makeExtension({ id: "dog", extensionApiVersion: "1.2.0" })],
        "1.5.0",
      ),
    ).not.toThrow();
    expect(warnedMessages()).toContain("drifted");
  });

  it("logs — and does not fail — on patch drift", () => {
    expect(() =>
      validateExtensions(
        [makeExtension({ id: "dog", extensionApiVersion: "0.8.1" })],
        "0.8.0",
      ),
    ).not.toThrow();
    const msg = warnedMessages();
    expect(msg).toContain("0.8.1");
    expect(msg).toContain("0.8.0");
    expect(msg).toContain("drifted");
  });

  it("fails startup with a precise message on a garbage version", () => {
    expect(() =>
      validateExtensions(
        [makeExtension({ id: "dog", extensionApiVersion: "banana" })],
        "0.8.0",
      ),
    ).toThrow(/unparseable extensionApiVersion: "banana" \(length 6\)/);
  });

  it("fails cleanly (never a deep throw) on an empty-string version", () => {
    expect(() =>
      validateExtensions(
        [makeExtension({ id: "dog", extensionApiVersion: "" })],
        "0.8.0",
      ),
    ).toThrow(/unparseable extensionApiVersion/);
  });

  it("fails cleanly on a non-string version smuggled past the types", () => {
    expect(() =>
      validateExtensions(
        [makeExtension({ id: "dog", extensionApiVersion: 8 as unknown as string })],
        "0.8.0",
      ),
    ).toThrow(/a non-string value of type "number"/);
  });

  it("truncates an oversized garbage version in the error message", () => {
    const huge = "9".repeat(5000);
    let message = "";
    try {
      validateExtensions(
        [makeExtension({ id: "dog", extensionApiVersion: huge })],
        "0.8.0",
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("(length 5000)");
    expect(message).toContain("…");
    expect(message.length).toBeLessThan(500);
  });

  it("fails startup when core's own version constant is malformed", () => {
    expect(() =>
      validateExtensions(
        [makeExtension({ id: "dog", extensionApiVersion: "0.8.0" })],
        "not-a-version",
      ),
    ).toThrow(/core packaging bug/);
  });

  it("checks every extension, failing on the incompatible one", () => {
    expect(() =>
      validateExtensions(
        [
          makeExtension({ id: "dog", extensionApiVersion: "0.8.0" }),
          makeExtension({ id: "plant", extensionApiVersion: "0.6.0" }),
        ],
        "0.8.0",
      ),
    ).toThrow(/"plant"/);
  });

  it("defaults to the shipped EXTENSION_API_VERSION when no core version is passed", () => {
    // Guards the lockstep contract: the const the package exports is the one
    // core validates against.
    expect(() =>
      validateExtensions([
        makeExtension({ id: "dog", extensionApiVersion: EXTENSION_API_VERSION }),
      ]),
    ).not.toThrow();
    expect(() =>
      validateExtensions([
        makeExtension({ id: "dog", extensionApiVersion: "999.0.0" }),
      ]),
    ).toThrow(new RegExp(`core provides extension-api ${EXTENSION_API_VERSION}`));
  });
});
