/**
 * Quiet Hours Module
 *
 * Determines whether the current time falls within a user's quiet hours window.
 * Provides age-tier-based defaults for quiet hours configuration.
 */

import type { AgeTier } from "@prisma/client";

export interface QuietHoursConfig {
  quietHoursEnabled: boolean;
  quietHoursStart: number | null; // minutes from midnight
  quietHoursEnd: number | null; // minutes from midnight
}

/**
 * Returns true if nowMinutes falls within the quiet hours window.
 *
 * Handles overnight wraparound: if start > end (e.g., 22:00=1320 to 07:00=420),
 * quiet hours are active when nowMinutes >= start OR nowMinutes < end.
 * Normal range (start < end): active when start <= nowMinutes < end.
 */
export function isInQuietHours(
  user: QuietHoursConfig,
  nowMinutes: number,
): boolean {
  if (!user.quietHoursEnabled) {
    return false;
  }

  if (user.quietHoursStart === null || user.quietHoursEnd === null) {
    return false;
  }

  const start = user.quietHoursStart;
  const end = user.quietHoursEnd;

  if (start > end) {
    // Overnight wraparound: e.g., 22:00 (1320) to 07:00 (420)
    return nowMinutes >= start || nowMinutes < end;
  }

  // Normal range: e.g., 08:00 (480) to 12:00 (720)
  return nowMinutes >= start && nowMinutes < end;
}

/**
 * Returns default quiet hours configuration for the given age tier.
 *
 * CHILD: 20:00-07:00, enabled by default
 * TEEN: 22:00-07:00, enabled by default
 * ADULT: 23:00-06:00, disabled by default
 */
export function getDefaultQuietHours(ageTier: AgeTier): {
  start: number;
  end: number;
  enabled: boolean;
} {
  switch (ageTier) {
    case "CHILD":
      return { start: 1200, end: 420, enabled: true };
    case "TEEN":
      return { start: 1320, end: 420, enabled: true };
    case "ADULT":
      return { start: 1380, end: 360, enabled: false };
  }
}
