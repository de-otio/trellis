/**
 * CSRF Protection
 *
 * Provides CSRF token generation and validation to prevent Cross-Site Request Forgery attacks.
 * Uses Double Submit Cookie pattern: token stored in encrypted session cookie and validated
 * against X-CSRF-Token header.
 *
 * Fallback: If KV is configured, can also validate against KV (for migration/transition period).
 */

import type { Env } from "../env.js";
import type { Session } from "./session-cookie.js";

/**
 * CSRF Protection utility class
 */
export class CSRFProtection {
  private env?: Env;

  constructor(env?: Env) {
    this.env = env;
  }

  /**
   * Generate a secure random CSRF token
   * Uses crypto.randomUUID() for secure token generation
   */
  generateToken(): string {
    return crypto.randomUUID();
  }

  /**
   * Static convenience method for generating tokens (backward compatibility)
   * @deprecated Use instance method instead: new CSRFProtection().generateToken()
   */
  static generateToken(): string {
    return new CSRFProtection().generateToken();
  }

  /**
   * Validate a CSRF token using Double Submit Cookie pattern
   *
   * Primary method: Validates token from session cookie against header token
   * Fallback: If KV is configured and session doesn't have token, validates against KV
   *
   * @param token - The CSRF token from the request header (X-CSRF-Token)
   * @param session - The user's session (contains csrfToken if available)
   * @param env - Optional environment (for KV fallback)
   * @returns true if token is valid, false otherwise
   */
  async validateToken(
    token: string,
    session: Session | null,
    env?: Env,
  ): Promise<boolean> {
    if (!token) {
      return false;
    }

    // Use provided env or instance env
    const effectiveEnv = env || this.env;

    // Primary method: Double Submit Cookie pattern (token in session)
    if (session?.csrfToken) {
      // Use constant-time comparison to prevent timing attacks
      const isValid = this.constantTimeCompare(token, session.csrfToken);

      // If token is valid but older than 24 hours, flag it for rotation
      if (isValid && session.csrfTokenCreatedAt) {
        const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
        if (Date.now() - session.csrfTokenCreatedAt > TWENTY_FOUR_HOURS_MS) {
          session.csrfTokenNeedsRotation = true;
        }
      }

      return isValid;
    }

    // Fallback: KV storage (for migration/transition period)
    if (effectiveEnv?.CSRF_TOKENS_KV && session?.userId) {
      const storedToken = await effectiveEnv.CSRF_TOKENS_KV.get(
        `csrf:${session.userId}`,
        "text",
      );

      if (!storedToken) {
        return false;
      }

      return this.constantTimeCompare(token, storedToken);
    }

    // No session or token - invalid
    return false;
  }

  /**
   * Static method for validating tokens (for convenience and testing)
   * Creates a temporary instance to perform validation
   */
  static async validateToken(
    token: string,
    session: Session | null,
    env?: Env,
  ): Promise<boolean> {
    const instance = new CSRFProtection(env);
    return instance.validateToken(token, session, env);
  }

  /**
   * Store a CSRF token in session (Double Submit Cookie pattern)
   *
   * The token is included in the session object and will be stored in the encrypted
   * session cookie. No separate storage is needed.
   *
   * @param token - The CSRF token to include in session
   * @param session - The session object to update
   * @returns Updated session with csrfToken and csrfTokenCreatedAt
   */
  storeTokenInSession(token: string, session: Session): Session {
    return {
      ...session,
      csrfToken: token,
      csrfTokenCreatedAt: Date.now(),
      csrfTokenNeedsRotation: false,
    };
  }

  /**
   * Store a CSRF token in KV (legacy/fallback method)
   *
   * @deprecated Use storeTokenInSession instead. This method is kept for migration/fallback.
   *
   * @param token - The CSRF token to store
   * @param sessionId - The user's session ID (userId from session)
   * @param ttl - Time to live in seconds (default: 3600 = 1 hour)
   */
  async storeTokenInKV(
    token: string,
    sessionId: string,
    ttl: number = 3600,
  ): Promise<void> {
    if (!this.env?.CSRF_TOKENS_KV) {
      return; // Silently skip if KV not available
    }

    await this.env.CSRF_TOKENS_KV.put(`csrf:${sessionId}`, token, {
      expirationTtl: ttl,
    });
  }

  /**
   * Remove CSRF token from session
   * Useful for logout or token invalidation
   *
   * @param session - The session object to update
   * @returns Updated session without csrfToken
   */
  removeTokenFromSession(session: Session): Session {
    const { csrfToken, ...sessionWithoutToken } = session;
    return sessionWithoutToken;
  }

  /**
   * Delete a CSRF token from KV (legacy/fallback method)
   *
   * @deprecated Use removeTokenFromSession instead. This method is kept for migration/fallback.
   *
   * @param sessionId - The user's session ID
   */
  async deleteTokenFromKV(sessionId: string): Promise<void> {
    if (!this.env?.CSRF_TOKENS_KV) {
      return;
    }

    await this.env.CSRF_TOKENS_KV.delete(`csrf:${sessionId}`);
  }

  /**
   * Constant-time string comparison to prevent timing attacks
   *
   * @param a - First string
   * @param b - Second string
   * @returns true if strings are equal, false otherwise
   */
  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }

    return result === 0;
  }

  static storeTokenInSession(token: string, session: Session): Session {
    return new CSRFProtection().storeTokenInSession(token, session);
  }

  static async storeTokenInKV(
    token: string,
    sessionId: string,
    env: Env,
    ttl: number = 3600,
  ): Promise<void> {
    return new CSRFProtection(env).storeTokenInKV(token, sessionId, ttl);
  }

  static removeTokenFromSession(session: Session): Session {
    return new CSRFProtection().removeTokenFromSession(session);
  }

  static async deleteTokenFromKV(sessionId: string, env: Env): Promise<void> {
    return new CSRFProtection(env).deleteTokenFromKV(sessionId);
  }
}
