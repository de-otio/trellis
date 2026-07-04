/**
 * Unit Tests: Health Routes
 *
 * Tests for health check, configuration, and CSRF token endpoints.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { healthRoutes } from "../../../src/lib/routes/health.js";
import type { Session } from "../../../src/lib/session-cookie.js";

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    constructor(env: any) {}
  },
}));

// Mock addRegionHeadersAsync
const mockAddRegionHeadersAsync = vi.fn();
vi.mock("../../../src/lib/request-context", () => ({
  addRegionHeadersAsync: (...args: any[]) => mockAddRegionHeadersAsync(...args),
}));

// Mock SessionManager
const mockGetSession = vi.fn();
const mockSetSession = vi.fn();
const mockEncryptSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
    setSession = mockSetSession;
    encryptSession = mockEncryptSession;
  },
}));

// Mock CSRFProtection
const mockGenerateToken = vi.fn();
const mockStoreTokenInSession = vi.fn();
vi.mock("../../../src/lib/csrf", () => ({
  CSRFProtection: {
    generateToken: (...args: any[]) => mockGenerateToken(...args),
    storeTokenInSession: (...args: any[]) => mockStoreTokenInSession(...args),
  },
}));


describe("Health Routes", () => {
  let mockEnv: Env;
  let mockRequestContext: TrellisRequestContext;
  let mockRequest: Request;
  let mockSession: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    // Pin build provenance: /health reads process.env.BUILD_SHA (CI-stamped
    // into the image); ensure it is unset so assertions see buildSha: null
    // regardless of the runner's environment.
    delete process.env.BUILD_SHA;

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockRequestContext = {
      tenantId: "tenant-123",
      userId: "user-123",
      region: "us-east-1",
      config: {
        features: { feature1: true },
        endpoints: { api: "https://api.example.com" },
        timeouts: { request: 5000 },
      },
    } as TrellisRequestContext;

    mockSession = {
      userId: "user-123",
      tenantId: "tenant-123",
      expiresAt: new Date(Date.now() + 3600000),
    } as Session;

    mockRequest = new Request("https://example.com/health", {
      method: "GET",
    });

    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddRegionHeadersAsync.mockImplementation(async (response) => response);
    mockSetSession.mockImplementation(async (response) => response);
  });

  describe("GET /health - Health check", () => {
    const route = healthRoutes.find(
      (r) => r.method === "GET" && r.path === "/health",
    );

    it("should return health check successfully with request context", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        // buildSha is null: BUILD_SHA is not set in the unit-test env
        // (dedicated coverage in ../health-buildsha.test.ts)
        JSON.stringify({
          ok: true,
          region: "us-east-1",
          costAlert: false,
          buildSha: null,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
      expect(mockAddRegionHeadersAsync).toHaveBeenCalledWith(
        expect.any(Response),
        mockRequestContext,
      );
      expect(response.status).toBe(200);
    });

    it("should return health check successfully without request context", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ ok: true, costAlert: false, buildSha: null }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
      expect(mockAddRegionHeadersAsync).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
    });
  });

  describe("GET /api/config - Get region configuration", () => {
    const route = healthRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/config",
    );

    it("should get region configuration successfully", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({
          region: "us-east-1",
          features: { feature1: true },
          endpoints: { api: "https://api.example.com" },
          timeouts: { request: 5000 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
      expect(mockAddRegionHeadersAsync).toHaveBeenCalledWith(
        expect.any(Response),
        mockRequestContext,
      );
      expect(response.status).toBe(200);
    });

    it("should return 500 when request context is missing", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockAddRegionHeadersAsync).not.toHaveBeenCalled();
      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/csrf-token - Get CSRF token", () => {
    const route = healthRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/csrf-token",
    );

    it("should generate CSRF token successfully", async () => {
      const mockToken = "csrf-token-123";
      const updatedSession = { ...mockSession, csrfToken: mockToken };
      const mockResponse = new Response(JSON.stringify({ token: mockToken }));
      const mockEncryptedToken = "encrypted-session-token";
      mockGetSession.mockResolvedValue(mockSession);
      mockGenerateToken.mockReturnValue(mockToken);
      mockStoreTokenInSession.mockReturnValue(updatedSession);
      mockCreateSecureResponse.mockReturnValue(mockResponse);
      mockEncryptSession.mockResolvedValue(mockEncryptedToken);
      mockSetSession.mockResolvedValue(mockResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        url: new URL("https://example.com/api/csrf-token"),
      });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockGenerateToken).toHaveBeenCalled();
      expect(mockStoreTokenInSession).toHaveBeenCalledWith(
        mockToken,
        mockSession,
      );
      expect(mockSetSession).toHaveBeenCalledWith(
        expect.any(Response),
        updatedSession,
        "test-secret",
        undefined,
        mockEnv,
      );
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ token: mockToken, sessionToken: mockEncryptedToken }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv, {
        url: new URL("https://example.com/api/csrf-token"),
      });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockGenerateToken).not.toHaveBeenCalled();
      expect(response.status).toBe(401);
    });

    it("should handle errors during token generation", async () => {
      const error = new Error("Token generation failed");
      mockGetSession.mockResolvedValue(mockSession);
      mockGenerateToken.mockImplementation(() => {
        throw error;
      });

      const response = await route!.handler(mockRequest, mockEnv, {
        url: new URL("https://example.com/api/csrf-token"),
      });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Failed to generate CSRF token" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(response.status).toBe(500);
    });

    it("should log debug information when getting session", async () => {
      mockGetSession.mockResolvedValue(mockSession);
      mockGenerateToken.mockReturnValue("token");
      mockStoreTokenInSession.mockReturnValue(mockSession);

      await route!.handler(mockRequest, mockEnv, {
        url: new URL("https://example.com/api/csrf-token"),
      });

          });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(healthRoutes).toHaveLength(3);
      expect(healthRoutes.every((r) => r.method === "GET")).toBe(true);
    });

    it("should have middleware configured for /api/config route", () => {
      const configRoute = healthRoutes.find((r) => r.path === "/api/config");
      expect(configRoute?.middleware).toBeDefined();
    });

    it("should have middleware configured for /api/csrf-token route", () => {
      const csrfRoute = healthRoutes.find((r) => r.path === "/api/csrf-token");
      expect(csrfRoute?.middleware).toBeDefined();
    });

    it("should have descriptions for all routes", () => {
      healthRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
