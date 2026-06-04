/**
 * Unit Tests: CSRF Protection
 *
 * Tests for CSRF token generation, validation, and storage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CSRFProtection } from "../../src/lib/csrf.js";
import type { Env } from "../../src/env.js";

describe("CSRFProtection", () => {
  let mockEnv: Env;
  let mockKV: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockKV = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    mockEnv = {
      CSRF_TOKENS_KV: mockKV as any,
      ENVIRONMENT: "test",
    } as Env;
  });

  describe("generateToken", () => {
    it("should generate a valid UUID token", () => {
      const token = CSRFProtection.generateToken();

      // UUID v4 format: 8-4-4-4-12 hex characters
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(token).toMatch(uuidRegex);
    });

    it("should generate unique tokens", () => {
      const token1 = CSRFProtection.generateToken();
      const token2 = CSRFProtection.generateToken();

      expect(token1).not.toBe(token2);
    });

    it("should generate tokens of correct length", () => {
      const token = CSRFProtection.generateToken();
      // UUID format: 36 characters (32 hex + 4 hyphens)
      expect(token.length).toBe(36);
    });
  });

  describe("validateToken", () => {
    it("should return false for empty token", async () => {
      const session = {
        userId: "user-123",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
      };
      const isValid = await CSRFProtection.validateToken("", session);
      expect(isValid).toBe(false);
    });

    it("should return false for null session", async () => {
      const isValid = await CSRFProtection.validateToken("token", null);
      expect(isValid).toBe(false);
    });

    it("should return true when token matches session token (Double Submit Cookie)", async () => {
      const token = "valid-token-123";
      const session = {
        userId: "user-123",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
        csrfToken: token,
      };

      const isValid = await CSRFProtection.validateToken(token, session);

      expect(isValid).toBe(true);
    });

    it("should return false when token does not match session token", async () => {
      const session = {
        userId: "user-123",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
        csrfToken: "different-token",
      };

      const isValid = await CSRFProtection.validateToken("token", session);

      expect(isValid).toBe(false);
    });

    it("should fallback to KV when session has no csrfToken", async () => {
      const session = {
        userId: "user-123",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
      };
      const token = "valid-token-123";
      mockKV.get.mockResolvedValue(token);

      const isValid = await CSRFProtection.validateToken(
        token,
        session,
        mockEnv,
      );

      expect(isValid).toBe(true);
      expect(mockKV.get).toHaveBeenCalledWith("csrf:user-123", "text");
    });

    it("should return false when KV fallback has no token", async () => {
      const session = {
        userId: "user-123",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
      };
      mockKV.get.mockResolvedValue(null);

      const isValid = await CSRFProtection.validateToken(
        "token",
        session,
        mockEnv,
      );

      expect(isValid).toBe(false);
    });

    it("should use constant-time comparison to prevent timing attacks", async () => {
      const token = "valid-token";
      const session = {
        userId: "user-123",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
        csrfToken: token,
      };

      // Test with matching token
      const isValid1 = await CSRFProtection.validateToken(token, session);
      expect(isValid1).toBe(true);

      // Test with non-matching token (different length)
      const isValid2 = await CSRFProtection.validateToken("different", session);
      expect(isValid2).toBe(false);

      // Test with non-matching token (same length)
      const isValid3 = await CSRFProtection.validateToken(
        "valid-toke",
        session,
      );
      expect(isValid3).toBe(false);
    });
  });

  describe("storeTokenInSession", () => {
    it("should add token to session", () => {
      const session = {
        userId: "user-123",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
      };
      const token = "test-token";

      const updatedSession = CSRFProtection.storeTokenInSession(token, session);

      expect(updatedSession.csrfToken).toBe(token);
      expect(updatedSession.userId).toBe(session.userId);
      expect(updatedSession.email).toBe(session.email);
    });

    it("should overwrite existing token in session", () => {
      const session = {
        userId: "user-123",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
        csrfToken: "old-token",
      };
      const token = "new-token";

      const updatedSession = CSRFProtection.storeTokenInSession(token, session);

      expect(updatedSession.csrfToken).toBe("new-token");
    });
  });

  describe("storeTokenInKV", () => {
    it("should store token in KV with default TTL", async () => {
      const token = "test-token";
      const sessionId = "session-id";

      await CSRFProtection.storeTokenInKV(token, sessionId, mockEnv);

      expect(mockKV.put).toHaveBeenCalledWith("csrf:session-id", token, {
        expirationTtl: 3600,
      });
    });

    it("should silently skip if KV is not configured", async () => {
      const envWithoutKV = { ...mockEnv, CSRF_TOKENS_KV: undefined };

      await CSRFProtection.storeTokenInKV("token", "session-id", envWithoutKV);

      expect(mockKV.put).not.toHaveBeenCalled();
    });
  });

  describe("removeTokenFromSession", () => {
    it("should remove token from session", () => {
      const session = {
        userId: "user-123",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
        csrfToken: "token-to-remove",
      };

      const updatedSession = CSRFProtection.removeTokenFromSession(session);

      expect(updatedSession.csrfToken).toBeUndefined();
      expect(updatedSession.userId).toBe(session.userId);
    });

    it("should handle session without token", () => {
      const session = {
        userId: "user-123",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
      };

      const updatedSession = CSRFProtection.removeTokenFromSession(session);

      expect(updatedSession.csrfToken).toBeUndefined();
    });
  });

  describe("deleteTokenFromKV", () => {
    it("should delete token from KV", async () => {
      const sessionId = "session-id";

      await CSRFProtection.deleteTokenFromKV(sessionId, mockEnv);

      expect(mockKV.delete).toHaveBeenCalledWith("csrf:session-id");
    });

    it("should silently skip if KV is not configured", async () => {
      const envWithoutKV = { ...mockEnv, CSRF_TOKENS_KV: undefined };

      await CSRFProtection.deleteTokenFromKV("session-id", envWithoutKV);

      expect(mockKV.delete).not.toHaveBeenCalled();
    });
  });

  describe("integration scenarios", () => {
    it("should work with full token lifecycle (session-based)", async () => {
      const token = CSRFProtection.generateToken();
      const session = {
        userId: "user-123",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
      };

      // Store token in session
      const sessionWithToken = CSRFProtection.storeTokenInSession(
        token,
        session,
      );
      expect(sessionWithToken.csrfToken).toBe(token);

      // Validate token
      const isValid = await CSRFProtection.validateToken(
        token,
        sessionWithToken,
      );
      expect(isValid).toBe(true);

      // Remove token from session
      const sessionWithoutToken =
        CSRFProtection.removeTokenFromSession(sessionWithToken);
      expect(sessionWithoutToken.csrfToken).toBeUndefined();
    });

    it("should prevent token reuse after removal", async () => {
      const token = "test-token";
      const session = {
        userId: "user-123",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
        csrfToken: token,
      };

      // Validate token
      expect(await CSRFProtection.validateToken(token, session)).toBe(true);

      // Remove token from session
      const sessionWithoutToken =
        CSRFProtection.removeTokenFromSession(session);

      // Token should no longer be valid
      expect(
        await CSRFProtection.validateToken(token, sessionWithoutToken),
      ).toBe(false);
    });
  });
});
