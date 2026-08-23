/**
 * MinimumContentGateModerationProvider — the deterministic pre-model intake
 * gate for degenerate images.
 *
 * The load-bearing assertions:
 *  - a degenerate image (tiny dimensions, or solid colour) short-circuits to
 *    the configured decision and the inner provider is NEVER called;
 *  - a normal image passes through UNTOUCHED and the inner provider IS called
 *    with the same ref;
 *  - an image exactly AT a floor passes (the floors are inclusive);
 *  - undecodable bytes fail closed to `review` — never approve, never a call
 *    to the inner provider;
 *  - a bytes-READ failure propagates as the typed provider error (it is
 *    infrastructure, not media);
 *  - construction REFUSES absent/malformed floors — no silent defaults.
 *
 * Fixtures are generated with sharp (already the package's decoder) and a
 * SEEDED PRNG, so the entropy measurements are reproducible run to run.
 */

import { beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  MinimumContentGateModerationProvider,
  type MinimumContentGateConfig,
} from "../../../src/lib/media/minimum-content-gate.js";
import {
  MockModerationProvider,
  isModerationProviderError,
  type ImageRef,
} from "../../../src/lib/media/moderation-provider.js";
import type { MediaBytesAccess } from "../../../src/lib/media/media-bytes-access.js";

// ---------------------------------------------------------------------------
// Fixtures: generated, deterministic, tiny.
// ---------------------------------------------------------------------------

/** mulberry32 — a seeded PRNG so the noise image is identical on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A solid-colour PNG — entropy exactly 0. THE degenerate fixture (the 16x16
 * swatch that scored "violence" in calibration pass 1 was this shape). */
async function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

/** A seeded-noise PNG — greyscale entropy near 8 bits/pixel, far above any
 * sane floor. Stands in for "a normal photo". */
