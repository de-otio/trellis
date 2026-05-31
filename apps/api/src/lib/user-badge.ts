/**
 * User Badge System
 *
 * Computes and manages user verification badges.
 * Badges are computed on-the-fly based on verification status - no separate badge table needed.
 * This minimizes operational burden by eliminating manual badge management.
 */

export type UserBadgeType = "verified" | "identity_verified";

export interface UserBadge {
  type: UserBadgeType;
  earned: boolean;
  earnedAt: Date | null;
  display: boolean; // User preference to show/hide badge
  method?: string; // Verification method: 'email', 'automated', 'manual', etc.
}

export interface UserVerificationData {
  emailVerified: boolean;
  emailVerifiedAt: Date | null;
  showVerifiedBadge: boolean;
  identityVerified?: boolean;
  identityVerifiedAt?: Date | null;
  showIdentityVerifiedBadge?: boolean;
  identityVerificationMethod?: string | null;
}

/**
 * Compute verification badge status for a user
 * This is computed on-the-fly, no separate badge table needed
 */
export function computeVerificationBadge(
  user: UserVerificationData,
): UserBadge {
  return {
    type: "verified",
    earned: user.emailVerified && user.emailVerifiedAt !== null,
    earnedAt: user.emailVerifiedAt,
    display: user.emailVerified && user.showVerifiedBadge,
  };
}

/**
 * Compute identity verification badge (anti-impersonation)
 * This badge indicates the account is verified as a real person/organization
 */
export function computeIdentityVerificationBadge(
  user: UserVerificationData,
): UserBadge {
  const earned =
    user.identityVerified === true &&
    user.identityVerifiedAt !== null &&
    user.identityVerifiedAt !== undefined;

  return {
    type: "identity_verified",
    earned,
    earnedAt: user.identityVerifiedAt || null,
    display: earned && user.showIdentityVerifiedBadge !== false, // Default to true
    method: user.identityVerificationMethod || undefined,
  };
}

/**
 * Get all badges for a user
 * Includes email verification and identity verification badges
 *
 * @param user - User verification data
 * @returns Array of earned badges
 */
export function getUserBadges(user: UserVerificationData): UserBadge[] {
  const badges: UserBadge[] = [];

  // Email verification badge
  const verifiedBadge = computeVerificationBadge(user);
  if (verifiedBadge.earned) {
    badges.push(verifiedBadge);
  }

  // Identity verification badge (anti-impersonation)
  const identityBadge = computeIdentityVerificationBadge(user);
  if (identityBadge.earned) {
    badges.push(identityBadge);
  }

  // Future badges can be added here:
  // - Phone verified badge
  // - Organization verified badge
  // - Content creator badge
  // etc.

  return badges;
}

/**
 * Check if user has a specific badge type
 */
export function hasBadge(
  user: UserVerificationData,
  badgeType: UserBadgeType,
): boolean {
  const badges = getUserBadges(user);
  return badges.some((badge) => badge.type === badgeType && badge.earned);
}

/**
 * Check if user is identity verified (anti-impersonation)
 * This is the key check for distinguishing real accounts from fake ones
 */
export function isIdentityVerified(user: UserVerificationData): boolean {
  return hasBadge(user, "identity_verified");
}

/**
 * Check if user should display a specific badge
 */
export function shouldDisplayBadge(
  user: UserVerificationData,
  badgeType: UserBadge["type"],
): boolean {
  const badges = getUserBadges(user);
  const badge = badges.find((b) => b.type === badgeType);
  return badge ? badge.display : false;
}
