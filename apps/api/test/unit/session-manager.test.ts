/**
 * Unit Tests: Session Manager
 *
 * Comprehensive tests for SessionManager including:
 * - Session encryption/decryption
 * - Session retrieval from cookies
 * - Session expiration and inactivity timeout
 * - Legacy session handling
 * - Secret rotation (fallback secret)
 * - Cookie parsing edge cases
 * - Session setting and clearing
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type Session } from "../../src/lib/session-cookie.js";

// Mock Cognito JWT verification (the Bearer-token auth strategy).
const { mockVerifyCognitoJwt } = vi.hoisted(() => ({
  mockVerifyCognitoJwt: vi.fn(),
}));
vi.mock("../../src/lib/auth/cognito-jwt", () => ({
  verifyCognitoJwt: mockVerifyCognitoJwt,
  verifyLegacyCognitoClaims: mockVerifyCognitoJwt,
}));

// Mock session-config - simple mock that returns default config
vi.mock("../../src/lib/session-config", () => ({
  getSessionConfig: (env: any) => ({
    userSessionTimeoutDays: 90,
    ssoSessionTimeoutDays: 7,
    dashboardSessionTimeoutHours: 24,
    refreshThresholdHours: 1,
    inactivityTimeoutMinutes: 60,
  }),
  calculateCookieMaxAge: (config: any, sessionType: string) => {
    switch (sessionType) {
      case "user":
        return 90 * 24 * 60 * 60;
      case "sso":
        return 7 * 24 * 60 * 60;
      case "dashboard":
        return 24 * 60 * 60;
      default:
        return 90 * 24 * 60 * 60;
    }
  },
}));

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  const testSecret = "test-secret-key-32-characters-long!!";
  const testSalt = "test-session-salt-for-unit-tests";
  const testEnv: any = { SESSION_SALT: testSalt };

  beforeEach(() => {
    sessionManager = new SessionManager();
    vi.clearAllMocks();
  });

  describe("encryptSession / decryptSession", () => {
    it("should encrypt and decrypt session data successfully", async () => {
      const sessionData = JSON.stringify({
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      });

      const encrypted = await sessionManager.encryptSession(
        sessionData,
        testSecret,
        testSalt,
      );
      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe("string");
      expect(encrypted.length).toBeGreaterThan(0);

      const decrypted = await sessionManager.decryptSession(
        encrypted,
        testSecret,
        testSalt,
      );
      expect(decrypted).toBe(sessionData);
    });

    it("should fail to decrypt with wrong secret", async () => {
      const sessionData = JSON.stringify({
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      });

      const encrypted = await sessionManager.encryptSession(
        sessionData,
        testSecret,
        testSalt,
      );
      const decrypted = await sessionManager.decryptSession(
        encrypted,
        "wrong-secret",
        testSalt,
      );
      expect(decrypted).toBeNull();
    });

    it("should handle corrupted encrypted data", async () => {
      const decrypted = await sessionManager.decryptSession(
        "invalid-encrypted-data",
        testSecret,
        testSalt,
      );
      expect(decrypted).toBeNull();
    });

    it("should handle empty encrypted data", async () => {
      const decrypted = await sessionManager.decryptSession("", testSecret, testSalt);
      expect(decrypted).toBeNull();
    });

    it("should use custom salt when provided", async () => {
      const sessionData = JSON.stringify({
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      });

      // Salts must be >= 16 chars (foundation MIN_SALT_LENGTH).
      const saltA = "custom-salt-alpha-0001";
      const saltB = "custom-salt-bravo-0002";
      const encrypted1 = await sessionManager.encryptSession(
        sessionData,
        testSecret,
        saltA,
      );
      const encrypted2 = await sessionManager.encryptSession(
        sessionData,
        testSecret,
        saltB,
      );

      // Different salts should produce different encrypted values
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt correctly with their respective salts
      const decrypted1 = await sessionManager.decryptSession(
        encrypted1,
        testSecret,
        saltA,
      );
      const decrypted2 = await sessionManager.decryptSession(
        encrypted2,
        testSecret,
        saltB,
      );
      expect(decrypted1).toBe(sessionData);
      expect(decrypted2).toBe(sessionData);
    });
  });

  describe("getSession", () => {
    const bearerReq = (token = "h.cA.s") =>
      new Request("https://example.com/api/test", {
        headers: { Authorization: `Bearer ${token}` },
      });

    it("JWT Bearer: session.userId is the cuid in custom:userId, not the Cognito sub", async () => {
      // Regression (media uploads "Tenant resolution failed"): DB User.id is a
      // cuid and handlers look up the session user via where:{id:session.userId};
      // the media routes authenticate via THIS getSession Bearer path.
      mockVerifyCognitoJwt.mockResolvedValue({
        sub: "23643892-00c1-7057-551c-aed44aed1f13", // Cognito sub (UUID)
        "custom:userId": "cmqurmq7x000002i80nqmgfr8", // DB User.id (cuid)
        email: "user@example.com",
        username: "user@example.com",
      });

      const session = await sessionManager.getSession(bearerReq(), testSecret, testEnv);

      expect(session?.userId).toBe("cmqurmq7x000002i80nqmgfr8");
    });

    it("JWT Bearer: falls back to sub when custom:userId is absent (legacy tokens)", async () => {
      mockVerifyCognitoJwt.mockResolvedValue({
        sub: "legacy-sub-123",
        email: "legacy@example.com",
        username: "legacy@example.com",
      });

      const session = await sessionManager.getSession(bearerReq(), testSecret, testEnv);

      expect(session?.userId).toBe("legacy-sub-123");
    });

    it("should return null for missing Cookie header", async () => {
      const request = new Request("https://example.com/api/test", {
        method: "GET",
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session).toBeNull();
    });

    it("should return null for missing session cookie", async () => {
      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: "other-cookie=value",
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session).toBeNull();
    });

    it("should return null for invalid secret", async () => {
      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: "trellis_session=encrypted-data",
        },
      });

      const session = await sessionManager.getSession(request, "", testEnv);
      expect(session).toBeNull();
    });

    it("should retrieve valid session from cookie", async () => {
      const sessionData: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session).not.toBeNull();
      expect(session?.userId).toBe(sessionData.userId);
      expect(session?.email).toBe(sessionData.email);
    });

    it("should return null for expired session", async () => {
      const expiredSession: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() - 1000, // Expired
        profileContext: "primary",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(expiredSession),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session).toBeNull();
    });

    it("should handle session with lastActivityAt field", async () => {
      // Test that sessions with lastActivityAt can be retrieved
      // Note: Inactivity timeout checking requires session-config via require()
      // So we test without env to avoid that complexity
      const sessionData: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        lastActivityAt: Date.now() - 30 * 60 * 1000, // 30 minutes ago
        profileContext: "primary",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      // Pass minimal env with SESSION_SALT (required for decryption)
      const session = await sessionManager.getSession(request, testSecret, testEnv);
      // Session should be valid
      expect(session).not.toBeNull();
      expect(session?.userId).toBe("test-user-123");
      expect(session?.lastActivityAt).toBeDefined();
    });

    it("should update lastActivityAt on successful retrieval", async () => {
      const oldActivityTime = Date.now() - 1000;
      const sessionData: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        lastActivityAt: oldActivityTime,
        profileContext: "primary",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      // Pass minimal env with SESSION_SALT (required for decryption)
      const session = await sessionManager.getSession(request, testSecret, testEnv);

      // Session should be retrieved successfully (without inactivity check)
      expect(session).not.toBeNull();
      if (session) {
        expect(session.lastActivityAt).toBeDefined();
        expect(session.lastActivityAt).toBeGreaterThan(oldActivityTime);
      }
    });

    it("should detect legacy session cookie", async () => {
      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: "session=legacy-cookie-value",
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session).toBeNull();
      expect(sessionManager.hadLegacySessionCookie).toBe(true);
    });

    it("should detect invalid session structure (missing userId)", async () => {
      const invalidSession = {
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(invalidSession),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session).toBeNull();
      expect(sessionManager.hadInvalidSessionCookie).toBe(true);
    });

    it("should detect legacy BlueSky session", async () => {
      const legacySession = {
        did: "did:plc:test",
        handle: "test.bsky.social",
        accessJwt: "token",
        refreshJwt: "refresh",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(legacySession),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session).toBeNull();
      expect(sessionManager.hadInvalidSessionCookie).toBe(true);
    });

    it("should try fallback secret when primary fails", async () => {
      const fallbackSecret = "fallback-secret-key-32-characters-long!!";
      // Inject fallback into env so session-cookie can read env.SESSION_SECRET_FALLBACK
      const envWithFallback = { ...testEnv, SESSION_SECRET_FALLBACK: fallbackSecret };

      const sessionData: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      // Encrypt with fallback secret
      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        fallbackSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      // Primary secret fails; session-cookie reads SESSION_SECRET_FALLBACK from env
      const session = await sessionManager.getSession(
        request,
        testSecret,
        envWithFallback,
      );
      expect(session).not.toBeNull();
      expect(session?.userId).toBe(sessionData.userId);
    });

    it("should handle malformed cookies gracefully", async () => {
      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: "malformed=cookie=value; another; =empty",
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session).toBeNull();
    });

    it("should handle URL-encoded cookies", async () => {
      const sessionData: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      // URL encode the cookie value
      const encodedCookie = encodeURIComponent(encrypted);

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encodedCookie}`,
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session).not.toBeNull();
      expect(session?.userId).toBe(sessionData.userId);
    });
  });

  describe("setSession", () => {
    it("should set session cookie in response", async () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const response = new Response("OK", { status: 200 });
      const result = await sessionManager.setSession(
        response,
        session,
        testSecret,
        undefined,
        testEnv,
      );

      const setCookieHeader = result.headers.get("Set-Cookie");
      expect(setCookieHeader).toBeDefined();
      expect(setCookieHeader).toContain("trellis_session=");
      expect(setCookieHeader).toContain("HttpOnly");
      expect(setCookieHeader).toContain("Secure");
      expect(setCookieHeader).toContain("Path=/");
    });

    it("should set cookie domain when provided", async () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const response = new Response("OK", { status: 200 });
      const result = await sessionManager.setSession(
        response,
        session,
        testSecret,
        ".example.com",
        testEnv,
      );

      const setCookieHeader = result.headers.get("Set-Cookie");
      expect(setCookieHeader).toContain("Domain=.example.com");
    });

    it("should use SameSite=Lax for localhost", async () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const response = new Response("OK", { status: 200 });
      const result = await sessionManager.setSession(
        response,
        session,
        testSecret,
        "", // Empty domain = localhost
        testEnv,
      );

      const setCookieHeader = result.headers.get("Set-Cookie");
      expect(setCookieHeader).toContain("SameSite=Lax");
      expect(setCookieHeader).not.toContain("SameSite=None");
    });

    it("should use SameSite=None; Secure for production domain", async () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const response = new Response("OK", { status: 200 });
      const result = await sessionManager.setSession(
        response,
        session,
        testSecret,
        ".example.com",
        testEnv,
      );

      const setCookieHeader = result.headers.get("Set-Cookie");
      expect(setCookieHeader).toContain("SameSite=None");
      expect(setCookieHeader).toContain("Secure");
    });

    it("should set cookie with max-age", async () => {
      const userSession: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        sessionType: "user",
        profileContext: "primary",
      };

      const response = new Response("OK", { status: 200 });
      // Don't pass env to avoid require() call
      const result = await sessionManager.setSession(
        response,
        userSession,
        testSecret,
        undefined,
        testEnv,
      );

      const setCookieHeader = result.headers.get("Set-Cookie");
      expect(setCookieHeader).toBeDefined();
      expect(setCookieHeader).toContain("Max-Age=");
      // Should have a valid max-age value
      const maxAgeMatch = setCookieHeader?.match(/Max-Age=(\d+)/);
      expect(maxAgeMatch).not.toBeNull();
      if (maxAgeMatch) {
        expect(parseInt(maxAgeMatch[1], 10)).toBeGreaterThan(0);
      }
    });

    it("should use setSessionCookie alias", async () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const response = new Response("OK", { status: 200 });
      const result = await sessionManager.setSessionCookie(
        response,
        session,
        testSecret,
        undefined,
        testEnv,
      );

      const setCookieHeader = result.headers.get("Set-Cookie");
      expect(setCookieHeader).toBeDefined();
      expect(setCookieHeader).toContain("trellis_session=");
    });
  });

  describe("clearSession", () => {
    it("should clear session cookie", () => {
      const response = new Response("OK", { status: 200 });
      const result = sessionManager.clearSession(response);

      const setCookieHeaders = result.headers.getSetCookie();
      expect(setCookieHeaders.length).toBeGreaterThan(0);

      // Should clear with both SameSite=None and SameSite=Lax
      const cookieHeaders = setCookieHeaders.join("; ");
      expect(cookieHeaders).toContain("trellis_session=");
      expect(cookieHeaders).toContain("Max-Age=0");
      expect(cookieHeaders).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    });

    it("should clear session cookie with domain", () => {
      const response = new Response("OK", { status: 200 });
      const result = sessionManager.clearSession(response, ".example.com");

      const setCookieHeaders = result.headers.getSetCookie();
      const cookieHeaders = setCookieHeaders.join("; ");
      expect(cookieHeaders).toContain("Domain=.example.com");
    });

    it("should clear legacy session cookie", () => {
      const response = new Response("OK", { status: 200 });
      const result = sessionManager.clearSession(response);

      const setCookieHeaders = result.headers.getSetCookie();
      const cookieHeaders = setCookieHeaders.join("; ");
      expect(cookieHeaders).toContain("session=");
    });

    it("should use clearSessionCookie alias", () => {
      const response = new Response("OK", { status: 200 });
      const result = sessionManager.clearSessionCookie(response);

      const setCookieHeaders = result.headers.getSetCookie();
      expect(setCookieHeaders.length).toBeGreaterThan(0);
    });
  });

  describe("Session with role and metadata", () => {
    it("should handle session with role", async () => {
      const sessionData: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        role: "INTERNAL",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session?.role).toBe("INTERNAL");
    });

    it("should handle session with CSRF token", async () => {
      const sessionData: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        csrfToken: "csrf-token-123",
        profileContext: "primary",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session?.csrfToken).toBe("csrf-token-123");
    });

    it("should handle session with user region", async () => {
      const sessionData: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        userRegion: "EU",
        profileContext: "primary",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session?.userRegion).toBe("EU");
    });
  });

  describe("Border Safety Mode - Profile Context", () => {
    it("should handle session with profileContext primary", async () => {
      const sessionData: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session?.profileContext).toBe("primary");
    });

    it("should handle session with profileContext decoy", async () => {
      const sessionData: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "decoy",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session?.profileContext).toBe("decoy");
    });

    it("should handle session with contextId", async () => {
      const sessionData: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
        contextId: "context-123",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session?.contextId).toBe("context-123");
    });

    it("should handle session without contextId (optional field)", async () => {
      const sessionData: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
        // No contextId (optional field)
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(session?.contextId).toBeUndefined();
    });
  });

  describe("SESSION_SALT consistency (salt mismatch bug)", () => {
    // Regression test for the bug where sessions encrypted with salt
    // could not be decrypted when env was not passed to getSession().
    // getSession(request, secret) without env => salt is undefined => decryption fails.

    it("should decrypt session when env with SESSION_SALT is passed", async () => {
      const session: Session = {
        userId: "salt-test-user",
        email: "salt@test.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
        dataRegion: "EU",
        profileContext: "primary",
      };

      // Encrypt with salt (as setSession does)
      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(session),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      // Decrypt WITH env (correct — salt matches)
      const decrypted = await sessionManager.getSession(
        request,
        testSecret,
        testEnv,
      );
      expect(decrypted).not.toBeNull();
      expect(decrypted?.userId).toBe("salt-test-user");
    });

    it("should fail to decrypt salt-encrypted session when env is omitted", async () => {
      const session: Session = {
        userId: "salt-test-user",
        email: "salt@test.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
        dataRegion: "EU",
        profileContext: "primary",
      };

      // Encrypt with salt
      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(session),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        headers: {
          Cookie: `trellis_session=${encrypted}`,
        },
      });

      // Decrypt WITHOUT env (bug — salt is undefined, decryption fails)
      const decrypted = await sessionManager.getSession(
        request,
        testSecret,
        // no env — salt will be undefined
      );
      expect(decrypted).toBeNull();
    });

    it("should require salt for encryption (salt is mandatory)", async () => {
      // Salt is required — encrypting without it should throw
      await expect(
        sessionManager.encryptSession(
          JSON.stringify({
            userId: "no-salt-user",
            email: "nosalt@test.com",
            role: "END_USER",
            expiresAt: Date.now() + 3600000,
            dataRegion: "EU",
            profileContext: "primary",
          }),
          testSecret,
          // no salt
        ),
      ).rejects.toThrow("SESSION_SALT");
    });
  });
});
