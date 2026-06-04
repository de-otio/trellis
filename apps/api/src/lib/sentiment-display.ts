/**
 * Sentiment Display Mode
 *
 * Determines how sentiment data is displayed based on the viewer's age tier
 * and whether they are the post author. Part of Stream C: Sentiment Safeguards.
 *
 * Rules:
 * - CHILD viewing own post: DISTRIBUTION (aggregate only)
 * - CHILD viewing other's post: HIDDEN (no sentiment data)
 * - TEEN viewing any post: DISTRIBUTION (aggregate only)
 * - ADULT viewing any post: FULL (all details)
 */

import type { AgeTier } from "@prisma/client";

export enum SentimentDisplayMode {
  FULL = "full",
  DISTRIBUTION = "distribution",
  HIDDEN = "hidden",
}

export function getSentimentDisplayMode(
  ageTier: AgeTier,
  isPostAuthor: boolean,
): SentimentDisplayMode {
  switch (ageTier) {
    case "CHILD":
      return isPostAuthor
        ? SentimentDisplayMode.DISTRIBUTION
        : SentimentDisplayMode.HIDDEN;
    case "TEEN":
      return SentimentDisplayMode.DISTRIBUTION;
    case "ADULT":
      return SentimentDisplayMode.FULL;
    default:
      // Default to most restrictive for unknown tiers
      return SentimentDisplayMode.HIDDEN;
  }
}
