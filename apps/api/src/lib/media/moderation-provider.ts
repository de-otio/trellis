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
  /**
   * Which sampling/scoring policy produced this result. Together with the
   * content hash, the provider, and {@link modelVersion} it identifies the
   * inputs a verdict depended on — the four things you need to answer "how do
   * you know you caught it?" months later, and none of them can be
   * reconstructed after the fact.
   */
  readonly policyVersion?: string;
  /** The raw labels behind the collapsed decision. SERVER-SIDE ONLY (see below). */
  readonly labels?: ReadonlyArray<ModerationLabel>;
  /** The per-frame audit record. SERVER-SIDE ONLY (see below). */
  readonly detail?: ModerationJobDetail;
}

/**
 * The evidence behind a video verdict, for the audit trail.
 *
 * NEVER SEND ANY OF THIS TO A CLIENT. Confidences, frame timings, sampling
 * parameters, and skip counts are a tuning oracle: with them an adversary
 * learns which frames were looked at and how close a piece of content came to
 * a bar, which is precisely enough to iterate against the classifier. It exists
 * so operators can audit their own pipeline, and it stops at the server.
 */
export interface ModerationJobDetail {
  /** How many frames the plan expected, given the clip and the policy. */
  readonly expectedFrames?: number;
  /** How many frames were actually classified. */
  readonly framesScored?: number;
  /**
   * How many expected frames never produced a verdict — undecodable, or lost
   * to an error. A rising number here means the pipeline is seeing less of
   * each video than its policy claims.
   */
  readonly framesSkipped?: number;
  /** Per-frame evidence, in temporal order. */
  readonly frames?: ReadonlyArray<ModerationFrameDetail>;
}

/**
 * Per-frame evidence for one sampled still. Server-side only.
 *
 * **This shape is expected to grow a per-frame perceptual hash, and when it
 * does the hash MUST be computed during the scoring pass.** The frame-sampling
 * adapter deletes every frame it extracted in a `finally` — see the cleanup in
 * `frame-sampling-adapter.ts` — so a hash added later cannot be backfilled from
 * stored data: the only way to recompute it is to re-extract from the original
 * video and re-sample, which is the expensive work a frame hash exists to
 * avoid. Capture it here at scoring time, or lose it for all media already
 * processed.
 *
 * That ordering is the whole constraint. Adding the field is easy; adding it in
 * the wrong place yields a column that is correct going forward and empty for
 * everything historical, which looks like a working cache with a zero hit rate.
 */
