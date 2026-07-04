// CONTRACT: stable — coordinate changes. Shared P0b text-moderation seam.
//
// A-TEXTMOD decision: this is THE injectable text-moderation seam. The legacy
// `ModerationHandler` (apps/api/src/lib/moderation-handler.ts) was removed in
// T4: it performed network I/O directly (not injectable), spoke a different,
// real-category-named result vocabulary, and — critically — FAILED OPEN: on a
// moderation error / spent budget / missing API key it returned
// `{ approved: true }`, the exact opposite of the media pipeline's fail-closed
// invariant.
//
// The seam returns the canonical `ModerationVerdict` (./moderation-provider.ts).
// The imperative shell (the consuming app, e.g. Skybber) wires the concrete
// adapter via setTextModerationProvider (./request-text-moderation.ts); that
// adapter wraps the hosted moderation call and MUST map its outcome fail-closed:
//
//   clean, affirmatively scored below thresholds -> decision "approved"
//   positively flagged                           -> decision "quarantine"
//   error / budgetExceeded / timeout / no config -> decision "review" (FAIL CLOSED)
//
// (The shell, not this file, owns that adapter — keeping core SDK-free.)
//
// Pure functional core: no I/O, no clock, no random, no cloud SDK. The Mock is
// in-memory and deterministic. Ships in the PUBLIC npm tarball: NO thresholds,
// secrets, or real-category vocabulary here — labels carry opaque tokens.

import type { ModerationVerdict } from "./moderation-provider.js";
import type { WarnSink } from "./moderation-provider.js";

/**
 * The text-moderation capability seam used by the AUDIO track (over a
 * transcript), by the POST/COMMENT text gate (see ../text-moderation-gate.ts),
 * and by any caller needing to classify free text into the canonical 3-value
 * verdict.
 *
 * Binding rule (same as MediaModerationProvider): absence of signal, an
 * internal fault, a spent budget, or ANY uncertainty MUST fail closed to
 * `decision: "review"`. An implementation must NEVER manufacture `approved`
 * from doubt.
 */
export interface TextModerationProvider {
  moderateText(text: string): Promise<ModerationVerdict>;
}

const NULL_PROVIDER_NAME = "null-text";
const NULL_PROVIDER_WARNING =
  "[NullTextModerationProvider] No text-moderation backend injected — failing" +
  ' closed to decision="review". Text will NOT auto-approve. Inject a real' +
  " provider (setTextModerationProvider) in any non-dev environment.";

/**
 * A verdict that fails closed: every call resolves to `review` with no labels.
 * Nothing this provider returns can ever auto-approve text. Used as the safe
 * default before a concrete provider is injected (mirrors the image seam's
 * NullModerationProvider).
 */
export class NullTextModerationProvider implements TextModerationProvider {
  private readonly warn: WarnSink;

  constructor(warn: WarnSink = (msg, data) => console.warn(msg, data)) {
    this.warn = warn;
  }

  async moderateText(_text: string): Promise<ModerationVerdict> {
    this.warn(NULL_PROVIDER_WARNING);
    return { decision: "review", labels: [], provider: NULL_PROVIDER_NAME };
  }
}

/** Returns true for the fail-closed Null text provider. */
export function isNullTextModerationProvider(
  provider: TextModerationProvider,
): boolean {
  return provider instanceof NullTextModerationProvider;
}

const MOCK_PROVIDER_NAME = "mock-text";

const MOCK_DEFAULT_VERDICT: ModerationVerdict = {
  decision: "review",
  labels: [],
  provider: MOCK_PROVIDER_NAME,
};

/**
 * Test seam: returns a canned verdict (default fail-closed `review`). Labels, if
 * programmed, must use ONLY opaque category tokens — never real-category strings.
 */
export class MockTextModerationProvider implements TextModerationProvider {
  private verdict: ModerationVerdict;

  /** Records of each input, for assertions. */
  readonly calls: string[] = [];

  constructor(canned: ModerationVerdict = MOCK_DEFAULT_VERDICT) {
    this.verdict = canned;
  }

  /** Program the verdict returned by subsequent `moderateText` calls. */
  setVerdict(verdict: ModerationVerdict): void {
    this.verdict = verdict;
  }

  async moderateText(text: string): Promise<ModerationVerdict> {
    this.calls.push(text);
    return this.verdict;
  }
}
