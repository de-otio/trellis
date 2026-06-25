// CONTRACT: stable — coordinate changes. Shared P0b text-moderation seam.
//
// A-TEXTMOD decision: NO clean injectable text-moderation seam exists today.
//
// The repo already has apps/api/src/lib/moderation-handler.ts
// (`ModerationHandler.moderateText(text, env): Promise<ModerationResult>`), but
// it is NOT usable as the media-pipeline seam, for three reasons:
//
//   1. It is a concrete class that performs network I/O directly (fetches the
//      hosted moderation API), not an injectable interface — it cannot live in
//      the functional core, and it cannot be swapped for a Mock in property
//      tests without monkey-patching the network.
//   2. Its result shape (`ModerationResult { approved, score, details, ... }`)
//      is a different, real-category-named vocabulary — it is NOT the opaque
//      `ModerationVerdict` the media seam standardizes on.
//   3. CRITICALLY, it FAILS OPEN: on a moderation error it returns
//      `{ approved: true }` (and likewise `{ approved: true, budgetExceeded }`
//      when the budget is spent). That is the exact opposite of the media
//      pipeline's fail-closed invariant — a faulted text moderation must
//      degrade to `review`, never to a decision that can serve bytes.
//
// Therefore B0 defines a thin, fail-closed `TextModerationProvider` seam that
// returns the canonical `ModerationVerdict` (./moderation-provider.ts). The
// imperative shell wires the concrete adapter; that adapter MUST map the legacy
// `ModerationResult` into a verdict WITHOUT inheriting the fail-open behavior:
//
//   approved === true                  -> decision "approved"
//   approved === false                 -> decision "quarantine" (a positive flag)
//   error / budgetExceeded / timeout   -> decision "review"   (FAIL CLOSED)
//
// (The shell, not this file, owns that adapter — keeping core SDK-free.)
//
// Pure functional core: no I/O, no clock, no random, no cloud SDK. The Mock is
// in-memory and deterministic. Ships in the PUBLIC npm tarball: NO thresholds,
// secrets, or real-category vocabulary here — labels carry opaque tokens.

import type { ModerationVerdict } from "./moderation-provider.js";

/**
 * The text-moderation capability seam used by the AUDIO track (over a
 * transcript) and by any caller needing to classify free text into the
 * canonical 3-value verdict.
 *
 * Binding rule (same as MediaModerationProvider): absence of signal, an
 * internal fault, a spent budget, or ANY uncertainty MUST fail closed to
 * `decision: "review"`. An implementation must NEVER manufacture `approved`
 * from doubt.
 */
export interface TextModerationProvider {
  moderateText(text: string): Promise<ModerationVerdict>;
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
