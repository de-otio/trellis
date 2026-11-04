/**
 * processMediaMessage — the outcome-returning entry point.
 *
 * Mocks only. Every number below is an obviously-mock value, not config.
 */

import { describe, expect, it, vi } from "vitest";

import {
  processMediaMessage,
  processObjectKey,
  type ExistingModerationJob,
  type MediaFileRow,
  type MediaProcessingDeps,
  type ThresholdSnapshot,
} from "../../../src/lib/workers/media-processing.js";
import {
  MockStoragePort,
  MockTranscodePort,
  MockTranscribePort,
} from "../../../src/lib/media/media-ports.js";
import {
  MockModerationProvider,
  ModerationProviderError,
  MOCK_CATEGORY_A,
} from "../../../src/lib/media/moderation-provider.js";
import type { HoldGround } from "../../../src/lib/media/moderation-provider.js";
import type { MediaLifecycle } from "../../../src/lib/media/media-lifecycle.js";
import type { Track } from "../../../src/lib/media/track-verdict.js";

const TENANT = "caaaaaaaaaaaaaaaaaaaaaaaa";
const UPLOAD = "cuuuuuuuuuuuuuuuuuuuuuuu1";
const KEY = `pending/${TENANT}/${UPLOAD}`;
const STAGING_KEY = `processing/${TENANT}/${UPLOAD}`;
const MEDIA_ID = "media-1";
const BODY = JSON.stringify({ objectKey: KEY });
const THRESHOLDS: ThresholdSnapshot = {
  [MOCK_CATEGORY_A]: { review: 0.5, quarantine: 0.9 },
};

const YOUNG = { mediaAgeSeconds: 9, maxMediaAgeSeconds: 10 };
const AT_BOUND = { mediaAgeSeconds: 10, maxMediaAgeSeconds: 10 };

interface Opts {
  lifecycle?: MediaLifecycle;
  hasAudio?: boolean;
  jobs?: ExistingModerationJob[];
  pin?: { stagingVersionId: string; contentHash: string; hasAudio?: boolean };
  deferDelaySeconds?: number;
  /** Which optional port members the fake offers. */
  optional?: { list?: boolean; hold?: boolean; reserve?: boolean };
  spend?: { current: number; cap: number };
}

function world(opts: Opts = {}) {
  const optional = { list: true, hold: true, reserve: true, ...opts.optional };
  const calls: string[] = [];
  const storage = new MockStoragePort({
    [KEY]: Buffer.from("raw upload bytes"),
    [STAGING_KEY]: Buffer.from("cleaned bytes"),
  });
  const transcode = new MockTranscodePort({
    duration: 4,
    hasAudio: opts.hasAudio ?? true,
  });
  const transcodeSpy = vi.spyOn(transcode, "transcodeVideo");
  const transcribe = new MockTranscribePort();
  const startTranscription = transcribe.startTranscription.bind(transcribe);
  vi.spyOn(transcribe, "startTranscription").mockImplementation(async (i) => {
    calls.push("start:AUDIO");
    return startTranscription(i);
  });
  const moderation = new MockModerationProvider();
  const startVideo = vi.spyOn(moderation, "startVideoModeration");
  startVideo.mockImplementation(async () => {
    calls.push("start:VISUAL");
    return { jobId: "visual-job-1" };
  });

  const state = {
    lifecycle: opts.lifecycle ?? ("UPLOADED" as MediaLifecycle),
    stagingVersionId: opts.pin?.stagingVersionId ?? null,
    contentHash: opts.pin?.contentHash ?? UPLOAD,
    hasAudio: opts.pin?.hasAudio ?? null,
  };
  const jobs: ExistingModerationJob[] = [...(opts.jobs ?? [])];
  const created: Array<{ track: Track; jobId: string }> = [];
  const persisted: Array<{ stagingVersionId: string; contentHash: string }> = [];
  const reviewed: string[] = [];
  const holds: Array<{ ground: HoldGround; expectedFrom: MediaLifecycle }> = [];
  const reserved: Array<readonly Track[]> = [];

  const persistence: MediaProcessingDeps["persistence"] = {
    async findMediaByUploadId(): Promise<MediaFileRow> {
      return {
        id: MEDIA_ID,
        tenantId: TENANT,
        uploadId: UPLOAD,
        lifecycle: state.lifecycle,
        stagingVersionId: state.stagingVersionId,
        contentHash: state.contentHash,
        hasAudio: state.hasAudio,
      };
    },
    async createModerationJob(input) {
      calls.push(`create:${input.track}`);
      created.push({ track: input.track, jobId: input.jobId });
      jobs.push({ track: input.track, jobId: input.jobId });
    },
    async persistCleanedContent(_id, c) {
      persisted.push({
        stagingVersionId: c.stagingVersionId,
        contentHash: c.contentHash,
      });
      state.stagingVersionId = c.stagingVersionId;
      state.contentHash = c.contentHash;
      state.hasAudio = c.hasAudio ?? null;
    },
    async markMediaForReview(id) {
      reviewed.push(id);
    },
    async markMediaUploaded() {},
    async markMediaRejected() {},
    ...(optional.list && {
      async listModerationJobs() {
        return jobs;
      },
    }),
    ...(optional.hold && {
      async holdForReview(_id, hold) {
        holds.push(hold);
        if (state.lifecycle !== hold.expectedFrom) return false;
        state.lifecycle = "REVIEW";
        return true;
      },
    }),
  };

  const deps: MediaProcessingDeps = {
    storage,
    transcode,
    transcribe,
    moderation,
    persistence,
    config: {
      maxDurationSeconds: 60,
      thresholds: THRESHOLDS,
      ...(opts.deferDelaySeconds !== undefined && {
        deferDelaySeconds: opts.deferDelaySeconds,
      }),
      ...(opts.spend !== undefined && {
        spend: { dailyCapUsd: opts.spend.cap, perMinuteRateUsd: 1 },
      }),
    },
    ...(opts.spend !== undefined && {
      spendGuard: {
        getTodaySpendUsd: async () => opts.spend!.current,
        recordSpendUsd: async () => {},
        reportCapExceeded: async () => {},
      },
    }),
    ...(optional.reserve && {
      store: {
        async reserveTracks(_id: string, tracks: readonly Track[]) {
          calls.push("reserve");
          reserved.push(tracks);
        },
      },
    }),
    bucket: "example-media-bucket",
    newJobName: (seed) => `job-${seed}`,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };

  return {
    deps,
    state,
    calls,
    created,
    persisted,
    reviewed,
    holds,
    reserved,
    transcodeSpy,
    startVideo,
    transcribe,
  };
}

