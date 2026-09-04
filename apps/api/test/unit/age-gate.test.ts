/**
 * Unit Tests: Age Gate
 *
 * Tests for age tier computation and feature access configuration.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  computeAgeTier,
  computeAgeYears,
  getFeatureAccess,
  isUnderMinimumAge,
  MINIMUM_SIGNUP_AGE_YEARS,
  MINOR_TIERS_SUPPORTED,
  requiresParentalConsent,
  resolveSessionAgeTier,
  UnderMinimumAgeError,
  UNDER_MINIMUM_AGE_ERROR,
} from "../../src/lib/age-gate.js";
import { computeAgeTier as transitionComputeAgeTier } from "../../src/lib/age-tier-transition.js";
import { computeAgeTier as provisioningComputeAgeTier } from "../../src/lib/identity/provision-confirmed-user.js";

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

describe("computeAgeTier — clock frame (regression)", () => {
  // `age-tier-transition.ts` carried its own copy of this arithmetic that read
  // BOTH operands with the local-time accessors (`getFullYear`/`getMonth`/
  // `getDate`) while the other two copies read UTC. Dates of birth are stored
  // at UTC midnight, so in a zone behind UTC the local reading pulls the DOB
  // back one calendar day and the birthday appears to land a day early — a
  // 17-year-old reads as ADULT for 24 hours, and the nightly job disagrees
  // with provisioning about the same user.
  //
  // Concretely: DOB 2008-03-15T00:00:00Z evaluated at 2026-03-14T20:00:00Z.
  // The user turns 18 on the 15th, so the answer is TEEN. Read in
  // America/Los_Angeles (UTC-7 on that date) the local accessors put both the
  // DOB and "now" on the 14th and the comparison yields ADULT.
  const DOB = new Date("2008-03-15T00:00:00.000Z");
  const NOW = new Date("2026-03-14T20:00:00.000Z");

  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it.each([
    "America/Los_Angeles", // behind UTC — the direction that mis-ages upward
    "Pacific/Kiritimati", // UTC+14 — the far side, mis-ages downward
    "UTC",
  ])("computes the same tier under TZ=%s as under UTC", (tz) => {
    process.env.TZ = tz;

    // Guard: if the runtime ignored the TZ change this assertion would pass
    // for the wrong reason, so prove the change took effect before relying on
    // it. (`UTC` is exempt — offset 0 is the expected result there.)
    if (tz !== "UTC") {
      expect(NOW.getTimezoneOffset()).not.toBe(0);
    }

    expect(computeAgeTier(DOB, NOW)).toBe("TEEN");
    expect(computeAgeYears(DOB, NOW)).toBe(17);
    expect(isUnderMinimumAge(DOB, NOW)).toBe(true);

    // One day later they are an adult, in every zone.
    const nextDay = new Date("2026-03-15T20:00:00.000Z");
    expect(computeAgeTier(DOB, nextDay)).toBe("ADULT");
    expect(isUnderMinimumAge(DOB, nextDay)).toBe(false);
  });

  it("is the same implementation everywhere it is used", () => {
    // The three call sites used to hold three copies. Identity, not just
    // agreement: a re-divergence should fail here rather than wait for a
    // date that happens to expose it.
    expect(transitionComputeAgeTier).toBe(computeAgeTier);
    expect(provisioningComputeAgeTier).toBe(computeAgeTier);
  });

  it("accepts an injected `now` so a batch pass can pin one instant", () => {
    const pinned = new Date("2030-01-01T00:00:00.000Z");
    // Both tier boundaries, on the day either side.
    expect(computeAgeTier(new Date("2017-01-02T00:00:00.000Z"), pinned)).toBe("CHILD"); // 12
    expect(computeAgeTier(new Date("2017-01-01T00:00:00.000Z"), pinned)).toBe("TEEN"); // 13
    expect(computeAgeTier(new Date("2012-01-02T00:00:00.000Z"), pinned)).toBe("TEEN"); // 17
    expect(computeAgeTier(new Date("2012-01-01T00:00:00.000Z"), pinned)).toBe("ADULT"); // 18
  });
});

describe("minimum age (18+ floor)", () => {
  const NOW = new Date("2026-09-04T12:00:00.000Z");

  it("states the minimum as 18", () => {
    expect(MINIMUM_SIGNUP_AGE_YEARS).toBe(18);
  });

  it("is under the minimum the day before the 18th birthday", () => {
    expect(isUnderMinimumAge(new Date("2008-09-05T00:00:00.000Z"), NOW)).toBe(true);
  });

  it("is not under the minimum on the 18th birthday itself", () => {
    expect(isUnderMinimumAge(new Date("2008-09-04T00:00:00.000Z"), NOW)).toBe(false);
  });

  it("agrees with the tier boundary — exactly the non-ADULT tiers are refused", () => {
    for (const yearsAgo of [0, 5, 12, 13, 17]) {
      const dob = new Date(Date.UTC(2026 - yearsAgo, 8, 4));
      expect(computeAgeTier(dob, NOW)).not.toBe("ADULT");
      expect(isUnderMinimumAge(dob, NOW)).toBe(true);
    }
    for (const yearsAgo of [18, 19, 40]) {
      const dob = new Date(Date.UTC(2026 - yearsAgo, 8, 4));
      expect(computeAgeTier(dob, NOW)).toBe("ADULT");
      expect(isUnderMinimumAge(dob, NOW)).toBe(false);
    }
  });

  it("carries a structured envelope with a remediation string", () => {
    expect(UNDER_MINIMUM_AGE_ERROR.error).toBe("AGE_REQUIREMENT_NOT_MET");
    expect(UNDER_MINIMUM_AGE_ERROR.message).toContain("18");
    expect(UNDER_MINIMUM_AGE_ERROR.remediation.length).toBeGreaterThan(0);
    expect(UNDER_MINIMUM_AGE_ERROR.field).toBe("dateOfBirth");
    expect(new UnderMinimumAgeError().envelope).toBe(UNDER_MINIMUM_AGE_ERROR);
  });
});

describe("resolveSessionAgeTier (quarantine choke point)", () => {
  it("has minor tiers switched off", () => {
    expect(MINOR_TIERS_SUPPORTED).toBe(false);
  });

  it.each(["CHILD", "TEEN", "ADULT"] as const)(
    "resolves a session claiming %s to ADULT",
    (claimed) => {
      expect(resolveSessionAgeTier(claimed)).toBe("ADULT");
    },
  );

  it("resolves an absent tier to ADULT", () => {
    expect(resolveSessionAgeTier(undefined)).toBe("ADULT");
    expect(resolveSessionAgeTier()).toBe("ADULT");
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
