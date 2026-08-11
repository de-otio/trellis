// CONTRACT: stable — coordinate changes. Shared P0b I/O SEAM definitions.
//
// These are the capability seams the media pipeline's imperative SHELL binds to,
// mirroring the MediaModerationProvider seam discipline (./moderation-provider.ts):
// core ships the *interfaces* plus test-only Mock implementations; the consuming
// app (Skybber) injects the concrete cloud adapters (ffmpeg/MediaConvert, S3,
// Transcribe) at startup. Core imports NO cloud SDK here.
//
// IMPORTANT: this file deliberately defines ONLY the seam interfaces and their
// in-memory Mocks. The mocks are deterministic and side-effect-free w.r.t. the
// outside world (they touch only their own in-process state) so functional-core
// units can be exercised against them in property tests. Operational parameters
// (e.g. maxDurationSeconds) are *arguments*, never literals baked into these
// interfaces — this file ships in the PUBLIC npm tarball.

import { expectedFrameCount } from "./frame-aggregation.js";

// ---------------------------------------------------------------------------
// TranscodePort — re-encode/normalize video & audio to a known-clean form,
// strip active content, generate a poster frame. The shell drives this from a
// staging path to an output path; the functional core never touches bytes.
// ---------------------------------------------------------------------------

export interface TranscodeVideoInput {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly posterPath: string;
  /** Hard cap on accepted duration; injected from Env.media (never a literal). */
  readonly maxDurationSeconds: number;
}

export interface TranscodeVideoResult {
  readonly cleanedPath: string;
  readonly posterPath: string;
  readonly durationSeconds: number;
  /**
   * Whether the cleaned output carries an audio stream. A video with no audio
   * (a silent clip, a screen recording, a GIF-style mp4) has nothing to
   * transcribe — the shell skips the AUDIO speech-to-text job and resolves the
   * AUDIO track as vacuously approved (no audio ⇒ no audio content to be
   * unsafe), instead of starting a transcription that would fail and fail the
   * track closed to REVIEW forever. The adapter reports this from a probe of
   * the produced output (NOT a guess); the shell never inspects bytes itself.
   */
  readonly hasAudio: boolean;
}

export interface TranscodeAudioInput {
  readonly inputPath: string;
  readonly outputPath: string;
  /** Hard cap on accepted duration; injected from Env.media (never a literal). */
  readonly maxDurationSeconds: number;
}

