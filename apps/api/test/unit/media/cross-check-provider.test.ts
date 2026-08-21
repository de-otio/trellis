import { describe, expect, it } from "vitest";

import {
  CrossCheckModerationProvider,
  type CrossCheckModerationConfig,
} from "../../../src/lib/media/cross-check-provider.js";
import {
  isModerationProviderError,
  ModerationProviderError,
  type ImageRef,
  type MediaModerationProvider,
  type ModerationCallOptions,
  type ModerationDecision,
  type ModerationVerdict,
  type S3Ref,
  type VideoModerationStart,
} from "../../../src/lib/media/moderation-provider.js";

const REF: ImageRef = { bucket: "example-media-bucket", key: "cas/tenant/hash" };

/**
 * A stub signal: resolves a canned verdict, throws a canned error, or runs a
 * per-call responder. Records every ref + options it was asked about so a test
 * can assert both signals ran and both saw the same input.
 */
class StubProvider implements MediaModerationProvider {
  readonly calls: Array<{ input: ImageRef; options?: ModerationCallOptions }> =
    [];
  constructor(
    readonly name: string,
    private readonly behaviour:
      | { verdict: ModerationVerdict }
      | { error: unknown }
      | {
          responder: (
            input: ImageRef,
            options?: ModerationCallOptions,
          ) => Promise<ModerationVerdict>;
        },
  ) {}

  async moderateImage(
    input: ImageRef,
    options?: ModerationCallOptions,
  ): Promise<ModerationVerdict> {
    this.calls.push({ input, options });
    if ("verdict" in this.behaviour) return this.behaviour.verdict;
    if ("error" in this.behaviour) throw this.behaviour.error;
    return this.behaviour.responder(input, options);
  }
  async startVideoModeration(): Promise<VideoModerationStart> {
    throw new Error("not used");
  }
  async getVideoModeration(): Promise<ModerationVerdict> {
    throw new Error("not used");
  }
}

function verdict(
  decision: ModerationDecision,
  overrides: Partial<ModerationVerdict> = {},
): ModerationVerdict {
  return {
    decision,
    labels: [],
    provider: "stub",
    ...overrides,
  };
}

function provider(
  primary: MediaModerationProvider,
  crossCheck: MediaModerationProvider,
): CrossCheckModerationProvider {
  const config: CrossCheckModerationConfig = { primary, crossCheck };
  return new CrossCheckModerationProvider(config);
}

describe("CrossCheckModerationProvider — construction", () => {
  it("requires both signals", () => {
    const ok = new StubProvider("a", { verdict: verdict("approved") });
    expect(
      () =>
        new CrossCheckModerationProvider({
          primary: ok,
          crossCheck: undefined as unknown as MediaModerationProvider,
        }),
    ).toThrow(/both `primary` and `crossCheck`/);
    expect(
      () =>
        new CrossCheckModerationProvider({
          primary: undefined as unknown as MediaModerationProvider,
          crossCheck: ok,
        }),
    ).toThrow(/both `primary` and `crossCheck`/);
  });

  it("reports the PRIMARY signal's name (wrapper rule), not its own", () => {
    const p = provider(
      new StubProvider("category-scorer", { verdict: verdict("approved") }),
      new StubProvider("verdict-gate", { verdict: verdict("approved") }),
    );
    expect(p.name).toBe("category-scorer");
  });
});

