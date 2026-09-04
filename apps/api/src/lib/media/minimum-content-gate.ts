// The MINIMUM-CONTENT INTAKE GATE: a deterministic pre-model check that stops
// degenerate images from reaching any vision classifier at all.
//
// WHY (measured, not hypothetical). A 16×16 solid-colour swatch was scored
// "violence"-class by the category scorer (calibration pass 1, 2026-08-22) — a
// pure false positive: there is nothing in such an image for a classifier to
// see, so whatever it reports is confabulation. A taxonomy prompt clause
// ("score degenerate images 0") mitigates that, but a prompt clause is a
// mitigation, not a gate: it depends on the model honouring it, on every model
// the operator ever swaps in honouring it, and it still spends a paid network
// call to classify an image that provably carries no content. The degenerate
// case moved from the scorer to the verdict gate between probes — which is
// exactly what "model-dependent" means — so the fix must sit IN FRONT OF BOTH
// signals, before any network call. This wrapper is that gate: wrap it around
// the composed classifier (typically the CrossCheckModerationProvider) and a
// below-floor image short-circuits deterministically; the inner provider is
// never called for it.
//
// WHAT IT CHECKS. Two structural floors, both operator-supplied:
//   - DIMENSIONS: width or height below the configured minimum. Read from a
//     real decode (sharp metadata), not from a byte heuristic.
//   - ENTROPY: sharp's greyscale Shannon entropy (0..8 bits/pixel) below the
//     configured floor. A solid colour is exactly 0; near-solid gradients and
//     swatches sit close to it. `minEntropy: 0` expresses "dimensions only" —
//     explicitly, since no entropy value is below 0.
// An image AT a floor passes (the checks are strict `<`).
//
// DECISION SEMANTICS — OPERATOR CONFIG, FAIL-CLOSED DEFAULT. The estate spec
// (skybber HANDOFF-2026-08-22 §"Still open") requires the gate to exist and to
// sit in front of both signals, but does not specify what a gated image should
// BECOME. So, like ScalewayVerdictModerationProvider.blockDecision, the mapped
// decision is config: `review` (default — fail closed, a human decides) or
// `quarantine`. `approved` is deliberately NOT accepted: auto-approving
// anything that dodges the classifiers would turn the gate into a moderation
// bypass an uploader can trigger at will, violating the seam rule that a
// provider never manufactures `approved` without a signal.
//
// FAIL CLOSED, ALWAYS. Bytes that cannot be decoded (or decode without
// dimensions) resolve to `review` with a structural label — never `approved`,
// and never a call to the inner provider (a classifier cannot see more of an
// image than the decoder can). A bytes-READ failure is different: that is
// infrastructure, not media, and the typed ModerationProviderError propagates
// unchanged so core's retry/alert classification still applies.
//
// It is a MECHANISM: no floor values, vocabulary or secrets are compiled in —
// construction REFUSES config with missing floors rather than defaulting them
// (this file ships in the public @de-otio/trellis tarball; a hard-coded
// threshold would be a published threshold). Labels carry structural tokens
// ("the gate refused this"), not real-category vocabulary.
//
// COMPOSITION. Image-level, like the classifiers it wraps. Video calls pass
// through to the inner provider untouched; to gate sampled video frames,
// compose it UNDER FrameSamplingVideoModerationAdapter:
//   FrameSampling( MinimumContentGate( CrossCheck(scorer, verdictGate) ) )
// Note that gating frames means a fade-to-black frame maps to the configured
// decision — pick the video composition (and the entropy floor) deliberately.

import {
  type ImageRef,
  type MediaModerationProvider,
  type ModerationCallOptions,
  type ModerationDecision,
  type ModerationVerdict,
  type S3Ref,
  type VideoModerationStart,
  ModerationProviderError,
} from "./moderation-provider.js";
import type { MediaBytesAccess } from "./media-bytes-access.js";
import { readImageBytes } from "./scaleway-vision-shared.js";

