import { describe, expect, it } from "vitest";

import { PERSONALIZATION_OPTION_KEYS } from "../../src/lib/feed-personalization.js";

// ---------------------------------------------------------------------------
// REPRODUCIBILITY / NO-COVERT-ORDERING INVARIANT — feed-personalization
// options must never be scoring-shaped
//
// PersonalizationOptions (feed-personalization.ts) may only ever describe a
// FILTER (which posts are included), never a SCORE (how they are ordered).
// The feed's only ordering is `createdAt DESC` under FEED_RANKING_VERSION —
// see REPRODUCIBILITY.md Section 2 and feed-pagination.ts's
// ALLOWED_SORT_FIELDS.
//
// A previous version of this interface declared `boostByMatchCount` and
// `taxonomyWeight`; neither was ever implemented (feed-handler.ts only ever
// built a WHERE filter from personalization output), so they were dead
// surface that contradicted the invariant sitting right next to them. This
// test pins the allowlist so a scoring-shaped option can't reappear
// silently: PERSONALIZATION_OPTION_KEYS is kept in sync with the interface
// at compile time (see the `satisfies` / completeness check in
// feed-personalization.ts), so this is the runtime half of that guard.
// ---------------------------------------------------------------------------

describe("PersonalizationOptions — no scoring-shaped keys", () => {
  const SCORE_SHAPED = /score|weight|boost|rank|relevance/i;

  it("PERSONALIZATION_OPTION_KEYS contains exactly the current, filter-only options", () => {
    expect([...PERSONALIZATION_OPTION_KEYS].sort()).toEqual(
      ["enabled", "minMatchingTags"].sort(),
    );
  });

  it("no option name is scoring-shaped (weight/boost/score/rank/relevance)", () => {
    for (const key of PERSONALIZATION_OPTION_KEYS) {
      expect(key, `"${key}" looks scoring-shaped — forbidden by the no-covert-ordering invariant`).not.toMatch(
        SCORE_SHAPED,
      );
    }
  });

  it("the removed boostByMatchCount/taxonomyWeight options do not reappear", () => {
    expect(PERSONALIZATION_OPTION_KEYS).not.toContain("boostByMatchCount");
    expect(PERSONALIZATION_OPTION_KEYS).not.toContain("taxonomyWeight");
  });
});
