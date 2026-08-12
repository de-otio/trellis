/**
 * frame-sampling-adapter.ts — video moderation for an IMAGE-ONLY classifier.
 *
 * The moderation seam asks a backend for three things, and the third — a video
 * job model with its own start/poll lifecycle and its own completion
 * notification — is the one most classifiers do not have. This adapter supplies
 * it in core: given any provider that can classify a still image, it samples
 * frames out of a video, classifies each, and aggregates the results under the
 * law in ./frame-aggregation.ts.
 *
 * RESOLVES INLINE, ON PURPOSE. `startVideoModeration` does the whole job and
 * returns `initialDecision` alongside the job id. There is no remote job to
 * poll and no completion message will ever arrive, so the caller persists the
 * decision immediately (the same mechanism a silent video's audio track already
 * uses) rather than waiting for a notification that is not coming. Two
 * consequences, stated rather than discovered later:
 *
 *   - Sampling time is spent inside the CALLER's budget — for the media
 *     pipeline, the processing worker's. It is bounded by `maxFramesPerJob`
 *     times the per-frame classifier call, plus the extraction itself.
 *   - The job id is core-minted and carries no tenant, key, or user material:
 *     it is crypto-random, because an id that encodes what it points at is an
 *     id that leaks what it points at wherever ids are logged.
 *
 * CLEANUP covers every frame this adapter is TOLD about: success, ceiling
 * breach, classifier error, abort. The one gap is an extractor that writes
 * frames and then throws without reporting their paths — core cannot delete
 * files it never learned of, so the port makes that the adapter's
 * responsibility and core logs the prefix.
 *
 * FAIL-CLOSED AT EVERY EDGE. No sampling config, no `sampleFrames` capability,
 * a ceiling breach, an extraction shortfall, an aborted deadline, a classifier
 * that throws — every one of them resolves `review`. Nothing in this file can
 * produce `approved` except a complete set of frames that each approved.
 */

import {
  aggregateFrameVerdicts,
  planFrameSampling,
  type FrameVerdict,
} from "./frame-aggregation.js";
import type { LabelPolicy } from "./label-policy.js";
import type { TranscodePort } from "./media-ports.js";
import { createHash } from "node:crypto";

import type {
  ImageRef,
  MediaModerationProvider,
  ModerationCallOptions,
  ModerationFrameDetail,
  ModerationJobDetail,
  ModerationLabel,
  ModerationVerdict,
  S3Ref,
  VideoModerationStart,
} from "./moderation-provider.js";
import {
  UNKNOWN_PROVIDER_NAME,
  moderationProviderName,
} from "./moderation-provider.js";

/**
 * Sampling parameters. Both moderation-relevant values are operator-supplied
 * with NO compiled default — absence means the feature refuses to run, which is
 * why they are optional in the type but fatal at use.
 */
export interface FrameSamplingConfig {
  /** Frames sampled per second of video. Operator-supplied; no default. */
  readonly framesPerSecond?: number;
  /** Absolute ceiling on frames for one job. Operator-supplied; no default. */
  readonly maxFramesPerJob?: number;
  /**
   * The pipeline's duration cap, passed through to the extractor so a single
   * clip cannot make it run unbounded. Operator-supplied (Env.media); absence
   * refuses the job rather than guessing a bound.
   */
  readonly maxDurationSeconds?: number;
  /**
   * How many frames to classify concurrently. A RESOURCE bound, not a
   * moderation parameter — it trades wall-clock against provider rate limits
   * and says nothing about policy — so it has a conservative code default.
   */
  readonly frameConcurrency?: number;
  /**
   * An operator-chosen name for this sampling policy, recorded on every job.
   *
   * When absent, a FINGERPRINT of the effective parameters is used instead: a
   * short digest that changes if and only if the policy changed. That is the
   * property an audit needs ("was this scanned under the policy we think?"),
   * and it is available with no operator action, so the audit trail is never
   * simply empty. It does NOT conceal the parameters — see
   * {@link policyFingerprint} — so it is server-side-only material either way.
   */
  readonly policyVersion?: string;
}

/**
 * A short digest of the effective sampling parameters.
 *
 * Its job is to tell two policies APART, and that is all it should be trusted
 * to do. It is NOT a concealment control: an unsalted digest over a handful of
 * plausible rates and small integer ceilings has a preimage space small enough
 * to exhaust in under a second, so anyone holding this string can recover the
 * parameters. Treat `policyVersion` as server-side-only material with the same
 * "never send to a client" rule as the per-frame audit detail — an operator who
 * needs a genuinely opaque identifier should supply their own
 * {@link FrameSamplingConfig.policyVersion}.
 */
