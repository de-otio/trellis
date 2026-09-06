/**
 * Feed Pagination Module
 *
 * Provides age-tier-based pagination configuration and metadata computation
 * for feed endpoints. Enforces chronological-only feed ordering.
 */

import type { AgeTier } from "@prisma/client";

export interface PaginationMetadata {
  pageNumber: number;
  sessionPostCount: number;
  hasReachedLimit: boolean;
}

export interface PaginationConfig {
  maxPages: number | null; // null = unlimited
  postsPerPage: number;
}

/**
 * Returns pagination configuration for the given age tier.
 *
 * CHILD: maxPages=5, postsPerPage=10
 * TEEN: maxPages=20, postsPerPage=15
 * ADULT: maxPages=null (unlimited), postsPerPage=20
 */
export function getPaginationConfig(ageTier: AgeTier): PaginationConfig {
  switch (ageTier) {
    case "CHILD":
      return { maxPages: 5, postsPerPage: 10 };
    case "TEEN":
      return { maxPages: 20, postsPerPage: 15 };
    case "ADULT":
      return { maxPages: null, postsPerPage: 20 };
  }
}

/**
 * Computes pagination metadata for the current page request.
 */
export function computePaginationMetadata(
  pageNumber: number,
  postsPerPage: number,
  maxPages: number | null,
): PaginationMetadata {
  return {
    pageNumber,
    sessionPostCount: pageNumber * postsPerPage,
    hasReachedLimit: maxPages !== null && pageNumber >= maxPages,
  };
}

/**
 * Feed ordering policy guard.
 *
 * The platform invariant is NO COVERT ENGAGEMENT ORDERING: every feed
 * order must be declared, versioned, and user-visible, and covert
 * engagement-based sorting (by sentiment count, comment count, etc.) is
 * prohibited to prevent dopamine-driven scroll patterns.
 * See analysis/safer-social-design/03-feed-and-scroll-improvements.md
 *
 * Ranking version 1 implements the chronological DEFAULT — the only
 * ordering currently shipped. Chronological-only is the current
 * mechanism, not a permanent foreclosure: alternative rankers (e.g.
 * bridging-based or prosocial) may be introduced as declared, versioned,
 * user-chosen treatments under the accountability contract in
 * plans/pluggable-ranking/ (doctrine revision 2026-08-20, decision log in
 * analysis/subtractive-filtering/06).
 *
 * REPRODUCIBILITY INVARIANT — DO NOT EXTEND WITHOUT A RESEARCH AUDIT
 * ===================================================================
 * This constant defines the complete set of permitted feed sort fields.
 * The feed is a fixed, known treatment used in research studies; adding
 * a sort field or ranker changes the treatment condition, so every
 * ordering must remain identifiable by version for cohort comparisons.
 *
 * Any change to ALLOWED_SORT_FIELDS must:
 *   1. Be accompanied by a FEED_RANKING_VERSION bump (see below).
 *   2. Be logged in the provenance manifest referenced by doc 07
 *      (analysis/research-platform/ provenance manifest).
 *   3. Receive sign-off from the research lead before merging.
 *   4. Satisfy the pluggable-ranking accountability contract: declared
 *      optimization target, deterministic per version, user-chosen (never
 *      a silent default swap), legible to the user, and no undeclared
 *      engagement inputs.
 */
export const ALLOWED_SORT_FIELDS = ["createdAt"] as const;
export type AllowedSortField = (typeof ALLOWED_SORT_FIELDS)[number];

/**
 * The ORDER BY the home and entity feeds actually execute under
 * `chronological@1`: the single allowed sort field, descending, with the
 * post id as the deterministic tiebreak (it matches the keyset cursor
 * exactly — see feed-handler.ts).
 *
 * This exists so the pinned constant and the executed order are ONE fact.
 * Before it, `ALLOWED_SORT_FIELDS` had no runtime consumer: the query
 * hardcoded its own `orderBy`, so the reproducibility-invariant test could
 * stay green while the feed sorted by something else. The `satisfies`
 * clause ties the two at compile time — change the allowlist without
 * changing this, or this without the allowlist, and `tsc --build` fails.
 * The invariant test block pins the value as well.
 */
export const FEED_ORDER_BY = [
  { createdAt: "desc" },
  { id: "desc" },
] as const satisfies readonly [
  { readonly [K in AllowedSortField]: "desc" },
  { readonly id: "desc" },
];

/**
 * Feed ranking version — increment whenever ALLOWED_SORT_FIELDS changes
 * or any new ranking/ordering logic is introduced.
 *
 * The doc 07 provenance manifest depends on this version to identify which
 * feed treatment a given data export was collected under. A version change
 * constitutes a new experimental condition and must be audited accordingly.
 *
 * Current version 1: chronological-only (createdAt DESC), no engagement
 * ranking, no personalisation signals. Version 1 is the permanent default
 * ordering; any future version is an additional user-chosen treatment,
 * never a replacement of this default.
 */
export const FEED_RANKING_VERSION = 1 as const;

/**
 * Feed ranker identity — a human-legible name for the ordering behind
 * FEED_RANKING_VERSION, in `{name}@{version}` form.
 *
 * This exists so "how is my feed ordered" has one canonical, citable answer
 * (see docs/concepts/feed-ordering.md) instead of only a bare version
 * integer. It carries no information FEED_RANKING_VERSION doesn't already
 * have — the two are kept in lockstep deliberately, not two independent
 * facts to reconcile.
 *
 * Bump discipline is IDENTICAL to FEED_RANKING_VERSION (see above and
 * REPRODUCIBILITY.md Section 2): the `@N` suffix here must equal
 * FEED_RANKING_VERSION, and both change together, for the same reasons,
 * under the same sign-off. `name` changes only when the ranking mechanism
 * itself changes (e.g. a future opt-in ranker introduced under
 * plans/pluggable-ranking/ would ship as `"<its-name>@1"`, not as a bump to
 * this constant — chronological@1 remains the permanent default).
 *
 * Exposed on the wire as `ranker` on every feed response — `FeedResponse`
 * (feed-handler.ts, home and entity feeds) and the circles feed
 * (circle-handler.ts) — so a client can show the user which declared order
 * it received rather than relying on documentation to say so.
 */
export const FEED_RANKER_ID = "chronological@1" as const;

/**
 * Returns true only if the field is an allowed sort field.
 */
export function validateSortField(field: string): field is AllowedSortField {
  return (ALLOWED_SORT_FIELDS as readonly string[]).includes(field);
}
