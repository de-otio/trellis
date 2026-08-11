/**
 * Public API surface snapshot.
 *
 * `@de-otio/trellis` is consumed via this exact set of named exports. Pinning
 * them means an accidental removal or rename fails here, before publish, where
 * it would otherwise only surface as a broken consumer build downstream.
 *
 * When you intentionally add/remove a public export, update this list in the
 * same change.
 */

import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";

const EXPECTED_EXPORTS = [
  "getExtension",
  "getExtensions",
  "registerExtension",
  "setMediaModerationProvider",
  "setPushTransportProvider",
  "setRealtimeProvider",
  "setTextModerationProvider",
  "startServer",
  // Media-moderation seam: everything a provider implementor needs from the
  // package root, so an adapter is written against published names rather than
  // deep paths into dist/.
  "assertModerationProviderAllowed",
  "completionEnvelopeBody",
  "createLabelPolicy",
  "createMediaBytesAccess",
  "FrameSamplingVideoModerationAdapter",
  "isModerationProviderError",
  "LabelPolicyConfigError",
  "MediaBytesTooLargeError",
  "ModerationDeadlineConfigError",
  "ModerationProviderError",
  "NullModerationProvider",
  "parseCompletionEnvelope",
  "setMediaLabelPolicy",
  "setMediaReviewPromotion",
  "ModerationMetrics",
  "withModerationDeadline",
].sort();

describe("public API surface (@de-otio/trellis)", () => {
  it("exports exactly the documented names", () => {
    expect(Object.keys(publicApi).sort()).toEqual(EXPECTED_EXPORTS);
  });

  it("exposes the registration + boot functions as callables", () => {
    expect(typeof publicApi.registerExtension).toBe("function");
    expect(typeof publicApi.startServer).toBe("function");
    expect(typeof publicApi.getExtension).toBe("function");
    expect(typeof publicApi.getExtensions).toBe("function");
  });

  it("exposes the moderation-provider injection hooks as callables", () => {
    expect(typeof publicApi.setMediaModerationProvider).toBe("function");
    expect(typeof publicApi.setTextModerationProvider).toBe("function");
  });

  it("exposes the push-transport injection hook as a callable (T8)", () => {
    expect(typeof publicApi.setPushTransportProvider).toBe("function");
  });
});

describe("public API surface — the media-moderation seam", () => {
  it("exposes the provider contract a backend implements against", () => {
    expect(typeof publicApi.ModerationProviderError).toBe("function");
    expect(typeof publicApi.isModerationProviderError).toBe("function");
    expect(typeof publicApi.NullModerationProvider).toBe("function");
    expect(typeof publicApi.assertModerationProviderAllowed).toBe("function");
  });

  it("exposes the pieces that let an image-only classifier moderate video", () => {
    expect(typeof publicApi.FrameSamplingVideoModerationAdapter).toBe("function");
  });

  it("exposes the operator-owned policy and its refusal", () => {
    expect(typeof publicApi.createLabelPolicy).toBe("function");
    expect(typeof publicApi.setMediaLabelPolicy).toBe("function");
    expect(typeof publicApi.LabelPolicyConfigError).toBe("function");
  });

  it("exposes the deadline wrapper and the bytes capability", () => {
    expect(typeof publicApi.withModerationDeadline).toBe("function");
    expect(typeof publicApi.createMediaBytesAccess).toBe("function");
  });

  it("exposes the completion envelope in both directions", () => {
    const body = publicApi.completionEnvelopeBody({
      track: "VISUAL",
      jobId: "job-1",
    });
    expect(publicApi.parseCompletionEnvelope(body)).toEqual({
      track: "VISUAL",
      jobId: "job-1",
    });
  });
});
