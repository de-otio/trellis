/**
 * Regression test: the no-DB extension-probing fallback maze is GONE (T9).
 *
 * The maze served raw S3 bytes by guessing `media/{hash}.{ext}` keys WITHOUT a
 * DB lookup — a gate-bypass and a path-injection sink. T9 deleted it. This test
 * is a source-level guard: it greps media.ts for the dead-code fingerprints so
 * a future refactor that reintroduces a no-DB storage probe fails CI.
 *
 * (The behavioral "DB null but bytes exist → deny" invariant is T5's
 * anti-oracle property suite; this test guards the structural deletion T5
 * depends on.)
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEDIA_TS = resolve(
  __dirname,
  "../../../src/lib/routes/media.ts",
);

describe("serveMediaByHash maze removal (T9)", () => {
  const source = readFileSync(MEDIA_TS, "utf8");

  it("does not interpolate the URL hash into a guessed storage key", () => {
    // The maze built keys like `media/${contentHash}.${ext}` /
    // `media/${contentHash}_thumb.${ext}`. None may remain.
    expect(source).not.toMatch(/media\/\$\{contentHash\}/);
  });

  it("does not probe storage with head() during serve", () => {
    expect(source).not.toMatch(/r2Bucket\.head\(/);
  });

  it("has no extension-probe fallback scaffolding left", () => {
    expect(source).not.toContain("foundOriginalKey");
    expect(source).not.toContain("commonExtensions");
    expect(source).not.toContain("fallback key lookup");
  });
});