function policyFingerprint(config: FrameSamplingConfig): string {
  const canonical = JSON.stringify({
    fps: config.framesPerSecond ?? null,
    max: config.maxFramesPerJob ?? null,
    dur: config.maxDurationSeconds ?? null,
  });
  return `fs-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/** Conservative default fan-out: enough to be useful, low enough to be polite. */
const DEFAULT_FRAME_CONCURRENCY = 4;

/** Logging seam; the worker already has one of this shape. */
export interface FrameSamplingLog {
  info?: (msg: string, data?: Record<string, unknown>) => void;
  warn?: (msg: string, data?: Record<string, unknown>) => void;
  error?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface FrameSamplingDeps {
  /** The image-only classifier this adapter turns into a video classifier. */
  readonly images: MediaModerationProvider;
  /**
   * The operator's label policy, applied to EVERY frame.
   *
   * Without it the video path would honour the provider's own per-frame
   * decision while the image path honoured the operator's policy — so the
   * policy's strongest rule ("a category you have not mapped quarantines")
   * would hold for a still and not for the same content inside a clip. An
   * operator who configures a policy reasonably believes it governs both.
   *
   * The policy can only degrade a frame's verdict, so wiring it can never make
   * the video path more permissive than the provider already was.
   */
  readonly policy?: LabelPolicy;
  /** Frame extraction + per-frame cleanup. */
  readonly transcode: TranscodePort;
  readonly config: FrameSamplingConfig;
  /**
   * Where frames for a job are written. Returns a storage prefix; the transcode
   * adapter writes the numbered frames beneath it and reports their keys back.
   */
  readonly frameDirFor: (jobId: string) => string;
  /**
   * Mints the core-side job id. Injected so the adapter stays free of ambient
   * randomness in tests; production passes a crypto-random generator.
   */
  readonly newJobId: () => string;
  readonly log?: FrameSamplingLog;
}

/** The fail-closed verdict this adapter returns whenever anything is unclear. */
function reviewVerdict(provider: string): ModerationVerdict {
  return { decision: "review", labels: [], provider };
}

/**
 * A frame's verdict plus the evidence behind it. Extends the aggregation law's
 * input rather than replacing it: the law still sees only `decision`, so
 * carrying evidence cannot change what the evidence decides.
 */
interface ScoredFrame extends FrameVerdict {
  readonly labels?: ReadonlyArray<ModerationLabel>;
  readonly modelVersion?: string;
}

/** The fail-closed result, with whatever audit detail was known at the refusal. */
function refused(detail: ModerationJobDetail = {}): {
  verdict: ModerationVerdict;
  detail: ModerationJobDetail;
} {
  return {
    verdict: reviewVerdict(PROVIDER_NAME),
    detail: { framesScored: 0, ...detail },
  };
}

const PROVIDER_NAME = "frame-sampling";

/**
 * How many resolved verdicts to keep for in-process polling. Small on purpose:
 * the decision is persisted by the caller at start time, so this cache only
 * serves a same-process `getVideoModeration` and must never become a place
 * where verdicts quietly accumulate.
 */
const VERDICT_CACHE_LIMIT = 128;

export class FrameSamplingVideoModerationAdapter
  implements MediaModerationProvider
{
  private readonly deps: FrameSamplingDeps;
  private readonly resolved = new Map<string, ModerationVerdict>();

  constructor(deps: FrameSamplingDeps) {
    this.deps = deps;
  }

  /**
   * The underlying classifier's name, passed through unchanged. This adapter
   * supplies a video JOB MODEL; it does not classify anything itself, so it is
   * not a separate provider identity. A getter rather than a copied field so a
   * provider that names itself lazily is still reported correctly.
   */
  get name(): string | undefined {
    return this.deps.images.name;
  }

  /**
   * Who to attribute an AGGREGATE verdict to: the classifier that actually
   * scored the frames, falling back to this adapter only when that classifier
   * reports no name.
   *
   * Not {@link PROVIDER_NAME} unconditionally. `"frame-sampling"` is the same
   * string for every classifier, so attributing scored verdicts to it collides
   * every backend into one identity — which defeats a per-provider cache key
   * and makes per-provider counters meaningless. It would also disagree with
   * what {@link name} reports, and a verdict field that contradicts the
   * provider's own name leaves two sets of counters with nothing to say which
   * is right.
   *
   * The REFUSAL verdicts are deliberately not routed through here: when core
   * declines to sample at all, no classifier ran, and `"frame-sampling"` is the
   * honest answer to who produced that verdict.
   */
  private scoredAttribution(): string {
    const inner = moderationProviderName(this.deps.images);
    return inner === UNKNOWN_PROVIDER_NAME ? PROVIDER_NAME : inner;
  }

  /** Images pass straight through to the underlying classifier. */
  async moderateImage(
    input: ImageRef,
    options?: ModerationCallOptions,
  ): Promise<ModerationVerdict> {
    return this.deps.images.moderateImage(input, options);
  }

  /**
   * Sample, classify, aggregate — all of it, now. Returns the minted job id
   * together with the decision it already reached.
   */
  async startVideoModeration(
    input: S3Ref,
    options?: ModerationCallOptions,
  ): Promise<VideoModerationStart> {
    const jobId = this.deps.newJobId();
    const { verdict, detail } = await this.resolveVideo(jobId, input, options);
    this.remember(jobId, verdict);
    return {
      jobId,
      initialDecision: verdict.decision,
      policyVersion:
        this.deps.config.policyVersion ?? policyFingerprint(this.deps.config),
      labels: verdict.labels,
      detail,
    };
  }

  /**
   * Poll. For a job this adapter minted, the answer was already known at start
   * and persisted by the caller; this returns the cached verdict when the poll
   * happens in the same process, and fails closed to `review` otherwise. It
   * NEVER invents an approval for an id it does not recognise.
   */
  async getVideoModeration(
    jobId: string,
    _options?: ModerationCallOptions,
  ): Promise<ModerationVerdict> {
    const known = this.resolved.get(jobId);
    if (known !== undefined) return known;
    this.deps.log?.warn?.(
      "frame-sampling: polled for an unknown job — failing closed to review",
    );
    return reviewVerdict(PROVIDER_NAME);
  }

  private remember(jobId: string, verdict: ModerationVerdict): void {
    if (this.resolved.size >= VERDICT_CACHE_LIMIT) {
      // Oldest insertion first — Map preserves insertion order.
      const oldest = this.resolved.keys().next();
      if (!oldest.done) this.resolved.delete(oldest.value);
    }
    this.resolved.set(jobId, verdict);
  }

  private async resolveVideo(
    jobId: string,
    input: S3Ref,
    options?: ModerationCallOptions,
  ): Promise<{ verdict: ModerationVerdict; detail: ModerationJobDetail }> {
    const { transcode, config, log } = this.deps;

    if (typeof transcode.sampleFrames !== "function") {
      log?.error?.(
        "frame-sampling: the transcode adapter cannot extract frames — failing the visual track closed to review",
      );
      return refused();
    }

    let durationSeconds: number;
    try {
      durationSeconds = await transcode.probeDurationSeconds(input.key);
    } catch (err) {
      log?.warn?.("frame-sampling: duration probe failed — review", {
        error: String(err),
      });
      return refused();
    }

    const plan =
      typeof config.maxDurationSeconds === "number" &&
      Number.isFinite(config.maxDurationSeconds) &&
      config.maxDurationSeconds > 0
        ? planFrameSampling({
            durationSeconds,
            framesPerSecond: config.framesPerSecond,
            maxFrames: config.maxFramesPerJob,
          })
        : ({ ok: false, reason: "config-absent" } as const);
    if (!plan.ok) {
      // `config-absent`: nobody configured a rate or a ceiling, so there is no
      // sampling policy to apply and none is invented here.
      // `ceiling-exceeded`: this clip would need more frames than the operator
      // allows per job, and silently sampling fewer would scan it at a rate
      // nobody chose — indistinguishable afterwards from a decode failure.
      log?.warn?.("frame-sampling: refusing to sample — review", {
        reason: plan.reason,
      });
      return refused();
    }

    const outputDir = this.deps.frameDirFor(jobId);
    let framePaths: ReadonlyArray<string> = [];
    try {
      const sampled = await transcode.sampleFrames({
        inputPath: input.key,
        outputDir,
        framesPerSecond: config.framesPerSecond as number,
        maxFrames: config.maxFramesPerJob as number,
        maxDurationSeconds: config.maxDurationSeconds as number,
      });
      framePaths = Array.isArray(sampled?.framePaths) ? sampled.framePaths : [];
    } catch (err) {
      // An extractor that wrote some frames and THEN threw leaves them behind:
      // it never returned their paths, so there is nothing here to delete. The
      // prefix is logged so an operator can reap it, and the port documents
      // that a throwing adapter owns whatever it already wrote — core cannot
      // clean up files it was never told about.
      log?.warn?.(
        "frame-sampling: extraction failed — review (any frames already written under outputDir are the adapter's to remove)",
        { error: String(err), outputDir },
      );
      return refused({ expectedFrames: plan.expectedFrames });
    }

    try {
      // A port that ignored the ceiling would turn one upload into an unbounded
      // bill, so the ceiling is re-checked here rather than trusted.
      if (framePaths.length > (config.maxFramesPerJob as number)) {
        log?.error?.(
          "frame-sampling: extraction exceeded the per-job ceiling — review",
          { extracted: framePaths.length },
        );
        return refused({ expectedFrames: plan.expectedFrames });
      }

      const frames = await this.classifyFrames(input, framePaths, options);
      const decision = aggregateFrameVerdicts(frames, plan.expectedFrames);

      log?.info?.("frame-sampling: aggregated a visual verdict", {
        extractedFrames: framePaths.length,
        expectedFrames: plan.expectedFrames,
        decision,
      });

      // Carry the evidence, not just the enum. A collapsed 3-value verdict is
      // all the pipeline needs to act, but it is not enough for anything to
      // later observe WHY — and the labels and frame timings cannot be
      // reconstructed once the frames are deleted, which happens below.
      const interval = 1 / (config.framesPerSecond as number);
      return {
        verdict: {
          decision,
          labels: frames.flatMap((f) => f.labels ?? []),
          provider: this.scoredAttribution(),
        },
        detail: {
          expectedFrames: plan.expectedFrames,
          framesScored: frames.filter((f) => f.decision !== null).length,
          framesSkipped: Math.max(
            0,
            plan.expectedFrames - frames.filter((f) => f.decision !== null).length,
          ),
          // If a per-frame perceptual hash is ever added, it belongs HERE — in
          // this mapping, inside the scoring pass — not in a later stage. The
          // `finally` below deletes every frame, so a hash computed afterwards
          // has nothing to read and cannot be backfilled for media already
          // processed. See the note on `ModerationFrameDetail`.
          frames: frames.map<ModerationFrameDetail>((f, index) => ({
            index,
            offsetSeconds: index * interval,
            decision: f.decision,
            ...(f.labels !== undefined && { labels: f.labels }),
            ...(f.modelVersion !== undefined && { modelVersion: f.modelVersion }),
          })),
        },
      };
    } finally {
      // EVERY path: success, ceiling breach, classifier error, abort. A sampled
      // still is a copy of user media and must not outlive the decision it
      // informed.
      await this.cleanup(framePaths);
    }
  }

  /**
   * Classify each frame, at most `frameConcurrency` at a time. A frame whose
   * classification throws — or that is reached after the caller's deadline
   * aborted — contributes `null`, which the aggregation law counts as `review`.
   */
  private async classifyFrames(
    input: S3Ref,
    framePaths: ReadonlyArray<string>,
    options?: ModerationCallOptions,
  ): Promise<ScoredFrame[]> {
    const limit = Math.max(
      1,
      Math.floor(this.deps.config.frameConcurrency ?? DEFAULT_FRAME_CONCURRENCY),
    );
    const results: ScoredFrame[] = new Array(framePaths.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= framePaths.length) return;
        if (options?.signal?.aborted === true) {
          // Do not start work the caller has already stopped waiting for.
          results[index] = { decision: null };
          continue;
        }
        try {
          const raw = await this.deps.images.moderateImage(
            { bucket: input.bucket, key: framePaths[index] },
            options,
          );
          // The operator's policy is authoritative over the provider's own
          // decision here exactly as it is on the image path. It only ever
          // degrades, so this cannot loosen a frame.
          const verdict =
            this.deps.policy === undefined
              ? raw
              : { ...raw, decision: this.deps.policy.decide(raw) };
          results[index] = {
            decision:
              verdict?.decision === "approved" ||
              verdict?.decision === "review" ||
              verdict?.decision === "quarantine"
                ? verdict.decision
                : null,
            ...(Array.isArray(raw?.labels) && { labels: raw.labels }),
            ...(raw?.modelVersion !== undefined && {
              modelVersion: raw.modelVersion,
            }),
          };
        } catch (err) {
          this.deps.log?.warn?.(
            "frame-sampling: a frame could not be classified — counting it as review",
            { error: String(err) },
          );
          results[index] = { decision: null };
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(limit, framePaths.length) }, () => worker()),
    );
    return results;
  }

  private async cleanup(framePaths: ReadonlyArray<string>): Promise<void> {
    const { transcode, log } = this.deps;
    if (typeof transcode.deleteFrame !== "function") {
      if (framePaths.length > 0) {
        log?.warn?.(
          "frame-sampling: the transcode adapter exposes no frame cleanup — sampled stills are the adapter's responsibility",
          { frames: framePaths.length },
        );
      }
      return;
    }
    for (const path of framePaths) {
      try {
        await transcode.deleteFrame(path);
      } catch (err) {
        // Best-effort: a leftover temp frame is storage noise, and letting a
        // cleanup failure escape would convert it into a lost verdict.
        log?.warn?.("frame-sampling: frame cleanup tolerated", {
          error: String(err),
        });
      }
    }
  }
}
