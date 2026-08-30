/**
 * Session Configuration
 *
 * Provides configurable session timeout settings following security best practices.
 * Reads from environment variables with sensible defaults.
 */

import { getLogger, Logger } from "./logger.js";

export interface SessionConfig {
  /** Regular user session timeout in days (magic link authentication) */
  userSessionTimeoutDays: number;

  /** SSO session timeout in days (Microsoft Entra ID, SAML) */
  ssoSessionTimeoutDays: number;

  /** Dashboard/admin session timeout in hours (more secure) */
  dashboardSessionTimeoutHours: number;

  /** Session refresh threshold in hours (refresh when this much time remains) */
  refreshThresholdHours: number;

  /** Inactivity timeout in minutes (0 to disable) */
  inactivityTimeoutMinutes: number;
}

/**
 * Session Configuration Manager class
 *
 * Environment variables (with defaults):
 * - SESSION_USER_TIMEOUT_DAYS (default: 90)
 * - SESSION_SSO_TIMEOUT_DAYS (default: 7)
 * - SESSION_DASHBOARD_TIMEOUT_HOURS (default: 24)
 * - SESSION_REFRESH_THRESHOLD_HOURS (default: 1)
 * - SESSION_INACTIVITY_TIMEOUT_MINUTES (default: 60)
 */
export class SessionConfigManager {
  private config: SessionConfig;
  private logger: Logger;

  constructor(env: { [key: string]: any }) {
    this.logger = getLogger();
    this.config = this.loadConfig(env);
  }

  /**
   * Load session configuration from environment variables
   */
  private loadConfig(env: { [key: string]: any }): SessionConfig {
    // Parse SESSION_CONFIG JSON if provided (from config.yaml)
    let config: Partial<SessionConfig> = {};

    if (env.SESSION_CONFIG) {
      try {
        const parsed =
          typeof env.SESSION_CONFIG === "string"
            ? JSON.parse(env.SESSION_CONFIG)
            : env.SESSION_CONFIG;

        config = {
          userSessionTimeoutDays: parsed.USER_SESSION_TIMEOUT_DAYS,
          ssoSessionTimeoutDays: parsed.SSO_SESSION_TIMEOUT_DAYS,
          dashboardSessionTimeoutHours: parsed.DASHBOARD_SESSION_TIMEOUT_HOURS,
          refreshThresholdHours: parsed.REFRESH_THRESHOLD_HOURS,
          inactivityTimeoutMinutes: parsed.INACTIVITY_TIMEOUT_MINUTES,
        };
      } catch (e) {
        this.logger.warn(
          "[SessionConfig] Failed to parse SESSION_CONFIG, using defaults",
        );
      }
    }

    // Fall back to individual env vars, then defaults
    return {
      userSessionTimeoutDays: this.resolveTimeout(
        "userSessionTimeoutDays",
        config.userSessionTimeoutDays ?? env.SESSION_USER_TIMEOUT_DAYS,
        90,
      ),

      ssoSessionTimeoutDays: this.resolveTimeout(
        "ssoSessionTimeoutDays",
        config.ssoSessionTimeoutDays ?? env.SESSION_SSO_TIMEOUT_DAYS,
        7,
      ),

      dashboardSessionTimeoutHours: this.resolveTimeout(
        "dashboardSessionTimeoutHours",
        config.dashboardSessionTimeoutHours ??
          env.SESSION_DASHBOARD_TIMEOUT_HOURS,
        24,
      ),

      refreshThresholdHours: this.resolveTimeout(
        "refreshThresholdHours",
        config.refreshThresholdHours ?? env.SESSION_REFRESH_THRESHOLD_HOURS,
        1,
      ),

      inactivityTimeoutMinutes: this.resolveTimeout(
        "inactivityTimeoutMinutes",
        config.inactivityTimeoutMinutes ?? env.SESSION_INACTIVITY_TIMEOUT_MINUTES,
        60,
        { allowZero: true }, // 0 disables the inactivity timeout
      ),
    };
  }

