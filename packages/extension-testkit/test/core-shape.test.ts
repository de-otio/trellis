/**
 * `assertCoreShape` — the guard between a too-old core and a confusing crash.
 *
 * Pure unit tests against stubs. They need no docker stack and no server, and
 * deliberately do not go through `loadCore()`: that resolves a fixed specifier,
 * so the only way to exercise the wrong-core path is to hand the checker the
 * wrong module directly. That is the whole reason the check is a separate
 * exported function rather than an inline `if` inside `loadCore()`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

describe("MINIMUM_CORE_VERSION vs the peerDependencies range", () => {
  /** `MAJOR.MINOR.PATCH[-prerelease]`, ordered with prerelease below release. */
  function compare(a: string, b: string): number {
    const parse = (v: string) => {
      const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
      if (!m) throw new Error(`unparseable version: ${v}`);
      return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
    };
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < 3; i++) {
      if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
    }
    if (x.pre === y.pre) return 0;
    if (x.pre === null) return 1;
    if (y.pre === null) return -1;
    return x.pre < y.pre ? -1 : 1;
  }

  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { peerDependencies?: Record<string, string> };
  const range = manifest.peerDependencies?.["@de-otio/trellis"] ?? "";

  it("declares core as a `>=` peer range", () => {
    expect(range).toMatch(/^>=\d/);
  });

  it("keeps the guard at or ahead of the range floor, never behind it", () => {
    // Ahead is the normal state: a peer range may only name a version that is
    // already on the registry, and three of the members the testkit calls ship
    // for the first time alongside this package. Behind would mean npm refuses
    // installs the testkit would have accepted — enforcement nobody wrote down.
    expect(compare(MINIMUM_CORE_VERSION, range.slice(2))).toBeGreaterThanOrEqual(0);
  });

  it("orders prereleases below the release they precede", () => {
    // Guards the comparator itself: without this the check above would pass
    // vacuously on exactly the version shapes this repo uses.
    expect(compare("0.25.0-alpha.8", "0.25.0-alpha.7")).toBeGreaterThan(0);
    expect(compare("0.25.0", "0.25.0-alpha.8")).toBeGreaterThan(0);
    expect(compare("0.25.0-alpha.7", "0.25.0-alpha.7")).toBe(0);
    expect(compare("0.24.0", "0.25.0-alpha.7")).toBeLessThan(0);
  });
});
