/**
 * Unit Tests: Route Helpers
 *
 * Tests for route helper functions and RouteHelpers class.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

// Mock CorsHandler first - before any imports that use it
vi.mock("../../src/lib/cors-handler", () => ({
  CorsHandler: {
    addCorsHeaders: vi
      .fn()
      .mockImplementation(async (response: Response) => response),
  },
}));

// Hoist all mock functions to avoid circular dependency issues
const { mockGetSession, mockCreateSecureResponse, mockAddSecurityHeaders, mockSanitizeError, mockVerifyCognitoJwt } = vi.hoisted(() => {
  const mockGetSession = vi.fn();
  const mockCreateSecureResponse = vi.fn();
  const mockAddSecurityHeaders = vi.fn();
  const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
  const mockVerifyCognitoJwt = vi.fn();
  return {
    mockGetSession,
    mockCreateSecureResponse,
    mockAddSecurityHeaders,
    mockSanitizeError,
    mockVerifyCognitoJwt,
  };
});

// Mock Cognito JWT verification (the Bearer-token auth strategy)
vi.mock("../../src/lib/auth/cognito-jwt", () => ({
  verifyCognitoJwt: mockVerifyCognitoJwt,
}));

// Mock SessionManager
vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// Mock SecurityHeaders
vi.mock("../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
    constructor(env: any) {}
  },
}));

// Mock Validator
vi.mock("../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));

// Import route-helpers dynamically after mocks are set up to avoid circular dependency
let RouteHelpers: any;
let extractPathParam: any;
let getSession: any;
let requireAuth: any;
let wrapHandler: any;
type RouteHandlerContext = any;

beforeAll(async () => {
  const routeHelpersModule = await import("../../src/lib/route-helpers.js");
  RouteHelpers = routeHelpersModule.RouteHelpers;
  extractPathParam = routeHelpersModule.extractPathParam;
  getSession = routeHelpersModule.getSession;
  requireAuth = routeHelpersModule.requireAuth;
  wrapHandler = routeHelpersModule.wrapHandler;
});

describe("RouteHelpers", () => {
  let mockEnv: Env;
  let mockRequest: Request;
  let mockContext: RouteHandlerContext;
  let routeHelpers: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockRequest = new Request("https://example.com/api/test", {
      method: "GET",
    });

    const mockUrl = new URL("https://example.com/api/test");
    mockContext = {
      request: mockRequest,
      env: mockEnv,
      url: mockUrl,
      pathname: "/api/test",
      params: {},
    };

    routeHelpers = new RouteHelpers(mockEnv);

    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
    // Reset CorsHandler mock
    const { CorsHandler } = await import("../../src/lib/cors-handler.js");
    vi.mocked(CorsHandler.addCorsHeaders).mockClear();
    vi.mocked(CorsHandler.addCorsHeaders).mockImplementation(
      async (response: Response) => response,
    );
  });

  describe("getSessionFromRequest", () => {
    const bearer = (token = "h.p.s") =>
      new Request("https://example.com/api/test", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

    it("JWT Bearer: session.userId is the cuid in custom:userId, not the Cognito sub", async () => {
      // Regression: the DB User.id is a cuid and every handler looks up the
      // session user via `where: { id: session.userId }`. Using claims.sub here
      // mismatched the cuid-keyed row and broke those lookups (e.g. media
      // tenant resolution → "Tenant resolution failed").
      mockVerifyCognitoJwt.mockResolvedValue({
        sub: "23643892-00c1-7057-551c-aed44aed1f13", // Cognito sub (UUID)
        "custom:userId": "cmqurmq7x000002i80nqmgfr8", // DB User.id (cuid)
        email: "user@example.com",
        username: "user@example.com",
      });

      const result = await routeHelpers.getSessionFromRequest(bearer());

      expect(result).toEqual({
        userId: "cmqurmq7x000002i80nqmgfr8",
        email: "user@example.com",
      });
      // The session-cookie fallback must not be consulted on a valid JWT.
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("JWT Bearer: falls back to sub when custom:userId is absent (legacy tokens)", async () => {
      mockVerifyCognitoJwt.mockResolvedValue({
        sub: "legacy-sub-123",
        email: "legacy@example.com",
        username: "legacy@example.com",
      });

      const result = await routeHelpers.getSessionFromRequest(bearer());

      expect(result).toEqual({ userId: "legacy-sub-123", email: "legacy@example.com" });
    });

    it("should get session successfully", async () => {
      const mockSession = {
        userId: "user-123",
        email: "user@example.com",
      };
      mockGetSession.mockResolvedValue(mockSession);

      const result = await routeHelpers.getSessionFromRequest(mockRequest);

      expect(mockGetSession).toHaveBeenCalledWith(
        mockRequest,
        "test-secret",
        mockEnv,
      );
      expect(result).toEqual(mockSession);
    });

    it("should return null when session secret is missing from env", async () => {
      // env.SESSION_SECRET is undefined — getSession receives empty string and returns null
      mockEnv = { ...mockEnv, SESSION_SECRET: undefined } as any;
      routeHelpers = new RouteHelpers(mockEnv);
      mockGetSession.mockResolvedValue(null);

      const result = await routeHelpers.getSessionFromRequest(mockRequest);

      expect(result).toBeNull();
    });

    it("should return null when session is not found", async () => {
      mockGetSession.mockResolvedValue(null);

      const result = await routeHelpers.getSessionFromRequest(mockRequest);

      expect(result).toBeNull();
    });
  });

  describe("requireAuth", () => {
    it("should return null when session exists", async () => {
      const mockSession = {
        userId: "user-123",
        email: "user@example.com",
      };
      mockGetSession.mockResolvedValue(mockSession);

      const result = await routeHelpers.requireAuth(mockContext);

      expect(result).toBeNull();
    });

    it("should return error response when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const result = await routeHelpers.requireAuth(mockContext);

      expect(result).not.toBeNull();
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(result!.status).toBe(401);
    });
  });

  describe("wrapHandler", () => {
    it("should wrap handler successfully with authentication", async () => {
      const mockSession = {
        userId: "user-123",
        email: "user@example.com",
      };
      mockGetSession.mockResolvedValue(mockSession);

      const handler = vi.fn(async (context) => {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });

      const result = await routeHelpers.wrapHandler(handler, mockContext, true);

      expect(handler).toHaveBeenCalledWith({
        ...mockContext,
        session: mockSession,
      });
      expect(mockAddSecurityHeaders).toHaveBeenCalled();
      const { CorsHandler } = await import("../../src/lib/cors-handler.js");
      expect(vi.mocked(CorsHandler.addCorsHeaders)).toHaveBeenCalled();
      expect(result.status).toBe(200);
    });

    it("should wrap handler without authentication when requireAuthFlag is false", async () => {
      const handler = vi.fn(async (context) => {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });

      const result = await routeHelpers.wrapHandler(
        handler,
        mockContext,
        false,
      );

      expect(handler).toHaveBeenCalled();
      expect(mockAddSecurityHeaders).toHaveBeenCalled();
      const { CorsHandler } = await import("../../src/lib/cors-handler.js");
      expect(vi.mocked(CorsHandler.addCorsHeaders)).toHaveBeenCalled();
      expect(result.status).toBe(200);
    });

    it("should return 401 when authentication is required but session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const handler = vi.fn();

      const result = await routeHelpers.wrapHandler(handler, mockContext, true);

      expect(handler).not.toHaveBeenCalled();
      const { CorsHandler } = await import("../../src/lib/cors-handler.js");
      expect(vi.mocked(CorsHandler.addCorsHeaders)).toHaveBeenCalled();
      expect(result.status).toBe(401);
    });

    it("should handle handler errors", async () => {
      const mockSession = {
        userId: "user-123",
        email: "user@example.com",
      };
      mockGetSession.mockResolvedValue(mockSession);

      const error = new Error("Handler error");
      const handler = vi.fn(async () => {
        throw error;
      });

      const result = await routeHelpers.wrapHandler(handler, mockContext, true);

            expect(mockSanitizeError).toHaveBeenCalledWith(error);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining('"error"'),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
      const { CorsHandler } = await import("../../src/lib/cors-handler.js");
      expect(vi.mocked(CorsHandler.addCorsHeaders)).toHaveBeenCalled();
      expect(result.status).toBe(500);
    });
  });

  describe("extractPathParam", () => {
    it("should extract path parameter successfully", () => {
      const result = routeHelpers.extractPathParam(
        "/api/posts/post-123",
        "/api/posts/",
      );
      expect(result).toBe("post-123");
    });

    it("should return null when pathname does not start with prefix", () => {
      const result = routeHelpers.extractPathParam(
        "/api/comments/comment-123",
        "/api/posts/",
      );
      expect(result).toBeNull();
    });

    it("should return null when pathname equals prefix", () => {
      const result = routeHelpers.extractPathParam(
        "/api/posts/",
        "/api/posts/",
      );
      expect(result).toBeNull();
    });

    it("should handle empty pathname", () => {
      const result = routeHelpers.extractPathParam("", "/api/posts/");
      expect(result).toBeNull();
    });
  });
});

describe("Legacy functions", () => {
  let mockEnv: Env;
  let mockRequest: Request;
  let mockContext: RouteHandlerContext;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockRequest = new Request("https://example.com/api/test", {
      method: "GET",
    });

    const mockUrl = new URL("https://example.com/api/test");
    mockContext = {
      request: mockRequest,
      env: mockEnv,
      url: mockUrl,
      pathname: "/api/test",
      params: {},
    };

    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
    // Reset CorsHandler mock
    const { CorsHandler } = await import("../../src/lib/cors-handler.js");
    vi.mocked(CorsHandler.addCorsHeaders).mockClear();
    vi.mocked(CorsHandler.addCorsHeaders).mockImplementation(
      async (response: Response) => response,
    );
  });

  describe("getSession", () => {
    it("should get session using RouteHelpers", async () => {
      const mockSession = {
        userId: "user-123",
        email: "user@example.com",
      };
      mockGetSession.mockResolvedValue(mockSession);

      const result = await getSession(mockRequest, mockEnv);

      expect(result).toEqual(mockSession);
    });
  });

  describe("requireAuth (legacy)", () => {
    it("should require authentication using RouteHelpers", async () => {
      mockGetSession.mockResolvedValue(null);

      const result = await requireAuth(mockContext);

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });
  });

  describe("wrapHandler (legacy)", () => {
    it("should wrap handler using RouteHelpers", async () => {
      const mockSession = {
        userId: "user-123",
        email: "user@example.com",
      };
      mockGetSession.mockResolvedValue(mockSession);

      const handler = vi.fn(async (context) => {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });

      const result = await wrapHandler(handler, mockContext, true);

      expect(result.status).toBe(200);
    });
  });

  describe("extractPathParam (legacy)", () => {
    it("should extract path parameter", () => {
      const result = extractPathParam("/api/posts/post-123", "/api/posts/");
      expect(result).toBe("post-123");
    });
  });
});
