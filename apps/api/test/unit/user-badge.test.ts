/**
 * Unit Tests: User Badge
 *
 * Tests for badge computation and verification logic.
 */

import { describe, expect, it } from "vitest";
import {
  computeIdentityVerificationBadge,
  computeVerificationBadge,
  getUserBadges,
  hasBadge,
  isIdentityVerified,
  shouldDisplayBadge,
  type UserVerificationData,
} from "../../src/lib/user-badge.js";

describe("User Badge System", () => {
  describe("computeVerificationBadge", () => {
    it("should compute badge for verified user with display enabled", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date("2024-01-01"),
        showVerifiedBadge: true,
      };

      const badge = computeVerificationBadge(user);

      expect(badge.type).toBe("verified");
      expect(badge.earned).toBe(true);
      expect(badge.earnedAt).toEqual(new Date("2024-01-01"));
      expect(badge.display).toBe(true);
    });

    it("should compute badge for verified user with display disabled", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date("2024-01-01"),
        showVerifiedBadge: false,
      };

      const badge = computeVerificationBadge(user);

      expect(badge.earned).toBe(true);
      expect(badge.display).toBe(false);
    });

    it("should not earn badge if email not verified", () => {
      const user: UserVerificationData = {
        emailVerified: false,
        emailVerifiedAt: null,
        showVerifiedBadge: true,
      };

      const badge = computeVerificationBadge(user);

      expect(badge.earned).toBe(false);
      expect(badge.earnedAt).toBeNull();
      expect(badge.display).toBe(false);
    });

    it("should not earn badge if emailVerifiedAt is null", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: null as Date | null,
        showVerifiedBadge: true,
      };

      const badge = computeVerificationBadge(user);

      // When emailVerifiedAt is null, earned should be false
      // because: true && (null !== null) = true && false = false
      expect(badge.earned).toBe(false);
      // Display is based on emailVerified && showVerifiedBadge, not on earned
      // So display can be true even if badge is not earned
      expect(badge.display).toBe(true);
    });
  });

  describe("computeIdentityVerificationBadge", () => {
    it("should compute badge for identity verified user", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: true,
        identityVerifiedAt: new Date("2024-01-01"),
        showIdentityVerifiedBadge: true,
        identityVerificationMethod: "government_id",
      };

      const badge = computeIdentityVerificationBadge(user);

      expect(badge.type).toBe("identity_verified");
      expect(badge.earned).toBe(true);
      expect(badge.earnedAt).toEqual(new Date("2024-01-01"));
      expect(badge.display).toBe(true);
      expect(badge.method).toBe("government_id");
    });

    it("should default display to true if showIdentityVerifiedBadge not set", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: true,
        identityVerifiedAt: new Date("2024-01-01"),
        // showIdentityVerifiedBadge not set
      };

      const badge = computeIdentityVerificationBadge(user);

      expect(badge.earned).toBe(true);
      expect(badge.display).toBe(true);
    });

    it("should set display to false if showIdentityVerifiedBadge is false", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: true,
        identityVerifiedAt: new Date("2024-01-01"),
        showIdentityVerifiedBadge: false,
      };

      const badge = computeIdentityVerificationBadge(user);

      expect(badge.earned).toBe(true);
      expect(badge.display).toBe(false);
    });

    it("should not earn badge if identityVerified is false", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: false,
        identityVerifiedAt: null,
      };

      const badge = computeIdentityVerificationBadge(user);

      expect(badge.earned).toBe(false);
      expect(badge.earnedAt).toBeNull();
      expect(badge.display).toBe(false);
    });

    it("should not earn badge if identityVerifiedAt is null", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: true,
        identityVerifiedAt: null,
      };

      const badge = computeIdentityVerificationBadge(user);

      expect(badge.earned).toBe(false);
    });

    it("should not earn badge if identityVerifiedAt is undefined", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: true,
        // identityVerifiedAt undefined
      };

      const badge = computeIdentityVerificationBadge(user);

      expect(badge.earned).toBe(false);
    });

    it("should include method if provided", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: true,
        identityVerifiedAt: new Date(),
        identityVerificationMethod: "automated",
      };

      const badge = computeIdentityVerificationBadge(user);

      expect(badge.method).toBe("automated");
    });

    it("should not include method if not provided", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: true,
        identityVerifiedAt: new Date(),
        identityVerificationMethod: null,
      };

      const badge = computeIdentityVerificationBadge(user);

      expect(badge.method).toBeUndefined();
    });
  });

  describe("getUserBadges", () => {
    it("should return empty array for user with no badges", () => {
      const user: UserVerificationData = {
        emailVerified: false,
        emailVerifiedAt: null,
        showVerifiedBadge: false,
      };

      const badges = getUserBadges(user);

      expect(badges).toEqual([]);
    });

    it("should return only verified badge when email verified", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date("2024-01-01"),
        showVerifiedBadge: true,
        identityVerified: false,
      };

      const badges = getUserBadges(user);

      expect(badges).toHaveLength(1);
      expect(badges[0].type).toBe("verified");
      expect(badges[0].earned).toBe(true);
    });

    it("should return only identity badge when identity verified", () => {
      const user: UserVerificationData = {
        emailVerified: false,
        emailVerifiedAt: null,
        showVerifiedBadge: false,
        identityVerified: true,
        identityVerifiedAt: new Date("2024-01-01"),
        showIdentityVerifiedBadge: true,
      };

      const badges = getUserBadges(user);

      expect(badges).toHaveLength(1);
      expect(badges[0].type).toBe("identity_verified");
      expect(badges[0].earned).toBe(true);
    });

    it("should return both badges when both verified", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date("2024-01-01"),
        showVerifiedBadge: true,
        identityVerified: true,
        identityVerifiedAt: new Date("2024-01-02"),
        showIdentityVerifiedBadge: true,
      };

      const badges = getUserBadges(user);

      expect(badges).toHaveLength(2);
      expect(badges.some((b) => b.type === "verified")).toBe(true);
      expect(badges.some((b) => b.type === "identity_verified")).toBe(true);
    });

    it("should not include unearned badges", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date("2024-01-01"),
        showVerifiedBadge: true,
        identityVerified: false,
        identityVerifiedAt: null,
      };

      const badges = getUserBadges(user);

      expect(badges).toHaveLength(1);
      expect(badges.every((b) => b.earned)).toBe(true);
    });
  });

  describe("hasBadge", () => {
    it("should return true if user has verified badge", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date("2024-01-01"),
        showVerifiedBadge: true,
      };

      expect(hasBadge(user, "verified")).toBe(true);
    });

    it("should return false if user does not have verified badge", () => {
      const user: UserVerificationData = {
        emailVerified: false,
        emailVerifiedAt: null,
        showVerifiedBadge: false,
      };

      expect(hasBadge(user, "verified")).toBe(false);
    });

    it("should return true if user has identity_verified badge", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: true,
        identityVerifiedAt: new Date("2024-01-01"),
      };

      expect(hasBadge(user, "identity_verified")).toBe(true);
    });

    it("should return false if user does not have identity_verified badge", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: false,
        identityVerifiedAt: null,
      };

      expect(hasBadge(user, "identity_verified")).toBe(false);
    });
  });

  describe("isIdentityVerified", () => {
    it("should return true for identity verified user", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: true,
        identityVerifiedAt: new Date("2024-01-01"),
      };

      expect(isIdentityVerified(user)).toBe(true);
    });

    it("should return false for non-identity verified user", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: false,
        identityVerifiedAt: null,
      };

      expect(isIdentityVerified(user)).toBe(false);
    });

    it("should return false when identityVerified is undefined", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        // identityVerified undefined
      };

      expect(isIdentityVerified(user)).toBe(false);
    });
  });

  describe("shouldDisplayBadge", () => {
    it("should return true if badge is earned and display is enabled", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date("2024-01-01"),
        showVerifiedBadge: true,
      };

      expect(shouldDisplayBadge(user, "verified")).toBe(true);
    });

    it("should return false if badge is earned but display is disabled", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date("2024-01-01"),
        showVerifiedBadge: false,
      };

      expect(shouldDisplayBadge(user, "verified")).toBe(false);
    });

    it("should return false if badge is not earned", () => {
      const user: UserVerificationData = {
        emailVerified: false,
        emailVerifiedAt: null,
        showVerifiedBadge: true,
      };

      expect(shouldDisplayBadge(user, "verified")).toBe(false);
    });

    it("should return true for identity badge when display enabled", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: true,
        identityVerifiedAt: new Date("2024-01-01"),
        showIdentityVerifiedBadge: true,
      };

      expect(shouldDisplayBadge(user, "identity_verified")).toBe(true);
    });

    it("should return false for identity badge when display disabled", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: true,
        identityVerifiedAt: new Date("2024-01-01"),
        showIdentityVerifiedBadge: false,
      };

      expect(shouldDisplayBadge(user, "identity_verified")).toBe(false);
    });

    it("should return false for non-existent badge type", () => {
      const user: UserVerificationData = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
      };

      // Type assertion for testing non-existent badge type
      expect(shouldDisplayBadge(user, "nonexistent" as any)).toBe(false);
    });
  });
});
