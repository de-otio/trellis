/**
 * Unit Tests: Auth Handler
 *
 * Comprehensive tests for authentication route handling including:
 * - Magic link authentication
 * - SSO authentication (Microsoft, SAML)
 * - Session management
 * - CORS handling
 * - Rate limiting
 * - Feature flag checks
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { AuthHandler } from "../../src/lib/auth-handler.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";

// Mock dependencies
vi.mock("../../src/lib/rate-limit", () => {
  const mockApplyRateLimitKV = vi.fn();
  return {
    RateLimiter: class {
      applyRateLimitKV = mockApplyRateLimitKV;
    },
  };
});

vi.mock("../../src/lib/cors-handler", () => {
  const mockGetAllowedOrigin = vi.fn();
  const mockAddCorsHeaders = vi.fn();
  return {
    CorsHandler: {
      getAllowedOrigin: mockGetAllowedOrigin,
      addCorsHeaders: mockAddCorsHeaders,
    },
  };
});

vi.mock("../../src/lib/security-headers", () => {
  const mockAddSecurityHeaders = vi.fn();
  const mockCreateSecureResponse = vi.fn();
  return {
    SecurityHeaders: class {
      addSecurityHeaders = mockAddSecurityHeaders;
      createSecureResponse = mockCreateSecureResponse;
    },
  };
});

// Import after mocks to get mocked versions
import { CorsHandler } from "../../src/lib/cors-handler.js";
import { RateLimiter } from "../../src/lib/rate-limit.js";
import { SecurityHeaders } from "../../src/lib/security-headers.js";

describe("AuthHandler", () => {
  let mockEnv: Env;
  let mockRateLimiter: RateLimiter;
  let mockSecurityHeaders: SecurityHeaders;
  let mockRequestContext: TrellisRequestContext | undefined;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      RECAPTCHA_SITE_KEY: "test-site-key",
      SESSION_SECRET: "test-secret-key-32-characters-long!!",
    } as Env;

    mockRateLimiter = new RateLimiter();
    mockSecurityHeaders = new SecurityHeaders();

    mockRequestContext = {
      config: {
        features: {
          authentication: {
            magicLink: true,
            microsoftSSO: true,
            samlSSO: true,
          },
        },
      },
    } as TrellisRequestContext;

    // Setup default mock responses
    (mockRateLimiter.applyRateLimitKV as any).mockResolvedValue(null);
    (CorsHandler.getAllowedOrigin as any).mockReturnValue(
      "https://example.com",
    );
    (CorsHandler.addCorsHeaders as any).mockImplementation(
      (response: Response) => response,
    );
    (mockSecurityHeaders.addSecurityHeaders as any).mockImplementation(
      (response: Response) => response,
    );
    (mockSecurityHeaders.createSecureResponse as any).mockImplementation(
      (body: string, options: any) => new Response(body, options),
    );
  });

  describe("OPTIONS requests", () => {
    it("should handle OPTIONS requests with CORS headers", async () => {
      const request = new Request(
        "https://api.example.com/auth/send-magic-link",
        {
          method: "OPTIONS",
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      );
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type, Authorization, X-CSRF-Token, X-Retry-Count",
      );
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true",
      );
    });
  });

  describe("reCAPTCHA site key endpoint", () => {
    it("should return reCAPTCHA site key", async () => {
      const request = new Request(
        "https://api.example.com/auth/recaptcha-site-key",
        {
          method: "GET",
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.siteKey).toBe("test-site-key");
      expect(mockSecurityHeaders.addSecurityHeaders).toHaveBeenCalled();
    });

    it("should return empty string if site key not configured", async () => {
      const envWithoutKey = {
        ...mockEnv,
        RECAPTCHA_SITE_KEY: undefined,
      } as Env;
      const request = new Request(
        "https://api.example.com/auth/recaptcha-site-key",
        {
          method: "GET",
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        envWithoutKey,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      const body = await response.json();
      expect(body.siteKey).toBe("");
    });
  });

  describe("Magic link authentication", () => {
    it("should send magic link successfully", async () => {
      const request = new Request(
        "https://api.example.com/auth/send-magic-link",
        {
          method: "POST",
          body: JSON.stringify({ email: "test@example.com" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should reject magic link if feature flag disabled", async () => {
      const contextWithDisabledMagicLink = {
        ...mockRequestContext,
        config: {
          features: {
            authentication: {
              magicLink: false,
              microsoftSSO: true,
              samlSSO: true,
            },
          },
        },
      } as TrellisRequestContext;

      const request = new Request(
        "https://api.example.com/auth/send-magic-link",
        {
          method: "POST",
          body: JSON.stringify({ email: "test@example.com" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        contextWithDisabledMagicLink,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should handle rate limiting for magic link", async () => {
      const rateLimitResponse = new Response(
        JSON.stringify({ error: "Rate limit exceeded", retryAfter: 3600 }),
        {
          status: 429,
          headers: { "Retry-After": "3600" },
        },
      );

      (mockRateLimiter.applyRateLimitKV as any).mockResolvedValue(
        rateLimitResponse,
      );

      const request = new Request(
        "https://api.example.com/auth/send-magic-link",
        {
          method: "POST",
          body: JSON.stringify({ email: "test@example.com" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should handle rate limiting when body parsing fails", async () => {
      // Request with invalid JSON body
      const request = new Request(
        "https://api.example.com/auth/send-magic-link",
        {
          method: "POST",
          body: "invalid json",
          headers: { "content-type": "application/json" },
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      // Auth is deprecated — returns 410 before rate limiting
      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should handle CORS when no allowed origin", async () => {
      (CorsHandler.getAllowedOrigin as any).mockReturnValue(null);

      const request = new Request(
        "https://api.example.com/auth/send-magic-link",
        {
          method: "POST",
          body: JSON.stringify({ email: "test@example.com" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      // Should not include Access-Control-Allow-Origin header
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.status).toBe(410);
    });
  });

  describe("Magic link callback", () => {
    it("should handle GET callback (redirect)", async () => {
      const request = new Request("https://api.example.com/auth/callback", {
        method: "GET",
      });

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should handle POST callback (token exchange)", async () => {
      const request = new Request("https://api.example.com/auth/callback", {
        method: "POST",
        body: JSON.stringify({ code: "test-code" }),
        headers: { "content-type": "application/json" },
      });

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });
  });

  describe("Session management", () => {
    it("should get current session", async () => {
      const request = new Request("https://api.example.com/auth/me", {
        method: "GET",
      });

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should handle logout", async () => {
      const request = new Request("https://api.example.com/auth/logout", {
        method: "POST",
      });

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });
  });

  describe("Microsoft SSO", () => {
    it("should initiate Microsoft SSO", async () => {
      const request = new Request(
        "https://api.example.com/auth/sso/microsoft",
        {
          method: "GET",
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should reject Microsoft SSO if feature flag disabled", async () => {
      const contextWithDisabledSSO = {
        ...mockRequestContext,
        config: {
          features: {
            authentication: {
              magicLink: true,
              microsoftSSO: false,
              samlSSO: true,
            },
          },
        },
      } as TrellisRequestContext;

      const request = new Request(
        "https://api.example.com/auth/sso/microsoft",
        {
          method: "GET",
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        contextWithDisabledSSO,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should handle silent Microsoft SSO", async () => {
      const request = new Request(
        "https://api.example.com/auth/sso/microsoft/silent",
        {
          method: "GET",
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should reject silent Microsoft SSO if feature flag disabled", async () => {
      const contextWithDisabledSSO = {
        ...mockRequestContext,
        config: {
          features: {
            authentication: {
              magicLink: true,
              microsoftSSO: false,
              samlSSO: true,
            },
          },
        },
      } as TrellisRequestContext;

      const request = new Request(
        "https://api.example.com/auth/sso/microsoft/silent",
        {
          method: "GET",
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        contextWithDisabledSSO,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });
  });

  describe("SAML SSO", () => {
    it("should initiate SAML SSO without partner", async () => {
      const request = new Request("https://api.example.com/auth/sso/saml", {
        method: "GET",
      });

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should initiate SAML SSO with partner", async () => {
      const request = new Request(
        "https://api.example.com/auth/sso/saml?partner=test-partner",
        {
          method: "GET",
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });
  });

  describe("SSO callback", () => {
    it("should handle GET SSO callback", async () => {
      const request = new Request("https://api.example.com/auth/sso/callback", {
        method: "GET",
      });

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should handle POST SSO callback (token exchange)", async () => {
      const request = new Request("https://api.example.com/auth/sso/callback", {
        method: "POST",
        body: JSON.stringify({ code: "test-code" }),
        headers: { "content-type": "application/json" },
      });

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });
  });

  describe("Session exchange", () => {
    it("should handle token exchange", async () => {
      const request = new Request(
        "https://api.example.com/auth/session/exchange",
        {
          method: "POST",
          body: JSON.stringify({ accessToken: "test-token" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });
  });

  describe("Password reset (deprecated)", () => {
    it("should return 410 for password reset requests", async () => {
      const request = new Request(
        "https://api.example.com/auth/reset-password",
        {
          method: "POST",
          body: JSON.stringify({ email: "test@example.com" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });
  });

  describe("Error handling", () => {
    it("should handle errors gracefully", async () => {
      const request = new Request(
        "https://api.example.com/auth/send-magic-link",
        {
          method: "POST",
          body: JSON.stringify({ email: "test@example.com" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should include CORS headers in error responses", async () => {
      const request = new Request(
        "https://api.example.com/auth/send-magic-link",
        {
          method: "POST",
          body: JSON.stringify({ email: "test@example.com" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true",
      );
    });

    it("should handle errors when handler methods throw", async () => {
      const request = new Request("https://api.example.com/auth/me", {
        method: "GET",
      });

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("This auth endpoint has been deprecated.");
    });

    it("should return 404 for unknown routes", async () => {
      // Mock the dynamic import to not throw errors
      const request = new Request("https://api.example.com/auth/unknown", {
        method: "GET",
      });

      const response = await AuthHandler.handleAuthRoutes(
        request,
        mockEnv,
        new URL(request.url),
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      expect(mockSecurityHeaders.addSecurityHeaders).toHaveBeenCalled();
    });
  });
});
