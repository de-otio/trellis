// CONTRACT: stable — coordinate changes.
//
// Request-path provider seam for SYNCHRONOUS image moderation. Mirrors the
// realtime-transport seam (apps/api/src/lib/realtime/index.ts): a consuming app
// (Skybber) calls setMediaModerationProvider() ONCE at startup with its concrete
// cloud adapter, and the upload handler reads it via getMediaModerationProvider()
// on every sync-image request. Core imports no cloud SDK.
//
// FAIL-CLOSED DEFAULT: when no provider has been injected, getMediaModerationProvider()
// returns a NullModerationProvider (every verdict = "review") rather than throwing.
// An un-wired deploy must degrade to REVIEW (never serve, never 500) — a thrown
// error here would turn every image upload into a 500. The startup guard
// (assertModerationProviderAllowed) is the place that loudly refuses to run Null
// outside dev; this seam is the safe runtime fallback.

import {
  type MediaModerationProvider,
  NullModerationProvider,
} from "./moderation-provider.js";

// ---------------------------------------------------------------------------
// Provider-injection hook (mirrors setRealtimeProvider). A consuming app calls
// setMediaModerationProvider() at startup, BEFORE the upload route serves, with
// its concrete provider. getMediaModerationProvider() returns the injected
// provider if present, else a fail-closed Null default.
// ---------------------------------------------------------------------------

let injected: MediaModerationProvider | undefined;

/**
 * Consuming app (Skybber) calls this at startup with its concrete moderation
 * provider (e.g. an AWS Rekognition adapter). MUST run before the upload route
 * serves. Re-exported from `@de-otio/trellis` (apps/api/src/index.ts).
 */
export function setMediaModerationProvider(
  provider: MediaModerationProvider,
): void {
  injected = provider;
}

/**
 * Returns the injected provider if one was registered, else a fail-closed
 * {@link NullModerationProvider} (every verdict = `review`). The upload handler
 * calls this on each sync-image request. Defaulting to Null — rather than
 * throwing — means an un-wired deploy degrades to REVIEW (never serves, never
 * 500), which is the safe behaviour for a moderation seam.
 */
export function getMediaModerationProvider(): MediaModerationProvider {
  return injected ?? new NullModerationProvider();
}

/** Test-only: clear the injected provider so tests don't leak across cases. */
export function __resetMediaModerationProviderForTests(): void {
  injected = undefined;
}
