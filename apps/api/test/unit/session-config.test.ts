/**
 * Unit Tests: Session Config
 *
 * Comprehensive tests for SessionConfigManager including:
 * - Configuration loading from environment variables
 * - Default values
 * - JSON configuration parsing
 * - Session expiration calculations
 * - Cookie max-age calculations
 * - Session refresh logic
 * - Expiration checks
 * - Legacy function compatibility
 */

import { describe, expect, it, vi } from "vitest";
import {
  SessionConfigManager,
  calculateCookieMaxAge,
  calculateSessionExpiration,
  getSessionConfig,
  isSessionExpired,
  shouldRefreshSession,
  type SessionConfig,
} from "../../src/lib/session-config.js";

describe("SessionConfigManager", () => {
  describe("Configuration Loading", () => {
    it("should use default values when no env vars provided", () => {
      const manager = new SessionConfigManager({});
      const config = manager.getConfig();

      expect(config.userSessionTimeoutDays).toBe(90);
      expect(config.ssoSessionTimeoutDays).toBe(7);
      expect(config.dashboardSessionTimeoutHours).toBe(24);
      expect(config.refreshThresholdHours).toBe(1);
      expect(config.inactivityTimeoutMinutes).toBe(60);
    });

    it("should load configuration from individual env vars", () => {
      const env = {
        SESSION_USER_TIMEOUT_DAYS: "30",
        SESSION_SSO_TIMEOUT_DAYS: "14",
        SESSION_DASHBOARD_TIMEOUT_HOURS: "12",
        SESSION_REFRESH_THRESHOLD_HOURS: "2",
        SESSION_INACTIVITY_TIMEOUT_MINUTES: "30",
      };

      const manager = new SessionConfigManager(env);
      const config = manager.getConfig();

      expect(config.userSessionTimeoutDays).toBe(30);
      expect(config.ssoSessionTimeoutDays).toBe(14);
      expect(config.dashboardSessionTimeoutHours).toBe(12);
      expect(config.refreshThresholdHours).toBe(2);
      expect(config.inactivityTimeoutMinutes).toBe(30);
    });

    it("should load configuration from SESSION_CONFIG JSON string", () => {
      const env = {
        SESSION_CONFIG: JSON.stringify({
          USER_SESSION_TIMEOUT_DAYS: 60,
          SSO_SESSION_TIMEOUT_DAYS: 10, // Number, not string
          DASHBOARD_SESSION_TIMEOUT_HOURS: 48,
          REFRESH_THRESHOLD_HOURS: 3,
          INACTIVITY_TIMEOUT_MINUTES: 120,
        }),
      };

      const manager = new SessionConfigManager(env);
      const config = manager.getConfig();

      expect(config.userSessionTimeoutDays).toBe(60);
      expect(config.ssoSessionTimeoutDays).toBe(10);
      expect(config.dashboardSessionTimeoutHours).toBe(48);
      expect(config.refreshThresholdHours).toBe(3);
      expect(config.inactivityTimeoutMinutes).toBe(120);
    });

    it("should load configuration from SESSION_CONFIG object", () => {
      const env = {
        SESSION_CONFIG: {
          USER_SESSION_TIMEOUT_DAYS: 45,
          SSO_SESSION_TIMEOUT_DAYS: 5,
          DASHBOARD_SESSION_TIMEOUT_HOURS: 36,
          REFRESH_THRESHOLD_HOURS: 4,
          INACTIVITY_TIMEOUT_MINUTES: 90,
        },
      };

      const manager = new SessionConfigManager(env);
      const config = manager.getConfig();

      expect(config.userSessionTimeoutDays).toBe(45);
      expect(config.ssoSessionTimeoutDays).toBe(5);
      expect(config.dashboardSessionTimeoutHours).toBe(36);
      expect(config.refreshThresholdHours).toBe(4);
      expect(config.inactivityTimeoutMinutes).toBe(90);
    });

    it("should fall back to individual env vars when SESSION_CONFIG is invalid JSON", () => {
      const env = {
        SESSION_CONFIG: "invalid-json",
        SESSION_USER_TIMEOUT_DAYS: "30",
        SESSION_SSO_TIMEOUT_DAYS: "14",
      };

      const manager = new SessionConfigManager(env);
      const config = manager.getConfig();

      // Should use individual env vars as fallback
      expect(config.userSessionTimeoutDays).toBe(30);
      expect(config.ssoSessionTimeoutDays).toBe(14);
      // Should use defaults for others
      expect(config.dashboardSessionTimeoutHours).toBe(24);
    });

    it("should fall back to defaults when SESSION_CONFIG has missing fields", () => {
      const env = {
        SESSION_CONFIG: JSON.stringify({
          USER_SESSION_TIMEOUT_DAYS: 60,
          // Missing other fields
        }),
      };

      const manager = new SessionConfigManager(env);
      const config = manager.getConfig();

      expect(config.userSessionTimeoutDays).toBe(60);
      // Should use defaults for missing fields
      expect(config.ssoSessionTimeoutDays).toBe(7);
      expect(config.dashboardSessionTimeoutHours).toBe(24);
    });

    it("should prioritize SESSION_CONFIG over individual env vars", () => {
      const env = {
        SESSION_CONFIG: JSON.stringify({
          USER_SESSION_TIMEOUT_DAYS: 60,
        }),
        SESSION_USER_TIMEOUT_DAYS: "30", // Should be ignored
      };

      const manager = new SessionConfigManager(env);
      const config = manager.getConfig();

      expect(config.userSessionTimeoutDays).toBe(60);
    });

    it("should handle string numbers in env vars", () => {
      const env = {
        SESSION_USER_TIMEOUT_DAYS: "45",
        SESSION_SSO_TIMEOUT_DAYS: "10",
      };

      const manager = new SessionConfigManager(env);
      const config = manager.getConfig();

      expect(config.userSessionTimeoutDays).toBe(45);
      expect(config.ssoSessionTimeoutDays).toBe(10);
    });
  });

  describe("calculateSessionExpiration", () => {
    it("should calculate expiration for user session type", () => {
      const env = {
        SESSION_USER_TIMEOUT_DAYS: "30",
      };
      const manager = new SessionConfigManager(env);

      const before = Date.now();
      const expiration = manager.calculateSessionExpiration("user");
      const after = Date.now();

      const expected = before + 30 * 24 * 60 * 60 * 1000;
      expect(expiration).toBeGreaterThanOrEqual(expected - 100);
      expect(expiration).toBeLessThanOrEqual(after + 30 * 24 * 60 * 60 * 1000);
    });

    it("should calculate expiration for SSO session type", () => {
      const env = {
        SESSION_SSO_TIMEOUT_DAYS: "7",
      };
      const manager = new SessionConfigManager(env);

      const before = Date.now();
      const expiration = manager.calculateSessionExpiration("sso");
      const after = Date.now();

      const expected = before + 7 * 24 * 60 * 60 * 1000;
      expect(expiration).toBeGreaterThanOrEqual(expected - 100);
      expect(expiration).toBeLessThanOrEqual(after + 7 * 24 * 60 * 60 * 1000);
    });

    it("should calculate expiration for dashboard session type", () => {
      const env = {
        SESSION_DASHBOARD_TIMEOUT_HOURS: "12",
      };
      const manager = new SessionConfigManager(env);

      const before = Date.now();
      const expiration = manager.calculateSessionExpiration("dashboard");
      const after = Date.now();

      const expected = before + 12 * 60 * 60 * 1000;
      expect(expiration).toBeGreaterThanOrEqual(expected - 100);
      expect(expiration).toBeLessThanOrEqual(after + 12 * 60 * 60 * 1000);
    });

    it("should default to user session type for unknown type", () => {
      const manager = new SessionConfigManager({});
      const expiration = manager.calculateSessionExpiration("unknown" as any);

      const expected = Date.now() + 90 * 24 * 60 * 60 * 1000;
      expect(expiration).toBeGreaterThanOrEqual(expected - 1000);
      expect(expiration).toBeLessThanOrEqual(expected + 1000);
    });
  });

  describe("calculateCookieMaxAge", () => {
    it("should calculate max-age for user session type", () => {
      const env = {
        SESSION_USER_TIMEOUT_DAYS: "30",
      };
      const manager = new SessionConfigManager(env);

      const maxAge = manager.calculateCookieMaxAge("user");
      expect(maxAge).toBe(30 * 24 * 60 * 60); // 30 days in seconds
    });

    it("should calculate max-age for SSO session type", () => {
      const env = {
        SESSION_SSO_TIMEOUT_DAYS: "7",
      };
      const manager = new SessionConfigManager(env);

      const maxAge = manager.calculateCookieMaxAge("sso");
      expect(maxAge).toBe(7 * 24 * 60 * 60); // 7 days in seconds
    });

    it("should calculate max-age for dashboard session type", () => {
      const env = {
        SESSION_DASHBOARD_TIMEOUT_HOURS: "24",
      };
      const manager = new SessionConfigManager(env);

      const maxAge = manager.calculateCookieMaxAge("dashboard");
      expect(maxAge).toBe(24 * 60 * 60); // 24 hours in seconds
    });

    it("should default to user session type for unknown type", () => {
      const manager = new SessionConfigManager({});
      const maxAge = manager.calculateCookieMaxAge("unknown" as any);
      expect(maxAge).toBe(90 * 24 * 60 * 60); // Default 90 days
    });
  });

  describe("shouldRefreshSession", () => {
    it("should return true when session is within refresh threshold", () => {
      const env = {
        SESSION_REFRESH_THRESHOLD_HOURS: "1",
      };
      const manager = new SessionConfigManager(env);

      // Session expires in 30 minutes (within 1 hour threshold)
      const sessionExpiresAt = Date.now() + 30 * 60 * 1000;
      expect(manager.shouldRefreshSession(sessionExpiresAt)).toBe(true);
    });

    it("should return false when session is beyond refresh threshold", () => {
      const env = {
        SESSION_REFRESH_THRESHOLD_HOURS: "1",
      };
      const manager = new SessionConfigManager(env);

      // Session expires in 2 hours (beyond 1 hour threshold)
      const sessionExpiresAt = Date.now() + 2 * 60 * 60 * 1000;
      expect(manager.shouldRefreshSession(sessionExpiresAt)).toBe(false);
    });

    it("should return false when session is already expired", () => {
      const manager = new SessionConfigManager({});

      // Session expired 1 hour ago
      const sessionExpiresAt = Date.now() - 60 * 60 * 1000;
      expect(manager.shouldRefreshSession(sessionExpiresAt)).toBe(false);
    });

    it("should return false when session expires exactly at threshold", () => {
      const env = {
        SESSION_REFRESH_THRESHOLD_HOURS: "1",
      };
      const manager = new SessionConfigManager(env);

      // Session expires in exactly 1 hour (at threshold, not within)
      const sessionExpiresAt = Date.now() + 1 * 60 * 60 * 1000;
      expect(manager.shouldRefreshSession(sessionExpiresAt)).toBe(false);
    });

    it("should handle custom refresh threshold", () => {
      const env = {
        SESSION_REFRESH_THRESHOLD_HOURS: "2",
      };
      const manager = new SessionConfigManager(env);

      // Session expires in 90 minutes (within 2 hour threshold)
      const sessionExpiresAt = Date.now() + 90 * 60 * 1000;
      expect(manager.shouldRefreshSession(sessionExpiresAt)).toBe(true);
    });
  });

  describe("isSessionExpired", () => {
    it("should return false for future expiration", () => {
      const manager = new SessionConfigManager({});
      const sessionExpiresAt = Date.now() + 3600000; // 1 hour from now
      expect(manager.isSessionExpired(sessionExpiresAt)).toBe(false);
    });

    it("should return true for past expiration", () => {
      const manager = new SessionConfigManager({});
      const sessionExpiresAt = Date.now() - 3600000; // 1 hour ago
      expect(manager.isSessionExpired(sessionExpiresAt)).toBe(true);
    });

    it("should return true for current time expiration", () => {
      const manager = new SessionConfigManager({});
      // Use a time slightly in the past to account for execution time
      const sessionExpiresAt = Date.now() - 10;
      expect(manager.isSessionExpired(sessionExpiresAt)).toBe(true);
    });
  });

  describe("getConfig", () => {
    it("should return the current configuration", () => {
      const env = {
        SESSION_USER_TIMEOUT_DAYS: "30",
      };
      const manager = new SessionConfigManager(env);
      const config = manager.getConfig();

      expect(config).toBeDefined();
      expect(config.userSessionTimeoutDays).toBe(30);
      expect(typeof config).toBe("object");
    });

    it("should return the same configuration object", () => {
      const manager = new SessionConfigManager({});
      const config1 = manager.getConfig();
      const config2 = manager.getConfig();

      // getConfig returns the same object reference (not immutable)
      expect(config1).toBe(config2);
      expect(config1).toEqual(config2);
    });
  });
});

