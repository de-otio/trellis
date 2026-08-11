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

/**
 * How a stored object is pinned to the EXACT bytes a moderation job scanned.
 *
 * Stores differ in what they can offer: object versioning (`versionId`), an
 * entity tag (`etag`), or a caller-computed digest (`contentHash`). The union
 * lets an adapter carry whichever its store supports without core knowing which.
 *
 * OPAQUE CAPTURE-AND-COMPARE. A pin is captured once, at job start, and later
 * compared for equality against the value recorded then — it is NEVER
 * recomputed from bytes and never interpreted. In particular an `etag` is not a
 * content digest on every store (a multipart upload's ETag is a digest of
 * digests plus a part count), so treating one as a hash would silently compare
 * unequal for identical bytes. Equality is `kind` AND `value`; a differing or
 * absent pin is drift, and drift fails closed.
 */
export interface MediaPin {
  readonly kind: "versionId" | "etag" | "contentHash";
  readonly value: string;
}

/** An opaque reference to an already-stored image object (key + bucket handle). */
export interface ImageRef {
  readonly bucket: string;
  readonly key: string;
  /**
   * Pin the reference to the EXACT stored bytes (AR-SEC F3), so a later
   * overwrite of the same key can never change what a started job scanned.
   */
  readonly pin?: MediaPin;
}

/** An opaque reference to an already-stored object in S3-compatible storage. */
export interface S3Ref {
  readonly bucket: string;
  readonly key: string;
  /**
   * Pin the reference to the EXACT stored bytes (AR-SEC F3), so a later
   * overwrite of the same key can never change what a started job scanned.
   */
  readonly pin?: MediaPin;
  /**
   * @deprecated Alias for `pin: { kind: "versionId", value }`. Kept so existing
   * consumers keep compiling and their refs keep pinning; new code sets `pin`.
   * When both are present `pin` wins.
   */
  readonly versionId?: string;
}

/**
 * The pin a ref carries, normalised across the `pin` field and the deprecated
 * `versionId` alias. Returns `null` when the ref is unpinned — which callers
 * must treat as "cannot certify these bytes", never as "any bytes will do".
 */
export function refPin(ref: ImageRef | S3Ref): MediaPin | null {
  if (ref.pin !== undefined) {
    return ref.pin.value.length > 0 ? ref.pin : null;
  }
  const legacy = (ref as S3Ref).versionId;
  return typeof legacy === "string" && legacy.length > 0
    ? { kind: "versionId", value: legacy }
    : null;
}

/**
 * Opaque pin equality. Two pins match iff both are present, of the same kind,
 * and byte-identical. A missing pin on either side is NOT a match — absence of
 * evidence is not evidence of sameness.
 */
export function pinsEqual(a: MediaPin | null, b: MediaPin | null): boolean {
  if (a === null || b === null) return false;
  return a.kind === b.kind && a.value === b.value;
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
  /**
   * The classifier/taxonomy build that produced this verdict, as an OPAQUE
   * string the provider chooses (a model id, a taxonomy version, a build tag).
   * Core never parses it — it only compares it for equality against the version
   * the operator pinned, so a silent taxonomy change cannot keep approving
   * against a category map that no longer means what it did.
   *
   * OPTIONAL, because this is a published seam and a required field would break
   * every existing adapter. The consequence is stated rather than hidden: under
   * a pin mode that demands a version, ABSENCE is unverifiable and therefore
   * `review` — a provider that reports nothing gets no approvals.
   */
  readonly modelVersion?: string;
}

/**
 * Per-call options every seam method accepts.
 *
 * `signal` lets the caller abort in-flight provider work when its deadline
 * expires. Aborting is only half the contract: the DECISION is committed at the
 * deadline, so a provider that resolves afterwards must not be able to overturn
 * the fail-closed verdict already recorded. The deadline wrapper enforces both
 * halves; an adapter only needs to honour the signal.
 */
export interface ModerationCallOptions {
  readonly signal?: AbortSignal;
}

/**
 * The handle returned when a video moderation job is started.
 *
 * `jobId` is the poll handle. `initialDecision` is present only when the
 * backend ALREADY resolved the whole track during the start call — which is
 * what core's frame-sampling adapter does: it samples, classifies and
 * aggregates inline, so there is no remote job to poll and no completion
 * notification will ever arrive for this id. The caller persists that decision
 * immediately instead of waiting for a message that is not coming.
 *
 * Both extra fields are OPTIONAL, so an existing adapter that returns `{ jobId }`
 * still satisfies the seam.
 */
export interface VideoModerationStart {
  readonly jobId: string;
  /** Set when the track resolved during `start`; no poll or completion follows. */
  readonly initialDecision?: ModerationDecision;
  /** The taxonomy version the job started under, for drift detection at completion. */
  readonly modelVersion?: string;
}

/**
 * The one canonical moderation seam. Image moderation is sync-ish (resolves a
 * verdict directly); video moderation is async (start → poll), mirroring the
 * cloud provider's job model. Audio reuses the text-moderation path and adds no
 * method here.
 *
 * A provider that can only classify STILL IMAGES satisfies this seam: core's
 * frame-sampling video adapter turns `moderateImage` into video moderation by
 * sampling frames and aggregating their verdicts. Implementing
 * `startVideoModeration`/`getVideoModeration` natively is for backends that
 * have their own video job model.
 */
