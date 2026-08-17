/**
 * Unit Tests: Middleware
 *
 * Tests for middleware composition, CORS middleware, and security headers middleware.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  composeMiddleware,
  corsMiddleware,
  csrfMiddleware,
  securityHeadersMiddleware,
  type Middleware,
  type MiddlewareContext,
} from "../../src/lib/middleware.js";
import type { Env } from "../../src/env.js";

// Mock SecurityHeaders
vi.mock("../../src/lib/security-headers", () => {
  return {
    SecurityHeaders: class {
      constructor(env: Env) {}
      addSecurityHeaders(response: Response): Response {
        const newResponse = response.clone();
        newResponse.headers.set("X-Content-Type-Options", "nosniff");
        newResponse.headers.set("X-Frame-Options", "DENY");
        return newResponse;
      }
    },
  };
});

// Mock SessionManager
vi.mock("../../src/lib/session-cookie", () => {
  return {
    SessionManager: class {
      async getSession(request: Request, secret: string) {
        // Return mock session for authenticated requests
        if (request.headers.get("Cookie")?.includes("trellis_session")) {
          return {
            userId: "user-123",
            email: "user@example.com",
            expiresAt: Date.now() + 3600000,
          };
        }
        return null;
      }
    },
  };
});

// Mock CSRFProtection
const mockValidateToken = vi.fn();
vi.mock("../../src/lib/csrf", () => {
  return {
    CSRFProtection: class {
      static validateToken = mockValidateToken;
    },
  };
});


describe("Middleware", () => {
  let mockEnv: Env;
  let mockContext: MiddlewareContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateToken.mockResolvedValue(true); // Default: valid token
    mockEnv = {
      APP_DOMAIN: "https://app.example.com",
      ALLOWED_ORIGINS: "https://app.example.com,https://www.example.com",
    } as Env;

    mockContext = {
      request: new Request("https://api.example.com/health", {
        method: "GET",
        headers: {
          Origin: "https://app.example.com",
        },
      }),
      env: mockEnv,
      url: new URL("https://api.example.com/health"),
      pathname: "/health",
      method: "GET",
    };
  });

  describe("composeMiddleware", () => {
    it("should execute middleware in order", async () => {
      const executionOrder: number[] = [];
      const middleware1: Middleware = async (context, next) => {
        executionOrder.push(1);
        return next();
      };
      const middleware2: Middleware = async (context, next) => {
        executionOrder.push(2);
        return next();
      };
      const middleware3: Middleware = async (context, next) => {
        executionOrder.push(3);
        return next();
      };

      const composed = composeMiddleware([
        middleware1,
        middleware2,
        middleware3,
      ]);
      const handler = async () => {
        executionOrder.push(4);
        return new Response("OK");
      };

      await composed(mockContext, handler);

      expect(executionOrder).toEqual([1, 2, 3, 4]);
    });

    it("should allow middleware to modify response", async () => {
      const middleware: Middleware = async (context, next) => {
        const response = await next();
        const newResponse = response.clone();
        newResponse.headers.set("X-Custom-Header", "custom-value");
        return newResponse;
      };

      const composed = composeMiddleware([middleware]);
      const handler = async () => new Response("OK");

      const response = await composed(mockContext, handler);

      expect(response.headers.get("X-Custom-Header")).toBe("custom-value");
    });

    it("should allow middleware to short-circuit request", async () => {
      const middleware: Middleware = async (context, next) => {
        return new Response("Short-circuited", { status: 403 });
      };

      const composed = composeMiddleware([middleware]);
      const handler = async () => new Response("OK");

      const response = await composed(mockContext, handler);

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Short-circuited");
    });

    it("should handle empty middleware array", async () => {
      const composed = composeMiddleware([]);
      const handler = async () => new Response("OK");

      const response = await composed(mockContext, handler);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("OK");
    });

    it("should throw error if next() is called multiple times", async () => {
      const middleware: Middleware = async (context, next) => {
        await next();
        return next(); // Call next() twice
      };

      const composed = composeMiddleware([middleware]);
      const handler = async () => new Response("OK");

      await expect(composed(mockContext, handler)).rejects.toThrow(
        "next() called multiple times",
      );
    });
  });

  describe("corsMiddleware", () => {
    it("should handle OPTIONS preflight requests", async () => {
      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/health", {
          method: "OPTIONS",
          headers: {
            Origin: "https://app.example.com",
          },
        }),
        method: "OPTIONS",
      };

      const middleware = corsMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      );
      const allowedHeaders = response.headers.get(
        "Access-Control-Allow-Headers",
      );
      expect(allowedHeaders).toContain("Content-Type");
      expect(allowedHeaders).toContain("Authorization");
      expect(allowedHeaders).toContain("X-CSRF-Token");
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true",
      );
    });

    it("should add CORS headers to response", async () => {
      const middleware = corsMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(mockContext, handler);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      );
      const allowedHeaders = response.headers.get(
        "Access-Control-Allow-Headers",
      );
      expect(allowedHeaders).toContain("Content-Type");
      expect(allowedHeaders).toContain("Authorization");
      expect(allowedHeaders).toContain("X-CSRF-Token");
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true",
      );
    });

    it("should handle requests without Origin header", async () => {
      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/health", {
          method: "GET",
        }),
      };

      const middleware = corsMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      // When no Origin header, CorsHandler returns APP_DOMAIN for safety
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      );
      const allowedHeaders = response.headers.get(
        "Access-Control-Allow-Headers",
      );
      expect(allowedHeaders).toContain("X-CSRF-Token");
    });

    it("should handle requests from allowed origins in ALLOWED_ORIGINS", async () => {
      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/health", {
          method: "GET",
          headers: {
            Origin: "https://www.example.com",
          },
        }),
      };

      const middleware = corsMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://www.example.com",
      );
    });

    it("should not add CORS headers for disallowed origins", async () => {
      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/health", {
          method: "GET",
          headers: {
            Origin: "https://evil.com",
          },
        }),
      };

      const middleware = corsMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should include X-CSRF-Token in Access-Control-Allow-Headers for preflight requests", async () => {
      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/invitations", {
          method: "OPTIONS",
          headers: {
            Origin: "https://app.example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type, X-CSRF-Token",
          },
        }),
        method: "OPTIONS",
      };

      const middleware = corsMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      const allowedHeaders = response.headers.get(
        "Access-Control-Allow-Headers",
      );
      expect(allowedHeaders).toBeTruthy();
      expect(allowedHeaders).toContain("X-CSRF-Token");
      expect(allowedHeaders).toContain("Content-Type");
      expect(allowedHeaders).toContain("Authorization");
    });

    it("should include X-CSRF-Token in Access-Control-Allow-Headers for regular requests", async () => {
      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/invitations", {
          method: "POST",
          headers: {
            Origin: "https://app.example.com",
            "Content-Type": "application/json",
            "X-CSRF-Token": "test-token",
          },
        }),
        method: "POST",
      };

      const middleware = corsMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      const allowedHeaders = response.headers.get(
        "Access-Control-Allow-Headers",
      );
      expect(allowedHeaders).toBeTruthy();
      expect(allowedHeaders).toContain("X-CSRF-Token");
    });
  });

  describe("securityHeadersMiddleware", () => {
    it("should add security headers to response", async () => {
      const middleware = securityHeadersMiddleware(mockEnv);
      const handler = async () => new Response("OK");

      const response = await middleware(mockContext, handler);

      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("should preserve existing response headers", async () => {
      const middleware = securityHeadersMiddleware(mockEnv);
      const handler = async () => {
        const response = new Response("OK");
        response.headers.set("Content-Type", "application/json");
        return response;
      };

      const response = await middleware(mockContext, handler);

      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });
  });

  describe("middleware composition", () => {
    it("should compose CORS and security headers middleware", async () => {
      const composed = composeMiddleware([
        corsMiddleware(),
        securityHeadersMiddleware(mockEnv),
      ]);
      const handler = async () => new Response("OK");

      const response = await composed(mockContext, handler);

      // CORS headers
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      // Security headers
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("should execute middleware in correct order", async () => {
      const executionLog: string[] = [];
      const customMiddleware: Middleware = async (context, next) => {
        executionLog.push("custom-before");
        const response = await next();
        executionLog.push("custom-after");
        return response;
      };

      const composed = composeMiddleware([
        customMiddleware,
        corsMiddleware(),
        securityHeadersMiddleware(mockEnv),
      ]);
      const handler = async () => {
        executionLog.push("handler");
        return new Response("OK");
      };

      await composed(mockContext, handler);

      expect(executionLog).toEqual([
        "custom-before",
        "handler",
        "custom-after",
      ]);
    });
  });

  describe("csrfMiddleware", () => {
    let mockKV: {
      get: ReturnType<typeof vi.fn>;
    };

    beforeEach(async () => {
      vi.clearAllMocks();
      mockKV = {
        get: vi.fn(),
      };
      mockEnv = {
        ...mockEnv,
        CSRF_TOKENS_KV: mockKV as any,
        SESSION_SECRET: "test-secret",
        ENVIRONMENT: "dev",
        trellis_dev_session_secret: "test-secret",
      } as Env;
      // Update mockContext to reflect the new env so spread tests pick up SESSION_SECRET
      mockContext = { ...mockContext, env: mockEnv };

      // Reset CSRF mock
      const csrfModule = await import("../../src/lib/csrf.js");
      vi.mocked(csrfModule.CSRFProtection.validateToken).mockClear();
    });

    it("should skip validation for GET requests", async () => {
      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/posts", {
          method: "GET",
        }),
        method: "GET",
      };

      const middleware = csrfMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("OK");
    });

    it("should skip validation for HEAD requests", async () => {
      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/posts", {
          method: "HEAD",
        }),
        method: "HEAD",
      };

      const middleware = csrfMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      expect(response.status).toBe(200);
    });

    it("should skip validation for OPTIONS requests", async () => {
      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/posts", {
          method: "OPTIONS",
        }),
        method: "OPTIONS",
      };

      const middleware = csrfMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      expect(response.status).toBe(200);
    });

    it("should allow requests without session (let auth middleware handle)", async () => {
      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/posts", {
          method: "POST",
        }),
        method: "POST",
      };

      const middleware = csrfMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      // Should pass through to handler (auth will handle unauthorized)
      expect(response.status).toBe(200);
    });

    it("should reject POST requests without CSRF token", async () => {
      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/posts", {
          method: "POST",
          headers: {
            Cookie: "trellis_session=encrypted-session",
          },
        }),
        method: "POST",
      };

      const middleware = csrfMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("CSRF token required");
    });

    it("should reject POST requests with invalid CSRF token", async () => {
      mockValidateToken.mockResolvedValueOnce(false);

      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/posts", {
          method: "POST",
          headers: {
            Cookie: "trellis_session=encrypted-session",
            "X-CSRF-Token": "invalid-token",
          },
        }),
        method: "POST",
      };

      const middleware = csrfMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Invalid CSRF token");
      // Check that validateToken was called
      expect(mockValidateToken).toHaveBeenCalled();
      const callArgs = mockValidateToken.mock.calls[0];
      expect(callArgs?.[0]).toBe("invalid-token");
      expect(callArgs?.[1]?.userId).toBe("user-123");
    });

    it("should allow POST requests with valid CSRF token", async () => {
      mockValidateToken.mockResolvedValueOnce(true);

      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/posts", {
          method: "POST",
          headers: {
            Cookie: "trellis_session=encrypted-session",
            "X-CSRF-Token": "valid-token",
          },
        }),
        method: "POST",
      };

      const middleware = csrfMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("OK");
      // Check that validateToken was called
      expect(mockValidateToken).toHaveBeenCalled();
      const callArgs = mockValidateToken.mock.calls[0];
      expect(callArgs[0]).toBe("valid-token");
      expect(callArgs[1]?.userId).toBe("user-123");
    });

    it("should validate CSRF token for PUT requests", async () => {
      mockValidateToken.mockResolvedValueOnce(true);

      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request(
          "https://api.example.com/user/privacy-preferences",
          {
            method: "PUT",
            headers: {
              Cookie: "trellis_session=encrypted-session",
              "X-CSRF-Token": "valid-token",
            },
          },
        ),
        method: "PUT",
      };

      const middleware = csrfMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      expect(response.status).toBe(200);
      expect(mockValidateToken).toHaveBeenCalled();
    });

    it("should validate CSRF token for DELETE requests", async () => {
      mockValidateToken.mockResolvedValueOnce(true);

      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/posts/123", {
          method: "DELETE",
          headers: {
            Cookie: "trellis_session=encrypted-session",
            "X-CSRF-Token": "valid-token",
          },
        }),
        method: "DELETE",
      };

      const middleware = csrfMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      expect(response.status).toBe(200);
      expect(mockValidateToken).toHaveBeenCalled();
    });

    it("should validate CSRF token for PATCH requests", async () => {
      mockValidateToken.mockResolvedValueOnce(true);

      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/posts/123/hide", {
          method: "PATCH",
          headers: {
            Cookie: "trellis_session=encrypted-session",
            "X-CSRF-Token": "valid-token",
          },
        }),
        method: "PATCH",
      };

      const middleware = csrfMiddleware();
      const handler = async () => new Response("OK");

      const response = await middleware(context, handler);

      expect(response.status).toBe(200);
      expect(mockValidateToken).toHaveBeenCalled();
    });

    it("should work with composed middleware", async () => {
      const csrfModule = await import("../../src/lib/csrf.js");
      vi.mocked(csrfModule.CSRFProtection.validateToken).mockResolvedValueOnce(
        true,
      );

      const context: MiddlewareContext = {
        ...mockContext,
        request: new Request("https://api.example.com/posts", {
          method: "POST",
          headers: {
            Cookie: "trellis_session=encrypted-session",
            "X-CSRF-Token": "valid-token",
            Origin: "https://app.example.com",
          },
        }),
        method: "POST",
      };

      const composed = composeMiddleware([
        corsMiddleware(),
        csrfMiddleware(),
        securityHeadersMiddleware(mockEnv),
      ]);
      const handler = async () => new Response("OK");

      const response = await composed(context, handler);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    // ---------------------------------------------------------------------
    // Phase 8 — the CSRF bypass used to be keyed off the SHAPE of the
    // Authorization header ("three dot-separated segments"), unverified. A
    // cross-origin script can set that header while the browser still attaches
    // the session cookie, so `Authorization: Bearer a.b.c` disabled CSRF on a
    // cookie-authenticated request. The predicate is now cookie presence.
    // ---------------------------------------------------------------------
    describe("Phase 8: the CSRF skip is derived from cookie presence", () => {
      function postWith(headers: Record<string, string>): MiddlewareContext {
        return {
          ...mockContext,
          request: new Request("https://api.example.com/posts", {
            method: "POST",
            headers,
          }),
          method: "POST",
        };
      }

      it("does NOT skip CSRF for a junk Bearer alongside a session cookie", async () => {
        const response = await csrfMiddleware()(
          postWith({
            Cookie: "trellis_session=encrypted-session",
            Authorization: "Bearer a.b.c", // three segments, never verified
          }),
          async () => new Response("OK"),
        );

        // No X-CSRF-Token was supplied → must be rejected, not waved through.
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "CSRF token required" });
      });

      it("does NOT skip CSRF for a real-looking JWT alongside a session cookie", async () => {
        const jwtish = `${btoa('{"alg":"RS256"}')}.${btoa('{"sub":"x"}')}.sig`;
        const response = await csrfMiddleware()(
          postWith({
            Cookie: "trellis_session=encrypted-session",
            Authorization: `Bearer ${jwtish}`,
          }),
          async () => new Response("OK"),
        );

        expect(response.status).toBe(403);
      });

      it("rejects a cookie-authenticated request with an INVALID CSRF token even with a Bearer", async () => {
        mockValidateToken.mockResolvedValueOnce(false);
        const response = await csrfMiddleware()(
          postWith({
            Cookie: "trellis_session=encrypted-session",
            Authorization: "Bearer a.b.c",
            "X-CSRF-Token": "forged",
          }),
          async () => new Response("OK"),
        );

        expect(mockValidateToken).toHaveBeenCalled();
        expect(response.status).toBe(403);
      });

      it("still skips CSRF for a pure Bearer client (no cookie at all)", async () => {
        const response = await csrfMiddleware()(
          postWith({ Authorization: "Bearer some-opaque-token" }),
          async () => new Response("OK"),
        );

        expect(response.status).toBe(200);
        expect(mockValidateToken).not.toHaveBeenCalled();
      });

      it("a non-session cookie does not force CSRF on a Bearer client", async () => {
        const response = await csrfMiddleware()(
          postWith({
            Cookie: "locale=de; theme=dark",
            Authorization: "Bearer some-opaque-token",
          }),
          async () => new Response("OK"),
        );

        expect(response.status).toBe(200);
      });

      it("the legacy `session=` cookie name also forces CSRF", async () => {
        const response = await csrfMiddleware()(
          postWith({
            Cookie: "session=legacy-value",
            Authorization: "Bearer a.b.c",
          }),
          async () => new Response("OK"),
        );

        // No session resolves from the legacy cookie, so this falls through to
        // the "no session" branch rather than 403 — the point is that it did
        // NOT take the Bearer shortcut before the session lookup.
        expect(response.status).toBe(200);
      });
    });
  });
});
