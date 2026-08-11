import { describe, expect, it } from "vitest";

import { FrameSamplingVideoModerationAdapter } from "../../../src/lib/media/frame-sampling-adapter.js";
import {
  MockTranscodePort,
  type TranscodePort,
} from "../../../src/lib/media/media-ports.js";
import {
  MockModerationProvider,
  type ModerationVerdict,
  type S3Ref,
} from "../../../src/lib/media/moderation-provider.js";
import type { ModerationDecision } from "../../../src/lib/media/media-lifecycle.js";

const BUCKET = "example-media-bucket";
const REF: S3Ref = {
  bucket: BUCKET,
  key: "processing/c0000000000000000000000aa/c1111111111111111111111bb",
  pin: { kind: "versionId", value: "mock-version-1" },
};

function verdict(decision: ModerationDecision): ModerationVerdict {
  return { decision, labels: [], provider: "mock" };
}

function makeAdapter(opts: {
  duration?: number;
  /** `null` means "the operator configured nothing" — distinct from omitted. */
  framesPerSecond?: number | null;
  maxFramesPerJob?: number | null;
  maxDurationSeconds?: number | null;
  extractable?: number;
  transcode?: TranscodePort;
} = {}) {
  const images = new MockModerationProvider();
  const transcode =
    opts.transcode ?? new MockTranscodePort({ duration: opts.duration ?? 4 });
  if (transcode instanceof MockTranscodePort && opts.extractable !== undefined) {
    transcode.setExtractableFrames(opts.extractable);
  }
  const logs: Array<{ level: string; msg: string }> = [];
  let seq = 0;
  const adapter = new FrameSamplingVideoModerationAdapter({
    images,
    transcode,
    config: {
      framesPerSecond:
        opts.framesPerSecond === null ? undefined : (opts.framesPerSecond ?? 1),
      maxFramesPerJob:
        opts.maxFramesPerJob === null ? undefined : (opts.maxFramesPerJob ?? 10),
      maxDurationSeconds:
        opts.maxDurationSeconds === null
          ? undefined
          : (opts.maxDurationSeconds ?? 60),
      frameConcurrency: 2,
    },
    frameDirFor: (jobId) => `processing/frames/${jobId}`,
    newJobId: () => `core-job-${(seq += 1)}`,
    log: {
      info: (msg) => logs.push({ level: "info", msg }),
      warn: (msg) => logs.push({ level: "warn", msg }),
      error: (msg) => logs.push({ level: "error", msg }),
    },
  });
  return { adapter, images, transcode, logs };
}

describe("FrameSamplingVideoModerationAdapter — resolves inline", () => {
  it("returns the aggregated decision alongside the job id", async () => {
    const { adapter, images } = makeAdapter({ duration: 4 });
    images.setImageVerdict(verdict("approved"));

    const started = await adapter.startVideoModeration(REF);

    expect(started.jobId).toBe("core-job-1");
    expect(started.initialDecision).toBe("approved");
  });

  it("classifies one frame per planned sample, under the video's bucket", async () => {
    const { adapter, images } = makeAdapter({ duration: 4, framesPerSecond: 1 });
    images.setImageVerdict(verdict("approved"));

    await adapter.startVideoModeration(REF);

    expect(images.imageCalls).toHaveLength(4);
    for (const call of images.imageCalls) {
      expect(call.bucket).toBe(BUCKET);
      expect(call.key).toContain("processing/frames/core-job-1/");
    }
  });

  it("a single quarantined frame quarantines the video", async () => {
    const { adapter, images } = makeAdapter({ duration: 4 });
    let n = 0;
    images.setImageResponder(async () => {
      n += 1;
      return verdict(n === 3 ? "quarantine" : "approved");
    });

    const started = await adapter.startVideoModeration(REF);

    expect(started.initialDecision).toBe("quarantine");
  });

  it("a classifier that throws on one frame degrades the video to review", async () => {
    const { adapter, images } = makeAdapter({ duration: 4 });
    let n = 0;
    images.setImageResponder(async () => {
      n += 1;
      if (n === 2) throw new Error("classifier unavailable");
      return verdict("approved");
    });

    const started = await adapter.startVideoModeration(REF);

    expect(started.initialDecision).toBe("review");
  });

  it("an extraction shortfall reviews even when every extracted frame approved", async () => {
    const { adapter, images } = makeAdapter({
      duration: 8,
      framesPerSecond: 1,
      extractable: 2,
    });
    images.setImageVerdict(verdict("approved"));

    const started = await adapter.startVideoModeration(REF);

    expect(images.imageCalls).toHaveLength(2);
    expect(started.initialDecision).toBe("review");
  });

  it("zero extractable frames reviews", async () => {
    const { adapter, images } = makeAdapter({ duration: 4, extractable: 0 });
    images.setImageVerdict(verdict("approved"));

    const started = await adapter.startVideoModeration(REF);

    expect(images.imageCalls).toHaveLength(0);
    expect(started.initialDecision).toBe("review");
  });
});

