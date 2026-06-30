/**
 * Unit Tests: media/request-moderation.ts (T1 — request-path provider seam)
 *
 * Covers:
 * - set → get round-trip: the injected provider is the one returned.
 * - UNSET default: returns a fail-closed NullModerationProvider whose verdict is
 *   `review` (an un-wired deploy degrades to REVIEW, never auto-approves, never
 *   throws/500).
 * - reset clears the injection (no leak across cases).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetMediaModerationProviderForTests,
  getMediaModerationProvider,
  setMediaModerationProvider,
} from "../../../src/lib/media/request-moderation.js";
import {
  MockModerationProvider,
  NullModerationProvider,
  isNullModerationProvider,
  type ImageRef,
} from "../../../src/lib/media/moderation-provider.js";

const REF: ImageRef = { bucket: "b", key: "processing/c/h" };

afterEach(() => {
  __resetMediaModerationProviderForTests();
});

describe("getMediaModerationProvider — UNSET (fail-closed default)", () => {
  it("returns a NullModerationProvider when no provider was injected", () => {
    const provider = getMediaModerationProvider();
    expect(isNullModerationProvider(provider)).toBe(true);
  });

  it("the default Null provider fails closed to decision=review (never approves)", async () => {
    const provider = getMediaModerationProvider();
    const verdict = await provider.moderateImage(REF);
    // Mutation-sensitive: if the seam ever defaulted to an approving provider,
    // this flips red.
    expect(verdict.decision).toBe("review");
    expect(verdict.decision).not.toBe("approved");
  });

  it("does not throw when unset (must degrade, not 500)", () => {
    expect(() => getMediaModerationProvider()).not.toThrow();
  });
});

describe("setMediaModerationProvider — set → get round-trip", () => {
  it("returns exactly the injected provider instance", () => {
    const injected = new MockModerationProvider();
    setMediaModerationProvider(injected);
    expect(getMediaModerationProvider()).toBe(injected);
  });

  it("the injected provider's verdict is used (not the Null default)", async () => {
    const injected = new MockModerationProvider();
    injected.setImageVerdict({
      decision: "approved",
      labels: [],
      provider: "mock",
    });
    setMediaModerationProvider(injected);
    const verdict = await getMediaModerationProvider().moderateImage(REF);
    expect(verdict.decision).toBe("approved");
  });

  it("reset reverts to the fail-closed Null default", async () => {
    setMediaModerationProvider(new MockModerationProvider());
    __resetMediaModerationProviderForTests();
    const provider = getMediaModerationProvider();
    expect(provider).toBeInstanceOf(NullModerationProvider);
    expect((await provider.moderateImage(REF)).decision).toBe("review");
  });
});
