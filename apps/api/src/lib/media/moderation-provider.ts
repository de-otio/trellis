// CONTRACT: stable — coordinate changes.
//
// The MediaModerationProvider capability seam — THE interface every media
// moderation backend binds to, mirroring the RealtimeTransport seam
// (apps/api/src/lib/realtime/). Core ships the interface plus a fail-closed
// Null provider and a test-only Mock; the consuming app (Skybber) injects the
// concrete cloud adapter at startup. Core imports no cloud SDK.
//
// Binding rules for every provider implementor:
//   - A verdict carries a 3-value `decision` (approved | review | quarantine).
//     `rejected` is a lifecycle state reached only by human/CSAM action, never a
//     provider decision (see ModerationStatus state machine).
//   - Absence of signal, an internal fault, or any uncertainty MUST fail closed
//     to `review`. A provider must NEVER manufacture `approved` from doubt.
//   - This interface ships in the PUBLIC npm tarball: NO thresholds, secrets, or
//     real-category vocabulary live here. Labels carry opaque category tokens;
//     the operative numeric thresholds are injected via Env (config), not code.
//   - CSAM detection is deliberately NOT on this interface — it is a separate,
//     statutory provider with preserve-and-report duties.
//   - Refs are opaque (key + bucket handle), never raw image/video bytes.

// ModerationDecision is owned by the moderation-status module (T1). Imported for
// local use (below) and re-exported so call sites that pull the decision union
// from the provider seam keep working; the single source of truth is
// ./moderation-status.ts.
import type { ModerationDecision } from "./media-lifecycle.js";
export type { ModerationDecision };

/** An opaque reference to an already-stored image object (key + bucket handle). */
export interface ImageRef {
  readonly bucket: string;
  readonly key: string;
}

/** An opaque reference to an already-stored object in S3-compatible storage. */
export interface S3Ref {
  readonly bucket: string;
  readonly key: string;
  /**
   * Pin the reference to an EXACT stored object version (AR-SEC F3). When set,
   * the provider adapter must moderate that specific version (Rekognition:
   * `Video.S3Object.Version`), so a later overwrite of the same key can never
   * change what a started job actually scanned.
   */
  readonly versionId?: string;
}

/** A single classifier label. `category` is an OPAQUE token, never a real-category string. */
export interface ModerationLabel {
  readonly category: string;
  readonly confidence: number;
}

/**
 * ModerationVerdict — the RESULT object (hub name). The `decision` is the
 * 3-value classifier verdict; `labels` are opaque category tokens with
 * confidences; `provider` identifies which backend produced it.
 */
export interface ModerationVerdict {
  readonly decision: ModerationDecision;
  readonly labels: ReadonlyArray<ModerationLabel>;
  readonly provider: string;
}

/**
 * The one canonical moderation seam. Image moderation is sync-ish (resolves a
 * verdict directly); video moderation is async (start → poll), mirroring the
 * cloud provider's job model. Audio reuses the text-moderation path and adds no
 * method here.
 */
export interface MediaModerationProvider {
  /** Synchronous-style image moderation: resolves a verdict directly. */
  moderateImage(input: ImageRef): Promise<ModerationVerdict>;
  /** Kicks off async video moderation; returns a handle to poll. */
  startVideoModeration(input: S3Ref): Promise<{ jobId: string }>;
  /** Polls a previously-started video moderation job for its verdict. */
  getVideoModeration(jobId: string): Promise<ModerationVerdict>;
}

// ---------------------------------------------------------------------------
// Warning sink.
//
// The Null provider must warn loudly on every call. To keep this module a pure
// functional core (no dependency on the I/O logger module), the warning sink is
// an injectable callback shaped like Logger.warn. It defaults to console.warn so
// the provider is loud out of the box, but tests inject a spy instead.
// ---------------------------------------------------------------------------

export type WarnSink = (message: string, data?: unknown) => void;

const NULL_PROVIDER_NAME = "null";
const NULL_PROVIDER_WARNING =
  "[NullModerationProvider] No moderation backend injected — failing closed to" +
  ' decision="review". Media will NOT auto-approve. Inject a real provider in' +
  " any non-dev environment.";

/**
 * A verdict that fails closed: every call resolves to `review` with no labels.
 * Nothing this provider returns can ever auto-approve media. Used as the safe
 * default before a concrete provider is injected (dev only — see the startup
 * guard below).
 */