export interface ModerationFrameDetail {
  /** Position in the sampled sequence. */
  readonly index: number;
  /** Offset into the clip, in seconds, at the policy's sampling rate. */
  readonly offsetSeconds: number;
  /** `null` when the frame could not be classified. */
  readonly decision: ModerationDecision | null;
  readonly labels?: ReadonlyArray<ModerationLabel>;
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
  /**
   * What this provider calls itself — the same token it puts in
   * `ModerationVerdict.provider`.
   *
   * Optional, because adding a required member to a published seam would break
   * every adapter already implementing it. But absence costs something real:
   * `ModerationVerdict.provider` only exists once a call has SUCCEEDED, so on
   * the paths where there is no verdict — a throw, a deadline breach, or a
   * cache lookup that happens *before* the call — core has no way to attribute
   * the work except by asking the provider. A provider that reports no name is
   * attributed to {@link UNKNOWN_PROVIDER_NAME} on those paths.
   *
   * Keep it identical to the token you put in `verdict.provider`, so the
   * pre-call and post-hoc attributions agree. The one principled exception is a
   * core adapter that AGGREGATES other providers' work: its refusal verdicts
   * are its own (no classifier ran) while its scored verdicts are attributed to
   * the classifier underneath. `FrameSamplingVideoModerationAdapter` does
   * exactly that, and documents it at `scoredAttribution`.
   *
   * Read it through {@link moderationProviderName} rather than directly, and
   * see the wrapper rule documented there.
   */
  readonly name?: string;
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

/** Attribution for a provider that reports no name of its own. */
export const UNKNOWN_PROVIDER_NAME = "unknown";

/**
 * The provider's self-reported name, or {@link UNKNOWN_PROVIDER_NAME}.
 *
 * Core calls this instead of reading `.name` so that one rule holds everywhere:
 * a name is a non-empty string or it does not count. A provider that reports
 * `""`, whitespace, or a non-string is attributed as unknown rather than
 * producing an empty dimension — an empty string is the value a partly-wired
 * adapter yields, and it must not read as a distinct identity.
 *
 * **The wrapper rule.** A decorator around a provider (a deadline, a
 * frame-sampling adapter, a retry shim) must PASS THE INNER NAME THROUGH, never
 * substitute its own. The name answers "whose classifier produced this?", and
 * wrapping does not change the answer. Substituting would split one provider's
 * counters and cache entries across two identities the moment an operator adds
 * a wrapper — and the split would look like a traffic shift rather than a
 * config change.
 *
 * This deliberately does NOT validate the charset. Metric dimensions have their
 * own stricter admission rule against the operator's declared set (see
 * `isAcceptableProviderDimension`); a name that is honest but undeclared should
 * still be usable for a cache key and a log line.
 */
export function moderationProviderName(
  provider: Pick<MediaModerationProvider, "name"> | null | undefined,
): string {
  const name = provider?.name;
  if (typeof name !== "string") return UNKNOWN_PROVIDER_NAME;
  const trimmed = name.trim();
  return trimmed.length === 0 ? UNKNOWN_PROVIDER_NAME : trimmed;
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
 *
 * ── WHY `infraFault` IS SEPARATE FROM `unknownCause` ───────────────────────
 *
 * The two used to be the same thing, and that made one whole class of outage
 * unreportable. `unknownCause` answers "could the adapter attribute this?" and
 * it is only ever consulted on the `retryable: false` branch. So a fault that
 * is BOTH attributable AND transient — a **429 rate limit** being the case that
 * matters — could not raise the signal by any combination of these flags:
 * saying `unknownCause: true` would be a lie (a 429 is perfectly attributed),
 * and saying `retryable: false` would throw away the retry that usually fixes
 * it.
 *
 * The consequence was concrete and matched an observed symptom: a
 * tokens-per-minute ceiling converted an upload burst into a review-queue
 * spike **with no alarm**, because the alarm's input could not be produced.
 * Meanwhile 401/403 — a credential fault — did raise it, with a comment saying
 * such a fault "must alert rather than silently review forever". A sustained
 * 429 is the same situation and was getting the opposite treatment.
 *
 * So `infraFault` now says the thing directly: **"the infrastructure failed,
 * not the media"**, orthogonally to whether it is retryable and to whether the
 * adapter could name it. `unknownCause: true` still implies it, so every
 * existing adapter keeps its current behaviour with no change.
 *
 * It is a COUNTER, not an alarm. A single 429 that succeeds on retry is normal
 * and should be counted; `ModerationMetrics` buckets by window, and the
 * threshold at which a count becomes an alarm is operator config — which is
 * also why counting a transient fault here is not noise.
 */
export class ModerationProviderError extends Error {
  readonly retryable: boolean;
  /** The adapter could not attribute the cause — core alerts as well as fails closed. */
  readonly unknownCause: boolean;
  /**
   * The INFRASTRUCTURE failed, not the media. Independent of {@link retryable}:
   * a throttle or a 5xx is both transient and an infrastructure fault, and
   * operators need the second fact even though core handles the first.
   *
   * Implied by `unknownCause` — an unattributable fault is an infrastructure
   * fault by definition — so adapters that only set `unknownCause` are
   * unaffected.
   */
  readonly infraFault: boolean;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      unknownCause?: boolean;
      infraFault?: boolean;
      cause?: unknown;
    } = {
      retryable: false,
    },
  ) {
    super(message);
    this.name = "ModerationProviderError";
    this.retryable = options.retryable;
    this.unknownCause = options.unknownCause ?? false;
    // `unknownCause` implies `infraFault`, so no existing adapter changes
    // behaviour and no caller has to set both.
    this.infraFault = options.infraFault === true || this.unknownCause;
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
  readonly name = NULL_PROVIDER_NAME;
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
  readonly name = MOCK_PROVIDER_NAME;
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
