// CONTRACT: stable — coordinate changes.
//
// Server-only block-class derivation (spec 07 §4.3 / plan 08 Phase 2). Pure
// functional core: no I/O, no clock, no random, no cloud SDK. Ships in the
// PUBLIC npm tarball — so it hardcodes NO provider vocabulary (no "sexual/minors"
// string), NO jurisdiction, NO threshold. The deployment's moderation adapter
// maps its provider's illegal category (e.g. OpenAI `sexual/minors`, or a future
// hash-match hit) onto the single RESERVED, provider-neutral opaque label token
// below; core recognises only that token.
//
// The resulting `BlockClass` NEVER leaves the domain: it is not in
// `ModerationResolvedPayload`, not in any client response or notification. The
// owner-scoped disposition read exposes only the coarse `appealable` boolean
// derived here.

import type { ModerationVerdict } from "../media/moderation-provider.js";
import type { BlockClass } from "../media/compliance-seams.js";

/**
 * The RESERVED, jurisdiction-/provider-neutral label token that signals the
 * illegal-suspected class. A deployment's moderation adapter emits a
 * {@link ModerationLabel} with this `category` when its underlying provider
 * flags a suspected-illegal category (the text path: OpenAI `sexual/minors`;
 * later: a media hash-match hit). Core matches ONLY this token, so no real
 * category vocabulary is ever compiled into the public tarball.
 *
 * The `x-` prefix marks it as an out-of-band, reserved control token distinct
 * from ordinary opaque classifier tokens.
 */
export const ILLEGAL_SUSPECTED_LABEL = "x-illegal-suspected";

/**
 * Derive the SERVER-ONLY {@link BlockClass} from a moderation verdict.
 *
 * `illegal-suspected` iff ANY label carries the reserved
 * {@link ILLEGAL_SUSPECTED_LABEL} token; otherwise `lawful-flagged`. Total over
 * its input; a verdict with no labels is `lawful-flagged`.
 *
 * The asymmetry is deliberate and conservative in the direction that matters:
 * illegal-class must be affirmatively signalled by the adapter, never inferred.
 */
export function deriveBlockClass(verdict: ModerationVerdict): BlockClass {
  for (const label of verdict.labels) {
    if (label.category === ILLEGAL_SUSPECTED_LABEL) {
      return "illegal-suspected";
    }
  }
  return "lawful-flagged";
}

/**
 * Whether a blocked item may be offered the submit-for-analysis appeal path.
 *
 * `false` for `illegal-suspected` (the carve-out: never appealable, never
 * offered submit). `true` for `lawful-flagged`. An UNKNOWN/absent block class is
 * treated as `lawful-flagged` → appealable — media illegal-class detection is a
 * known gap (spec 07 §8), so only an explicitly-marked illegal item is
 * non-appealable; a blocked-but-unclassified item gets the lawful appeal path.
 *
 * `appealable` is the ONLY bit derived from the block class that ever crosses
 * the domain boundary (spec 07 §4.1).
 */
export function isAppealable(blockClass: BlockClass | null | undefined): boolean {
  return blockClass !== "illegal-suspected";
}
