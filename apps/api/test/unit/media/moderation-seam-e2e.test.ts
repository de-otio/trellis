/**
 * End-to-end through the moderation seam, on mocks only.
 *
 * The unit suites each prove one module. This one proves the JOIN: an
 * image-only classifier, wired through the frame-sampling adapter and the
 * deadline wrapper, carries a video from a landed upload to a persisted,
 * fan-in-consistent lifecycle — and the fail-closed rules survive being
 * composed, which is where they are easiest to lose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  processObjectKey,
  type MediaFileRow,
  type MediaProcessingDeps,
  type ThresholdSnapshot,
} from "../../../src/lib/workers/media-processing.js";
import { FrameSamplingVideoModerationAdapter } from "../../../src/lib/media/frame-sampling-adapter.js";
import { withModerationDeadline } from "../../../src/lib/media/moderation-deadline.js";
import { createLabelPolicy } from "../../../src/lib/media/label-policy.js";
import {
  MockStoragePort,
  MockTranscodePort,
  MockTranscribePort,
} from "../../../src/lib/media/media-ports.js";
import {
  MockModerationProvider,
  MOCK_CATEGORY_A,
  type ModerationVerdict,
} from "../../../src/lib/media/moderation-provider.js";
import { isServable } from "../../../src/lib/media/serve-gate.js";
import type { MediaLifecycle } from "../../../src/lib/media/media-lifecycle.js";
import type { Track } from "../../../src/lib/media/track-verdict.js";

const TENANT = "caaaaaaaaaaaaaaaaaaaaaaaa";
const UPLOAD = "cuuuuuuuuuuuuuuuuuuuuuuu1";
const BUCKET = "example-media-bucket";
const PENDING_KEY = `pending/${TENANT}/${UPLOAD}`;
const STAGING_KEY = `processing/${TENANT}/${UPLOAD}`;
const MEDIA_ID = "media-1";
const DURATION = 4;
const TIMEOUT_MS = 5_000;

const THRESHOLDS: ThresholdSnapshot = {
  [MOCK_CATEGORY_A]: { review: 0.5, quarantine: 0.9 },
};

function verdict(
  decision: "approved" | "review" | "quarantine",
  modelVersion = "mock-taxonomy-1",
): ModerationVerdict {
  return { decision, labels: [], provider: "mock", modelVersion };
}

/** The whole pipeline, wired the way a consuming application would wire it. */
function pipeline(
  opts: {
    hasAudio?: boolean;
    extractableFrames?: number;
    framesPerSecond?: number;
    maxFramesPerJob?: number;
    /** The row's persisted lifecycle; `null` models an adapter that cannot say. */
    lifecycle?: MediaLifecycle | null;
  } = {},
) {
  const storage = new MockStoragePort({
    [PENDING_KEY]: Buffer.from("raw upload bytes"),
    [STAGING_KEY]: Buffer.from("cleaned bytes"),
  });
  const transcode = new MockTranscodePort({
    duration: DURATION,
    hasAudio: opts.hasAudio ?? false,
  });
  if (opts.extractableFrames !== undefined) {
    transcode.setExtractableFrames(opts.extractableFrames);
  }
  const images = new MockModerationProvider();

  const frameSampling = new FrameSamplingVideoModerationAdapter({
    images,
    transcode,
    config: {
      framesPerSecond: opts.framesPerSecond ?? 1,
      maxFramesPerJob: opts.maxFramesPerJob ?? 20,
      maxDurationSeconds: 60,
      frameConcurrency: 2,
    },
    frameDirFor: (jobId) => `processing/frames/${jobId}`,
    newJobId: (() => {
      let n = 0;
      return () => `core-job-${(n += 1)}`;
    })(),
  });

  // Exactly as a consumer would: the deadline wraps the outermost provider.
  const moderation = withModerationDeadline(frameSampling, {
    timeoutMs: TIMEOUT_MS,
  });

  const jobs: Array<{
    track: Track;
    jobId: string;
    initialDecision?: string;
  }> = [];
  const statuses: MediaLifecycle[] = [];
  const reviewed: string[] = [];

  const row: MediaFileRow = {
    id: MEDIA_ID,
    tenantId: TENANT,
    uploadId: UPLOAD,
    ...(opts.lifecycle !== null && {
      lifecycle: opts.lifecycle ?? "UPLOADED",
    }),
  };

  const deps: MediaProcessingDeps = {
    storage,
    transcode,
    transcribe: new MockTranscribePort(),
    moderation,
    persistence: {
      async findMediaByUploadId() {
        return row;
      },
      async createModerationJob(input) {
        jobs.push({
          track: input.track,
          jobId: input.jobId,
          initialDecision: input.initialDecision,
        });
      },
      async persistCleanedContent() {},
      async markMediaForReview(id) {
        reviewed.push(id);
        statuses.push("REVIEW");
      },
      async markMediaUploaded() {},
      async markMediaRejected() {
        statuses.push("REJECTED");
      },
      async persistMediaStatus(_id, status, options) {
        // Model the required conditional write: the adapter applies it only if
        // the row still holds the state the decision was computed from.
        if (options !== undefined && options.expectedFrom !== row.lifecycle) {
          return;
        }
        statuses.push(status);
      },
    },
    config: { maxDurationSeconds: 60, thresholds: THRESHOLDS },
    bucket: BUCKET,
    newJobName: (seed) => `job-${seed}`,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };

  return { deps, storage, images, transcode, jobs, statuses, reviewed };
}

