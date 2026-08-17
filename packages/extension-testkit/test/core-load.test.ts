/**
 * `isMissingPeerError` — the discriminator `loadCore()` uses to decide
 * whether a failed `import("@de-otio/trellis")` means "core isn't installed"
 * or "core IS installed and failed while loading".
 *
 * Pure unit tests against synthetic errors, in the same spirit as
 * core-shape.test.ts: the real bug this guards against was a catch-all that
 * reported EVERY import failure as a missing peer dependency, even when core
 * was correctly installed and pinned and the real failure was thrown from
 * inside core (e.g. `@prisma/client` not generated yet). Exercising the real
 * dynamic import in loadCore() would need an actual broken module tree on
 * disk; testing the discriminator directly is both cheaper and the thing
 * that actually needs covering.
 */

import { describe, expect, it } from "vitest";
import { isMissingPeerError } from "../src/core.js";

/** Mimics Node's error for a genuinely-unresolvable top-level bare specifier. */
function moduleNotFound(specifier: string): Error {
  const err = new Error(
    `Cannot find package '${specifier}' imported from /some/importer.js`,
  ) as NodeJS.ErrnoException;
  err.code = "ERR_MODULE_NOT_FOUND";
  return err;
}

describe("isMissingPeerError", () => {
  it("is true for @de-otio/trellis itself failing to resolve", () => {
    expect(isMissingPeerError(moduleNotFound("@de-otio/trellis"))).toBe(true);
  });

  it("is false when core resolves but a module IT imports does not", () => {
    // The bug this guards against: core is installed and pinned correctly,
    // but something core itself imports (e.g. a not-yet-generated
    // @prisma/client) fails. Same error CODE, different specifier — must not
    // be reported as "install @de-otio/trellis".
    expect(isMissingPeerError(moduleNotFound("@prisma/client"))).toBe(false);
  });

  it("is false for a named-export failure thrown from inside core", () => {
    // This is the exact shape from the real incident: @prisma/client exists
    // on disk but hasn't been generated, so importing it succeeds at module
    // resolution but fails when core tries to use a named export from it.
    const err = new SyntaxError(
      "The requested module '@prisma/client' does not provide an export named 'Prisma'",
    );
    expect(isMissingPeerError(err)).toBe(false);
  });

  it("is false for any other ERR_MODULE_NOT_FOUND whose message names a different package", () => {
    // Guards against a discriminator that keys on the error CODE alone —
    // the specifier in the message must actually be @de-otio/trellis.
    expect(isMissingPeerError(moduleNotFound("some-other-package"))).toBe(false);
  });

  it("is false for a non-Error thrown value", () => {
    expect(isMissingPeerError("not an error")).toBe(false);
    expect(isMissingPeerError(undefined)).toBe(false);
    expect(isMissingPeerError(null)).toBe(false);
  });

  it("is false for an Error with no error code at all", () => {
    expect(isMissingPeerError(new Error("something unrelated broke"))).toBe(false);
  });
});
