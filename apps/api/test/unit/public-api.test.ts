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
  // Lifecycle: releasing core's process-wide pools is a supported operation,
  // so it has a supported name. Without it a consumer booting the server
  // in-process had to import dist/lib/… to tear down.
  "shutdownTrellis",
  // Version-compatibility rules, so a conformance check applies the same rule
  // core applies at boot instead of restating the 0.x policy — plus the
  // version core itself loaded, which is the only authoritative answer to
  // "compatible with what".
  "classifyApiVersion",
  "parseApiVersion",
  "EXTENSION_API_VERSION",
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
  // Provider self-identification: the resolver and the fallback it returns.
  "moderationProviderName",
  "UNKNOWN_PROVIDER_NAME",
  // Concrete providers shipped from core: the generic Scaleway vision
  // classifier and the two-signal cross-check that composes providers and
  // returns the worst verdict (injection defence). Both are mechanisms —
  // vocabulary/thresholds/secrets remain operator config.
  "ScalewayVisionModerationProvider",
  "ScalewayVerdictModerationProvider",
  "CrossCheckModerationProvider",
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

  it("exposes shutdown as a callable, and it resolves rather than throwing", async () => {
    expect(typeof publicApi.shutdownTrellis).toBe("function");
    // Asserted through the published surface: nothing was ever opened here, so
    // this is the "called when idle" case, and it must be a quiet no-op rather
    // than a rejection — a teardown that throws is the failure it prevents.
    await expect(publicApi.shutdownTrellis()).resolves.toMatchObject({
      failed: [],
    });
  });

  it("exposes the version rules, applying core's own 0.x policy", () => {
    expect(typeof publicApi.classifyApiVersion).toBe("function");
    expect(typeof publicApi.parseApiVersion).toBe("function");
    // Through the published surface, not the module: a differing MINOR is
    // breaking while the API is 0.x, which is the rule a conformance check
    // must not restate for itself.
    expect(publicApi.classifyApiVersion("0.8.0", "0.9.2").kind).toBe("incompatible");
    expect(publicApi.classifyApiVersion("0.9.1", "0.9.2").kind).toBe("drift");
    expect(publicApi.classifyApiVersion("0.9.2", "0.9.2").kind).toBe("match");
    expect(publicApi.classifyApiVersion(undefined, "0.9.2").kind).toBe("absent");
    // And the constant core re-exports must be the version core would compare
    // against — a copy that had drifted would make every verdict above answer
    // a different question than the one a conformance check is asking.
    expect(
      publicApi.classifyApiVersion(publicApi.EXTENSION_API_VERSION, publicApi.EXTENSION_API_VERSION)
        .kind,
    ).toBe("match");
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

  it("exposes provider self-identification, resolving through the package root", () => {
    expect(typeof publicApi.moderationProviderName).toBe("function");
    expect(publicApi.UNKNOWN_PROVIDER_NAME).toBe("unknown");
    // Asserted through the published surface, not the module: a consumer
    // importing this must get the fallback behaviour, not just the symbol.
    expect(publicApi.moderationProviderName({ name: "  acme " })).toBe("acme");
    expect(publicApi.moderationProviderName({})).toBe(publicApi.UNKNOWN_PROVIDER_NAME);
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