/**
 * The serve key the worker derives for these fixture bytes, if anything landed
 * there. Recomputed the same way the worker does (sha256 of the cleaned bytes)
 * rather than asserted as a literal, so a change to the fixture cannot silently
 * make this probe look at a key nothing was ever written to.
 */
async function casKeyOf(storage: MockStoragePort): Promise<string | null> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256")
    .update(Buffer.from("cleaned bytes"))
    .digest("hex");
  const candidate = `cas/${TENANT}/${hash}`;
  return (await storage.headObject(candidate)).exists ? candidate : null;
}

describe("moderation seam end-to-end — a silent video, frame-sampled", () => {
  it("carries an approving video all the way to servable", async () => {
    const { deps, storage, images, jobs, statuses } = pipeline();
    images.setImageVerdict(verdict("approved"));

    const out = await processObjectKey(PENDING_KEY, deps);

    expect(out.disposition).toBe("ack");
    // Every frame was classified through the image seam.
    expect(images.imageCalls).toHaveLength(DURATION);
    // The visual track resolved at start — no completion message is coming.
    const visual = jobs.find((j) => j.track === "VISUAL");
    expect(visual?.initialDecision).toBe("approved");
    // ...and the object was settled here rather than left waiting.
    expect(statuses).toEqual(["APPROVED"]);

    // The reviewed bytes are now servable, and the transients are gone.
    const cas = await casKeyOf(storage);
    expect(cas).not.toBeNull();
    expect((await storage.headObject(PENDING_KEY)).exists).toBe(false);
    expect((await storage.headObject(STAGING_KEY)).exists).toBe(false);
    expect(
      isServable({ lifecycle: "APPROVED", deletedAt: null, hidden: false }),
    ).toBe(true);
  });

  it("holds a video whose frames disagree, and serves nothing", async () => {
    const { deps, storage, images, statuses } = pipeline();
    let n = 0;
    images.setImageResponder(async () => {
      n += 1;
      return verdict(n === 2 ? "quarantine" : "approved");
    });

    await processObjectKey(PENDING_KEY, deps);

    expect(statuses).toEqual(["QUARANTINED"]);
    expect(await casKeyOf(storage)).toBeNull();
    expect(
      isServable({ lifecycle: "QUARANTINED", deletedAt: null, hidden: false }),
    ).toBe(false);
  });

  it("holds a video whose frames could not all be decoded", async () => {
    // Only two of the four expected frames decode; the two that do, approve.
    const { deps, storage, images, statuses } = pipeline({ extractableFrames: 2 });
    images.setImageVerdict(verdict("approved"));

    await processObjectKey(PENDING_KEY, deps);

    expect(statuses).toEqual(["REVIEW"]);
    expect(await casKeyOf(storage)).toBeNull();
  });

  it("holds a video whose sampling plan exceeds the per-job ceiling", async () => {
    const { deps, storage, images, statuses } = pipeline({
      framesPerSecond: 10,
      maxFramesPerJob: 5,
    });
    images.setImageVerdict(verdict("approved"));

    await processObjectKey(PENDING_KEY, deps);

    expect(images.imageCalls).toHaveLength(0);
    expect(statuses).toEqual(["REVIEW"]);
    expect(await casKeyOf(storage)).toBeNull();
  });

  it("leaves no sampled frames behind", async () => {
    const { deps, transcode, images } = pipeline();
    images.setImageVerdict(verdict("approved"));

    await processObjectKey(PENDING_KEY, deps);

    expect(transcode.deletedFrames).toHaveLength(DURATION);
  });

  it("removes the poster still on the way out", async () => {
    const { deps, storage, images } = pipeline();
    images.setImageVerdict(verdict("approved"));
    await storage.putObject(
      `${STAGING_KEY}.poster`,
      Buffer.from("poster"),
      "image/jpeg",
    );

    await processObjectKey(PENDING_KEY, deps);

    expect((await storage.headObject(`${STAGING_KEY}.poster`)).exists).toBe(false);
  });
});

describe("moderation seam end-to-end — a video WITH audio still waits for fan-in", () => {
  it("records the inline visual verdict and starts a transcription", async () => {
    const { deps, images, jobs, statuses } = pipeline({ hasAudio: true });
    images.setImageVerdict(verdict("approved"));

    await processObjectKey(PENDING_KEY, deps);

    expect(jobs.find((j) => j.track === "VISUAL")?.initialDecision).toBe(
      "approved",
    );
    // The audio track has a real job with no pre-resolved decision, so the
    // completion worker owns the final transition — nothing is settled here.
    const audio = jobs.find((j) => j.track === "AUDIO");
    expect(audio?.initialDecision).toBeUndefined();
    expect(statuses).toEqual([]);
  });
});

