/**
 * Age Gate Module
 *
 * Computes age tiers from date of birth and provides tier-based feature access
 * configuration for child safety compliance.
 */

import type { AgeTier } from "@prisma/client";

export interface FeatureAccess {
  maxFeedPages: number | null; // null = unlimited
  sessionTimeLimits: {
    firstNudgeMinutes: number | null;
    secondNudgeMinutes: number | null;
    hardLimitMinutes: number | null;
  };
  sentimentDisplay: "full" | "distribution" | "hidden";
  sentimentDisplayOwnPost: "full" | "distribution";
  canViewSentimentUsers: boolean;
  canEditNotificationPreferences: boolean;
  showUnreadCount: boolean; // false = show boolean hasUnread only
  dmAccess: "anyone" | "connections" | "nobody";
}

/**
 * Calculate age tier from date of birth.
 *
 * Under 13 = CHILD, 13-17 = TEEN, 18+ = ADULT.
 * Uses UTC dates to avoid timezone issues.
 */
export function computeAgeTier(dateOfBirth: Date): AgeTier {
  const now = new Date();

  // Calculate age using UTC to avoid timezone issues
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();

  // Check if birthday has not yet occurred this year
  const monthDiff = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())
  ) {
    age--;
  }

  if (age < 13) {
    return "CHILD";
  } else if (age < 18) {
    return "TEEN";
  } else {
    return "ADULT";
  }
}

/**
 * Returns true if the age tier requires parental consent (CHILD only).
 */
export function requiresParentalConsent(ageTier: AgeTier): boolean {
  return ageTier === "CHILD";
}

/**
 * Returns the feature access configuration for the given age tier.
 */
export function getFeatureAccess(ageTier: AgeTier): FeatureAccess {
  switch (ageTier) {
    case "CHILD":
      return {
        maxFeedPages: 5,
        sessionTimeLimits: {
          firstNudgeMinutes: 15,
          secondNudgeMinutes: 25,
          hardLimitMinutes: 30,
        },
        sentimentDisplay: "hidden",
        sentimentDisplayOwnPost: "distribution",
        canViewSentimentUsers: false,
        canEditNotificationPreferences: false,
        showUnreadCount: false,
        dmAccess: "nobody",
      };

    case "TEEN":
      return {
        maxFeedPages: 20,
        sessionTimeLimits: {
          firstNudgeMinutes: 30,
          secondNudgeMinutes: 50,
          hardLimitMinutes: null,
        },
        sentimentDisplay: "distribution",
        sentimentDisplayOwnPost: "distribution",
        canViewSentimentUsers: false,
        canEditNotificationPreferences: true,
        showUnreadCount: false,
        dmAccess: "connections",
      };

    case "ADULT":
      return {
        maxFeedPages: null,
        sessionTimeLimits: {
          firstNudgeMinutes: 60,
          secondNudgeMinutes: null,
          hardLimitMinutes: null,
        },
        sentimentDisplay: "full",
        sentimentDisplayOwnPost: "full",
        canViewSentimentUsers: true,
        canEditNotificationPreferences: true,
        showUnreadCount: true,
        dmAccess: "connections",
      };
  }
}
