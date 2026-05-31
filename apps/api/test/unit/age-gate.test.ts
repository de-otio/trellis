/**
 * Unit Tests: Age Gate
 *
 * Tests for age tier computation and feature access configuration.
 */

import { describe, expect, it } from "vitest";
import {
  computeAgeTier,
  getFeatureAccess,
  requiresParentalConsent,
} from "../../src/lib/age-gate.js";

describe("computeAgeTier", () => {
  function dobYearsAgo(years: number): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()),
    );
  }

  it("should return CHILD for age 5", () => {
    expect(computeAgeTier(dobYearsAgo(5))).toBe("CHILD");
  });

  it("should return TEEN for age 15", () => {
    expect(computeAgeTier(dobYearsAgo(15))).toBe("TEEN");
  });

  it("should return ADULT for age 25", () => {
    expect(computeAgeTier(dobYearsAgo(25))).toBe("ADULT");
  });

  it("should return TEEN for exactly age 13 (birthday today)", () => {
    expect(computeAgeTier(dobYearsAgo(13))).toBe("TEEN");
  });

  it("should return ADULT for exactly age 18 (birthday today)", () => {
    expect(computeAgeTier(dobYearsAgo(18))).toBe("ADULT");
  });

  it("should return CHILD one day before turning 13", () => {
    const now = new Date();
    // DOB is 13 years ago but one day in the future (birthday hasn't happened yet)
    const dob = new Date(
      Date.UTC(
        now.getUTCFullYear() - 13,
        now.getUTCMonth(),
        now.getUTCDate() + 1,
      ),
    );
    expect(computeAgeTier(dob)).toBe("CHILD");
  });

  it("should return TEEN one day before turning 18", () => {
    const now = new Date();
    const dob = new Date(
      Date.UTC(
        now.getUTCFullYear() - 18,
        now.getUTCMonth(),
        now.getUTCDate() + 1,
      ),
    );
    expect(computeAgeTier(dob)).toBe("TEEN");
  });

  it("should handle leap year birthday (Feb 29)", () => {
    // Find a recent leap year
    const now = new Date();
    let leapYear = now.getUTCFullYear() - 20;
    while (
      !(leapYear % 4 === 0 && (leapYear % 100 !== 0 || leapYear % 400 === 0))
    ) {
      leapYear--;
    }
    const dob = new Date(Date.UTC(leapYear, 1, 29)); // Feb 29
    const tier = computeAgeTier(dob);
    // Person born on Feb 29 of a leap year ~20+ years ago should be ADULT
    expect(tier).toBe("ADULT");
  });

  it("should return CHILD for a newborn (age 0)", () => {
    const now = new Date();
    const dob = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    expect(computeAgeTier(dob)).toBe("CHILD");
  });
});

describe("requiresParentalConsent", () => {
  it("should return true for CHILD", () => {
    expect(requiresParentalConsent("CHILD")).toBe(true);
  });

  it("should return false for TEEN", () => {
    expect(requiresParentalConsent("TEEN")).toBe(false);
  });

  it("should return false for ADULT", () => {
    expect(requiresParentalConsent("ADULT")).toBe(false);
  });
});

describe("getFeatureAccess", () => {
  it("should return CHILD config with restricted access", () => {
    const access = getFeatureAccess("CHILD");
    expect(access.maxFeedPages).toBe(5);
    expect(access.sessionTimeLimits.firstNudgeMinutes).toBe(15);
    expect(access.sessionTimeLimits.secondNudgeMinutes).toBe(25);
    expect(access.sessionTimeLimits.hardLimitMinutes).toBe(30);
    expect(access.sentimentDisplay).toBe("hidden");
    expect(access.sentimentDisplayOwnPost).toBe("distribution");
    expect(access.canViewSentimentUsers).toBe(false);
    expect(access.canEditNotificationPreferences).toBe(false);
    expect(access.showUnreadCount).toBe(false);
    expect(access.dmAccess).toBe("nobody");
  });

  it("should return TEEN config with moderate access", () => {
    const access = getFeatureAccess("TEEN");
    expect(access.maxFeedPages).toBe(20);
    expect(access.sessionTimeLimits.firstNudgeMinutes).toBe(30);
    expect(access.sessionTimeLimits.secondNudgeMinutes).toBe(50);
    expect(access.sessionTimeLimits.hardLimitMinutes).toBeNull();
    expect(access.sentimentDisplay).toBe("distribution");
    expect(access.sentimentDisplayOwnPost).toBe("distribution");
    expect(access.canViewSentimentUsers).toBe(false);
    expect(access.canEditNotificationPreferences).toBe(true);
    expect(access.showUnreadCount).toBe(false);
    expect(access.dmAccess).toBe("connections");
  });

  it("should return ADULT config with full access", () => {
    const access = getFeatureAccess("ADULT");
    expect(access.maxFeedPages).toBeNull();
    expect(access.sessionTimeLimits.firstNudgeMinutes).toBe(60);
    expect(access.sessionTimeLimits.secondNudgeMinutes).toBeNull();
    expect(access.sessionTimeLimits.hardLimitMinutes).toBeNull();
    expect(access.sentimentDisplay).toBe("full");
    expect(access.sentimentDisplayOwnPost).toBe("full");
    expect(access.canViewSentimentUsers).toBe(true);
    expect(access.canEditNotificationPreferences).toBe(true);
    expect(access.showUnreadCount).toBe(true);
    expect(access.dmAccess).toBe("connections");
  });
});