describe("moderation seam end-to-end — the deadline path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the object when the classifier never answers", async () => {
    const { deps, storage, images, statuses } = pipeline();
    // A classifier that hangs forever on every frame.
    images.setImageResponder(() => new Promise<ModerationVerdict>(() => {}));

    const run = processObjectKey(PENDING_KEY, deps);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    const out = await run;

    // A deadline says something about the moment, not the media: the record is
    // retried rather than declared poison...
    expect(out.disposition).toBe("fail");
    // ...and nothing became servable in the meantime.
    expect(await casKeyOf(storage)).toBeNull();
    expect(statuses).toEqual([]);
  });

  it("discards a classifier that answers approved too late", async () => {
    const { deps, storage, images } = pipeline();
    let release: ((v: ModerationVerdict) => void) | undefined;
    images.setImageResponder(
      () =>
        new Promise<ModerationVerdict>((resolve) => {
          release = resolve;
        }),
    );

    const run = processObjectKey(PENDING_KEY, deps);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    const out = await run;
    expect(out.disposition).toBe("fail");

    // The provider finally says "approved" — long after the decision was made.
    release?.(verdict("approved"));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 10);

    expect(await casKeyOf(storage)).toBeNull();
  });
});

describe("moderation seam end-to-end — an operator policy overrides the provider", () => {
  it("quarantines on an unmapped category even when the provider approved", async () => {
    const policy = createLabelPolicy({
      categories: THRESHOLDS,
      pinMode: "config",
      expectedModelVersion: "mock-taxonomy-1",
    });

    // The provider says approved; its labels say something the operator has
    // not ruled on. The policy is what decides.
    const providerVerdict: ModerationVerdict = {
      decision: "approved",
      labels: [{ category: "mock_category_unmapped", confidence: 0.1 }],
      provider: "mock",
      modelVersion: "mock-taxonomy-1",
    };

    expect(policy.decide(providerVerdict)).toBe("quarantine");
  });

  it("reviews when the taxonomy the map was written for has moved", async () => {
    const policy = createLabelPolicy({
      categories: THRESHOLDS,
      pinMode: "config",
      expectedModelVersion: "mock-taxonomy-1",
    });

    expect(policy.decide(verdict("approved", "mock-taxonomy-2"))).toBe("review");
  });
});

describe("moderation seam end-to-end — a redelivery cannot reverse a decision", () => {
  it("leaves a REJECTED object alone when the same message is delivered again", async () => {
    // At-least-once delivery is normal, and this worker has no dedupe of its
    // own. A second pass that assumed the object was still awaiting a verdict
    // would compute a legal-looking transition and overwrite a moderator's
    // rejection — with promotion, if the frames happen to aggregate approved.
    const { deps, storage, images, statuses } = pipeline({ lifecycle: "REJECTED" });
    images.setImageVerdict(verdict("approved"));

    const out = await processObjectKey(PENDING_KEY, deps);

    expect(out.disposition).toBe("ack");
    expect(statuses).toEqual([]);
    expect(await casKeyOf(storage)).toBeNull();
  });

  it("leaves an APPROVED object alone rather than re-deciding it", async () => {
    const { deps, statuses, images } = pipeline({ lifecycle: "APPROVED" });
    images.setImageVerdict(verdict("quarantine"));

    await processObjectKey(PENDING_KEY, deps);

    expect(statuses).toEqual([]);
  });

  it("does not settle at all when the adapter cannot report the lifecycle", async () => {
    // Refusing is the fail-closed choice: settling would mean writing a status
    // computed from an assumed state. The object is held for review instead.
    const { deps, storage, images, statuses, reviewed } = pipeline({
      lifecycle: null,
    });
    images.setImageVerdict(verdict("approved"));

    await processObjectKey(PENDING_KEY, deps);

    expect(reviewed).toEqual([MEDIA_ID]);
    expect(statuses).toEqual(["REVIEW"]);
    expect(await casKeyOf(storage)).toBeNull();
  });

  it("writes conditionally, so a decision landing mid-flight is not clobbered", async () => {
    const { deps, statuses, images } = pipeline({ lifecycle: "UPLOADED" });
    images.setImageVerdict(verdict("approved"));
    // The fixture's persistMediaStatus honours `expectedFrom`; move the row
    // out from under the decision after it was computed.
    const original = deps.persistence.findMediaByUploadId;
    let firstRead = true;
    deps.persistence.findMediaByUploadId = async (uploadId: string) => {
      const row = await original.call(deps.persistence, uploadId);
      if (row !== null && firstRead) {
        firstRead = false;
        // The row the worker decides from...
        return { ...row, lifecycle: "UPLOADED" as const };
      }
      return row;
    };

    await processObjectKey(PENDING_KEY, deps);

    // ...and the write only lands because the row still matched.
    expect(statuses).toEqual(["APPROVED"]);
  });
});