/** Refusal attribution: no classifier ran, so the refusal is the gate's own. */
const GATE_PROVIDER_NAME = "minimum-content-gate";

// STRUCTURAL tokens, not real-category names — they label "the intake gate
// stopped this" (below-floor) and "the bytes did not decode" (fail-closed).
// Both are operator-overridable; core ships no moderation vocabulary.
const DEFAULT_GATE_CATEGORY = "structural_minimum_content";
const DEFAULT_UNDECODABLE_CATEGORY = "structural_undecodable";

/** The decisions a gated image may map to. `approved` is deliberately absent. */
export type MinimumContentGateDecision = Extract<
  ModerationDecision,
  "review" | "quarantine"
>;

/**
 * Config for the minimum-content intake gate. The floors are OPERATOR POLICY —
 * all three are required, and construction refuses when any is absent or
 * malformed, because a silently-defaulted floor compiled into the public
 * tarball would be a published threshold.
 */
export interface MinimumContentGateConfig {
  /**
   * The provider a non-degenerate image is passed to, untouched — typically
   * the CrossCheckModerationProvider composing both vision signals, so the
   * gate sits in front of BOTH.
   */
  readonly inner: MediaModerationProvider;
  /** Credential-free byte reader (see media-bytes-access.ts). */
  readonly bytes: MediaBytesAccess;
  /** Minimum acceptable pixel width (inclusive: an image AT the floor passes). */
  readonly minWidth: number;
  /** Minimum acceptable pixel height (inclusive: an image AT the floor passes). */
  readonly minHeight: number;
  /**
   * Minimum acceptable greyscale Shannon entropy in bits/pixel (0..8,
   * inclusive floor: an image AT the floor passes). A solid colour measures
   * exactly 0. Set `0` to run a dimensions-only gate — explicitly.
   */
  readonly minEntropy: number;
  /**
   * What a below-floor image becomes. Defaults to `review` (fail closed, a
   * human decides). `approved` is not accepted — see the header.
   */
  readonly gateDecision?: MinimumContentGateDecision;
  /** Opaque label token on a below-floor refusal. Default "structural_minimum_content". */
  readonly gateCategory?: string;
  /** Opaque label token on an undecodable-bytes refusal. Default "structural_undecodable". */
  readonly undecodableCategory?: string;
}

/** What one structural measurement pass produced. */
interface MeasuredImage {
  readonly width: number;
  readonly height: number;
  readonly entropy: number;
}

function isPositiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * A wrapping MediaModerationProvider that measures an image's structural
 * content BEFORE any classifier runs. Below-floor images short-circuit to the
 * configured decision with a structural label — the inner provider is never
 * called, so a degenerate input can neither be confabulated over by a vision
 * model nor spend a paid call. Everything else passes through untouched.
 */
