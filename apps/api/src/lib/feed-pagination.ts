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
 * Engagement-based sorting (by sentiment count, comment count, etc.) is
 * prohibited by design to prevent dopamine-driven scroll patterns.
 * See analysis/safer-social-design/03-feed-and-scroll-improvements.md
 */
export const ALLOWED_SORT_FIELDS = ["createdAt"] as const;
export type AllowedSortField = (typeof ALLOWED_SORT_FIELDS)[number];

/**
 * Returns true only if the field is an allowed sort field.
 */
export function validateSortField(field: string): field is AllowedSortField {
  return (ALLOWED_SORT_FIELDS as readonly string[]).includes(field);
}
