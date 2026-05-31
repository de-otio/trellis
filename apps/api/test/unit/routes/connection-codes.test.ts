/**
 * Unit Tests: Connection Code Routes
 *
 * Tests for connection code route handlers including generate, redeem, list, and revoke.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { connectionCodeRoutes } from "../../../src/lib/routes/connection-codes.js";
import type { Session } from "../../../src/lib/session-cookie.js";

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
const mockAddSecurityHeaders = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
    constructor(env: any) {}
  },
}));

// Mock ConnectionCodeHandler
const mockHandleGenerate = vi.fn();
const mockHandleRedeem = vi.fn();
const mockHandleGetMyCodes = vi.fn();
const mockHandleRevoke = vi.fn();
vi.mock("../../../src/lib/connection-code-handler", () => ({
  ConnectionCodeHandler: class {
    handleGenerate = mockHandleGenerate;
    handleRedeem = mockHandleRedeem;
    handleGetMyCodes = mockHandleGetMyCodes;
    handleRevoke = mockHandleRevoke;
  },
}));


// Mock authMiddleware
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const TEST_TENANT_ID = "tenant-test-123";

describe("Connection Code Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockSession = {
      userId: "user-123",
      tenantId: "tenant-123",
      expiresAt: new Date(Date.now() + 3600000),
    } as Session;

    mockRequestContext = {
      tenantId: "tenant-123",
      userId: "user-123",
      region: "us-east-1",
    } as TrellisRequestContext;

    mockRequest = new Request("https://example.com/api/connection-codes", {
      method: "POST",
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockAuthMiddleware.mockResolvedValue({
      userId: "user-123",
      activeTenantId: TEST_TENANT_ID,
    });
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockHandleGenerate.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleRedeem.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleGetMyCodes.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleRevoke.mockResolvedValue(new Response("{}", { status: 200 }));
  });

  describe("POST /api/connection-codes - Generate connection code", () => {
    const route = connectionCodeRoutes.find(
      (r) => r.method === "POST" && r.description === "Generate connection code",
    );

    it("should generate connection code successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ code: "ABC123", expiresAt: "2025-04-13T00:00:00Z" }),
        { status: 201 },
      );
      mockHandleGenerate.mockResolvedValue(mockResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        mockRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleGenerate).toHaveBeenCalledWith(
        mockRequest,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(201);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      await route!.handler(mockRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGenerate).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/connection-codes/redeem - Redeem connection code", () => {
    const route = connectionCodeRoutes.find(
      (r) => r.method === "POST" && r.description === "Redeem connection code",
    );

    it("should redeem connection code successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ success: true, userId: "user-456" }),
        { status: 200 },
      );
      mockHandleRedeem.mockResolvedValue(mockResponse);

      const redeemRequest = new Request(
        "https://example.com/api/connection-codes/redeem",
        { method: "POST" },
      );

      const response = await route!.handler(redeemRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        redeemRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleRedeem).toHaveBeenCalledWith(
        redeemRequest,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const redeemRequest = new Request(
        "https://example.com/api/connection-codes/redeem",
        { method: "POST" },
      );

      await route!.handler(redeemRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleRedeem).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/connection-codes - Get my connection codes", () => {
    const route = connectionCodeRoutes.find(
      (r) => r.method === "GET" && r.description === "Get my connection codes",
    );

    it("should get my connection codes successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({
          codes: [
            { code: "ABC123", expiresAt: "2025-04-13T00:00:00Z", used: false },
          ],
        }),
        { status: 200 },
      );
      mockHandleGetMyCodes.mockResolvedValue(mockResponse);

      const getRequest = new Request(
        "https://example.com/api/connection-codes",
        { method: "GET" },
      );

      const response = await route!.handler(getRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        getRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleGetMyCodes).toHaveBeenCalledWith(
        getRequest,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const getRequest = new Request(
        "https://example.com/api/connection-codes",
        { method: "GET" },
      );

      await route!.handler(getRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetMyCodes).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/connection-codes - Revoke connection code", () => {
    const route = connectionCodeRoutes.find(
      (r) => r.method === "DELETE" && r.description === "Revoke connection code",
    );

    it("should revoke connection code successfully", async () => {
      const mockResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
      mockHandleRevoke.mockResolvedValue(mockResponse);

      const deleteRequest = new Request(
        "https://example.com/api/connection-codes",
        { method: "DELETE" },
      );

      const response = await route!.handler(deleteRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        deleteRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleRevoke).toHaveBeenCalledWith(
        deleteRequest,
        mockSession,
        mockEnv,
        mockRequestContext,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const deleteRequest = new Request(
        "https://example.com/api/connection-codes",
        { method: "DELETE" },
      );

      await route!.handler(deleteRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleRevoke).not.toHaveBeenCalled();
    });
  });

  describe("Route configuration", () => {
    it("should have 4 routes total", () => {
      expect(connectionCodeRoutes).toHaveLength(4);
    });

    it("should have correct methods for each route", () => {
      const generateRoute = connectionCodeRoutes.find(
        (r) => r.description === "Generate connection code",
      );
      const redeemRoute = connectionCodeRoutes.find(
        (r) => r.description === "Redeem connection code",
      );
      const getRoute = connectionCodeRoutes.find(
        (r) => r.description === "Get my connection codes",
      );
      const revokeRoute = connectionCodeRoutes.find(
        (r) => r.description === "Revoke connection code",
      );

      expect(generateRoute!.method).toBe("POST");
      expect(redeemRoute!.method).toBe("POST");
      expect(getRoute!.method).toBe("GET");
      expect(revokeRoute!.method).toBe("DELETE");
    });

    it("should have middleware configured for all routes", () => {
      connectionCodeRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
        expect(Array.isArray(route.middleware)).toBe(true);
      });
    });

    it("should have descriptions for all routes", () => {
      connectionCodeRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