describe("Legacy Functions", () => {
  describe("getSessionConfig", () => {
    it("should return default configuration", () => {
      const config = getSessionConfig({});
      expect(config.userSessionTimeoutDays).toBe(90);
      expect(config.ssoSessionTimeoutDays).toBe(7);
    });

    it("should load from environment variables", () => {
      const env = {
        SESSION_USER_TIMEOUT_DAYS: "30",
      };
      const config = getSessionConfig(env);
      expect(config.userSessionTimeoutDays).toBe(30);
    });
  });

  describe("calculateSessionExpiration (legacy)", () => {
    it("should calculate expiration for user session", () => {
      const config: SessionConfig = {
        userSessionTimeoutDays: 30,
        ssoSessionTimeoutDays: 7,
        dashboardSessionTimeoutHours: 24,
        refreshThresholdHours: 1,
        inactivityTimeoutMinutes: 60,
      };

      const before = Date.now();
      const expiration = calculateSessionExpiration(config, "user");
      const after = Date.now();

      const expected = before + 30 * 24 * 60 * 60 * 1000;
      expect(expiration).toBeGreaterThanOrEqual(expected - 100);
      expect(expiration).toBeLessThanOrEqual(after + 30 * 24 * 60 * 60 * 1000);
    });

    it("should calculate expiration for SSO session", () => {
      const config: SessionConfig = {
        userSessionTimeoutDays: 90,
        ssoSessionTimeoutDays: 7,
        dashboardSessionTimeoutHours: 24,
        refreshThresholdHours: 1,
        inactivityTimeoutMinutes: 60,
      };

      const expiration = calculateSessionExpiration(config, "sso");
      const expected = Date.now() + 7 * 24 * 60 * 60 * 1000;
      expect(expiration).toBeGreaterThanOrEqual(expected - 1000);
      expect(expiration).toBeLessThanOrEqual(expected + 1000);
    });

    it("should calculate expiration for dashboard session", () => {
      const config: SessionConfig = {
        userSessionTimeoutDays: 90,
        ssoSessionTimeoutDays: 7,
        dashboardSessionTimeoutHours: 12,
        refreshThresholdHours: 1,
        inactivityTimeoutMinutes: 60,
      };

      const expiration = calculateSessionExpiration(config, "dashboard");
      const expected = Date.now() + 12 * 60 * 60 * 1000;
      expect(expiration).toBeGreaterThanOrEqual(expected - 1000);
      expect(expiration).toBeLessThanOrEqual(expected + 1000);
    });
  });

  describe("calculateCookieMaxAge (legacy)", () => {
    it("should calculate max-age for user session", () => {
      const config: SessionConfig = {
        userSessionTimeoutDays: 30,
        ssoSessionTimeoutDays: 7,
        dashboardSessionTimeoutHours: 24,
        refreshThresholdHours: 1,
        inactivityTimeoutMinutes: 60,
      };

      const maxAge = calculateCookieMaxAge(config, "user");
      expect(maxAge).toBe(30 * 24 * 60 * 60);
    });

    it("should calculate max-age for SSO session", () => {
      const config: SessionConfig = {
        userSessionTimeoutDays: 90,
        ssoSessionTimeoutDays: 14,
        dashboardSessionTimeoutHours: 24,
        refreshThresholdHours: 1,
        inactivityTimeoutMinutes: 60,
      };

      const maxAge = calculateCookieMaxAge(config, "sso");
      expect(maxAge).toBe(14 * 24 * 60 * 60);
    });

    it("should calculate max-age for dashboard session", () => {
      const config: SessionConfig = {
        userSessionTimeoutDays: 90,
        ssoSessionTimeoutDays: 7,
        dashboardSessionTimeoutHours: 48,
        refreshThresholdHours: 1,
        inactivityTimeoutMinutes: 60,
      };

      const maxAge = calculateCookieMaxAge(config, "dashboard");
      expect(maxAge).toBe(48 * 60 * 60);
    });
  });

  describe("shouldRefreshSession (legacy)", () => {
    it("should return true when within refresh threshold", () => {
      const config: SessionConfig = {
        userSessionTimeoutDays: 90,
        ssoSessionTimeoutDays: 7,
        dashboardSessionTimeoutHours: 24,
        refreshThresholdHours: 1,
        inactivityTimeoutMinutes: 60,
      };

      const sessionExpiresAt = Date.now() + 30 * 60 * 1000; // 30 minutes
      expect(shouldRefreshSession(sessionExpiresAt, config)).toBe(true);
    });

    it("should return false when beyond refresh threshold", () => {
      const config: SessionConfig = {
        userSessionTimeoutDays: 90,
        ssoSessionTimeoutDays: 7,
        dashboardSessionTimeoutHours: 24,
        refreshThresholdHours: 1,
        inactivityTimeoutMinutes: 60,
      };

      const sessionExpiresAt = Date.now() + 2 * 60 * 60 * 1000; // 2 hours
      expect(shouldRefreshSession(sessionExpiresAt, config)).toBe(false);
    });
  });

  describe("isSessionExpired (legacy)", () => {
    it("should return false for future expiration", () => {
      const sessionExpiresAt = Date.now() + 3600000;
      expect(isSessionExpired(sessionExpiresAt)).toBe(false);
    });

    it("should return true for past expiration", () => {
      const sessionExpiresAt = Date.now() - 3600000;
      expect(isSessionExpired(sessionExpiresAt)).toBe(true);
    });
  });
});
