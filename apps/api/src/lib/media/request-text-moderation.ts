// CONTRACT: stable — coordinate changes.
//
// Request-path provider seam for TEXT moderation (post/comment text and the
// audio-transcript track). Mirrors the image seam (./request-moderation.ts) and
// the realtime-transport seam: a consuming app (Skybber) calls
// setTextModerationProvider() ONCE at startup with its concrete hosted-API
// adapter, and the posting gate reads it via getTextModerationProvider() on
// every moderated write. Core imports no cloud SDK and performs no network I/O.
//
// FAIL-CLOSED DEFAULT: when no provider has been injected,
// getTextModerationProvider() returns a NullTextModerationProvider (every
// verdict = "review") rather than throwing. An un-wired deploy must degrade to
// REVIEW (text held, never auto-approved, never 500) — a thrown error here
// would turn every post/comment write into a 500.

import {
  NullTextModerationProvider,
  type TextModerationProvider,
} from "./text-moderation.js";

let injected: TextModerationProvider | undefined;

/**
 * Consuming app (Skybber) calls this at startup with its concrete text
 * moderation provider (e.g. the hosted moderation-API adapter). MUST run before
 * the post/comment routes serve. Re-exported from `@de-otio/trellis`
 * (apps/api/src/index.ts).
 */
export function setTextModerationProvider(
  provider: TextModerationProvider,
): void {
  injected = provider;
}

/**
 * Returns the injected provider if one was registered, else a fail-closed
 * {@link NullTextModerationProvider} (every verdict = `review`). Defaulting to
 * Null — rather than throwing — means an un-wired deploy degrades to REVIEW
 * (text held, never auto-approved), which is the safe behaviour for a
 * moderation seam.
 */
export function getTextModerationProvider(): TextModerationProvider {
  return injected ?? new NullTextModerationProvider();
}

/** Test-only: clear the injected provider so tests don't leak across cases. */
export function __resetTextModerationProviderForTests(): void {
  injected = undefined;
}
