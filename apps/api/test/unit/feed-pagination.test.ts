import { describe, expect, it } from "vitest";

import {
  ALLOWED_SORT_FIELDS,
  FEED_ORDER_BY,
  FEED_RANKER_ID,
  FEED_RANKING_VERSION,
  computePaginationMetadata,
  getPaginationConfig,
  validateSortField,
} from "../../src/lib/feed-pagination.js";

describe("getPaginationConfig", () => {
  it("should return maxPages=5, postsPerPage=10 for CHILD", () => {
    expect(getPaginationConfig("CHILD")).toEqual({
      maxPages: 5,
      postsPerPage: 10,
    });
  });

  it("should return maxPages=20, postsPerPage=15 for TEEN", () => {
    expect(getPaginationConfig("TEEN")).toEqual({
      maxPages: 20,
      postsPerPage: 15,
    });
  });

  it("should return maxPages=null, postsPerPage=20 for ADULT", () => {
    expect(getPaginationConfig("ADULT")).toEqual({
      maxPages: null,
      postsPerPage: 20,
    });
  });
});

describe("computePaginationMetadata", () => {
  it("should compute correct sessionPostCount", () => {
    const result = computePaginationMetadata(3, 10, null);
    expect(result.sessionPostCount).toBe(30);
  });

  it("should set hasReachedLimit=true when pageNumber equals maxPages", () => {
    const result = computePaginationMetadata(5, 10, 5);
    expect(result.hasReachedLimit).toBe(true);
  });

  it("should set hasReachedLimit=false when pageNumber is below maxPages", () => {
    const result = computePaginationMetadata(4, 10, 5);
    expect(result.hasReachedLimit).toBe(false);
  });

  it("should set hasReachedLimit=false when maxPages is null", () => {
    const result = computePaginationMetadata(100, 20, null);
    expect(result.hasReachedLimit).toBe(false);
  });

  it("should return correct pageNumber in metadata", () => {
    const result = computePaginationMetadata(7, 15, 20);
    expect(result.pageNumber).toBe(7);
    expect(result.sessionPostCount).toBe(105);
  });
});

describe("validateSortField", () => {
  it("should return true for createdAt", () => {
    expect(validateSortField("createdAt")).toBe(true);
  });

  it("should return false for sentimentCount", () => {
    expect(validateSortField("sentimentCount")).toBe(false);
  });

  it("should return false for commentCount", () => {
    expect(validateSortField("commentCount")).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(validateSortField("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REPRODUCIBILITY INVARIANT — feed sort field allowlist
//
// These tests pin the exact allowlist that defines the chronological-only
// feed treatment used in research studies.  If they break, ALLOWED_SORT_FIELDS
// has changed, which constitutes a new experimental condition that requires
// a FEED_RANKING_VERSION bump and a research-lead sign-off before merging.
// ---------------------------------------------------------------------------

describe("feed sort-field reproducibility invariant", () => {
  it("ALLOWED_SORT_FIELDS contains exactly ['createdAt'] — the chronological default; no covert engagement ordering", () => {
    // The feed is a fixed treatment; sort fields must never be added without
    // a research audit, a version bump, and the pluggable-ranking
    // accountability contract (plans/pluggable-ranking/) — declared,
    // versioned, user-chosen, no undeclared engagement inputs.
    expect(Array.from(ALLOWED_SORT_FIELDS)).toEqual(["createdAt"]);
  });

  it("FEED_ORDER_BY is the allowlist's single field DESC with the id tiebreak — the executed order and the pinned constant are one fact", () => {
    // feed-handler.ts spreads FEED_ORDER_BY into the query; nothing restates
    // the order. If this fails, either the allowlist or the executed order
    // changed — and the other must change with it, under the same sign-off.
    expect(FEED_ORDER_BY).toEqual([
      { [ALLOWED_SORT_FIELDS[0]]: "desc" },
      { id: "desc" },
    ]);
    expect(FEED_ORDER_BY).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("engagement metric fields are rejected by validateSortField", () => {
    // Spot-check a representative set of fields that must never be allowed.
    const prohibited = [
      "sentimentCount",
      "commentCount",
      "shareCount",
      "viewCount",
      "reactionCount",
      "score",
      "relevance",
      "popularity",
    ];
    for (const field of prohibited) {
      expect(validateSortField(field), `"${field}" must be rejected`).toBe(false);
    }
  });

  it("FEED_RANKING_VERSION is 1 (chronological default, no engagement ranking)", () => {
    // Version 1 = createdAt DESC, no personalisation — the permanent default
    // ordering. Any future version is an additional user-chosen treatment,
    // never a replacement: bump the version, update the provenance manifest
    // in analysis/research-platform/, and satisfy plans/pluggable-ranking/.
    expect(FEED_RANKING_VERSION).toBe(1);
  });

  it("FEED_RANKER_ID names the current ranker and stays in lockstep with FEED_RANKING_VERSION", () => {
    // FEED_RANKER_ID carries no fact independent of FEED_RANKING_VERSION —
    // its `@N` suffix must equal the version constant, always. If this test
    // fails because the two were bumped independently, that is the bug to
    // fix, not the test.
    expect(FEED_RANKER_ID).toBe("chronological@1");
    expect(FEED_RANKER_ID).toBe(`chronological@${FEED_RANKING_VERSION}`);
  });
});
