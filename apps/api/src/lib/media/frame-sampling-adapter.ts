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
import type { TranscodePort } from "./media-ports.js";
import type {
  ImageRef,
  MediaModerationProvider,
  ModerationCallOptions,
  ModerationVerdict,
  S3Ref,
  VideoModerationStart,
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
    const verdict = await this.resolveVideo(jobId, input, options);
    this.remember(jobId, verdict);
    return { jobId, initialDecision: verdict.decision };
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
  ): Promise<ModerationVerdict> {
    const { transcode, config, log } = this.deps;

    if (typeof transcode.sampleFrames !== "function") {
      log?.error?.(
        "frame-sampling: the transcode adapter cannot extract frames — failing the visual track closed to review",
      );
      return reviewVerdict(PROVIDER_NAME);
    }

    let durationSeconds: number;
    try {
      durationSeconds = await transcode.probeDurationSeconds(input.key);
    } catch (err) {
      log?.warn?.("frame-sampling: duration probe failed — review", {
        error: String(err),
      });
      return reviewVerdict(PROVIDER_NAME);
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
      return reviewVerdict(PROVIDER_NAME);
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
      log?.warn?.("frame-sampling: extraction failed — review", {
        error: String(err),
      });
      return reviewVerdict(PROVIDER_NAME);
    }

    try {
      // A port that ignored the ceiling would turn one upload into an unbounded
      // bill, so the ceiling is re-checked here rather than trusted.
      if (framePaths.length > (config.maxFramesPerJob as number)) {
        log?.error?.(
          "frame-sampling: extraction exceeded the per-job ceiling — review",
          { extracted: framePaths.length },
        );
        return reviewVerdict(PROVIDER_NAME);
      }

      const frames = await this.classifyFrames(input, framePaths, options);
      const decision = aggregateFrameVerdicts(frames, plan.expectedFrames);

      log?.info?.("frame-sampling: aggregated a visual verdict", {
        extractedFrames: framePaths.length,
        expectedFrames: plan.expectedFrames,
        decision,
      });

      return { decision, labels: [], provider: PROVIDER_NAME };
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
  ): Promise<FrameVerdict[]> {
    const limit = Math.max(
      1,
      Math.floor(this.deps.config.frameConcurrency ?? DEFAULT_FRAME_CONCURRENCY),
    );
    const results: FrameVerdict[] = new Array(framePaths.length);
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
          const verdict = await this.deps.images.moderateImage(
            { bucket: input.bucket, key: framePaths[index] },
            options,
          );
          results[index] = {
            decision:
              verdict?.decision === "approved" ||
              verdict?.decision === "review" ||
              verdict?.decision === "quarantine"
                ? verdict.decision
                : null,
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
