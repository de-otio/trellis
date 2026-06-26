/**
 * T2 — MediaModerationProvider seam: Null / Mock providers + startup guard.
 *
 * Safety-critical invariants under test:
 *   - NullModerationProvider fails CLOSED to decision="review" and warns loudly.
 *   - MockModerationProvider returns the programmed verdict (test seam), using
 *     only abstract category tokens.
 *   - The startup guard refuses to run Null outside dev (throws), and permits a
 *     real provider in any environment.
 *
 * fast-check is seeded for determinism (CLAUDE.md: pin nondeterminism in tests).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  assertModerationProviderAllowed,
  isNullModerationProvider,
  MOCK_CATEGORY_A,
  MOCK_CATEGORY_B,
  MockModerationProvider,
  NullModerationProvider,
  NullProviderInProductionError,
  type ImageRef,
  type ModerationVerdict,
  type S3Ref,
} from "../../../src/lib/media/moderation-provider.js";

const FC_SEED = 0xc0ffee;

const IMAGE_REF: ImageRef = { bucket: "test-bucket", key: "cas/t1/abc" };
const S3_REF: S3Ref = { bucket: "test-bucket", key: "cas/t1/vid" };

describe("NullModerationProvider", () => {
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.fn();
  });

  it("moderateImage fails closed to review and warns", async () => {
    const provider = new NullModerationProvider(warn);

    const verdict = await provider.moderateImage(IMAGE_REF);

    expect(verdict.decision).toBe("review");
    expect(verdict.labels).toEqual([]);
    expect(verdict.provider).toBe("null");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/NullModerationProvider/);
  });

  it("getVideoModeration fails closed to review and warns", async () => {
    const provider = new NullModerationProvider(warn);

    const verdict = await provider.getVideoModeration("any-job");

    expect(verdict.decision).toBe("review");
    expect(verdict.provider).toBe("null");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("startVideoModeration warns and never yields an approvable handle", async () => {
    const provider = new NullModerationProvider(warn);

    const { jobId } = await provider.startVideoModeration(S3_REF);

    expect(jobId).toContain("null");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns on EVERY call (the warning is not deduped)", async () => {
    const provider = new NullModerationProvider(warn);

    await provider.moderateImage(IMAGE_REF);
    await provider.moderateImage(IMAGE_REF);
    await provider.getVideoModeration("j");

    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("defaults its warning sink to console.warn when none is injected", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new NullModerationProvider();

    await provider.moderateImage(IMAGE_REF);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("is identified by isNullModerationProvider", () => {
    expect(isNullModerationProvider(new NullModerationProvider(warn))).toBe(true);
    expect(isNullModerationProvider(new MockModerationProvider())).toBe(false);
  });

  it("property: NEVER returns approved, for any number of calls", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            bucket: fc.string({ minLength: 1, maxLength: 8 }),
            key: fc.string({ minLength: 1, maxLength: 16 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (refs) => {
          const provider = new NullModerationProvider(vi.fn());
          for (const ref of refs) {
            const v = await provider.moderateImage(ref);
            expect(v.decision).toBe("review");
            expect(v.decision).not.toBe("approved");
          }
        },
      ),
      { seed: FC_SEED, numRuns: 100 },
    );
  });
});

describe("MockModerationProvider", () => {
  it("returns the fail-closed review verdict by default", async () => {
    const provider = new MockModerationProvider();

    const verdict = await provider.moderateImage(IMAGE_REF);

    expect(verdict.decision).toBe("review");
    expect(verdict.provider).toBe("mock");
  });

  it("returns the programmed image verdict (constructor)", async () => {
    const canned: ModerationVerdict = {
      decision: "quarantine",
      labels: [{ category: MOCK_CATEGORY_A, confidence: 0.99 }],
      provider: "mock",
    };
    const provider = new MockModerationProvider({ image: canned });

    const verdict = await provider.moderateImage(IMAGE_REF);

    expect(verdict).toEqual(canned);
  });

  it("returns the programmed verdict via setImageVerdict", async () => {
    const provider = new MockModerationProvider();
    const canned: ModerationVerdict = {
      decision: "approved",
      labels: [{ category: MOCK_CATEGORY_B, confidence: 0.1 }],
      provider: "mock",
    };
    provider.setImageVerdict(canned);

    expect(await provider.moderateImage(IMAGE_REF)).toEqual(canned);
  });

  it("returns the programmed video verdict and a stable job handle", async () => {
    const provider = new MockModerationProvider();
    provider.setVideoVerdict({
      decision: "quarantine",
      labels: [],
      provider: "mock",
    });

    const { jobId } = await provider.startVideoModeration(S3_REF);
    expect(jobId).toContain("mock-job");

    const verdict = await provider.getVideoModeration(jobId);
    expect(verdict.decision).toBe("quarantine");
  });

  it("uses only abstract category tokens", () => {
    expect(MOCK_CATEGORY_A).toBe("category_a");
    expect(MOCK_CATEGORY_B).toBe("category_b");
  });

  it("property: round-trips any programmed decision", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ModerationVerdict["decision"]>(
          "approved",
          "review",
          "quarantine",
        ),
        async (decision) => {
          const provider = new MockModerationProvider();
          provider.setImageVerdict({ decision, labels: [], provider: "mock" });
          const v = await provider.moderateImage(IMAGE_REF);
          expect(v.decision).toBe(decision);
        },
      ),
      { seed: FC_SEED, numRuns: 50 },
    );
  });
});

describe("assertModerationProviderAllowed (startup guard)", () => {
  it("throws when Null is injected and ENVIRONMENT=prod", () => {
    const provider = new NullModerationProvider(vi.fn());

    expect(() => assertModerationProviderAllowed(provider, "prod")).toThrow(
      NullProviderInProductionError,
    );
  });

  it("throws for any non-dev environment with Null", () => {
    const provider = new NullModerationProvider(vi.fn());

    expect(() => assertModerationProviderAllowed(provider, "staging")).toThrow(
      NullProviderInProductionError,
    );
    expect(() => assertModerationProviderAllowed(provider, "production")).toThrow(
      NullProviderInProductionError,
    );
  });

  it("permits Null in dev (returns it unchanged)", () => {
    const provider = new NullModerationProvider(vi.fn());

    expect(assertModerationProviderAllowed(provider, "dev")).toBe(provider);
  });

  it("permits a real (non-Null) provider in any environment", () => {
    const real = new MockModerationProvider();

    expect(assertModerationProviderAllowed(real, "prod")).toBe(real);
    expect(assertModerationProviderAllowed(real, "dev")).toBe(real);
  });

  it("property: Null is allowed iff environment is exactly 'dev'", () => {
    fc.assert(
      fc.property(fc.string(), (environment) => {
        const provider = new NullModerationProvider(vi.fn());
        if (environment === "dev") {
          expect(assertModerationProviderAllowed(provider, environment)).toBe(
            provider,
          );
        } else {
          expect(() =>
            assertModerationProviderAllowed(provider, environment),
          ).toThrow(NullProviderInProductionError);
        }
      }),
      { seed: FC_SEED, numRuns: 100 },
    );
  });
});
