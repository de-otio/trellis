/**
 * The media-processing worker was rewritten for P0b as an orchestration SHELL
 * over the pure functional-core media units + injected capability seams
 * (TranscodePort / StoragePort / TranscribePort / MediaModerationProvider). The
 * old Sharp-only image-derivative tests that lived here no longer describe the
 * worker's behavior.
 *
 * Its tests now live next to the other P0b media units:
 *   apps/api/test/unit/media/processing-worker.test.ts
 *
 * This placeholder remains so the file path is not a dangling import for any
 * tooling that enumerates it; it asserts the relocation as a tripwire.
 *
 * Thin-test audit (2026-09): the single assertion used to be
 * `expect(true).toBe(true)` — always green, so it could never catch a
 * mis-stated relocation claim. It now checks the claim itself: the file
 * this comment points to must actually exist.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RELOCATED_TEST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../media/processing-worker.test.ts",
);

describe("media-processing-worker (relocated)", () => {
  it("tests moved to test/unit/media/processing-worker.test.ts", () => {
    expect(existsSync(RELOCATED_TEST)).toBe(true);
  });
});