describe("CrossCheckModerationProvider — both signals resolve", () => {
  it("runs BOTH signals with the same input and options", async () => {
    const primary = new StubProvider("p", { verdict: verdict("approved") });
    const cross = new StubProvider("c", { verdict: verdict("approved") });
    const signal = new AbortController().signal;
    await provider(primary, cross).moderateImage(REF, { signal });
    expect(primary.calls).toHaveLength(1);
    expect(cross.calls).toHaveLength(1);
    expect(primary.calls[0]!.input).toBe(REF);
    expect(cross.calls[0]!.input).toBe(REF);
    expect(primary.calls[0]!.options?.signal).toBe(signal);
    expect(cross.calls[0]!.options?.signal).toBe(signal);
  });

  // The severity ladder: approved < review < quarantine, and a pass survives
  // only when BOTH approved.
  const table: Array<[ModerationDecision, ModerationDecision, ModerationDecision]> =
    [
      ["approved", "approved", "approved"],
      ["approved", "review", "review"],
      ["review", "approved", "review"],
      ["approved", "quarantine", "quarantine"],
      ["quarantine", "approved", "quarantine"],
      ["review", "quarantine", "quarantine"],
      ["quarantine", "review", "quarantine"],
      ["review", "review", "review"],
      ["quarantine", "quarantine", "quarantine"],
    ];
  it.each(table)(
    "primary=%s crossCheck=%s -> %s (worst wins)",
    async (p, c, expected) => {
      const out = await provider(
        new StubProvider("p", { verdict: verdict(p) }),
        new StubProvider("c", { verdict: verdict(c) }),
      ).moderateImage(REF);
      expect(out.decision).toBe(expected);
    },
  );

  it("THE INJECTION CASE: primary hijacked to approved, verdict gate holds at quarantine -> quarantine", async () => {
    // Probe 16: a text overlay drives the category scorer to a confident
    // all-zero pass; the coarse verdict gate is not fooled and still blocks.
    const out = await provider(
      new StubProvider("category-scorer", {
        verdict: verdict("approved", { labels: [] }),
      }),
      new StubProvider("verdict-gate", {
        verdict: verdict("quarantine", {
          labels: [{ category: "policy_violation", confidence: 1 }],
        }),
      }),
    ).moderateImage(REF);
    expect(out.decision).toBe("quarantine");
    // The guard's label survives so a downstream policy still sees the signal.
    expect(out.labels).toContainEqual({
      category: "policy_violation",
      confidence: 1,
    });
  });

  it("unions labels from both signals", async () => {
    const out = await provider(
      new StubProvider("p", {
        verdict: verdict("review", {
          labels: [{ category: "cat_a", confidence: 0.6 }],
        }),
      }),
      new StubProvider("c", {
        verdict: verdict("review", {
          labels: [{ category: "cat_b", confidence: 0.7 }],
        }),
      }),
    ).moderateImage(REF);
    expect(out.labels).toEqual([
      { category: "cat_a", confidence: 0.6 },
      { category: "cat_b", confidence: 0.7 },
    ]);
  });

  it("reports the primary identity: provider name + modelVersion pass through", async () => {
    const out = await provider(
      new StubProvider("category-scorer", {
        verdict: verdict("approved", { modelVersion: "tax-v3" }),
      }),
      new StubProvider("verdict-gate", {
        verdict: verdict("approved", { modelVersion: "gate-v9" }),
      }),
    ).moderateImage(REF);
    expect(out.provider).toBe("category-scorer");
    expect(out.modelVersion).toBe("tax-v3");
  });

  it("omits modelVersion when the primary reports none", async () => {
    const out = await provider(
      new StubProvider("p", { verdict: verdict("approved") }),
      new StubProvider("c", { verdict: verdict("approved") }),
    ).moderateImage(REF);
    expect("modelVersion" in out).toBe(false);
  });
});