describe("FrameSamplingVideoModerationAdapter — refuses rather than guesses", () => {
  it("reviews when no sampling rate was configured", async () => {
    const { adapter, images } = makeAdapter({ framesPerSecond: null });
    images.setImageVerdict(verdict("approved"));

    const started = await adapter.startVideoModeration(REF);

    expect(started.initialDecision).toBe("review");
    expect(images.imageCalls).toHaveLength(0);
  });

  it("reviews when no per-job ceiling was configured", async () => {
    const { adapter, images } = makeAdapter({ maxFramesPerJob: null });
    images.setImageVerdict(verdict("approved"));

    expect((await adapter.startVideoModeration(REF)).initialDecision).toBe("review");
    expect(images.imageCalls).toHaveLength(0);
  });

  it("reviews when no duration cap was configured", async () => {
    const { adapter, images } = makeAdapter({ maxDurationSeconds: null });
    images.setImageVerdict(verdict("approved"));

    expect((await adapter.startVideoModeration(REF)).initialDecision).toBe("review");
    expect(images.imageCalls).toHaveLength(0);
  });

  it("reviews rather than under-sampling a clip past the ceiling", async () => {
    const { adapter, images } = makeAdapter({
      duration: 600,
      framesPerSecond: 1,
      maxFramesPerJob: 10,
    });
    images.setImageVerdict(verdict("approved"));

    const started = await adapter.startVideoModeration(REF);

    expect(started.initialDecision).toBe("review");
    // Nothing was classified: the refusal happens before any paid call.
    expect(images.imageCalls).toHaveLength(0);
  });

  it("reviews when the transcode adapter cannot extract frames at all", async () => {
    const noSampling: TranscodePort = {
      async probeDurationSeconds() {
        return 4;
      },
      async transcodeVideo() {
        throw new Error("unused");
      },
      async transcodeAudio() {
        throw new Error("unused");
      },
    };
    const { adapter, images } = makeAdapter({ transcode: noSampling });
    images.setImageVerdict(verdict("approved"));

    expect((await adapter.startVideoModeration(REF)).initialDecision).toBe("review");
  });

  it("reviews when extraction throws", async () => {
    const throwing = new MockTranscodePort({ duration: 4 });
    throwing.sampleFrames = async () => {
      throw new Error("decoder blew up");
    };
    const { adapter } = makeAdapter({ transcode: throwing });

    expect((await adapter.startVideoModeration(REF)).initialDecision).toBe("review");
  });

  it("reviews when the port returns MORE frames than the ceiling allows", async () => {
    const overrunning = new MockTranscodePort({ duration: 4 });
    overrunning.sampleFrames = async (input) => ({
      framePaths: Array.from(
        { length: input.maxFrames + 3 },
        (_, i) => `${input.outputDir}/frame-${i}.jpg`,
      ),
    });
    const { adapter, images } = makeAdapter({ transcode: overrunning });
    images.setImageVerdict(verdict("approved"));

    const started = await adapter.startVideoModeration(REF);

    expect(started.initialDecision).toBe("review");
    expect(images.imageCalls).toHaveLength(0);
  });

  it("reviews when the duration probe fails", async () => {
    const blind = new MockTranscodePort({ duration: 4 });
    blind.probeDurationSeconds = async () => {
      throw new Error("probe failed");
    };
    const { adapter } = makeAdapter({ transcode: blind });

    expect((await adapter.startVideoModeration(REF)).initialDecision).toBe("review");
  });
});