const retryable = () =>
  new ModerationProviderError("provider is down", { retryable: true });
const capacity = () =>
  new ModerationProviderError("over the limit", {
    retryable: false,
    capacity: true,
  });

describe("processMediaMessage — lifecycle gate", () => {
  it.each(["APPROVED", "REVIEW", "QUARANTINED", "REJECTED"] as const)(
    "is done, before any work, when the media is %s",
    async (lifecycle) => {
      const w = world({ lifecycle });
      const out = await processMediaMessage(BODY, w.deps, YOUNG);
      expect(out).toEqual({ kind: "done" });
      expect(w.transcodeSpy).not.toHaveBeenCalled();
      expect(w.startVideo).not.toHaveBeenCalled();
      expect(w.created).toEqual([]);
      expect(w.holds).toEqual([]);
      expect(w.reviewed).toEqual([]);
    },
  );

  it("processes an UPLOADED media", async () => {
    const w = world();
    expect(await processMediaMessage(BODY, w.deps, YOUNG)).toEqual({
      kind: "done",
    });
    expect(w.created.map((j) => j.track)).toEqual(["VISUAL", "AUDIO"]);
  });
});

describe("processMediaMessage — pin reuse", () => {
  it("a retry after a successful transcode does not transcode again, and the pin is unchanged", async () => {
    const w = world();
    w.startVideo.mockRejectedValueOnce(retryable());

    const first = await processMediaMessage(BODY, w.deps, YOUNG);
    expect(first.kind).toBe("retry");
    expect(w.transcodeSpy).toHaveBeenCalledTimes(1);
    expect(w.persisted).toHaveLength(1);
    const pin = { ...w.persisted[0]! };

    const second = await processMediaMessage(BODY, w.deps, YOUNG);
    expect(second).toEqual({ kind: "done" });
    expect(w.transcodeSpy).toHaveBeenCalledTimes(1);
    expect(w.persisted).toHaveLength(1);
    expect(w.state.stagingVersionId).toBe(pin.stagingVersionId);
    expect(w.state.contentHash).toBe(pin.contentHash);
    // The moderation start used the persisted version.
    expect(w.startVideo.mock.calls.at(-1)![0]).toMatchObject({
      key: STAGING_KEY,
      versionId: pin.stagingVersionId,
    });
  });

  it("does not treat the upload-time placeholder hash as a pin", async () => {
    const w = world({
      pin: { stagingVersionId: "v-1", contentHash: UPLOAD },
    });
    await processMediaMessage(BODY, w.deps, YOUNG);
    expect(w.transcodeSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses a pin the row already carries, whatever the job rows say", async () => {
    const hash = "a".repeat(64);
    const w = world({ pin: { stagingVersionId: "v-1", contentHash: hash } });
    await processMediaMessage(BODY, w.deps, YOUNG);
    expect(w.transcodeSpy).not.toHaveBeenCalled();
    expect(w.persisted).toEqual([]);
    expect(w.startVideo.mock.calls[0]![0]).toMatchObject({ versionId: "v-1" });
  });
});

describe("processMediaMessage — capacity is not an attempt", () => {
  it("defers, with nothing written as failed, when the provider is at capacity", async () => {
    const w = world({ deferDelaySeconds: 7 });
    w.startVideo.mockRejectedValueOnce(capacity());
    const out = await processMediaMessage(BODY, w.deps, YOUNG);
    expect(out).toEqual({
      kind: "defer",
      delaySeconds: 7,
      reason: expect.any(String),
    });
    expect(w.created).toEqual([]);
    expect(w.holds).toEqual([]);
    expect(w.reviewed).toEqual([]);
    expect(w.state.lifecycle).toBe("UPLOADED");
  });

  it("defers on the spend gate before the age bound", async () => {
    const w = world({ deferDelaySeconds: 7, spend: { current: 5, cap: 5 } });
    const out = await processMediaMessage(BODY, w.deps, YOUNG);
    expect(out.kind).toBe("defer");
    expect(w.transcodeSpy).not.toHaveBeenCalled();
    expect(w.startVideo).not.toHaveBeenCalled();
    expect(w.holds).toEqual([]);
  });

  it("settles REVIEW on the technical ground, not defer, when the spend gate still refuses at the age bound", async () => {
    const w = world({ deferDelaySeconds: 7, spend: { current: 5, cap: 5 } });
    expect(await processMediaMessage(BODY, w.deps, AT_BOUND)).toEqual({
      kind: "done",
    });
    expect(w.transcodeSpy).not.toHaveBeenCalled();
    expect(w.startVideo).not.toHaveBeenCalled();
    expect(w.holds).toEqual([{ ground: "technical", expectedFrom: "UPLOADED" }]);
    expect(w.state.lifecycle).toBe("REVIEW");
  });

  it("settles REVIEW on the technical ground, not defer, when the provider still refuses at the age bound", async () => {
    const w = world({ deferDelaySeconds: 7 });
    w.startVideo.mockRejectedValueOnce(capacity());
    expect(await processMediaMessage(BODY, w.deps, AT_BOUND)).toEqual({
      kind: "done",
    });
    expect(w.holds).toEqual([{ ground: "technical", expectedFrom: "UPLOADED" }]);
  });

  it("treats capacity as a retryable fault when no delay is configured", async () => {
    const w = world();
    w.startVideo.mockRejectedValueOnce(capacity());
    expect((await processMediaMessage(BODY, w.deps, YOUNG)).kind).toBe("retry");
  });
});

describe("processMediaMessage — retryable and poison faults", () => {
  it("retries a retryable fault before the age bound", async () => {
    const w = world();
    w.startVideo.mockRejectedValueOnce(retryable());
    expect(await processMediaMessage(BODY, w.deps, YOUNG)).toEqual({
      kind: "retry",
      reason: expect.any(String),
    });
    expect(w.holds).toEqual([]);
  });

  it("settles REVIEW on the technical ground, as a compare-and-set from UPLOADED, at the bound", async () => {
    const w = world();
    w.startVideo.mockRejectedValueOnce(retryable());
    expect(await processMediaMessage(BODY, w.deps, AT_BOUND)).toEqual({
      kind: "done",
    });
    expect(w.holds).toEqual([{ ground: "technical", expectedFrom: "UPLOADED" }]);
    expect(w.state.lifecycle).toBe("REVIEW");
    expect(w.reviewed).toEqual([]);
  });

  it("settles REVIEW on the unprocessable ground, as a compare-and-set, for poison", async () => {
    const w = world();
    w.startVideo.mockRejectedValueOnce(
      new ModerationProviderError("bad bytes", { retryable: false }),
    );
    expect(await processMediaMessage(BODY, w.deps, YOUNG)).toEqual({
      kind: "done",
    });
    expect(w.holds).toEqual([
      { ground: "unprocessable", expectedFrom: "UPLOADED" },
    ]);
    expect(w.reviewed).toEqual([]);
  });

  it("stands down when the compare-and-set loses to a decision that landed first", async () => {
    const w = world();
    w.startVideo.mockImplementationOnce(async () => {
      w.state.lifecycle = "APPROVED";
      throw retryable();
    });
    expect(await processMediaMessage(BODY, w.deps, AT_BOUND)).toEqual({
      kind: "done",
    });
    expect(w.state.lifecycle).toBe("APPROVED");
    expect(w.reviewed).toEqual([]);
  });
});

describe("processMediaMessage — tracks", () => {
  it("starts only AUDIO on redelivery with VISUAL live and AUDIO missing", async () => {
    const w = world({
      jobs: [{ track: "VISUAL", jobId: "visual-job-1" }],
      pin: { stagingVersionId: "v-1", contentHash: "b".repeat(64), hasAudio: true },
    });
    await processMediaMessage(BODY, w.deps, YOUNG);
    expect(w.startVideo).not.toHaveBeenCalled();
    expect(w.transcribe.startCalls).toHaveLength(1);
    expect(w.created.map((j) => j.track)).toEqual(["AUDIO"]);
    expect(w.reserved).toEqual([["AUDIO"]]);
  });

  it("starts a track again when its row is a placeholder or superseded", async () => {
    const w = world({
      jobs: [
        { track: "VISUAL", jobId: null },
        { track: "AUDIO", jobId: "old-audio", superseded: true },
      ],
    });
    await processMediaMessage(BODY, w.deps, YOUNG);
    expect(w.startVideo).toHaveBeenCalledTimes(1);
    expect(w.transcribe.startCalls).toHaveLength(1);
  });

  it("starts nothing when every track is already live", async () => {
    const w = world({
      jobs: [
        { track: "VISUAL", jobId: "v" },
        { track: "AUDIO", jobId: "a" },
      ],
    });
    expect(await processMediaMessage(BODY, w.deps, YOUNG)).toEqual({
      kind: "done",
    });
    expect(w.transcodeSpy).not.toHaveBeenCalled();
    expect(w.startVideo).not.toHaveBeenCalled();
    expect(w.reserved).toEqual([]);
  });

  it("reserves every track, in one call, before the first provider start", async () => {
    const w = world();
    await processMediaMessage(BODY, w.deps, YOUNG);
    expect(w.reserved).toEqual([["VISUAL", "AUDIO"]]);
    const firstStart = w.calls.findIndex((c) => c.startsWith("start:"));
    expect(w.calls.indexOf("reserve")).toBeGreaterThanOrEqual(0);
    expect(w.calls.indexOf("reserve")).toBeLessThan(firstStart);
    expect(w.calls.filter((c) => c === "reserve")).toHaveLength(1);
  });

  it("reserves the vacuous AUDIO track of a silent video too", async () => {
    const w = world({ hasAudio: false });
    await processMediaMessage(BODY, w.deps, YOUNG);
    expect(w.reserved).toEqual([["VISUAL", "AUDIO"]]);
    expect(w.created.map((j) => j.jobId)).toEqual([
      "visual-job-1",
      `noaudio:${MEDIA_ID}`,
    ]);
  });
});

describe("processMediaMessage — absent optional members change nothing", () => {
  it("starts both tracks, transcodes, and reserves nothing without the optional ports", async () => {
    const w = world({ optional: { list: false, hold: false, reserve: false } });
    expect(await processMediaMessage(BODY, w.deps, YOUNG)).toEqual({
      kind: "done",
    });
    expect(w.transcodeSpy).toHaveBeenCalledTimes(1);
    expect(w.created.map((j) => j.track)).toEqual(["VISUAL", "AUDIO"]);
    expect(w.reserved).toEqual([]);
  });

  it("falls back to markMediaForReview for poison and for the age bound", async () => {
    const poison = world({ optional: { hold: false } });
    poison.startVideo.mockRejectedValueOnce(
      new ModerationProviderError("bad bytes", { retryable: false }),
    );
    await processMediaMessage(BODY, poison.deps, YOUNG);
    expect(poison.reviewed).toEqual([MEDIA_ID]);

    const bound = world({ optional: { hold: false } });
    bound.startVideo.mockRejectedValueOnce(retryable());
    await processMediaMessage(BODY, bound.deps, AT_BOUND);
    expect(bound.reviewed).toEqual([MEDIA_ID]);
  });

  it("the legacy entry point still maps a retryable fault to a fail disposition", async () => {
    const w = world();
    w.startVideo.mockRejectedValueOnce(retryable());
    expect(await processObjectKey(KEY, w.deps)).toEqual({
      disposition: "fail",
      reason: "retryable",
    });
  });

  it("the legacy entry point maps a capacity refusal to a fail disposition", async () => {
    const w = world({ deferDelaySeconds: 7 });
    w.startVideo.mockRejectedValueOnce(capacity());
    expect((await processObjectKey(KEY, w.deps)).disposition).toBe("fail");
  });
});
