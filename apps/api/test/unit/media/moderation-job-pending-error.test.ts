import { describe, expect, it } from "vitest";

import {
  ModerationJobPendingError,
  ModerationProviderError,
  isModerationJobPendingError,
  isModerationProviderError,
} from "../../../src/lib/media/moderation-provider.js";

describe("ModerationJobPendingError", () => {
  it("carries name and the pending marker", () => {
    const e = new ModerationJobPendingError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ModerationJobPendingError");
    expect(e.pending).toBe(true);
    expect(isModerationJobPendingError(e)).toBe(true);
  });

  it("recognises a structurally equal error from another module copy", () => {
    // A second class object with the same shape — what a nested or linked
    // copy of the package produces. `instanceof` would miss it.
    class ForeignPendingError extends Error {
      readonly pending = true as const;
      constructor() {
        super("pending");
        this.name = "ModerationJobPendingError";
      }
    }
    const foreign = new ForeignPendingError();
    expect(foreign instanceof ModerationJobPendingError).toBe(false);
    expect(isModerationJobPendingError(foreign)).toBe(true);
  });

  it("rejects look-alikes missing either half of the shape", () => {
    expect(isModerationJobPendingError(null)).toBe(false);
    expect(isModerationJobPendingError(undefined)).toBe(false);
    expect(isModerationJobPendingError("ModerationJobPendingError")).toBe(false);
    expect(isModerationJobPendingError(new Error("pending"))).toBe(false);
    expect(
      isModerationJobPendingError({ name: "ModerationJobPendingError" }),
    ).toBe(false);
    expect(
      isModerationJobPendingError({
        name: "ModerationJobPendingError",
        pending: "true",
      }),
    ).toBe(false);
    expect(
      isModerationJobPendingError(
        new ModerationProviderError("x", { retryable: true }),
      ),
    ).toBe(false);
  });

  it("is not mistaken for a provider error", () => {
    expect(isModerationProviderError(new ModerationJobPendingError())).toBe(
      false,
    );
  });
});

describe("ModerationProviderError — capacity option", () => {
  it("defaults to undefined and leaves the other flags unchanged", () => {
    const e = new ModerationProviderError("x", { retryable: true });
    expect(e.capacity).toBeUndefined();
    expect(e.retryable).toBe(true);
    expect(e.infraFault).toBe(false);
    expect(e.unknownCause).toBe(false);
  });

  it("passes an explicit value through without implying infraFault", () => {
    const e = new ModerationProviderError("x", {
      retryable: true,
      capacity: true,
    });
    expect(e.capacity).toBe(true);
    expect(e.infraFault).toBe(false);
    expect(
      new ModerationProviderError("x", { retryable: false, capacity: false })
        .capacity,
    ).toBe(false);
  });
});