describe("FrameSamplingVideoModerationAdapter — cleanup on every path", () => {
  it("deletes every extracted frame after a successful run", async () => {
    const { adapter, transcode, images } = makeAdapter({ duration: 4 });
    images.setImageVerdict(verdict("approved"));

    await adapter.startVideoModeration(REF);

    const mock = transcode as MockTranscodePort;
    expect(mock.deletedFrames).toHaveLength(4);
    expect(new Set(mock.deletedFrames).size).toBe(4);
  });

  it("deletes every extracted frame when classification throws", async () => {
    const { adapter, transcode, images } = makeAdapter({ duration: 4 });
    images.setImageResponder(async () => {
      throw new Error("classifier down");
    });

    await adapter.startVideoModeration(REF);

    expect((transcode as MockTranscodePort).deletedFrames).toHaveLength(4);
  });

  it("deletes every extracted frame when the ceiling check trips", async () => {
    const overrunning = new MockTranscodePort({ duration: 4 });
    const emitted: string[] = [];
    overrunning.sampleFrames = async (input) => {
      const paths = Array.from(
        { length: input.maxFrames + 2 },
        (_, i) => `${input.outputDir}/frame-${i}.jpg`,
      );
      emitted.push(...paths);
      return { framePaths: paths };
    };
    const { adapter } = makeAdapter({ transcode: overrunning });

    await adapter.startVideoModeration(REF);

    expect(overrunning.deletedFrames).toEqual(emitted);
  });

  it("still returns a verdict when frame cleanup itself fails", async () => {
    const brittle = new MockTranscodePort({ duration: 4 });
    brittle.deleteFrame = async () => {
      throw new Error("delete failed");
    };
    const { adapter, images } = makeAdapter({ transcode: brittle });
    images.setImageVerdict(verdict("approved"));

    expect((await adapter.startVideoModeration(REF)).initialDecision).toBe(
      "approved",
    );
  });
});

describe("FrameSamplingVideoModerationAdapter — abort and polling", () => {
  it("does not classify frames once the caller's deadline aborted", async () => {
    const { adapter, images } = makeAdapter({ duration: 8 });
    images.setImageVerdict(verdict("approved"));
    const controller = new AbortController();
    controller.abort();

    const started = await adapter.startVideoModeration(REF, {
      signal: controller.signal,
    });

    expect(images.imageCalls).toHaveLength(0);
    expect(started.initialDecision).toBe("review");
  });

  it("returns the resolved verdict when polled in-process", async () => {
    const { adapter, images } = makeAdapter({ duration: 4 });
    images.setImageVerdict(verdict("approved"));

    const started = await adapter.startVideoModeration(REF);
    const polled = await adapter.getVideoModeration(started.jobId);

    expect(polled.decision).toBe("approved");
  });

  it("fails closed when polled for an id it never minted", async () => {
    const { adapter } = makeAdapter();
    expect((await adapter.getVideoModeration("someone-elses-job")).decision).toBe(
      "review",
    );
  });

  it("mints job ids that carry no tenant, key, or upload material", async () => {
    const { adapter } = makeAdapter({ duration: 2 });
    const started = await adapter.startVideoModeration(REF);
    expect(started.jobId).not.toContain("c0000000000000000000000aa");
    expect(started.jobId).not.toContain("c1111111111111111111111bb");
    expect(started.jobId).not.toContain(BUCKET);
  });

  it("passes images straight through to the underlying classifier", async () => {
    const { adapter, images } = makeAdapter();
    images.setImageVerdict(verdict("quarantine"));

    const out = await adapter.moderateImage({ bucket: BUCKET, key: "cas/x/y" });

    expect(out.decision).toBe("quarantine");
    expect(images.imageCalls).toHaveLength(1);
  });
});