export class MinimumContentGateModerationProvider
  implements MediaModerationProvider
{
  private readonly config: MinimumContentGateConfig;

  constructor(config: MinimumContentGateConfig) {
    if (!config.inner || typeof config.inner.moderateImage !== "function") {
      throw new ModerationProviderError(
        "MinimumContentGateModerationProvider requires an `inner` provider to wrap",
        { retryable: false },
      );
    }
    if (!config.bytes || typeof config.bytes.read !== "function") {
      throw new ModerationProviderError(
        "MinimumContentGateModerationProvider requires `bytes` (MediaBytesAccess)",
        { retryable: false },
      );
    }
    if (!isPositiveInteger(config.minWidth) || !isPositiveInteger(config.minHeight)) {
      throw new ModerationProviderError(
        "MinimumContentGateModerationProvider requires positive integer `minWidth` and `minHeight` — the floors are operator config, never defaulted",
        { retryable: false },
      );
    }
    if (
      typeof config.minEntropy !== "number" ||
      !Number.isFinite(config.minEntropy) ||
      config.minEntropy < 0
    ) {
      throw new ModerationProviderError(
        "MinimumContentGateModerationProvider requires a finite `minEntropy` >= 0 (use 0 for a dimensions-only gate — explicitly, never by omission)",
        { retryable: false },
      );
    }
    if (
      config.gateDecision !== undefined &&
      config.gateDecision !== "review" &&
      config.gateDecision !== "quarantine"
    ) {
      throw new ModerationProviderError(
        'MinimumContentGateModerationProvider `gateDecision` must be "review" or "quarantine" — a gate that auto-approves unclassified media is a moderation bypass',
        { retryable: false },
      );
    }
    this.config = config;
  }

  /**
   * Wrapper rule: the inner classifier's name, passed through unchanged. The
   * gate is not a classifier identity of its own for scored verdicts — only
   * its REFUSALS carry {@link GATE_PROVIDER_NAME}, exactly like the
   * frame-sampling adapter's refusal attribution.
   */
  get name(): string | undefined {
    return this.config.inner.name;
  }

  async moderateImage(
    input: ImageRef,
    options?: ModerationCallOptions,
  ): Promise<ModerationVerdict> {
    // A read failure propagates as the typed provider error: it is an
    // infrastructure fault, not a statement about the media, and core's
    // retry/alert classification must see it unchanged.
    const imageBytes = await readImageBytes(this.config.bytes, input, options);

    let measured: MeasuredImage;
    try {
      measured = await measureImage(imageBytes);
    } catch {
      // Undecodable bytes (or a decode with no dimensions): fail closed. No
      // classifier can see more of an image than the decoder can, so calling
      // the inner provider would only spend money to launder the uncertainty.
      // The decode error's text is deliberately not surfaced — the structural
      // label is the whole audit signal.
      return this.refuse(
        "review",
        this.config.undecodableCategory ?? DEFAULT_UNDECODABLE_CATEGORY,
      );
    }

    const belowFloor =
      measured.width < this.config.minWidth ||
      measured.height < this.config.minHeight ||
      measured.entropy < this.config.minEntropy;

    if (belowFloor) {
      return this.refuse(
        this.config.gateDecision ?? "review",
        this.config.gateCategory ?? DEFAULT_GATE_CATEGORY,
      );
    }

    return this.config.inner.moderateImage(input, options);
  }

  /** Video passes through untouched — gate frames by composing this provider
   * UNDER the frame-sampling adapter (see the header). */
  async startVideoModeration(
    input: S3Ref,
    options?: ModerationCallOptions,
  ): Promise<VideoModerationStart> {
    return this.config.inner.startVideoModeration(input, options);
  }

  async getVideoModeration(
    jobId: string,
    options?: ModerationCallOptions,
  ): Promise<ModerationVerdict> {
    return this.config.inner.getVideoModeration(jobId, options);
  }

  /**
   * A gate refusal: the gate's own verdict (no classifier ran, so no
   * `modelVersion` — refusals are never approvals, so the taxonomy pin has
   * nothing to verify here). Confidence 1: the measurement is deterministic.
   */
  private refuse(
    decision: MinimumContentGateDecision,
    category: string,
  ): ModerationVerdict {
    return {
      decision,
      labels: [{ category, confidence: 1 }],
      provider: GATE_PROVIDER_NAME,
    };
  }
}

/**
 * Decode once, measure twice: dimensions from metadata, entropy from channel
 * statistics. Uses sharp — already this package's image decoder (the
 * normalizer and EXIF stripper run every stored image through it, so by
 * moderation time the bytes are sharp-decodable; bytes that are not are
 * exactly the fail-closed case). Throws on any decode problem; the caller
 * turns the throw into a fail-closed refusal.
 */
async function measureImage(imageBytes: Buffer): Promise<MeasuredImage> {
  const { default: sharp } = await import("sharp");
  const image = sharp(imageBytes);
  const metadata = await image.metadata();
  const { width, height } = metadata;
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
    throw new Error("decoded image reports no dimensions");
  }
  const stats = await image.stats();
  if (typeof stats.entropy !== "number" || !Number.isFinite(stats.entropy)) {
    throw new Error("decoded image reports no entropy statistic");
  }
  return { width, height, entropy: stats.entropy };
}