export class NullModerationProvider implements MediaModerationProvider {
  private readonly warn: WarnSink;

  constructor(warn: WarnSink = (msg, data) => console.warn(msg, data)) {
    this.warn = warn;
  }

  private failClosed(): ModerationVerdict {
    this.warn(NULL_PROVIDER_WARNING);
    return { decision: "review", labels: [], provider: NULL_PROVIDER_NAME };
  }

  async moderateImage(_input: ImageRef): Promise<ModerationVerdict> {
    return this.failClosed();
  }

  async startVideoModeration(_input: S3Ref): Promise<{ jobId: string }> {
    // Even starting a job warns: there is no backend to do the work.
    this.warn(NULL_PROVIDER_WARNING);
    return { jobId: `${NULL_PROVIDER_NAME}-noop` };
  }

  async getVideoModeration(_jobId: string): Promise<ModerationVerdict> {
    return this.failClosed();
  }
}

/**
 * Returns true for the fail-closed Null provider. The startup guard uses this to
 * reject Null outside dev.
 */
export function isNullModerationProvider(
  provider: MediaModerationProvider,
): boolean {
  return provider instanceof NullModerationProvider;
}

const MOCK_PROVIDER_NAME = "mock";

const MOCK_DEFAULT_VERDICT: ModerationVerdict = {
  decision: "review",
  labels: [],
  provider: MOCK_PROVIDER_NAME,
};

/**
 * A test seam: returns canned verdicts on demand. Default is the fail-closed
 * `review`. Labels use ONLY abstract category tokens (`category_a`,
 * `category_b`); no real-category strings, no real imagery ever.
 */
export class MockModerationProvider implements MediaModerationProvider {
  private imageVerdict: ModerationVerdict;
  private videoVerdict: ModerationVerdict;
  private jobIdSeq = 0;

  constructor(
    canned: {
      image?: ModerationVerdict;
      video?: ModerationVerdict;
    } = {},
  ) {
    this.imageVerdict = canned.image ?? MOCK_DEFAULT_VERDICT;
    this.videoVerdict = canned.video ?? MOCK_DEFAULT_VERDICT;
  }

  /** Program the verdict returned by `moderateImage`. */
  setImageVerdict(verdict: ModerationVerdict): void {
    this.imageVerdict = verdict;
  }

  /** Program the verdict returned by `getVideoModeration`. */
  setVideoVerdict(verdict: ModerationVerdict): void {
    this.videoVerdict = verdict;
  }

  async moderateImage(_input: ImageRef): Promise<ModerationVerdict> {
    return this.imageVerdict;
  }

  async startVideoModeration(_input: S3Ref): Promise<{ jobId: string }> {
    this.jobIdSeq += 1;
    return { jobId: `${MOCK_PROVIDER_NAME}-job-${this.jobIdSeq}` };
  }

  async getVideoModeration(_jobId: string): Promise<ModerationVerdict> {
    return this.videoVerdict;
  }
}

/** Abstract category tokens for Mock verdicts — never real-category strings. */
export const MOCK_CATEGORY_A = "category_a";
export const MOCK_CATEGORY_B = "category_b";

/**
 * Error raised by the startup guard when the fail-closed Null provider would run
 * outside dev. Carrying a distinct type lets the wiring fail loudly and lets
 * tests assert on it.
 */
export class NullProviderInProductionError extends Error {
  constructor(environment: string) {
    super(
      `NullModerationProvider must not run in environment "${environment}" — a` +
        " real moderation provider must be injected outside dev. Refusing to" +
        " start: an un-moderated, fail-closed backend in production silently" +
        " sends all media to review with no path to approval.",
    );
    this.name = "NullProviderInProductionError";
  }
}

/**
 * Startup guard for the seam wiring. Validates that a non-Null provider is
 * injected whenever `environment !== "dev"`, and throws loudly otherwise.
 * Returns the provider unchanged when the check passes, so it can wrap the
 * injection site directly:
 *
 *   const provider = assertModerationProviderAllowed(injected, env.ENVIRONMENT);
 *
 * Fail loud, never silently run Null in prod.
 */
export function assertModerationProviderAllowed(
  provider: MediaModerationProvider,
  environment: string,
): MediaModerationProvider {
  if (environment !== "dev" && isNullModerationProvider(provider)) {
    throw new NullProviderInProductionError(environment);
  }
  return provider;
}