describe("CrossCheckModerationProvider — one signal throws", () => {
  it("resolved review + other throws -> returns review (block stands, co-signal not needed)", async () => {
    const out = await provider(
      new StubProvider("p", { verdict: verdict("review") }),
      new StubProvider("c", {
        error: new ModerationProviderError("boom", { retryable: true }),
      }),
    ).moderateImage(REF);
    expect(out.decision).toBe("review");
    expect(out.provider).toBe("p");
  });

  it("resolved quarantine (from the guard) + primary throws -> returns quarantine", async () => {
    const out = await provider(
      new StubProvider("p", {
        error: new ModerationProviderError("boom", { retryable: true }),
      }),
      new StubProvider("c", {
        verdict: verdict("quarantine", {
          labels: [{ category: "x", confidence: 1 }],
          modelVersion: "gate-v1",
        }),
      }),
    ).moderateImage(REF);
    expect(out.decision).toBe("quarantine");
    expect(out.provider).toBe("p"); // still attributed to the primary identity
    expect(out.labels).toEqual([{ category: "x", confidence: 1 }]);
    expect(out.modelVersion).toBe("gate-v1");
  });

  it("resolved APPROVED + other throws -> refuses the unguarded pass, re-throws", async () => {
    await expect(
      provider(
        new StubProvider("p", { verdict: verdict("approved") }),
        new StubProvider("c", {
          error: new ModerationProviderError("gate down", { retryable: true }),
        }),
      ).moderateImage(REF),
    ).rejects.toBeInstanceOf(ModerationProviderError);
  });

  it("preserves a retryable throw's classification on the unguarded-pass path", async () => {
    try {
      await provider(
        new StubProvider("p", { verdict: verdict("approved") }),
        new StubProvider("c", {
          error: new ModerationProviderError("throttled", { retryable: true }),
        }),
      ).moderateImage(REF);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isModerationProviderError(err)).toBe(true);
      const e = err as ModerationProviderError;
      expect(e.retryable).toBe(true);
      expect(e.unknownCause).toBe(false);
    }
  });

  it("preserves a permanent+unknownCause throw's classification (auth fault) on the unguarded-pass path", async () => {
    try {
      await provider(
        new StubProvider("p", {
          error: new ModerationProviderError("401", {
            retryable: false,
            unknownCause: true,
          }),
        }),
        new StubProvider("c", { verdict: verdict("approved") }),
      ).moderateImage(REF);
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as ModerationProviderError;
      expect(e.retryable).toBe(false);
      expect(e.unknownCause).toBe(true);
    }
  });

  it("wraps an UNTYPED throw as retryable + unknownCause on the unguarded-pass path", async () => {
    try {
      await provider(
        new StubProvider("p", { verdict: verdict("approved") }),
        new StubProvider("c", { error: new TypeError("socket hangup") }),
      ).moderateImage(REF);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isModerationProviderError(err)).toBe(true);
      const e = err as ModerationProviderError;
      expect(e.retryable).toBe(true);
      expect(e.unknownCause).toBe(true);
    }
  });
});

describe("CrossCheckModerationProvider — both signals throw", () => {
  it("throws a combined error; retryable only if BOTH are, unknownCause if EITHER is", async () => {
    // both retryable, neither unknownCause -> retryable, not unknown
    await assertCombined(
      new ModerationProviderError("a", { retryable: true }),
      new ModerationProviderError("b", { retryable: true }),
      { retryable: true, unknownCause: false },
    );
    // one permanent -> permanent for these bytes
    await assertCombined(
      new ModerationProviderError("a", { retryable: true }),
      new ModerationProviderError("b", { retryable: false }),
      { retryable: false, unknownCause: false },
    );
    // one unknownCause -> alert
    await assertCombined(
      new ModerationProviderError("a", { retryable: true }),
      new ModerationProviderError("b", {
        retryable: false,
        unknownCause: true,
      }),
      { retryable: false, unknownCause: true },
    );
    // an untyped throw counts as retryable + unknownCause
    await assertCombined(
      new ModerationProviderError("a", { retryable: true }),
      new Error("mystery"),
      { retryable: true, unknownCause: true },
    );
  });
});

async function assertCombined(
  primaryError: unknown,
  crossError: unknown,
  expected: { retryable: boolean; unknownCause: boolean },
): Promise<void> {
  try {
    await provider(
      new StubProvider("p", { error: primaryError }),
      new StubProvider("c", { error: crossError }),
    ).moderateImage(REF);
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(isModerationProviderError(err)).toBe(true);
    const e = err as ModerationProviderError;
    expect(e.retryable).toBe(expected.retryable);
    expect(e.unknownCause).toBe(expected.unknownCause);
  }
}

describe("CrossCheckModerationProvider — video is not its job", () => {
  const p = provider(
    new StubProvider("p", { verdict: verdict("approved") }),
    new StubProvider("c", { verdict: verdict("approved") }),
  );
  it("startVideoModeration throws a permanent provider error", async () => {
    await expect(
      p.startVideoModeration({} as S3Ref),
    ).rejects.toMatchObject({ retryable: false });
  });
  it("getVideoModeration throws a permanent provider error", async () => {
    await expect(p.getVideoModeration("job")).rejects.toMatchObject({
      retryable: false,
    });
  });
});
