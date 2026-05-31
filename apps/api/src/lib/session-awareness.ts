/**
 * Session Awareness Module
 *
 * Provides session duration thresholds and nudge messages for age-tier-based
 * screen time management.
 */

import type { AgeTier } from "@prisma/client";

export interface Nudge {
  type: "time_reminder" | "session_limit";
  message: string;
  sessionMinutes: number;
}

export interface SessionThresholds {
  firstNudgeMinutes: number | null;
  secondNudgeMinutes: number | null;
  hardLimitMinutes: number | null;
}

/**
 * Returns session duration thresholds for the given age tier.
 *
 * CHILD: first=15, second=25, hard=30
 * TEEN: first=30, second=50, hard=null
 * ADULT: first=60, second=null, hard=null
 */
export function getSessionThresholds(ageTier: AgeTier): SessionThresholds {
  switch (ageTier) {
    case "CHILD":
      return {
        firstNudgeMinutes: 15,
        secondNudgeMinutes: 25,
        hardLimitMinutes: 30,
      };
    case "TEEN":
      return {
        firstNudgeMinutes: 30,
        secondNudgeMinutes: 50,
        hardLimitMinutes: null,
      };
    case "ADULT":
      return {
        firstNudgeMinutes: 60,
        secondNudgeMinutes: null,
        hardLimitMinutes: null,
      };
  }
}

/**
 * Returns a nudge if the session duration exceeds any threshold for the age tier.
 *
 * Returns the highest applicable nudge:
 * - session_limit if hard limit is exceeded (CHILD only)
 * - time_reminder for first/second nudge thresholds
 * - null if no threshold exceeded
 */
export function getSessionNudge(
  sessionDurationMinutes: number,
  ageTier: AgeTier,
): Nudge | null {
  const thresholds = getSessionThresholds(ageTier);

  // Check hard limit first (highest priority)
  if (
    thresholds.hardLimitMinutes !== null &&
    sessionDurationMinutes >= thresholds.hardLimitMinutes
  ) {
    return {
      type: "session_limit",
      message: `You've reached your session limit of ${thresholds.hardLimitMinutes} minutes. Come back later!`,
      sessionMinutes: sessionDurationMinutes,
    };
  }

  // Check second nudge
  if (
    thresholds.secondNudgeMinutes !== null &&
    sessionDurationMinutes >= thresholds.secondNudgeMinutes
  ) {
    return {
      type: "time_reminder",
      message: `You've been browsing for ${sessionDurationMinutes} minutes. Time for a break.`,
      sessionMinutes: sessionDurationMinutes,
    };
  }

  // Check first nudge
  if (
    thresholds.firstNudgeMinutes !== null &&
    sessionDurationMinutes >= thresholds.firstNudgeMinutes
  ) {
    return {
      type: "time_reminder",
      message: `You've been browsing for ${sessionDurationMinutes} minutes. Consider taking a break!`,
      sessionMinutes: sessionDurationMinutes,
    };
  }

  return null;
}
