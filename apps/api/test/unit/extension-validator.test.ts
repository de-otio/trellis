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
import {
  csrfMiddleware,
  requireSessionMiddleware,
} from "../../src/lib/middleware.js";
import { CORE_SECRET_ENV_KEYS } from "../../src/lib/extension-config-keys.js";
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

/**
 * A gate core actually built. Core's `Middleware` context carries `env`, which
 * the extension-api `Middleware` type does not, so a real extension casts here
 * too — the cast is the shape of the seam, not a test shortcut.
 */
function coreGate() {
  return requireSessionMiddleware() as any;
}

/**
 * A hand-written no-op named exactly like core's gate. The validator used to
 * accept this on `.name` alone; it defends nothing.
 */
async function authMiddleware(_ctx: any, next: () => Promise<Response>) {
  return next();
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
            middleware: [coreGate()],
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
            middleware: [coreGate()],
          },
        ],
      });
      expect(() => validateExtensions([ext])).not.toThrow();
    });
  });

  // SEC M5 — raw `ext.routes` bypass core wrapping entirely: no auth, no CSRF,
  // no security headers, and the handler is handed the FULL core Env
  // (SESSION_SECRET, DATABASE_URL, KV bindings). The validator used to only
  // *warn* about a raw route with no auth middleware; a boot-log warning is not
  // a control, so it now REJECTS at startup.
  describe("auth middleware on raw ext.routes (SEC M5)", () => {
    it("REJECTS a raw route with no auth middleware", () => {
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
      expect(() => validateExtensions([ext])).toThrow(
        /raw route "List dogs" carries no core gate middleware/,
      );
    });

    it("REJECTS a raw route whose middleware array is empty", () => {
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs",
            handler: async () => new Response(""),
            middleware: [],
          },
        ],
      });
      expect(() => validateExtensions([ext])).toThrow(/no core gate middleware/);
    });

    it("REJECTS when middleware is present but none of it is auth/CSRF", () => {
      async function corsMiddleware(_ctx: any, next: () => Promise<Response>) {
        return next();
      }
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs",
            handler: async () => new Response(""),
            middleware: [corsMiddleware as any],
          },
        ],
      });
      expect(() => validateExtensions([ext])).toThrow(/no core gate middleware/);
    });

    it("names the offending extension and points at the wrapped path", () => {
      const ext = makeExtension({
        id: "evilext",
        routes: [
          { path: "/api/pwn", handler: async () => new Response("") },
        ],
      });
      let message = "";
      try {
        validateExtensions([ext]);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('"evilext"');
      expect(message).toContain("extensionRoutes");
      expect(message).toContain("SESSION_SECRET");
    });

    it("accepts a raw route carrying core's requireSessionMiddleware()", () => {
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs",
            handler: async () => new Response(""),
            middleware: [coreGate()],
            description: "List dogs",
          },
        ],
      });
      expect(() => validateExtensions([ext])).not.toThrow();
    });

    it("accepts a raw route carrying core's csrfMiddleware()", () => {
      // This is the case the OLD name check REJECTED: `csrfMiddleware()`
      // returns an anonymous arrow, so its `.name` is "" and the guard that
      // claimed to look for it never matched it.
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs",
            handler: async () => new Response(""),
            middleware: [csrfMiddleware() as any],
          },
        ],
      });
      expect(() => validateExtensions([ext])).not.toThrow();
    });

    // ── Sweep C7 — the guard is on identity, not on the label ──────────────
    //
    // The old guard read `m.name === "authMiddleware" || "csrfMiddleware"`.
    // `.name` is a property of the function the EXTENSION supplies, so the one
    // route mount that bypasses every core gate was protected by a string the
    // attacker writes. These four tests are the ones that fail on the old code.

    it("REJECTS a hand-written no-op named authMiddleware", () => {
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs",
            handler: async () => new Response(""),
            middleware: [authMiddleware as any],
            description: "Pretend gate",
          },
        ],
      });
      expect(() => validateExtensions([ext])).toThrow(
        /carries no core gate middleware/,
      );
    });

    it("REJECTS a hand-written no-op named csrfMiddleware", () => {
      async function csrfMiddleware(_ctx: any, next: () => Promise<Response>) {
        return next();
      }
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs",
            handler: async () => new Response(""),
            middleware: [csrfMiddleware as any],
          },
        ],
      });
      expect(() => validateExtensions([ext])).toThrow(/no core gate middleware/);
    });

    it("REJECTS a no-op whose `name` is assigned to match after the fact", () => {
      // `Function.prototype.name` is configurable, so even a lambda can claim
      // the label. Nothing an extension can write to its own function object
      // may satisfy the guard.
      const impostor = async (_ctx: any, next: () => Promise<Response>) => next();
      Object.defineProperty(impostor, "name", { value: "csrfMiddleware" });
      expect(impostor.name).toBe("csrfMiddleware");

      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs",
            handler: async () => new Response(""),
            middleware: [impostor as any],
          },
        ],
      });
      expect(() => validateExtensions([ext])).toThrow(/no core gate middleware/);
    });

    it("REJECTS a plain object carrying the tag as an own enumerable property", () => {
      // The tag is only meaningful on a function core built. A data object
      // that copies the symbol is not a middleware and must not pass.
      const tag = Symbol.for("de-otio.trellis.coreGateMiddleware");
      const fake = { [tag]: true };
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs",
            handler: async () => new Response(""),
            middleware: [fake as any],
          },
        ],
      });
      expect(() => validateExtensions([ext])).toThrow(/no core gate middleware/);
    });

    it("the error names the extension, the gates, and the preferred path", () => {
      const ext = makeExtension({
        id: "evilext",
        routes: [
          {
            path: "/api/pwn",
            handler: async () => new Response(""),
            middleware: [authMiddleware as any],
          },
        ],
      });
      let message = "";
      try {
        validateExtensions([ext]);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('"evilext"');
      expect(message).toContain("requireSessionMiddleware()");
      expect(message).toContain("extensionRoutes");
    });

    it("the first-party shape (routes: [], wrapped extensionRoutes) still loads", () => {
      // The dogs extension declares `routes: []` and wires everything through
      // `extensionRoutes` (core-wrapped). Rejecting raw unauthenticated routes
      // must not break it — this pins that.
      const ext = makeExtension({
        id: "dog",
        routes: [],
        extensionRoutes: [
          { path: "/api/ext/dog/entities", method: "GET", handler: async () => ({}) },
        ] as any,
      });
      expect(() => validateExtensions([ext])).not.toThrow();
    });
  });

  // ── Sweep C8 — a configSchema may not name a core secret ─────────────────
  //
  // `createExtensionContext` fills `ctx.config` from `process.env` for every
  // key the schema declares, so declaring the key WAS the exploit:
  // `z.object({ SESSION_SECRET: z.string() })` handed over the session-signing
  // key while the package docs promised core secrets are never exposed. The
  // existing coverage only checked an *undeclared* key, which was never the
  // hole. These fail on the old code.
  describe("core secrets in configSchema (C8)", () => {
    it("REJECTS a configSchema declaring SESSION_SECRET", () => {
      const ext = makeExtension({
        id: "dog",
        configSchema: z.object({ SESSION_SECRET: z.string() }),
      });
      expect(() => validateExtensions([ext])).toThrow(
        /declares core secret env key\(s\) in its configSchema: SESSION_SECRET/,
      );
    });

    it("REJECTS every key on the core-secret list, one at a time", () => {
      for (const key of CORE_SECRET_ENV_KEYS) {
        const ext = makeExtension({
          id: "dog",
          configSchema: z.object({ [key]: z.string().optional() }),
        });
        expect(
          () => validateExtensions([ext]),
          `expected boot refusal for ${key}`,
        ).toThrow(new RegExp(`configSchema: ${key}`));
      }
    });

    it("names every denied key at once, not just the first", () => {
      const ext = makeExtension({
        id: "dog",
        configSchema: z.object({
          DOG_FEATURE_FLAG: z.string().optional(),
          SESSION_SECRET: z.string().optional(),
          DATABASE_URL: z.string().optional(),
        }),
      });
      let message = "";
      try {
        validateExtensions([ext]);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("SESSION_SECRET");
      expect(message).toContain("DATABASE_URL");
      expect(message).not.toContain("DOG_FEATURE_FLAG");
    });

    it("still accepts an extension's own config keys", () => {
      const ext = makeExtension({
        id: "dog",
        configSchema: z.object({
          DOG_REGISTRY_URL: z.string().optional(),
          DOG_VISION_API_KEY: z.string().optional(),
        }),
      });
      expect(() => validateExtensions([ext])).not.toThrow();
    });

    it("accepts an empty configSchema — the live first-party shape", () => {
      expect(() =>
        validateExtensions([makeExtension({ id: "dog", configSchema: z.object({}) })]),
      ).not.toThrow();
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