describe("FrameSamplingVideoModerationAdapter — the audit trail", () => {
  it("records a policy version even when the operator named none", async () => {
    const { adapter, images } = makeAdapter({ duration: 4 });
    images.setImageVerdict(verdict("approved"));

    const started = await adapter.startVideoModeration(REF);

    expect(started.policyVersion).toMatch(/^fs-[0-9a-f]{16}$/);
  });

  it("changes the policy version when, and only when, the policy changes", async () => {
    const a = makeAdapter({ duration: 4, framesPerSecond: 1 });
    const sameAgain = makeAdapter({ duration: 4, framesPerSecond: 1 });
    const different = makeAdapter({ duration: 4, framesPerSecond: 2 });
    for (const h of [a, sameAgain, different]) {
      h.images.setImageVerdict(verdict("approved"));
    }

    const first = (await a.adapter.startVideoModeration(REF)).policyVersion;
    const second = (await sameAgain.adapter.startVideoModeration(REF)).policyVersion;
    const third = (await different.adapter.startVideoModeration(REF)).policyVersion;

    expect(second).toBe(first);
    expect(third).not.toBe(first);
  });

  it("does not disclose the sampling parameters inside the version", () => {
    // The fingerprint distinguishes policies; it must not publish them.
    const { adapter } = makeAdapter({ framesPerSecond: 7, maxFramesPerJob: 13 });
    return adapter.startVideoModeration(REF).then((started) => {
      expect(started.policyVersion).not.toContain("7");
      expect(started.policyVersion).not.toContain("13");
    });
  });

  it("uses the operator's policy name when one was given", async () => {
    const images = new MockModerationProvider();
    images.setImageVerdict(verdict("approved"));
    const adapter = new FrameSamplingVideoModerationAdapter({
      images,
      transcode: new MockTranscodePort({ duration: 2 }),
      config: {
        framesPerSecond: 1,
        maxFramesPerJob: 10,
        maxDurationSeconds: 60,
        policyVersion: "house-policy-2026-08",
      },
      frameDirFor: (jobId) => `processing/frames/${jobId}`,
      newJobId: () => "core-job-1",
    });

    expect((await adapter.startVideoModeration(REF)).policyVersion).toBe(
      "house-policy-2026-08",
    );
  });

  it("carries per-frame evidence, not just the collapsed decision", async () => {
    const { adapter, images } = makeAdapter({ duration: 4, framesPerSecond: 1 });
    images.setImageResponder(async () => ({
      decision: "approved",
      labels: [{ category: "category_a", confidence: 0.1 }],
      provider: "mock",
      modelVersion: "mock-taxonomy-1",
    }));

    const started = await adapter.startVideoModeration(REF);

    expect(started.detail?.expectedFrames).toBe(4);
    expect(started.detail?.framesScored).toBe(4);
    expect(started.detail?.framesSkipped).toBe(0);
    expect(started.detail?.frames).toHaveLength(4);
    expect(started.detail?.frames?.[2]).toMatchObject({
      index: 2,
      offsetSeconds: 2,
      decision: "approved",
      modelVersion: "mock-taxonomy-1",
    });
    // The labels survive the collapse to a single enum.
    expect(started.labels).toHaveLength(4);
  });

  it("counts the frames it never got a verdict for", async () => {
    const { adapter, images } = makeAdapter({
      duration: 8,
      framesPerSecond: 1,
      extractable: 3,
    });
    images.setImageVerdict(verdict("approved"));

    const started = await adapter.startVideoModeration(REF);

    expect(started.detail?.expectedFrames).toBe(8);
    expect(started.detail?.framesScored).toBe(3);
    expect(started.detail?.framesSkipped).toBe(5);
    expect(started.initialDecision).toBe("review");
  });

  it("still reports what it knew when it refused to sample", async () => {
    const { adapter } = makeAdapter({
      duration: 600,
      framesPerSecond: 1,
      maxFramesPerJob: 10,
    });

    const started = await adapter.startVideoModeration(REF);

    expect(started.initialDecision).toBe("review");
    expect(started.detail?.framesScored).toBe(0);
  });
});
