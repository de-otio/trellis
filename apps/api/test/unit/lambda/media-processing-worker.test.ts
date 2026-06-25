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
 */
import { describe, expect, it } from "vitest";

describe("media-processing-worker (relocated)", () => {
  it("tests moved to test/unit/media/processing-worker.test.ts", () => {
    expect(true).toBe(true);
  });
});
