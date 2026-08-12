import { describe, expect, it } from "vitest";

import {
  MockModerationProvider,
  NullModerationProvider,
  UNKNOWN_PROVIDER_NAME,
  moderationProviderName,
  type ImageRef,
  type MediaModerationProvider,
  type ModerationCallOptions,
  type ModerationVerdict,
  type S3Ref,
  type VideoModerationStart,
} from "../../../src/lib/media/moderation-provider.js";
import { withModerationDeadline } from "../../../src/lib/media/moderation-deadline.js";
import { FrameSamplingVideoModerationAdapter } from "../../../src/lib/media/frame-sampling-adapter.js";

/** A provider whose name is whatever the test needs it to be. */
function named(name: unknown): MediaModerationProvider {
  const base = new MockModerationProvider();
  return {
    // Deliberately unchecked: the point is what core does with a hostile value.
    name: name as string | undefined,
    moderateImage: (input: ImageRef, options?: ModerationCallOptions) =>
      base.moderateImage(input, options),
    startVideoModeration: (input: S3Ref, options?: ModerationCallOptions) =>
      base.startVideoModeration(input, options),
    getVideoModeration: (jobId: string, options?: ModerationCallOptions) =>
      base.getVideoModeration(jobId, options),
  };
}

describe("moderationProviderName", () => {
  it("reports the shipped providers' own names", () => {
    expect(moderationProviderName(new NullModerationProvider(() => {}))).toBe(
      "null",
    );
    expect(moderationProviderName(new MockModerationProvider())).toBe("mock");
  });

  it("agrees with what the provider puts in its verdict", async () => {
    // The two must not drift: the verdict field is the post-hoc attribution and
    // the name is the pre-call one. If they disagree, one path's counters are
    // wrong and nothing says which.
    const provider = new NullModerationProvider(() => {});
    const verdict = await provider.moderateImage({ key: "k" } as ImageRef);
    expect(verdict.provider).toBe(moderationProviderName(provider));
  });

  it("treats an absent name as unknown rather than undefined", () => {
    expect(moderationProviderName(named(undefined))).toBe(
      UNKNOWN_PROVIDER_NAME,
    );
  });

  it("treats an empty or whitespace name as unknown, not as an identity", () => {
    // A half-wired adapter yields "" — it must not become a distinct dimension.
    for (const bad of ["", "   ", "\t\n"]) {
      expect(moderationProviderName(named(bad))).toBe(UNKNOWN_PROVIDER_NAME);
    }
  });

  it("treats a non-string name as unknown rather than coercing it", () => {
    for (const bad of [42, null, {}, [], true]) {
      expect(moderationProviderName(named(bad))).toBe(UNKNOWN_PROVIDER_NAME);
    }
  });

  it("trims a padded name so padding cannot mint a second identity", () => {
    expect(moderationProviderName(named("  acme  "))).toBe("acme");
  });

  it("tolerates a null or undefined provider", () => {
    expect(moderationProviderName(null)).toBe(UNKNOWN_PROVIDER_NAME);
    expect(moderationProviderName(undefined)).toBe(UNKNOWN_PROVIDER_NAME);
  });
});

describe("the wrapper rule — wrapping must not change the identity", () => {
  it("the deadline wrapper reports the inner provider's name", () => {
    const inner = named("acme");
    const wrapped = withModerationDeadline(inner, { timeoutMs: 1000 });
    expect(moderationProviderName(wrapped)).toBe("acme");
  });

  it("the deadline wrapper keeps an absent name absent", () => {
    const wrapped = withModerationDeadline(named(undefined), {
      timeoutMs: 1000,
    });
    expect(moderationProviderName(wrapped)).toBe(UNKNOWN_PROVIDER_NAME);
  });

  it("the frame-sampling adapter reports the classifier's name", () => {
    const adapter = new FrameSamplingVideoModerationAdapter({
      images: named("acme"),
      transcode: {},
      config: {
        framesPerSecond: 1,
        maxFramesPerJob: 10,
        maxDurationSeconds: 60,
      },
      frameDirFor: (jobId) => `processing/frames/${jobId}`,
      newJobId: () => "job-1",
    } as never);
    expect(moderationProviderName(adapter)).toBe("acme");
  });

  it("stacking both wrappers still reports the innermost name", () => {
    // The configuration an operator actually deploys: an image-only classifier,
    // given a video job model, behind a deadline. Three objects, one identity.
    const adapter = new FrameSamplingVideoModerationAdapter({
      images: named("acme"),
      transcode: {},
      config: {
        framesPerSecond: 1,
        maxFramesPerJob: 10,
        maxDurationSeconds: 60,
      },
      frameDirFor: (jobId) => `processing/frames/${jobId}`,
      newJobId: () => "job-1",
    } as never);
    const wrapped = withModerationDeadline(adapter, { timeoutMs: 1000 });
    expect(moderationProviderName(wrapped)).toBe("acme");
  });

  it("the adapter follows a name assigned after construction", () => {
    // A getter, not a copied field: an adapter that names itself during its own
    // async init would otherwise be frozen as unknown at wrapper-build time.
    const inner = named(undefined) as { name?: string };
    const adapter = new FrameSamplingVideoModerationAdapter({
      images: inner,
      transcode: {},
      config: {
        framesPerSecond: 1,
        maxFramesPerJob: 10,
        maxDurationSeconds: 60,
      },
      frameDirFor: (jobId) => `processing/frames/${jobId}`,
      newJobId: () => "job-1",
    } as never);
    expect(moderationProviderName(adapter)).toBe(UNKNOWN_PROVIDER_NAME);
    inner.name = "acme";
    expect(moderationProviderName(adapter)).toBe("acme");
  });
});

describe("name vs. metric dimension", () => {
  it("an honest but undeclared name is still a usable name", async () => {
    // The two admission rules are deliberately different: a metric dimension
    // must be in the operator's declared set (cardinality), but a cache key and
    // a log line only need the name to be honest.
    const { isAcceptableProviderDimension } = await import(
      "../../../src/lib/media/moderation-metrics.js"
    );
    expect(moderationProviderName(named("acme"))).toBe("acme");
    expect(isAcceptableProviderDimension("acme", ["other"])).toBe(false);
  });
});