async function noisePng(width: number, height: number): Promise<Buffer> {
  const rand = mulberry32(0x5eed);
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(rand() * 256);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

function bytesReturning(buf: Buffer): MediaBytesAccess {
  return { read: async () => buf };
}

const REF: ImageRef = { bucket: "b", key: "k", pin: { kind: "etag", value: "e1" } };

const APPROVED = {
  decision: "approved" as const,
  labels: [],
  provider: "mock",
  modelVersion: "m1",
};

// Floors used throughout: 32x32 minimum, entropy floor 3.0 (solid = 0, noise ≈ 8).
function gateConfig(
  overrides: Partial<MinimumContentGateConfig> & Pick<MinimumContentGateConfig, "bytes">,
  inner: MockModerationProvider,
): MinimumContentGateConfig {
  return {
    inner,
    minWidth: 32,
    minHeight: 32,
    minEntropy: 3,
    ...overrides,
  };
}

describe("MinimumContentGateModerationProvider", () => {
  let inner: MockModerationProvider;

  beforeEach(() => {
    inner = new MockModerationProvider();
    inner.setImageVerdict(APPROVED);
  });

  // -------------------------------------------------------------------------
  // Degenerate inputs short-circuit — the inner provider never runs.
  // -------------------------------------------------------------------------

  it("gates a tiny image (below both dimension floors) and never calls the inner provider", async () => {
    const gate = new MinimumContentGateModerationProvider(
      gateConfig({ bytes: bytesReturning(await solidPng(16, 16)) }, inner),
    );
    const verdict = await gate.moderateImage(REF);

    expect(verdict.decision).toBe("review");
    expect(verdict.provider).toBe("minimum-content-gate");
    expect(verdict.labels).toEqual([
      { category: "structural_minimum_content", confidence: 1 },
    ]);
    expect(verdict.modelVersion).toBeUndefined();
    expect(inner.imageCalls).toHaveLength(0);
  });

  it("gates a large solid-colour image on the entropy floor alone", async () => {
    // 64x64 passes both dimension floors — only entropy (0 < 3) gates it.
    const gate = new MinimumContentGateModerationProvider(
      gateConfig({ bytes: bytesReturning(await solidPng(64, 64)) }, inner),
    );
    const verdict = await gate.moderateImage(REF);

    expect(verdict.decision).toBe("review");
    expect(verdict.labels[0]?.category).toBe("structural_minimum_content");
    expect(inner.imageCalls).toHaveLength(0);
  });

  it("gates when only ONE dimension is below its floor", async () => {
    // Noise (entropy passes), 31x64: width 31 < 32 must gate.
    const gate = new MinimumContentGateModerationProvider(
      gateConfig({ bytes: bytesReturning(await noisePng(31, 64)) }, inner),
    );
    const verdict = await gate.moderateImage(REF);

    expect(verdict.decision).toBe("review");
    expect(inner.imageCalls).toHaveLength(0);
  });

  it("maps a gated image to `quarantine` when configured, with the configured label", async () => {
    const gate = new MinimumContentGateModerationProvider(
      gateConfig(
        {
          bytes: bytesReturning(await solidPng(16, 16)),
          gateDecision: "quarantine",
          gateCategory: "custom_structural_token",
        },
        inner,
      ),
    );
    const verdict = await gate.moderateImage(REF);

    expect(verdict.decision).toBe("quarantine");
    expect(verdict.labels).toEqual([
      { category: "custom_structural_token", confidence: 1 },
    ]);
    expect(inner.imageCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Normal inputs pass through untouched — negative controls.
  // -------------------------------------------------------------------------

  it("passes a normal image through and the inner provider IS called with the same ref", async () => {
    const gate = new MinimumContentGateModerationProvider(
      gateConfig({ bytes: bytesReturning(await noisePng(64, 64)) }, inner),
    );
    const verdict = await gate.moderateImage(REF);

    // The inner verdict comes back byte-for-byte — including `approved`, which
    // the gate itself can never produce.
    expect(verdict).toEqual(APPROVED);
    expect(inner.imageCalls).toHaveLength(1);
    expect(inner.imageCalls[0]).toBe(REF);
  });

  it("passes an image EXACTLY at the dimension floors (inclusive floor) — and the 1px-smaller variant fails", async () => {
    // At the floor: 32x32 with noise passes through.
    const atFloor = new MinimumContentGateModerationProvider(
      gateConfig({ bytes: bytesReturning(await noisePng(32, 32)) }, inner),
    );
    const passVerdict = await atFloor.moderateImage(REF);
    expect(passVerdict.decision).toBe("approved");
    expect(inner.imageCalls).toHaveLength(1);

    // The must-fail variant: one pixel under the height floor gates.
    const under = new MockModerationProvider();
    under.setImageVerdict(APPROVED);
    const belowFloor = new MinimumContentGateModerationProvider(
      gateConfig({ bytes: bytesReturning(await noisePng(32, 31)) }, under),
    );
    const gatedVerdict = await belowFloor.moderateImage(REF);
    expect(gatedVerdict.decision).toBe("review");
    expect(under.imageCalls).toHaveLength(0);
  });

  it("treats minEntropy 0 as an explicit dimensions-only gate: a solid image at 0 entropy passes (0 >= 0)", async () => {
    const gate = new MinimumContentGateModerationProvider(
      gateConfig(
        { bytes: bytesReturning(await solidPng(64, 64)), minEntropy: 0 },
        inner,
      ),
    );
    const verdict = await gate.moderateImage(REF);

    expect(verdict.decision).toBe("approved");
    expect(inner.imageCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Fail-closed paths.
  // -------------------------------------------------------------------------

  it("fails closed to `review` on undecodable bytes — never approve, inner never called", async () => {
    const gate = new MinimumContentGateModerationProvider(
      gateConfig(
        {
          bytes: bytesReturning(Buffer.from("definitely-not-an-image")),
          // Even a quarantine-configured gate maps UNDECODABLE to review:
          // quarantine asserts a structural finding; undecodable is uncertainty.
          gateDecision: "quarantine",
        },
        inner,
      ),
    );
    const verdict = await gate.moderateImage(REF);

    expect(verdict.decision).toBe("review");
    expect(verdict.provider).toBe("minimum-content-gate");
    expect(verdict.labels).toEqual([
      { category: "structural_undecodable", confidence: 1 },
    ]);
    expect(inner.imageCalls).toHaveLength(0);
  });

  it("propagates a bytes-READ failure as the typed provider error — infrastructure, not a verdict", async () => {
    const gate = new MinimumContentGateModerationProvider(
      gateConfig(
        {
          bytes: {
            read: async () => {
              throw new Error("socket reset");
            },
          },
        },
        inner,
      ),
    );

    await expect(gate.moderateImage(REF)).rejects.toSatisfy((err: unknown) => {
      // The read wrapper's classification must survive: retryable transient.
      return isModerationProviderError(err) && err.retryable === true;
    });
    expect(inner.imageCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Construction refuses absent/malformed config — no silent defaults.
  // -------------------------------------------------------------------------

  it("refuses construction when any floor is absent or malformed", async () => {
    const bytes = bytesReturning(await noisePng(64, 64));
    const base = { inner, bytes, minWidth: 32, minHeight: 32, minEntropy: 3 };

    const broken: Array<Record<string, unknown>> = [
      { ...base, minWidth: undefined },
      { ...base, minHeight: undefined },
      { ...base, minEntropy: undefined },
      { ...base, minWidth: 0 },
      { ...base, minWidth: 1.5 },
      { ...base, minHeight: -1 },
      { ...base, minEntropy: -0.1 },
      { ...base, minEntropy: Number.NaN },
      { ...base, inner: undefined },
      { ...base, bytes: undefined },
    ];
    for (const config of broken) {
      expect(
        () =>
          new MinimumContentGateModerationProvider(
            config as unknown as MinimumContentGateConfig,
          ),
        JSON.stringify(config),
      ).toThrow();
    }

    // Control: the intact config constructs.
    expect(() => new MinimumContentGateModerationProvider(base)).not.toThrow();
  });

  it('refuses a gateDecision outside "review" | "quarantine" — approving unclassified media is a bypass', async () => {
    const bytes = bytesReturning(await noisePng(64, 64));
    expect(
      () =>
        new MinimumContentGateModerationProvider({
          inner,
          bytes,
          minWidth: 32,
          minHeight: 32,
          minEntropy: 3,
          gateDecision: "approved" as unknown as "review",
        }),
    ).toThrow(/review.*quarantine|bypass/);
  });

  // -------------------------------------------------------------------------
  // Wrapper semantics: attribution and video pass-through.
  // -------------------------------------------------------------------------

  it("passes the inner provider's name through (wrapper rule)", async () => {
    const gate = new MinimumContentGateModerationProvider(
      gateConfig({ bytes: bytesReturning(await noisePng(64, 64)) }, inner),
    );
    expect(gate.name).toBe("mock");
  });

  it("delegates the video methods to the inner provider untouched", async () => {
    const gate = new MinimumContentGateModerationProvider(
      gateConfig({ bytes: bytesReturning(await noisePng(64, 64)) }, inner),
    );
    const s3Ref = { bucket: "b", key: "v" };
    const start = await gate.startVideoModeration(s3Ref);
    expect(start.jobId).toMatch(/^mock-job-/);
    expect(inner.startVideoCalls).toEqual([s3Ref]);

    const verdict = await gate.getVideoModeration(start.jobId);
    expect(verdict.decision).toBe("review"); // the mock's canned default
  });
});
