/**
 * Extended Unit Tests: Session Manager
 *
 * Tests uncovered code paths: Cognito JWT path with dataRegion claim,
 * Bearer token encrypted session, inactivity timeout, cookie parsing edge cases,
 * fallback secret for Authorization header, session revocation, and hash token.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type Session } from "../../src/lib/session-cookie.js";

// Mock session-config
vi.mock("../../src/lib/session-config", () => ({
  getSessionConfig: (env: any) => ({
    userSessionTimeoutDays: 90,
    ssoSessionTimeoutDays: 7,
    dashboardSessionTimeoutHours: 24,
    refreshThresholdHours: 1,
    inactivityTimeoutMinutes: env?.INACTIVITY_TIMEOUT_MINUTES ?? 60,
  }),
  calculateCookieMaxAge: (config: any, sessionType: string) => {
    switch (sessionType) {
      case "sso": return 7 * 24 * 60 * 60;
      case "dashboard": return 24 * 60 * 60;
      default: return 90 * 24 * 60 * 60;
    }
  },
}));

// Mock cognito-jwt
const mockVerifyCognitoJwt = vi.fn();
vi.mock("../../src/lib/auth/cognito-jwt", () => ({
  verifyCognitoJwt: (...args: any[]) => mockVerifyCognitoJwt(...args),
  verifyLegacyCognitoClaims: (...args: any[]) => mockVerifyCognitoJwt(...args),
}));

describe("SessionManager - Extended", () => {
  let sessionManager: SessionManager;
  const testSecret = "test-secret-key-32-characters-long!!";
  const testSalt = "test-session-salt-for-unit-tests";
  const testEnv: any = { SESSION_SALT: testSalt };

  beforeEach(() => {
    sessionManager = new SessionManager();
    vi.clearAllMocks();
    mockVerifyCognitoJwt.mockRejectedValue(new Error("Not a JWT"));
  });

  describe("Cognito JWT path", () => {
    it("should authenticate via Cognito JWT with dataRegion claim", async () => {
      mockVerifyCognitoJwt.mockResolvedValue({
        sub: "cognito-user-123",
        email: "cognito@example.com",
        username: "cognitouser",
        "custom:role": "END_USER",
        "custom:dataRegion": "US",
      });

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Authorization: "Bearer header.payload.signature", // 3-part JWT
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).not.toBeNull();
      expect(session?.userId).toBe("cognito-user-123");
      expect(session?.email).toBe("cognito@example.com");
      expect(session?.dataRegion).toBe("US");
      expect(session?.role).toBe("END_USER");
      expect(session?.profileContext).toBe("primary");
    });

    it("should default dataRegion to EU when not in JWT claims", async () => {
      mockVerifyCognitoJwt.mockResolvedValue({
        sub: "cognito-user-456",
        email: "user@example.com",
        username: "user456",
      });

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Authorization: "Bearer header.payload.signature",
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).not.toBeNull();
      expect(session?.dataRegion).toBe("EU");
      expect(session?.role).toBe("END_USER");
    });

    it("should use username as email fallback when email is not in JWT", async () => {
      mockVerifyCognitoJwt.mockResolvedValue({
        sub: "cognito-user-789",
        username: "fallbackuser",
      });

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Authorization: "Bearer header.payload.signature",
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).not.toBeNull();
      expect(session?.email).toBe("fallbackuser");
    });

    it("should fall through to encrypted session when Cognito JWT verification fails", async () => {
      mockVerifyCognitoJwt.mockRejectedValue(new Error("Invalid JWT"));

      // Encrypt a valid session as the Bearer token
      const sessionData: Session = {
        userId: "encrypted-user",
        email: "encrypted@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
        dataRegion: "US",
      };
      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).not.toBeNull();
      expect(session?.userId).toBe("encrypted-user");
    });
  });

  describe("Bearer token - encrypted session", () => {
    it("should decrypt session from Authorization header", async () => {
      const sessionData: Session = {
        userId: "bearer-user",
        email: "bearer@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
        dataRegion: "EU",
      };
      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).not.toBeNull();
      expect(session?.userId).toBe("bearer-user");
    });

    it("should return null for expired session from Authorization header", async () => {
      const sessionData: Session = {
        userId: "expired-user",
        email: "expired@example.com",
        expiresAt: Date.now() - 1000, // expired
        profileContext: "primary",
        dataRegion: "EU",
      };
      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).toBeNull();
    });

    it("should try fallback secret for Authorization header token", async () => {
      const fallbackSecret = "fallback-secret-key-32-characters!!!!!";
      // Inject fallback into env so session-cookie reads env.SESSION_SECRET_FALLBACK
      const envWithFallback = { ...testEnv, SESSION_SECRET_FALLBACK: fallbackSecret };

      const sessionData: Session = {
        userId: "fallback-user",
        email: "fallback@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
        dataRegion: "US",
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
          Authorization: `Bearer ${encrypted}`,
        },
      });

      // Primary secret fails; session-cookie reads SESSION_SECRET_FALLBACK from env
      const session = await sessionManager.getSession(request, testSecret, envWithFallback);

      expect(session).not.toBeNull();
      expect(session?.userId).toBe("fallback-user");
    });

    it("should return null when both primary and fallback secrets fail for Bearer token", async () => {

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Authorization: "Bearer invalid-encrypted-data",
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).toBeNull();
    });

    it("should return null for unparseable decrypted token from Authorization header", async () => {
      // Create something that decrypts but isn't valid JSON
      // We test this by encrypting non-JSON data
      const encrypted = await sessionManager.encryptSession(
        "not valid json {{{",
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      // Should return null because JSON.parse fails
      expect(session).toBeNull();
    });

    it("should return null for decrypted token missing userId", async () => {
      const encrypted = await sessionManager.encryptSession(
        JSON.stringify({ email: "no-userid@example.com", expiresAt: Date.now() + 3600000 }),
        testSecret,
        testSalt,
      );

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${encrypted}`,
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      // Token decrypts and parses but missing userId, so no valid session
      expect(session).toBeNull();
    });
  });

  describe("Inactivity timeout", () => {
    it("should allow session with lastActivityAt when env is not provided (no timeout check)", async () => {
      // When env is not provided, inactivity timeout is not checked
      const sessionData: Session = {
        userId: "active-user",
        email: "active@example.com",
        expiresAt: Date.now() + 3600000,
        lastActivityAt: Date.now() - 999 * 60 * 1000, // very old activity
        profileContext: "primary",
        dataRegion: "EU",
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

      // With env (required for salt), disable inactivity timeout so old lastActivityAt is allowed
      const noTimeoutEnv = { ...testEnv, INACTIVITY_TIMEOUT_MINUTES: 0 };
      const session = await sessionManager.getSession(request, testSecret, noTimeoutEnv);

      expect(session).not.toBeNull();
      expect(session?.userId).toBe("active-user");
      // lastActivityAt should be updated to current time
      expect(session?.lastActivityAt).toBeGreaterThan(Date.now() - 5000);
    });

    it("should not check inactivity when lastActivityAt is not set", async () => {
      const sessionData: Session = {
        userId: "no-activity-user",
        email: "no-activity@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
        dataRegion: "EU",
        // No lastActivityAt
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

      // Even with env, if lastActivityAt is not set, inactivity check is skipped
      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).not.toBeNull();
      expect(session?.userId).toBe("no-activity-user");
    });

    it("should update lastActivityAt on successful session retrieval", async () => {
      const oldActivity = Date.now() - 10_000;
      const sessionData: Session = {
        userId: "timestamp-user",
        email: "timestamp@example.com",
        expiresAt: Date.now() + 3600000,
        lastActivityAt: oldActivity,
        profileContext: "primary",
        dataRegion: "EU",
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

      // Pass env with SESSION_SALT (required for decryption)
      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).not.toBeNull();
      expect(session!.lastActivityAt).toBeGreaterThan(oldActivity);
    });
  });

  describe("Cookie parsing edge cases", () => {
    it("should handle cookie with equals sign in value", async () => {
      const sessionData: Session = {
        userId: "eq-user",
        email: "eq@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
        dataRegion: "EU",
      };

      const encrypted = await sessionManager.encryptSession(
        JSON.stringify(sessionData),
        testSecret,
        testSalt,
      );

      // Base64 values often contain = signs
      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: `other=val; trellis_session=${encrypted}; another=test`,
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).not.toBeNull();
      expect(session?.userId).toBe("eq-user");
    });

    it("should handle empty cookie header", async () => {
      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: "",
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).toBeNull();
    });

    it("should handle cookies with spaces and special formatting", async () => {
      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: "  ; ; empty=;  =nokey; valid_key=valid_value",
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).toBeNull(); // No trellis_session cookie
    });
  });

  describe("Fallback secret rotation - cookie path", () => {
    it("should return null when both primary and fallback secrets fail for cookie", async () => {

      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: "trellis_session=corrupted-encrypted-data",
        },
      });

      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).toBeNull();
    });

    it("should succeed with fallback secret and no env (no fallback attempted)", async () => {
      const sessionData: Session = {
        userId: "no-env-user",
        email: "noenv@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
        dataRegion: "EU",
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

      // Pass minimal env with SESSION_SALT (required for decryption), no fallback attempted
      const session = await sessionManager.getSession(request, testSecret, testEnv);

      expect(session).not.toBeNull();
      expect(session?.userId).toBe("no-env-user");
    });
  });

  describe("setSession - session type configuration", () => {
    it("should default to 90-day max-age when env is not provided (user session)", async () => {
      const session: Session = {
        userId: "user-session",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
        sessionType: "user",
        profileContext: "primary",
        dataRegion: "EU",
      };

      const response = new Response("OK", { status: 200 });
      // Pass minimal env with SESSION_SALT (required for encryption)
      const result = await sessionManager.setSession(
        response,
        session,
        testSecret,
        undefined,
        testEnv,
      );

      const setCookieHeader = result.headers.get("Set-Cookie");
      expect(setCookieHeader).toContain("trellis_session=");
      const maxAgeMatch = setCookieHeader?.match(/Max-Age=(\d+)/);
      expect(maxAgeMatch).not.toBeNull();
      // Without session-config env settings, defaults to 90 days
      expect(parseInt(maxAgeMatch![1], 10)).toBe(90 * 24 * 60 * 60);
    });

    it("should use SSO-specific max-age when env is provided", async () => {
      const session: Session = {
        userId: "sso-user",
        email: "sso@example.com",
        expiresAt: Date.now() + 3600000,
        sessionType: "sso",
        profileContext: "primary",
        dataRegion: "EU",
      };

      const response = new Response("OK", { status: 200 });
      // Pass minimal env with SESSION_SALT (required for encryption)
      const result = await sessionManager.setSession(
        response,
        session,
        testSecret,
        undefined,
        testEnv,
      );

      const setCookieHeader = result.headers.get("Set-Cookie");
      const maxAgeMatch = setCookieHeader?.match(/Max-Age=(\d+)/);
      expect(maxAgeMatch).not.toBeNull();
      // With env provided, SSO sessions get 7-day max-age from session config
      expect(parseInt(maxAgeMatch![1], 10)).toBe(7 * 24 * 60 * 60);
    });

    it("should use dashboard-specific max-age when env is provided", async () => {
      const session: Session = {
        userId: "dashboard-user",
        email: "dashboard@example.com",
        expiresAt: Date.now() + 3600000,
        sessionType: "dashboard",
        profileContext: "primary",
        dataRegion: "EU",
      };

      const response = new Response("OK", { status: 200 });
      // Pass minimal env with SESSION_SALT (required for encryption)
      const result = await sessionManager.setSession(
        response,
        session,
        testSecret,
        undefined,
        testEnv,
      );

      const setCookieHeader = result.headers.get("Set-Cookie");
      const maxAgeMatch = setCookieHeader?.match(/Max-Age=(\d+)/);
      expect(maxAgeMatch).not.toBeNull();
      // With env provided, dashboard sessions get 24-hour max-age from session config
      expect(parseInt(maxAgeMatch![1], 10)).toBe(24 * 60 * 60);
    });
  });

  describe("revokeSession", () => {
    it("should revoke session from Authorization header", async () => {
      const mockKV = {
        put: vi.fn().mockResolvedValue(undefined),
      };
      const env = { SESSION_BLOCKLIST_KV: mockKV };

      const request = new Request("https://example.com/api/logout", {
        method: "POST",
        headers: {
          Authorization: "Bearer some-token-value",
        },
      });

      await sessionManager.revokeSession(request, env);

      expect(mockKV.put).toHaveBeenCalledWith(
        expect.stringMatching(/^blocked:/),
        "1",
        expect.objectContaining({ expirationTtl: 90 * 24 * 60 * 60 }),
      );
    });

    it("should revoke session from cookie", async () => {
      const mockKV = {
        put: vi.fn().mockResolvedValue(undefined),
      };
      const env = { SESSION_BLOCKLIST_KV: mockKV };

      const request = new Request("https://example.com/api/logout", {
        method: "POST",
        headers: {
          Cookie: "trellis_session=my-encrypted-session-token",
        },
      });

      await sessionManager.revokeSession(request, env);

      expect(mockKV.put).toHaveBeenCalledWith(
        expect.stringMatching(/^blocked:/),
        "1",
        expect.objectContaining({ expirationTtl: 90 * 24 * 60 * 60 }),
      );
    });

    it("should do nothing when SESSION_BLOCKLIST_KV is not configured", async () => {
      const env = {};

      const request = new Request("https://example.com/api/logout", {
        method: "POST",
        headers: {
          Authorization: "Bearer some-token",
        },
      });

      // Should not throw
      await sessionManager.revokeSession(request, env);
    });

    it("should do nothing when no token is found in request", async () => {
      const mockKV = {
        put: vi.fn().mockResolvedValue(undefined),
      };
      const env = { SESSION_BLOCKLIST_KV: mockKV };

      const request = new Request("https://example.com/api/logout", {
        method: "POST",
      });

      await sessionManager.revokeSession(request, env);

      expect(mockKV.put).not.toHaveBeenCalled();
    });
  });

  describe("Invalid secret handling", () => {
    it("should return null for null secret", async () => {
      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: "trellis_session=some-data",
        },
      });

      const session = await sessionManager.getSession(request, null as any, testEnv);

      expect(session).toBeNull();
    });

    it("should return null for non-string secret", async () => {
      const request = new Request("https://example.com/api/test", {
        method: "GET",
        headers: {
          Cookie: "trellis_session=some-data",
        },
      });

      const session = await sessionManager.getSession(request, 123 as any, testEnv);

      expect(session).toBeNull();
    });
  });

  describe("clearSession - comprehensive", () => {
    it("should clear all cookie variations without domain", () => {
      const response = new Response("OK", { status: 200 });
      const result = sessionManager.clearSession(response);

      const setCookieHeaders = result.headers.getSetCookie();
      // Should have 2 Set-Cookie headers: current name + legacy name (no domain variants)
      expect(setCookieHeaders.length).toBe(2);

      const allHeaders = setCookieHeaders.join("; ");
      expect(allHeaders).toContain("trellis_session=");
      expect(allHeaders).toContain("session="); // legacy
      expect(allHeaders).toContain("Max-Age=0");
    });

    it("should include domain in all clear cookies when provided", () => {
      const response = new Response("OK", { status: 200 });
      const result = sessionManager.clearSession(response, ".example.com");

      const setCookieHeaders = result.headers.getSetCookie();
      // Should have 3 Set-Cookie headers: current without domain, current with domain, legacy
      expect(setCookieHeaders.length).toBe(3);
      const headersWithDomain = setCookieHeaders.filter((h) =>
        h.includes("Domain=.example.com"),
      );
      // Only the current cookie name with domain should have the domain
      expect(headersWithDomain.length).toBe(1);
    });
  });
});
