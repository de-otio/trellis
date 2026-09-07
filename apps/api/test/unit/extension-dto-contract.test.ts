/**
 * "Unit test" for extension-dto-contract.ts.
 *
 * This module has ZERO runtime footprint: it is a set of `Satisfies<...>`
 * type-alias assertions (`type _EntitySatisfiesDto = Satisfies<ExtensionEntity,
 * Entity>;`, etc.) whose only effect is a `tsc --build` failure when a core
 * field the published extension DTOs depend on is renamed, removed or
 * retyped. There are no branches, no values, and nothing a `vitest` assertion
 * can exercise that the compiler does not already check more precisely —
 * `npm run lint` (== `tsc --build`, CI's "Lint & Test" job, see AGENTS.md §6)
 * IS the real test for this file, and it runs on every PR.
 *
 * What a runtime test CAN usefully pin, and what this file does:
 *  1. The module is import-safe (no accidental top-level side effect / throw)
 *     and has no runtime exports — `export {}` only, so extensions importing
 *     from anywhere near this module never see contract internals leak in.
 *  2. A regression guard: if a future edit accidentally adds a runtime value
 *     export here (this file is meant to compile away to nothing), this test
 *     fails and says so, rather than silently starting to ship dead code in
 *     the public `@de-otio/trellis` package's build output.
 */

import { describe, expect, it } from "vitest";

describe("extension-dto-contract.ts", () => {
  it("imports cleanly with no runtime side effects", async () => {
    await expect(import("../../src/lib/extension-dto-contract.js")).resolves.toBeDefined();
  });

  it("has no runtime exports — it is a compile-time-only contract (`export {}`)", async () => {
    const mod = await import("../../src/lib/extension-dto-contract.js");
    expect(Object.keys(mod)).toEqual([]);
  });
});
