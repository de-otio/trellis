/**
 * Unit Tests: media/request-text-moderation.ts (T4 — request-path text
 * moderation provider seam)
 *
 * Covers:
 * - set → get round-trip: the injected provider is the one returned.
 * - UNSET default: returns a fail-closed NullTextModerationProvider whose
 *   verdict is `review` (an un-wired deploy holds text for review, never
 *   auto-approves, never throws/500).
 * - reset clears the injection (no leak across cases).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetTextModerationProviderForTests,
  getTextModerationProvider,
  setTextModerationProvider,
} from "../../../src/lib/media/request-text-moderation.js";
import {
  MockTextModerationProvider,
  NullTextModerationProvider,
  isNullTextModerationProvider,
} from "../../../src/lib/media/text-moderation.js";

afterEach(() => {
  __resetTextModerationProviderForTests();
});

describe("getTextModerationProvider — UNSET (fail-closed default)", () => {
  it("returns a NullTextModerationProvider when no provider was injected", () => {
    const provider = getTextModerationProvider();
    expect(isNullTextModerationProvider(provider)).toBe(true);
  });

  it("the default Null provider fails closed to decision=review (never approves)", async () => {
    const provider = getTextModerationProvider();
    const verdict = await provider.moderateText("any text");
    // Mutation-sensitive: if the seam ever defaulted to an approving provider,
    // this flips red.
    expect(verdict.decision).toBe("review");
    expect(verdict.decision).not.toBe("approved");
  });

  it("does not throw when unset (must degrade, not 500)", () => {
    expect(() => getTextModerationProvider()).not.toThrow();
  });

  it("the Null provider warns loudly on every call", async () => {
    const warn = vi.fn();
    const provider = new NullTextModerationProvider(warn);
    await provider.moderateText("text");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain("failing");
  });
});

describe("setTextModerationProvider — set → get round-trip", () => {
  it("returns exactly the injected provider instance", () => {
    const injected = new MockTextModerationProvider();
    setTextModerationProvider(injected);
    expect(getTextModerationProvider()).toBe(injected);
  });

  it("the injected provider's verdict is used (not the Null default)", async () => {
    const injected = new MockTextModerationProvider({
      decision: "approved",
      labels: [],
      provider: "mock-text",
    });
    setTextModerationProvider(injected);
    const verdict = await getTextModerationProvider().moderateText("hello");
    expect(verdict.decision).toBe("approved");
  });

  it("reset reverts to the fail-closed Null default", async () => {
    setTextModerationProvider(new MockTextModerationProvider());
    __resetTextModerationProviderForTests();
    const provider = getTextModerationProvider();
    expect(provider).toBeInstanceOf(NullTextModerationProvider);
    expect((await provider.moderateText("t")).decision).toBe("review");
  });
});
