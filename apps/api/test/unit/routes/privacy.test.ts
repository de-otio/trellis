/**
 * Unit Tests: Privacy Routes
 *
 * Tests for privacy route handlers including getting and updating privacy preferences.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { privacyRoutes } from "../../../src/lib/routes/privacy.js";
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

// Mock PrivacyHandler
const mockHandleGetPreferences = vi.fn();
const mockHandleUpdatePreferences = vi.fn();
vi.mock("../../../src/lib/privacy-handler", () => ({
  PrivacyHandler: class {
    handleGetPreferences = mockHandleGetPreferences;
    handleUpdatePreferences = mockHandleUpdatePreferences;
  },
}));

// Mock Validator
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));


describe("Privacy Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
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

    mockRequest = new Request(
      "https://example.com/api/user/privacy-preferences",
      {
        method: "GET",
      },
    );

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
  });

  describe("GET /api/user/privacy-preferences - Get privacy preferences", () => {
    const route = privacyRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/user/privacy-preferences",
    );

    it("should get privacy preferences successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({
          profileVisibility: "public",
          showEmail: false,
          showPhone: false,
        }),
        { status: 200 },
      );
      mockHandleGetPreferences.mockResolvedValue(mockResponse);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockHandleGetPreferences).toHaveBeenCalledWith(
        mockRequest,
        mockSession,
        mockEnv,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      await route!.handler(mockRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetPreferences).not.toHaveBeenCalled();
    });

    it("should handle errors from PrivacyHandler", async () => {
      const error = new Error("Database error");
      mockHandleGetPreferences.mockRejectedValue(error);
      mockSanitizeError.mockReturnValue("Database error");

      await route!.handler(mockRequest, mockEnv);

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Database error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("PUT /api/user/privacy-preferences - Update privacy preferences", () => {
    const route = privacyRoutes.find(
      (r) => r.method === "PUT" && r.path === "/api/user/privacy-preferences",
    );

    it("should update privacy preferences successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({
          success: true,
          profileVisibility: "private",
          showEmail: false,
        }),
        { status: 200 },
      );
      mockHandleUpdatePreferences.mockResolvedValue(mockResponse);

      const putRequest = new Request(
        "https://example.com/api/user/privacy-preferences",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            profileVisibility: "private",
            showEmail: false,
          }),
        },
      );

      const response = await route!.handler(putRequest, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(putRequest, "test-secret", mockEnv);
      expect(mockHandleUpdatePreferences).toHaveBeenCalledWith(
        putRequest,
        mockSession,
        mockEnv,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const putRequest = new Request(
        "https://example.com/api/user/privacy-preferences",
        {
          method: "PUT",
        },
      );

      await route!.handler(putRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleUpdatePreferences).not.toHaveBeenCalled();
    });

    it("should handle errors from PrivacyHandler", async () => {
      const error = new Error("Invalid preferences");
      mockHandleUpdatePreferences.mockRejectedValue(error);
      mockSanitizeError.mockReturnValue("Invalid preferences");

      const putRequest = new Request(
        "https://example.com/api/user/privacy-preferences",
        {
          method: "PUT",
          body: JSON.stringify({ invalid: "data" }),
        },
      );

      await route!.handler(putRequest, mockEnv);

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Invalid preferences" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(privacyRoutes).toHaveLength(2);
      expect(privacyRoutes.some((r) => r.method === "GET")).toBe(true);
      expect(privacyRoutes.some((r) => r.method === "PUT")).toBe(true);
    });

    it("should have middleware configured for GET route", () => {
      const getRoute = privacyRoutes.find((r) => r.method === "GET");
      expect(getRoute?.middleware).toBeDefined();
    });

    it("should have middleware configured for PUT route", () => {
      const putRoute = privacyRoutes.find((r) => r.method === "PUT");
      expect(putRoute?.middleware).toBeDefined();
      expect(putRoute?.middleware?.length).toBeGreaterThan(0);
    });

    it("should have descriptions for all routes", () => {
      privacyRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
