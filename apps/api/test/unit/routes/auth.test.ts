/**
 * Unit Tests: Auth Routes
 *
 * Tests for authentication route handlers including /auth/* and /api/auth/* endpoints.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { authRoutes } from "../../../src/lib/routes/auth.js";

// Mock RateLimiter
const mockRateLimiter = {
  applyRateLimitKV: vi.fn(),
};
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    constructor() {
      return mockRateLimiter;
    }
  },
}));

// Mock SecurityHeaders
const mockSecurityHeaders = {
  createSecureResponse: vi.fn(),
  addSecurityHeaders: vi.fn(),
};
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    constructor(env: any) {
      return mockSecurityHeaders;
    }
  },
}));

// Mock handleAuthRoutes
const mockHandleAuthRoutes = vi.fn();
vi.mock("../../../src/worker", () => ({
  handleAuthRoutes: (...args: any[]) => mockHandleAuthRoutes(...args),
}));

describe("Auth Routes", () => {
  let mockEnv: Env;
  let mockRequestContext: TrellisRequestContext;
  let mockRequest: Request;
  let mockUrl: URL;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockRequestContext = {
      tenantId: "tenant-123",
      userId: "user-123",
      region: "us-east-1",
    } as TrellisRequestContext;

    mockUrl = new URL("https://example.com/auth/login");
    mockRequest = new Request(mockUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "test@example.com",
        password: "password123",
      }),
    });

    mockHandleAuthRoutes.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
  });

  describe("POST /auth/* - Authentication routes", () => {
    const route = authRoutes.find(
      (r) => r.method === "*" && r.path === "/auth/*",
    );

    it("should handle auth routes successfully", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        url: mockUrl,
        requestContext: mockRequestContext,
      });

      expect(mockHandleAuthRoutes).toHaveBeenCalledWith(
        mockRequest,
        mockEnv,
        mockUrl,
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );
      expect(response.status).toBe(200);
    });

    it("should handle GET requests", async () => {
      const getUrl = new URL("https://example.com/auth/status");
      const getRequest = new Request(getUrl.toString(), {
        method: "GET",
      });

      await route!.handler(getRequest, mockEnv, {
        url: getUrl,
        requestContext: mockRequestContext,
      });

      expect(mockHandleAuthRoutes).toHaveBeenCalledWith(
        getRequest,
        mockEnv,
        getUrl,
        mockRateLimiter,
        mockSecurityHeaders,
        mockRequestContext,
      );
    });

    it("should handle errors from handleAuthRoutes", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Invalid credentials" }),
        { status: 401 },
      );
      mockHandleAuthRoutes.mockResolvedValue(errorResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        url: mockUrl,
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(401);
    });
  });

  describe("POST /api/auth/* - API authentication routes (aliased)", () => {
    const route = authRoutes.find(
      (r) => r.method === "*" && r.path === "/api/auth/*",
    );

    it("should rewrite /api/auth/* to /auth/* and handle successfully", async () => {
      const apiUrl = new URL("https://example.com/api/auth/login");
      // Use GET to avoid body/duplex issues in Node.js Request constructor
      const apiRequest = new Request(apiUrl.toString(), {
        method: "GET",
      });

      const response = await route!.handler(apiRequest, mockEnv, {
        url: apiUrl,
        pathname: "/api/auth/login",
        requestContext: mockRequestContext,
      });

      // Verify the URL was rewritten
      expect(mockHandleAuthRoutes).toHaveBeenCalled();
      const callArgs = mockHandleAuthRoutes.mock.calls[0];
      const rewrittenRequest = callArgs[0];
      const rewrittenUrl = callArgs[2];

      expect(rewrittenUrl.pathname).toBe("/auth/login");
      expect(rewrittenRequest.url).toContain("/auth/login");
      expect(response.status).toBe(200);
    });

    it("should preserve request method and headers in rewritten request", async () => {
      const apiUrl = new URL("https://example.com/api/auth/logout");
      const apiRequest = new Request(apiUrl.toString(), {
        method: "DELETE",
        headers: {
          Authorization: "Bearer token123",
          "Content-Type": "application/json",
        },
        // No body for DELETE request to avoid duplex requirement
      });

      await route!.handler(apiRequest, mockEnv, {
        url: apiUrl,
        pathname: "/api/auth/logout",
        requestContext: mockRequestContext,
      });

      const callArgs = mockHandleAuthRoutes.mock.calls[0];
      const rewrittenRequest = callArgs[0];

      expect(rewrittenRequest.method).toBe("DELETE");
      expect(rewrittenRequest.headers.get("Authorization")).toBe(
        "Bearer token123",
      );
    });

    it("should handle different auth endpoints", async () => {
      const endpoints = [
        "/api/auth/register",
        "/api/auth/verify",
        "/api/auth/reset-password",
      ];

      for (const endpoint of endpoints) {
        vi.clearAllMocks();
        const url = new URL(`https://example.com${endpoint}`);
        // Use GET method to avoid body/duplex issues
        const request = new Request(url.toString(), {
          method: "GET",
        });

        await route!.handler(request, mockEnv, {
          url,
          pathname: endpoint,
          requestContext: mockRequestContext,
        });

        const callArgs = mockHandleAuthRoutes.mock.calls[0];
        const rewrittenUrl = callArgs[2];
        expect(rewrittenUrl.pathname).toBe(
          endpoint.replace("/api/auth", "/auth"),
        );
      }
    });

    it("should handle errors from handleAuthRoutes", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429 },
      );
      mockHandleAuthRoutes.mockResolvedValue(errorResponse);

      const apiUrl = new URL("https://example.com/api/auth/login");
      const apiRequest = new Request(apiUrl.toString(), {
        method: "POST",
      });

      const response = await route!.handler(apiRequest, mockEnv, {
        url: apiUrl,
        pathname: "/api/auth/login",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(429);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(authRoutes).toHaveLength(2);
      expect(authRoutes.every((r) => r.method === "*")).toBe(true);
    });

    it("should have middleware configured for all routes", () => {
      authRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      authRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
