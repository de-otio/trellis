/**
 * `assertCoreShape` — the guard between a too-old core and a confusing crash.
 *
 * Pure unit tests against stubs. They need no docker stack and no server, and
 * deliberately do not go through `loadCore()`: that resolves a fixed specifier,
 * so the only way to exercise the wrong-core path is to hand the checker the
 * wrong module directly. That is the whole reason the check is a separate
 * exported function rather than an inline `if` inside `loadCore()`.
 */

import { describe, expect, it } from "vitest";
import { assertCoreShape, MINIMUM_CORE_VERSION } from "../src/core.js";

/** Everything `CoreModule` requires, in the shape it requires. */
function wellFormedCore(): Record<string, unknown> {
  return {
    registerExtension: () => {},
    getExtension: () => undefined,
    getExtensions: () => [],
    startServer: async () => ({}),
    shutdownTrellis: async () => ({ closed: [], failed: [] }),
    classifyApiVersion: () => ({ kind: "match" }),
    EXTENSION_API_VERSION: "0.9.2",
  };
}

describe("assertCoreShape", () => {
  it("accepts a module carrying every required member", () => {
    const core = wellFormedCore();
    expect(assertCoreShape(core)).toBe(core);
  });

  it("names every missing member, not just the first", () => {
    // This is the published 0.25.0-alpha.7 surface: the shutdown hook, the
    // version classifier and the EXTENSION_API_VERSION re-export all landed
    // after it. A range of `>=0.25.0-alpha.7` would have resolved it happily.
    const stale = wellFormedCore();
    delete stale.shutdownTrellis;
    delete stale.classifyApiVersion;
    delete stale.EXTENSION_API_VERSION;

    expect(() => assertCoreShape(stale)).toThrow(
      /shutdownTrellis, classifyApiVersion, EXTENSION_API_VERSION/,
    );
  });

  it("points at the minimum version a consumer should install", () => {
    const stale = wellFormedCore();
    delete stale.classifyApiVersion;

    expect(() => assertCoreShape(stale)).toThrow(
      new RegExp(`>= ${MINIMUM_CORE_VERSION.replace(/\./g, "\\.")}`),
    );
  });

  it("rejects a member of the wrong kind, not merely a missing one", () => {
    // A core that exported EXTENSION_API_VERSION as, say, a getter object
    // would pass an `in` check and fail later inside the version comparison.
    const wrongKind = wellFormedCore();
    wrongKind.EXTENSION_API_VERSION = { value: "0.9.2" };

    expect(() => assertCoreShape(wrongKind)).toThrow(/EXTENSION_API_VERSION/);
  });

  it("reports the version it found when core exposes one", () => {
    const stale = wellFormedCore();
    delete stale.shutdownTrellis;
    stale.VERSION = "0.25.0-alpha.7";

    expect(() => assertCoreShape(stale)).toThrow(/0\.25\.0-alpha\.7/);
  });

  it("survives a null or undefined module instead of throwing on property access", () => {
    expect(() => assertCoreShape(undefined)).toThrow(/does not export/);
    expect(() => assertCoreShape(null)).toThrow(/does not export/);
  });
});