  /**
   * Resolve one timeout value, failing CLOSED on garbage.
   *
   * The old code fed env values straight into `parseInt`, so a malformed
   * value became `NaN` — and every comparison against `NaN` is false, which
   * made `isSessionExpired` silently answer "not expired" forever. A config
   * typo must degrade to the safe default (loudly), never to unbounded
   * sessions.
   */
  private resolveTimeout(
    name: string,
    raw: unknown,
    fallback: number,
    opts: { allowZero?: boolean } = {},
  ): number {
    if (raw === undefined || raw === null || raw === "") {
      return fallback;
    }
    const value = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    const valid =
      Number.isFinite(value) && (opts.allowZero ? value >= 0 : value > 0);
    if (!valid) {
      this.logger.warn(
        `[SessionConfig] Invalid ${name} value; using default ${fallback}`,
        { rawValue: String(raw) },
      );
      return fallback;
    }
    return value;
  }

  /**
   * Get the current session configuration
   */
  getConfig(): SessionConfig {
    return this.config;
  }

  /**
   * Calculate session expiration timestamp
   */
  calculateSessionExpiration(
    sessionType: "user" | "sso" | "dashboard",
  ): number {
    const now = Date.now();

    switch (sessionType) {
      case "user":
        return now + this.config.userSessionTimeoutDays * 24 * 60 * 60 * 1000;
      case "sso":
        return now + this.config.ssoSessionTimeoutDays * 24 * 60 * 60 * 1000;
      case "dashboard":
        return now + this.config.dashboardSessionTimeoutHours * 60 * 60 * 1000;
      default:
        return now + this.config.userSessionTimeoutDays * 24 * 60 * 60 * 1000;
    }
  }

  /**
   * Calculate cookie max-age in seconds
   */
  calculateCookieMaxAge(sessionType: "user" | "sso" | "dashboard"): number {
    switch (sessionType) {
      case "user":
        return this.config.userSessionTimeoutDays * 24 * 60 * 60;
      case "sso":
        return this.config.ssoSessionTimeoutDays * 24 * 60 * 60;
      case "dashboard":
        return this.config.dashboardSessionTimeoutHours * 60 * 60;
      default:
        return this.config.userSessionTimeoutDays * 24 * 60 * 60;
    }
  }

  /**
   * Check if session should be refreshed
   */
  shouldRefreshSession(sessionExpiresAt: number): boolean {
    const now = Date.now();
    const timeUntilExpiration = sessionExpiresAt - now;
    const refreshThreshold = this.config.refreshThresholdHours * 60 * 60 * 1000;

    return timeUntilExpiration > 0 && timeUntilExpiration < refreshThreshold;
  }

  /**
   * Check if session is expired
   */
  isSessionExpired(sessionExpiresAt: number): boolean {
    return sessionExpiresAt < Date.now();
  }
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use new SessionConfigManager class instead
 */
export function getSessionConfig(env: { [key: string]: any }): SessionConfig {
  return new SessionConfigManager(env).getConfig();
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use new SessionConfigManager class instead
 */
export function calculateSessionExpiration(
  config: SessionConfig,
  sessionType: "user" | "sso" | "dashboard",
): number {
  const manager = new SessionConfigManager({});
  manager["config"] = config; // Set config directly for compatibility
  return manager.calculateSessionExpiration(sessionType);
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use new SessionConfigManager class instead
 */
export function calculateCookieMaxAge(
  config: SessionConfig,
  sessionType: "user" | "sso" | "dashboard",
): number {
  const manager = new SessionConfigManager({});
  manager["config"] = config; // Set config directly for compatibility
  return manager.calculateCookieMaxAge(sessionType);
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use new SessionConfigManager class instead
 */
export function shouldRefreshSession(
  sessionExpiresAt: number,
  config: SessionConfig,
): boolean {
  const manager = new SessionConfigManager({});
  manager["config"] = config; // Set config directly for compatibility
  return manager.shouldRefreshSession(sessionExpiresAt);
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use new SessionConfigManager class instead
 */
export function isSessionExpired(sessionExpiresAt: number): boolean {
  return sessionExpiresAt < Date.now();
}
