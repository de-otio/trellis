/**
 * Age Tier Transition
 *
 * Checks users' date of birth and transitions their age tier when appropriate.
 * Applies new privacy defaults and notifies users and guardians.
 */

import type { AgeTier } from "@prisma/client";
import type { Env } from "../env.js";
import { getLogger, Logger } from "./logger.js";
import { getPrivacyDefaults, type PrivacySettings } from "./privacy-defaults.js";

/**
 * Compute the age tier from a date of birth.
 */
export function computeAgeTier(dateOfBirth: Date, now: Date = new Date()): AgeTier {
  const age = getAge(dateOfBirth, now);
  if (age < 13) return "CHILD";
  if (age < 18) return "TEEN";
  return "ADULT";
}

function getAge(dateOfBirth: Date, now: Date): number {
  let age = now.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = now.getMonth() - dateOfBirth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dateOfBirth.getDate())) {
    age--;
  }
  return age;
}

/**
 * Determine if a user setting is MORE restrictive than the new default.
 * If so, keep the user's setting; otherwise apply the new default.
 */
function mergeMoreRestrictive(
  currentSettings: PrivacySettings,
  newDefaults: PrivacySettings,
): PrivacySettings {
  const visibilityOrder = { PRIVATE: 0, CONNECTIONS: 1, PUBLIC: 2 };
  const dmOrder = { NOBODY: 0, CONNECTIONS: 1, ANYONE: 2 };

  return {
    // Boolean fields: false is more restrictive for "show" fields; true is more restrictive for stealth/optOut
    stealthMode: currentSettings.stealthMode || newDefaults.stealthMode,
    showOnlineStatus: currentSettings.showOnlineStatus && newDefaults.showOnlineStatus,
    showTypingIndicator: currentSettings.showTypingIndicator && newDefaults.showTypingIndicator,
    showLastSeen: currentSettings.showLastSeen && newDefaults.showLastSeen,
    locationTrackingEnabled: currentSettings.locationTrackingEnabled && newDefaults.locationTrackingEnabled,
    // Higher anonymization is more restrictive
    locationAnonymizationLevel: Math.max(currentSettings.locationAnonymizationLevel, newDefaults.locationAnonymizationLevel),
    analyticsOptOut: currentSettings.analyticsOptOut || newDefaults.analyticsOptOut,
    // Lower visibility order = more restrictive
    profileVisibility:
      visibilityOrder[currentSettings.profileVisibility] <= visibilityOrder[newDefaults.profileVisibility]
        ? currentSettings.profileVisibility
        : newDefaults.profileVisibility,
    // Lower dm order = more restrictive
    dmAccess:
      dmOrder[currentSettings.dmAccess] <= dmOrder[newDefaults.dmAccess]
        ? currentSettings.dmAccess
        : newDefaults.dmAccess,
  };
}

/**
 * Check all users with a date of birth and transition their age tier if needed.
 * Returns the count of transitioned users and errors.
 */
export async function checkAgeTierTransitions(env: Env): Promise<{
  transitioned: number;
  errors: number;
}> {
  const { createPrisma } = await import("../db.js");
  const db = createPrisma(env);
  const logger = getLogger();
  const now = new Date();

  let transitioned = 0;
  let errors = 0;

  try {
    const users = await db.user.findMany({
      where: { dateOfBirth: { not: null } },
      select: {
        id: true,
        dateOfBirth: true,
        ageTier: true,
        personalTenantId: true,
        stealthMode: true,
        showOnlineStatus: true,
        showTypingIndicator: true,
        showLastSeen: true,
        locationTrackingEnabled: true,
        locationAnonymizationLevel: true,
        analyticsOptOut: true,
        profileVisibility: true,
        dmAccess: true,
      },
    });

    for (const user of users) {
      try {
        if (!user.dateOfBirth) continue;

        const computedTier = computeAgeTier(user.dateOfBirth, now);
        if (computedTier === user.ageTier) continue;

        const oldTier = user.ageTier;
        const newDefaults = getPrivacyDefaults(computedTier);

        const currentSettings: PrivacySettings = {
          stealthMode: user.stealthMode,
          showOnlineStatus: user.showOnlineStatus,
          showTypingIndicator: user.showTypingIndicator,
          showLastSeen: user.showLastSeen,
          locationTrackingEnabled: user.locationTrackingEnabled,
          locationAnonymizationLevel: user.locationAnonymizationLevel,
          analyticsOptOut: user.analyticsOptOut,
          profileVisibility: user.profileVisibility,
          dmAccess: user.dmAccess,
        };

        // Keep user settings that are MORE restrictive than the new defaults
        const merged = mergeMoreRestrictive(currentSettings, newDefaults);

        await db.user.update({
          where: { id: user.id },
          data: {
            ageTier: computedTier,
            ...merged,
          },
        });

        // Use the user's personal tenant for system notifications.
        // Personal tenants are always present (created at sign-up).
        if (user.personalTenantId) {
          await db.notification.create({
            data: {
              userId: user.id,
              type: "SYSTEM",
              title: "Age tier updated",
              body: `Your account has transitioned from ${oldTier} to ${computedTier}. Privacy settings have been updated.`,
              data: { oldTier, newTier: computedTier },
              tenantId: user.personalTenantId,
            },
          });
        }

        // Notify guardian(s) if any active link exists
        const guardianLinks = await db.parentalLink.findMany({
          where: { childId: user.id, status: "ACTIVE" },
          include: { guardian: { select: { personalTenantId: true } } },
        });

        for (const link of guardianLinks) {
          if (!link.guardian.personalTenantId) continue;
          await db.notification.create({
            data: {
              userId: link.guardianId,
              type: "SYSTEM",
              title: "Child age tier updated",
              body: `Your linked child account has transitioned from ${oldTier} to ${computedTier}.`,
              data: { childId: user.id, oldTier, newTier: computedTier },
              tenantId: link.guardian.personalTenantId,
            },
          });
        }

        transitioned++;
        logger.info(`User ${user.id} transitioned from ${oldTier} to ${computedTier}`);
      } catch (error) {
        errors++;
        logger.error(`Error transitioning user ${user.id}:`, error);
      }
    }
  } catch (error) {
    logger.error("Error in checkAgeTierTransitions:", error);
    errors++;
  }

  return { transitioned, errors };
}