export interface TranscodeAudioResult {
  readonly cleanedPath: string;
  readonly durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Frame sampling — the input to core's frame-sampling video moderation, which
// lets an IMAGE-ONLY classifier moderate video.
// ---------------------------------------------------------------------------

/**
 * A request to extract still frames from a video.
 *
 * Both numbers are OPERATOR-SUPPLIED and arrive as arguments (never literals in
 * this public tarball):
 *
 * - `framesPerSecond` — how densely to sample.
 * - `maxFrames` — an ABSOLUTE ceiling on frames for this one job, independent
 *   of `framesPerSecond × duration`. It is a cost and disk bound, not a
 *   sampling preference: without it a long clip at a high rate turns one upload
 *   into an unbounded number of paid classifier calls and an unbounded number
 *   of temp files. The adapter must never emit more than `maxFrames`.
 *
 * The adapter writes frames to `outputDir` and returns their paths. Emitted
 * frames must carry NO inherited metadata (the container dictionary strip that
 * the transcode argv applies) — a sampled frame is a derivative of user media
 * and must not resurrect the GPS coordinates the transcode removed.
 */
export interface SampleFramesInput {
  readonly inputPath: string;
  readonly outputDir: string;
  readonly framesPerSecond: number;
  readonly maxFrames: number;
  /** Hard cap on accepted duration; injected from Env.media (never a literal). */
  readonly maxDurationSeconds: number;
}

export interface SampleFramesResult {
  /** Paths of the extracted frames, in temporal order. Never longer than `maxFrames`. */
  readonly framePaths: ReadonlyArray<string>;
}

export interface TranscodePort {
  /** Probe the duration of an input without transcoding it. */
  probeDurationSeconds(inputPath: string): Promise<number>;
  /** Re-encode a video to a clean form and emit a poster frame. */
  transcodeVideo(input: TranscodeVideoInput): Promise<TranscodeVideoResult>;
  /** Re-encode audio to a clean form. */
  transcodeAudio(input: TranscodeAudioInput): Promise<TranscodeAudioResult>;
  /**
   * Extract still frames for frame-sampled video moderation.
   *
   * OPTIONAL, so an existing consumer adapter still satisfies this interface —
   * this is a published package and a required method would be a breaking
   * change (same reasoning as `MediaPersistencePort.recordEmbeddedProvenance`).
   * The consequence is stated rather than hidden: frame-sampled moderation
   * REFUSES to run without it and fails the visual track closed to `review`.
   * It never degrades to "moderate nothing and approve".
   *
   * IF THIS THROWS, the adapter owns whatever it already wrote. Core deletes
   * the frames it is TOLD about, and a rejected call reports none — so an
   * extractor that fails partway must clean its own `outputDir` before
   * throwing. These are stills of media that may be about to be quarantined,
   * and core cannot delete files it never learned the names of.
   */
  sampleFrames?(input: SampleFramesInput): Promise<SampleFramesResult>;
  /**
   * Delete a previously-extracted frame. Called on EVERY path — success,
   * classifier error, deadline, ceiling breach — so sampled stills never
   * outlive the decision they informed. Must tolerate an already-absent file.
   *
   * OPTIONAL for the same published-package reason; when absent the adapter is
   * responsible for its own `outputDir` lifecycle, and core says so in a log
   * line rather than assuming cleanup happened.
   */
  deleteFrame?(framePath: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// StoragePort — object storage (S3-compatible). Keys are opaque strings built
// ONLY via ./cas-keys.ts; this seam never builds a key itself.
// ---------------------------------------------------------------------------

export interface StoragePort {
  /** Read an object. `options.versionId` pins the read to that EXACT stored
   * version (AR-SEC F3) — S3 `GetObject` with `VersionId`.
   *
   * `options.range` reads only `[start, end]` INCLUSIVE (S3 `Range:
   * bytes=start-end`). Added for the Art. 50 provenance sniff on video/audio
   * originals, which must inspect a few hundred bytes of a possibly
   * hundreds-of-megabytes object and must not pull the whole thing into a
   * worker's memory to do it. An implementation MAY return fewer bytes than
   * requested (short object) but must never return more. */
  getObject(
    key: string,
    options?: {
      versionId?: string;
      range?: { readonly start: number; readonly end: number };
    },
  ): Promise<Buffer>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Copy an object. `options.fromVersionId` pins the SOURCE to that exact
   * version (AR-SEC F3) — on S3 a versioned `CopySource`; without it the
   * CURRENT bytes at `fromKey` are copied (TOCTOU-prone for moderated media —
   * the media pipeline always pins). */
  copyObject(
    fromKey: string,
    toKey: string,
    options?: { fromVersionId?: string },
  ): Promise<void>;
  deleteObject(key: string): Promise<void>;
  /**
   * Existence check. Without options: reports the CURRENT object, and — when
   * the backing store is versioned (S3 bucket versioning, REQUIRED on the
   * media bucket for the moderation pipeline's version pinning, AR-SEC F3) —
   * its current `versionId`; `versionId` is `undefined` on an unversioned
   * store (the pipeline fails closed on that). With `options.versionId`:
   * whether that exact version exists.
   */
  headObject(
    key: string,
    options?: { versionId?: string },
  ): Promise<{
    exists: boolean;
    versionId?: string;
    /**
     * Object size in bytes, when the adapter reports it (S3 `HeadObject`
     * `ContentLength`). OPTIONAL so an existing consumer adapter still satisfies
     * this interface. Used by the Art. 50 provenance sniff to locate the TAIL
     * range of a video original; when absent the sniff simply skips the tail read
     * and inspects the head slice only.
     */
    size?: number;
  }>;
}

// ---------------------------------------------------------------------------
// TranscribePort — async speech-to-text for the AUDIO track. The transcript is
// fed to the text-moderation seam (./text-moderation.ts). Start → poll, mirroring
// the cloud job model (and the video-moderation start/poll shape).
// ---------------------------------------------------------------------------

export type TranscriptionStatus = "COMPLETED" | "FAILED" | "IN_PROGRESS";

export interface TranscribePort {
  startTranscription(input: {
    key: string;
    jobName: string;
  }): Promise<{ jobId: string }>;
  getTranscription(jobId: string): Promise<{
    status: TranscriptionStatus;
    transcript?: string;
  }>;
}

// ===========================================================================
// Mock implementations (test-only). Deterministic, in-memory, no outside I/O.
// ===========================================================================

/**
 * In-memory TranscodePort. Returns programmable durations and echoes the
 * requested output/poster paths back, so the shell's path-plumbing can be
 * asserted without invoking a real encoder.
 *
 * Determinism: a single `duration` (default 0) is returned by `probe` and by
 * both transcode calls unless overridden. `transcodeVideo`/`transcodeAudio`
 * never themselves enforce `maxDurationSeconds` — duration policy lives in the
 * functional core (a separate caps unit), and the mock must not silently make
 * that decision for it.
 */
export class MockTranscodePort implements TranscodePort {
  private duration: number;
  private hasAudio: boolean;
  /**
   * How many frames extraction ACTUALLY yields, when that differs from what
   * (rate × duration, capped) asks for — the shortfall case a real decoder hits
   * on a partly-undecodable clip. `undefined` means "yield what was asked for".
   */
  private extractableFrames?: number;

  /** Records of each call, for assertions. */
  readonly probeCalls: string[] = [];
  readonly videoCalls: TranscodeVideoInput[] = [];
  readonly audioCalls: TranscodeAudioInput[] = [];
  readonly sampleCalls: SampleFramesInput[] = [];
  /** Frame paths passed to `deleteFrame`, in call order — cleanup assertions. */
  readonly deletedFrames: string[] = [];

  constructor(opts: { duration?: number; hasAudio?: boolean } = {}) {
    this.duration = opts.duration ?? 0;
    // Default to true: the common case is a video WITH audio, and existing
    // tests assert the AUDIO-track-started path.
    this.hasAudio = opts.hasAudio ?? true;
  }

  /** Program a partial extraction: only this many frames actually decode. */
  setExtractableFrames(count: number | undefined): void {
    this.extractableFrames = count;
  }

  /** Program the duration returned by subsequent calls. */
  setDuration(seconds: number): void {
    this.duration = seconds;
  }

  /** Program whether `transcodeVideo` reports an audio stream. */
  setHasAudio(hasAudio: boolean): void {
    this.hasAudio = hasAudio;
  }

  async probeDurationSeconds(inputPath: string): Promise<number> {
    this.probeCalls.push(inputPath);
    return this.duration;
  }

  async transcodeVideo(input: TranscodeVideoInput): Promise<TranscodeVideoResult> {
    this.videoCalls.push(input);
    return {
      cleanedPath: input.outputPath,
      posterPath: input.posterPath,
      durationSeconds: this.duration,
      hasAudio: this.hasAudio,
    };
  }

  async transcodeAudio(input: TranscodeAudioInput): Promise<TranscodeAudioResult> {
    this.audioCalls.push(input);
    return {
      cleanedPath: input.outputPath,
      durationSeconds: this.duration,
    };
  }

  /**
   * Deterministic frame extraction: yields `expectedFrameCount(duration, rate,
   * maxFrames)` paths under `outputDir`, or fewer when `setExtractableFrames`
   * programmed a partial decode. Never exceeds `maxFrames` — a mock that could
   * would let a ceiling bug pass its own test.
   */
  async sampleFrames(input: SampleFramesInput): Promise<SampleFramesResult> {
    this.sampleCalls.push(input);
    const wanted = expectedFrameCount(
      this.duration,
      input.framesPerSecond,
      input.maxFrames,
    );
    const yielded =
      this.extractableFrames === undefined
        ? wanted
        : Math.min(wanted, Math.max(0, this.extractableFrames));
    const framePaths: string[] = [];
    for (let i = 0; i < yielded; i += 1) {
      framePaths.push(`${input.outputDir}/frame-${i}.jpg`);
    }
    return { framePaths };
  }

  async deleteFrame(framePath: string): Promise<void> {
    this.deletedFrames.push(framePath);
  }
}

/**
 * In-memory StoragePort backed by a Map, modelling a VERSIONED bucket
 * (AR-SEC F3): every put appends a new deterministic version
 * (`mock-version-N`), reads/copies may pin a version, and a delete hides the
 * current object behind a delete marker while prior versions stay resolvable
 * by versionId — mirroring S3 bucket-versioning semantics, which the media
 * pipeline's version pinning requires. `getObject` throws on a miss (callers
 * must handle the miss explicitly — a silent empty buffer would mask bugs).
 */
export class MockStoragePort implements StoragePort {
  private readonly objects = new Map<
    string,
    {
      versions: Array<{ versionId: string; body: Buffer; contentType: string }>;
      deleteMarker: boolean;
    }
  >();
  private versionSeq = 0;

  constructor(seed: Record<string, Buffer> = {}) {
    for (const [key, body] of Object.entries(seed)) {
      this.appendVersion(key, body, "application/octet-stream");
    }
  }

  private appendVersion(key: string, body: Buffer, contentType: string): void {
    this.versionSeq += 1;
    const versionId = `mock-version-${this.versionSeq}`;
    const entry = this.objects.get(key) ?? {
      versions: [],
      deleteMarker: false,
    };
    entry.versions.push({ versionId, body, contentType });
    entry.deleteMarker = false;
    this.objects.set(key, entry);
  }

  /** The CURRENT (latest, non-delete-marked) version of a key, if any. */
  private current(
    key: string,
  ): { versionId: string; body: Buffer; contentType: string } | undefined {
    const entry = this.objects.get(key);
    if (!entry || entry.deleteMarker || entry.versions.length === 0) {
      return undefined;
    }
    return entry.versions[entry.versions.length - 1];
  }

  async getObject(
    key: string,
    options?: {
      versionId?: string;
      range?: { readonly start: number; readonly end: number };
    },
  ): Promise<Buffer> {
    // Honour `range` rather than ignoring it: a mock that returned the WHOLE
    // object for a ranged read would let a test pass while the production path
    // (which really does get a slice) finds nothing.
    const slice = (body: Buffer): Buffer =>
      options?.range === undefined
        ? body
        : body.subarray(
            Math.max(0, options.range.start),
            Math.min(body.length, options.range.end + 1),
          );

    if (options?.versionId !== undefined) {
      const v = this.objects
        .get(key)
        ?.versions.find((x) => x.versionId === options.versionId);
      if (!v) {
        throw new Error(
          `MockStoragePort: no version "${options.versionId}" at key "${key}"`,
        );
      }
      return slice(v.body);
    }
    const obj = this.current(key);
    if (!obj) {
      throw new Error(`MockStoragePort: no object at key "${key}"`);
    }
    return slice(obj.body);
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    this.appendVersion(key, body, contentType);
  }

  async copyObject(
    fromKey: string,
    toKey: string,
    options?: { fromVersionId?: string },
  ): Promise<void> {
    const source =
      options?.fromVersionId !== undefined
        ? this.objects
            .get(fromKey)
            ?.versions.find((x) => x.versionId === options.fromVersionId)
        : this.current(fromKey);
    if (!source) {
      throw new Error(`MockStoragePort: no object at key "${fromKey}" to copy`);
    }
    this.appendVersion(toKey, source.body, source.contentType);
  }

  async deleteObject(key: string): Promise<void> {
    // Versioned-bucket semantics: a non-versioned delete places a delete
    // marker (the current object disappears; prior versions stay pinnable).
    const entry = this.objects.get(key);
    if (entry) {
      entry.deleteMarker = true;
    }
  }

  async headObject(
    key: string,
    options?: { versionId?: string },
  ): Promise<{ exists: boolean; versionId?: string; size?: number }> {
    if (options?.versionId !== undefined) {
      const v = this.objects
        .get(key)
        ?.versions.find((x) => x.versionId === options.versionId);
      return v
        ? { exists: true, versionId: options.versionId, size: v.body.length }
        : { exists: false };
    }
    const obj = this.current(key);
    return obj
      ? { exists: true, versionId: obj.versionId, size: obj.body.length }
      : { exists: false };
  }

  /** Test helper: read the content-type a key was stored with. */
  contentTypeOf(key: string): string | undefined {
    return this.current(key)?.contentType;
  }
}

/**
 * In-memory TranscribePort. By default a started job is immediately COMPLETED
 * with an empty transcript; callers program per-job results via `setResult`.
 * Job ids are a deterministic monotonic sequence.
 */
export class MockTranscribePort implements TranscribePort {
  private seq = 0;
  private readonly results = new Map<
    string,
    { status: TranscriptionStatus; transcript?: string }
  >();

  /** Records of each start call, for assertions. */
  readonly startCalls: { key: string; jobName: string }[] = [];

  async startTranscription(input: {
    key: string;
    jobName: string;
  }): Promise<{ jobId: string }> {
    this.startCalls.push(input);
    this.seq += 1;
    const jobId = `mock-transcribe-${this.seq}`;
    if (!this.results.has(jobId)) {
      this.results.set(jobId, { status: "COMPLETED", transcript: "" });
    }
    return { jobId };
  }

  /** Program the result a given job id will report. */
  setResult(
    jobId: string,
    result: { status: TranscriptionStatus; transcript?: string },
  ): void {
    this.results.set(jobId, result);
  }

  async getTranscription(jobId: string): Promise<{
    status: TranscriptionStatus;
    transcript?: string;
  }> {
    return this.results.get(jobId) ?? { status: "IN_PROGRESS" };
  }
}
