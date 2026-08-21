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
 * Returns true only if the field is an allowed sort field.
 */
export function validateSortField(field: string): field is AllowedSortField {
  return (ALLOWED_SORT_FIELDS as readonly string[]).includes(field);
}
