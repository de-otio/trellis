/**
 * Privacy Defaults
 *
 * Age-tier-aware privacy defaults and enforcement for child safety.
 * Locked fields cannot be overridden by the user or guardian to a less restrictive value.
 */

import type { AgeTier } from "@prisma/client";

export interface PrivacySettings {
  stealthMode: boolean;
  showOnlineStatus: boolean;
  showTypingIndicator: boolean;
  showLastSeen: boolean;
  locationTrackingEnabled: boolean;
  locationAnonymizationLevel: number;
  analyticsOptOut: boolean;
  profileVisibility: "PUBLIC" | "CONNECTIONS" | "PRIVATE";
  dmAccess: "ANYONE" | "CONNECTIONS" | "NOBODY";
}

/**
 * Fields that are locked (enforced) per age tier — cannot be overridden to less restrictive values.
 */
const LOCKED_FIELDS: Record<AgeTier, Partial<Record<keyof PrivacySettings, true>>> = {
  CHILD: {
    locationTrackingEnabled: true,
    locationAnonymizationLevel: true,
    analyticsOptOut: true,
    dmAccess: true,
  },
  TEEN: {},
  ADULT: {},
};

const DEFAULTS: Record<AgeTier, PrivacySettings> = {
  CHILD: {
    stealthMode: true,
    showOnlineStatus: false,
    showTypingIndicator: false,
    showLastSeen: false,
    locationTrackingEnabled: false,
    locationAnonymizationLevel: 3,
    analyticsOptOut: true,
    profileVisibility: "PRIVATE",
    dmAccess: "NOBODY",
  },
  TEEN: {
    stealthMode: false,
    showOnlineStatus: false,
    showTypingIndicator: true,
    showLastSeen: false,
    locationTrackingEnabled: false,
    locationAnonymizationLevel: 2,
    analyticsOptOut: true,
    profileVisibility: "CONNECTIONS",
    dmAccess: "CONNECTIONS",
  },
  ADULT: {
    stealthMode: false,
    showOnlineStatus: true,
    showTypingIndicator: true,
    showLastSeen: true,
    locationTrackingEnabled: false,
    locationAnonymizationLevel: 0,
    analyticsOptOut: false,
    profileVisibility: "PUBLIC",
    dmAccess: "CONNECTIONS",
  },
};

/**
 * Get the privacy defaults for a given age tier.
 */
export function getPrivacyDefaults(ageTier: AgeTier): PrivacySettings {
  return { ...DEFAULTS[ageTier] };
}

/**
 * Apply privacy locks for a given age tier.
 * Locked fields are overridden with the default value; unlocked fields pass through unchanged.
 */
export function applyPrivacyLocks(settings: PrivacySettings, ageTier: AgeTier): PrivacySettings {
  const defaults = DEFAULTS[ageTier];
  const locked = LOCKED_FIELDS[ageTier];
  const result = { ...settings };

  for (const field of Object.keys(locked) as (keyof PrivacySettings)[]) {
    (result as any)[field] = defaults[field];
  }

  return result;
}

/**
 * Returns true if the given field is locked (enforced) for the given age tier.
 */
export function isFieldLocked(field: keyof PrivacySettings, ageTier: AgeTier): boolean {
  return LOCKED_FIELDS[ageTier][field] === true;
}