export interface MediaModerationProvider {
  /** Synchronous-style image moderation: resolves a verdict directly. */
  moderateImage(
    input: ImageRef,
    options?: ModerationCallOptions,
  ): Promise<ModerationVerdict>;
  /** Kicks off async video moderation; returns a handle to poll. */
  startVideoModeration(
    input: S3Ref,
    options?: ModerationCallOptions,
  ): Promise<VideoModerationStart>;
  /** Polls a previously-started video moderation job for its verdict. */
  getVideoModeration(
    jobId: string,
    options?: ModerationCallOptions,
  ): Promise<ModerationVerdict>;
}

// ---------------------------------------------------------------------------
// Provider error contract.
// ---------------------------------------------------------------------------

/**
 * The typed error a provider adapter throws so core can classify the failure
 * without pattern-matching on vendor error names.
 *
 * `retryable` is the adapter's own judgement about whether the SAME call could
 * succeed later:
 *   - `true`  — transient (throttle, 5xx, socket). Core retries; the existing
 *               3-strike/DLQ path remains the upper bound.
 *   - `false` — permanent for these bytes (rejected input, unsupported media).
 *               Core stops retrying and fails the track closed to `review`.
 *
 * A typed error whose cause the adapter cannot attribute is thrown with
 * `retryable: false` AND `unknownCause: true`: core then fails closed to
 * `review` *and* emits an infra-fault signal, because a fail-closed verdict
 * that silently absorbs an infrastructure outage is indistinguishable from
 * healthy caution — exactly the blindness that lets an outage run for days.
 */
export class ModerationProviderError extends Error {
  readonly retryable: boolean;
  /** The adapter could not attribute the cause — core alerts as well as fails closed. */
  readonly unknownCause: boolean;

  constructor(
    message: string,
    options: { retryable: boolean; unknownCause?: boolean; cause?: unknown } = {
      retryable: false,
    },
  ) {
    super(message);
    this.name = "ModerationProviderError";
    this.retryable = options.retryable;
    this.unknownCause = options.unknownCause ?? false;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Structural type guard for {@link ModerationProviderError}. Structural rather
 * than `instanceof` on purpose: an adapter bundled with its own copy of this
 * package (npm nesting, a linked workspace) produces an error whose prototype
 * chain is a DIFFERENT class object, and an `instanceof` check would silently
 * demote it to the untyped fallback.
 */
export function isModerationProviderError(
  err: unknown,
): err is ModerationProviderError {
  if (err === null || typeof err !== "object") return false;
  const o = err as Record<string, unknown>;
  return (
    o.name === "ModerationProviderError" && typeof o.retryable === "boolean"
  );
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

  async moderateImage(
    _input: ImageRef,
    _options?: ModerationCallOptions,
  ): Promise<ModerationVerdict> {
    return this.failClosed();
  }

  async startVideoModeration(
    _input: S3Ref,
    _options?: ModerationCallOptions,
  ): Promise<VideoModerationStart> {
    // Even starting a job warns: there is no backend to do the work.
    this.warn(NULL_PROVIDER_WARNING);
    return { jobId: `${NULL_PROVIDER_NAME}-noop` };
  }

  async getVideoModeration(
    _jobId: string,
    _options?: ModerationCallOptions,
  ): Promise<ModerationVerdict> {
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
  private imageResponder?: (
    input: ImageRef,
    options?: ModerationCallOptions,
  ) => Promise<ModerationVerdict>;
  private jobIdSeq = 0;

  /** Every `moderateImage` ref, in call order — for asserting frame fan-out. */
  readonly imageCalls: ImageRef[] = [];
  /** Every `startVideoModeration` ref, in call order. */
  readonly startVideoCalls: S3Ref[] = [];

  constructor(
    canned: {
      image?: ModerationVerdict;
      video?: ModerationVerdict;
    } = {},
  ) {
    this.imageVerdict = canned.image ?? MOCK_DEFAULT_VERDICT;
    this.videoVerdict = canned.video ?? MOCK_DEFAULT_VERDICT;
  }

  /**
   * Program the verdict returned by `moderateImage`. Set `modelVersion` here to
   * exercise the taxonomy-pin modes; leave it unset to exercise the
   * unverifiable-pin path (which must fail closed to `review`).
   */
  setImageVerdict(verdict: ModerationVerdict): void {
    this.imageVerdict = verdict;
    this.imageResponder = undefined;
  }

  /**
   * Program a per-call responder for `moderateImage` — the seam for tests that
   * need a verdict to depend on WHICH ref was asked about (per-frame verdicts),
   * or that need the call to reject or to never settle. The responder owns its
   * own timing, so the mock stays free of clocks.
   */
  setImageResponder(
    responder: (
      input: ImageRef,
      options?: ModerationCallOptions,
    ) => Promise<ModerationVerdict>,
  ): void {
    this.imageResponder = responder;
  }

  /** Program the verdict returned by `getVideoModeration`. */
  setVideoVerdict(verdict: ModerationVerdict): void {
    this.videoVerdict = verdict;
  }

  async moderateImage(
    input: ImageRef,
    options?: ModerationCallOptions,
  ): Promise<ModerationVerdict> {
    this.imageCalls.push(input);
    if (this.imageResponder) return this.imageResponder(input, options);
    return this.imageVerdict;
  }

  async startVideoModeration(
    input: S3Ref,
    _options?: ModerationCallOptions,
  ): Promise<VideoModerationStart> {
    this.startVideoCalls.push(input);
    this.jobIdSeq += 1;
    return { jobId: `${MOCK_PROVIDER_NAME}-job-${this.jobIdSeq}` };
  }

  async getVideoModeration(
    _jobId: string,
    _options?: ModerationCallOptions,
  ): Promise<ModerationVerdict> {
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
