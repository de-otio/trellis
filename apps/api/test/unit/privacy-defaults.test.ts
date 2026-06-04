/**
 * Unit Tests: Privacy Defaults
 *
 * Tests for age-tier privacy defaults, locked field enforcement, and field lock queries.
 */

import { describe, expect, it } from "vitest";
import {
  applyPrivacyLocks,
  getPrivacyDefaults,
  isFieldLocked,
  type PrivacySettings,
} from "../../src/lib/privacy-defaults.js";

describe("getPrivacyDefaults", () => {
  it("should return correct CHILD defaults", () => {
    const defaults = getPrivacyDefaults("CHILD");
    expect(defaults).toEqual({
      stealthMode: true,
      showOnlineStatus: false,
      showTypingIndicator: false,
      showLastSeen: false,
      locationTrackingEnabled: false,
      locationAnonymizationLevel: 3,
      analyticsOptOut: true,
      profileVisibility: "PRIVATE",
      dmAccess: "NOBODY",
    });
  });

  it("should return correct TEEN defaults", () => {
    const defaults = getPrivacyDefaults("TEEN");
    expect(defaults).toEqual({
      stealthMode: false,
      showOnlineStatus: false,
      showTypingIndicator: true,
      showLastSeen: false,
      locationTrackingEnabled: false,
      locationAnonymizationLevel: 2,
      analyticsOptOut: true,
      profileVisibility: "CONNECTIONS",
      dmAccess: "CONNECTIONS",
    });
  });

  it("should return correct ADULT defaults", () => {
    const defaults = getPrivacyDefaults("ADULT");
    expect(defaults).toEqual({
      stealthMode: false,
      showOnlineStatus: true,
      showTypingIndicator: true,
      showLastSeen: true,
      locationTrackingEnabled: false,
      locationAnonymizationLevel: 0,
      analyticsOptOut: false,
      profileVisibility: "PUBLIC",
      dmAccess: "CONNECTIONS",
    });
  });
});

describe("applyPrivacyLocks", () => {
  it("should enforce CHILD locked fields (locationTrackingEnabled=true reverted to false)", () => {
    const settings: PrivacySettings = {
      ...getPrivacyDefaults("CHILD"),
      locationTrackingEnabled: true, // attempt to override locked field
    };

    const result = applyPrivacyLocks(settings, "CHILD");
    expect(result.locationTrackingEnabled).toBe(false);
  });

  it("should enforce CHILD locked fields (dmAccess=ANYONE reverted to NOBODY)", () => {
    const settings: PrivacySettings = {
      ...getPrivacyDefaults("CHILD"),
      dmAccess: "ANYONE", // attempt to override locked field
    };

    const result = applyPrivacyLocks(settings, "CHILD");
    expect(result.dmAccess).toBe("NOBODY");
  });

  it("should allow CHILD unlocked fields to pass through (showOnlineStatus=true kept)", () => {
    const settings: PrivacySettings = {
      ...getPrivacyDefaults("CHILD"),
      showOnlineStatus: true, // not a locked field, just a default
    };

    const result = applyPrivacyLocks(settings, "CHILD");
    expect(result.showOnlineStatus).toBe(true);
  });

  it("should not lock any fields for ADULT (all fields pass through)", () => {
    const settings: PrivacySettings = {
      stealthMode: true,
      showOnlineStatus: false,
      showTypingIndicator: false,
      showLastSeen: false,
      locationTrackingEnabled: true,
      locationAnonymizationLevel: 3,
      analyticsOptOut: true,
      profileVisibility: "PRIVATE",
      dmAccess: "NOBODY",
    };

    const result = applyPrivacyLocks(settings, "ADULT");
    expect(result).toEqual(settings);
  });

  it("should enforce CHILD analyticsOptOut locked to true", () => {
    const settings: PrivacySettings = {
      ...getPrivacyDefaults("CHILD"),
      analyticsOptOut: false, // attempt to override locked field
    };

    const result = applyPrivacyLocks(settings, "CHILD");
    expect(result.analyticsOptOut).toBe(true);
  });

  it("should enforce CHILD locationAnonymizationLevel locked to 3", () => {
    const settings: PrivacySettings = {
      ...getPrivacyDefaults("CHILD"),
      locationAnonymizationLevel: 0, // attempt to override locked field
    };

    const result = applyPrivacyLocks(settings, "CHILD");
    expect(result.locationAnonymizationLevel).toBe(3);
  });
});

describe("isFieldLocked", () => {
  it("should return true for locationTrackingEnabled for CHILD", () => {
    expect(isFieldLocked("locationTrackingEnabled", "CHILD")).toBe(true);
  });

  it("should return false for locationTrackingEnabled for ADULT", () => {
    expect(isFieldLocked("locationTrackingEnabled", "ADULT")).toBe(false);
  });

  it("should return true for dmAccess for CHILD", () => {
    expect(isFieldLocked("dmAccess", "CHILD")).toBe(true);
  });

  it("should return true for analyticsOptOut for CHILD", () => {
    expect(isFieldLocked("analyticsOptOut", "CHILD")).toBe(true);
  });

  it("should return false for stealthMode for CHILD (not locked, just defaulted)", () => {
    expect(isFieldLocked("stealthMode", "CHILD")).toBe(false);
  });

  it("should return false for all fields for TEEN", () => {
    const fields: (keyof PrivacySettings)[] = [
      "stealthMode",
      "showOnlineStatus",
      "showTypingIndicator",
      "showLastSeen",
      "locationTrackingEnabled",
      "locationAnonymizationLevel",
      "analyticsOptOut",
      "profileVisibility",
      "dmAccess",
    ];

    for (const field of fields) {
      expect(isFieldLocked(field, "TEEN")).toBe(false);
    }
  });
});
