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

export interface TranscodePort {
  /** Probe the duration of an input without transcoding it. */
  probeDurationSeconds(inputPath: string): Promise<number>;
  /** Re-encode a video to a clean form and emit a poster frame. */
  transcodeVideo(input: TranscodeVideoInput): Promise<TranscodeVideoResult>;
  /** Re-encode audio to a clean form. */
  transcodeAudio(input: TranscodeAudioInput): Promise<TranscodeAudioResult>;
}

// ---------------------------------------------------------------------------
// StoragePort — object storage (S3-compatible). Keys are opaque strings built
// ONLY via ./cas-keys.ts; this seam never builds a key itself.
// ---------------------------------------------------------------------------

export interface StoragePort {
  getObject(key: string): Promise<Buffer>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  copyObject(fromKey: string, toKey: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<{ exists: boolean }>;
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

  /** Records of each call, for assertions. */
  readonly probeCalls: string[] = [];
  readonly videoCalls: TranscodeVideoInput[] = [];
  readonly audioCalls: TranscodeAudioInput[] = [];

  constructor(opts: { duration?: number } = {}) {
    this.duration = opts.duration ?? 0;
  }

  /** Program the duration returned by subsequent calls. */
  setDuration(seconds: number): void {
    this.duration = seconds;
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
    };
  }

  async transcodeAudio(input: TranscodeAudioInput): Promise<TranscodeAudioResult> {
    this.audioCalls.push(input);
    return {
      cleanedPath: input.outputPath,
      durationSeconds: this.duration,
    };
  }
}

/**
 * In-memory StoragePort backed by a Map. `headObject` reports existence from the
 * map; `getObject` throws on a miss (callers must handle the miss explicitly —
 * a silent empty buffer would mask bugs).
 */
export class MockStoragePort implements StoragePort {
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  constructor(seed: Record<string, Buffer> = {}) {
    for (const [key, body] of Object.entries(seed)) {
      this.objects.set(key, { body, contentType: "application/octet-stream" });
    }
  }

  async getObject(key: string): Promise<Buffer> {
    const obj = this.objects.get(key);
    if (!obj) {
      throw new Error(`MockStoragePort: no object at key "${key}"`);
    }
    return obj.body;
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async copyObject(fromKey: string, toKey: string): Promise<void> {
    const obj = this.objects.get(fromKey);
    if (!obj) {
      throw new Error(`MockStoragePort: no object at key "${fromKey}" to copy`);
    }
    this.objects.set(toKey, { body: obj.body, contentType: obj.contentType });
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async headObject(key: string): Promise<{ exists: boolean }> {
    return { exists: this.objects.has(key) };
  }

  /** Test helper: read the content-type a key was stored with. */
  contentTypeOf(key: string): string | undefined {
    return this.objects.get(key)?.contentType;
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
