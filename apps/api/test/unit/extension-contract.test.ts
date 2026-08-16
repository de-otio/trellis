/**
 * Extension-API contract tests (Stage 4).
 *
 * In-process, no server/infra. Locks the TrellisExtension contract using the
 * dummy-target fixtures, so a breaking change to the extension API fails here
 * — before publish — rather than downstream in a consuming vertical.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

// Boot warnings (undeclared extensionApiVersion, missing auth middleware) are
// assertable rather than stdout noise.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), trace: vi.fn() },
}));
vi.mock("../../src/lib/logger", () => ({
  getLogger: () => mockLogger,
  Logger: class {},
}));

import { validateExtensions } from "../../src/lib/extension-validator.js";
import { EXTENSION_API_VERSION } from "@de-otio/trellis-extension-api";
import type { TrellisExtension } from "@de-otio/trellis-extension-api";
import {
  exampleExtension,
  minimalExtension,
  hookCalls,
  resetHookCalls,
} from "@de-otio/trellis-extension-testkit/example";

describe("extension contract: validateExtensions", () => {
  it("accepts the full and minimal reference extensions", () => {
    expect(() => validateExtensions([exampleExtension, minimalExtension])).not.toThrow();
  });

  it("rejects a reserved id", () => {
    const ext = { ...minimalExtension, id: "admin" };
    expect(() => validateExtensions([ext])).toThrow(/reserved/i);
  });

  it("rejects an invalid id format (uppercase / too short)", () => {
    expect(() => validateExtensions([{ ...minimalExtension, id: "X" }])).toThrow(/lowercase|2-32/i);
    expect(() => validateExtensions([{ ...minimalExtension, id: "Widget" }])).toThrow(
      /lowercase|2-32/i,
    );
  });

  it("rejects duplicate ids", () => {
    expect(() => validateExtensions([minimalExtension, { ...minimalExtension }])).toThrow(
      /duplicate/i,
    );
  });

  it("rejects routes that shadow a reserved core prefix", () => {
    const ext = {
      ...minimalExtension,
      id: "shadower",
      routes: [
        {
          path: "/api/admin/steal",
          method: "GET",
          handler: async () => new Response(null),
        },
      ],
    };
    expect(() => validateExtensions([ext as any])).toThrow(/reserved prefix/i);
  });
});

/**
 * `extensionApiVersion` (added in extension-api 0.8.0) is a NEW OPTIONAL field
 * on TrellisExtension. This block is the deliberate acknowledgement of that
 * contract change: it pins both halves of the compatibility promise —
 * omitting the field must stay valid forever (every pre-0.8.0 extension omits
 * it), and declaring it must gate startup on compatibility.
 */
describe("extension contract: extensionApiVersion (extension-api 0.8.0)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("the minimal reference extension omits the field and remains valid", () => {
    // Backward compatibility: the field is additive, never required. The
    // minimal fixture is the one that carries this promise — it exists to omit
    // every optional field — while `exampleExtension` models the good version
    // and declares it. Two fixtures, two jobs.
    expect(minimalExtension.extensionApiVersion).toBeUndefined();
    expect(exampleExtension.extensionApiVersion).toBe(EXTENSION_API_VERSION);
    expect(() => validateExtensions([exampleExtension, minimalExtension])).not.toThrow();
  });

  it("omitting the field warns exactly once, naming every extension that omits it", () => {
    const alsoUndeclared: TrellisExtension = { ...minimalExtension, id: "undeclared" };
    validateExtensions([exampleExtension, minimalExtension, alsoUndeclared]);
    const versionWarnings = mockLogger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("extensionApiVersion"));
    expect(versionWarnings).toHaveLength(1);
    expect(versionWarnings[0]).toContain(`"${minimalExtension.id}"`);
    expect(versionWarnings[0]).toContain(`"${alsoUndeclared.id}"`);
    // …and says nothing about the one that declared it.
    expect(versionWarnings[0]).not.toContain(`"${exampleExtension.id}"`);
  });

  it("declaring the current version is accepted silently", () => {
    const declared: TrellisExtension = {
      ...minimalExtension,
      extensionApiVersion: EXTENSION_API_VERSION,
    };
    expect(() => validateExtensions([declared])).not.toThrow();
    const versionWarnings = mockLogger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("extensionApiVersion"));
    expect(versionWarnings).toHaveLength(0);
  });

  it("declaring an incompatible version fails startup", () => {
    const stale: TrellisExtension = {
      ...minimalExtension,
      extensionApiVersion: "0.1.0",
    };
    expect(() => validateExtensions([stale], "0.8.0")).toThrow(
      /built against extension-api 0\.1\.0/,
    );
  });
});

describe("extension contract: metadataSchema", () => {
  it("the example schema accepts valid metadata", () => {
    const r = exampleExtension.metadataSchema.safeParse({
      color: "blue",
      size: "m",
    });
    expect(r.success).toBe(true);
  });

  it("the example schema rejects an out-of-enum size", () => {
    const r = exampleExtension.metadataSchema.safeParse({
      color: "blue",
      size: "xl",
    });
    expect(r.success).toBe(false);
  });

  it("the example schema rejects missing required fields and unknown keys", () => {
    expect(exampleExtension.metadataSchema.safeParse({ color: "blue" }).success).toBe(false);
    expect(
      exampleExtension.metadataSchema.safeParse({
        color: "blue",
        size: "m",
        rogue: 1,
      }).success,
    ).toBe(false); // .strict()
  });

  it("the minimal schema accepts arbitrary object metadata", () => {
    expect(minimalExtension.metadataSchema.safeParse({ anything: true }).success).toBe(true);
  });
});

describe("extension contract: optional surfaces", () => {
  it("computeLifeStage derives a value from metadata", () => {
    expect(exampleExtension.computeLifeStage?.({ size: "l" }, false, null)).toBe("mature");
    expect(exampleExtension.computeLifeStage?.({ size: "m" }, false, null)).toBeNull();
  });

  it("activityPub.enrichActor returns display-only fields", () => {
    const a = exampleExtension.activityPub?.enrichActor?.({
      name: "Spinny",
      metadata: { color: "red" },
    });
    expect(a?.summary).toContain("Spinny");
    expect(a?.attachment?.[0]).toMatchObject({ name: "Color", value: "red" });
  });
});

describe("extension contract: lifecycle", () => {
  beforeEach(() => resetHookCalls());

  // `shutdown` is the one lifecycle callback core actually invokes
  // (server.ts, on SIGTERM/SIGINT). Everything this block used to cover —
  // `init` and the five `hooks` — was declared by the contract but never
  // dispatched by core, so these assertions passed against the fixture's own
  // functions while proving nothing about core. Removed with that surface.
  it("shutdown fires and records", async () => {
    await exampleExtension.shutdown?.();
    expect(hookCalls.map((c) => c.hook)).toContain("shutdown");
  });
});
