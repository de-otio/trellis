/**
 * Unit Tests: Badges Routes
 *
 * Tests for badge route handlers including getting user badges and updating badge display.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { badgesRoutes } from "../../../src/lib/routes/badges.js";

// Mock BadgeHandler
const mockHandleGetUserBadges = vi.fn();
const mockHandleUpdateBadgeDisplay = vi.fn();
vi.mock("../../../src/lib/badge-handler", () => ({
  BadgeHandler: class {
    handleGetUserBadges = mockHandleGetUserBadges;
    handleUpdateBadgeDisplay = mockHandleUpdateBadgeDisplay;
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

// Mock addCorsHeaders
const mockAddCorsHeaders = vi.fn();
vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args),
}));

describe("Badges Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockRequest = new Request("https://example.com/api/users/user-123/badges", {
      method: "GET",
    });

    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockAddCorsHeaders.mockImplementation(async (response) => response);
  });

  describe("GET /api/users/:userId/badges - Get user badges", () => {
    const route = badgesRoutes.find(
      (r) => r.method === "GET" && r.path.toString().includes("badges"),
    );

    it("should get user badges successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ badges: [{ id: "badge-1", name: "Test Badge" }] }),
        { status: 200 },
      );
      mockHandleGetUserBadges.mockResolvedValue(mockResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/users/user-123/badges",
      });

      expect(mockHandleGetUserBadges).toHaveBeenCalledWith(
        mockRequest,
        mockEnv,
        "user-123",
      );
      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        mockResponse,
        mockRequest,
        mockEnv,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 400 for invalid path", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/users/invalid/path/badges",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Invalid path" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(mockHandleGetUserBadges).not.toHaveBeenCalled();
    });

    it("should handle errors from BadgeHandler", async () => {
      const error = new Error("Database error");
      mockHandleGetUserBadges.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/users/user-123/badges",
      });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Failed to get user badges" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });

    it("should extract userId correctly from pathname", async () => {
      const mockResponse = new Response(JSON.stringify({ badges: [] }), {
        status: 200,
      });
      mockHandleGetUserBadges.mockResolvedValue(mockResponse);

      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/users/another-user-id/badges",
      });

      expect(mockHandleGetUserBadges).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "another-user-id",
      );
    });
  });

  describe("PATCH /api/users/:userId/badges/display - Update badge display", () => {
    const route = badgesRoutes.find(
      (r) => r.method === "PATCH" && r.path.toString().includes("display"),
    );

    it("should update badge display successfully", async () => {
      const mockResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
      mockHandleUpdateBadgeDisplay.mockResolvedValue(mockResponse);

      const patchRequest = new Request(
        "https://example.com/api/users/user-123/badges/display",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ badgeIds: ["badge-1", "badge-2"] }),
        },
      );

      const response = await route!.handler(patchRequest, mockEnv, {
        pathname: "/api/users/user-123/badges/display",
      });

      expect(mockHandleUpdateBadgeDisplay).toHaveBeenCalledWith(
        patchRequest,
        mockEnv,
        "user-123",
      );
      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        mockResponse,
        patchRequest,
        mockEnv,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 400 for invalid path", async () => {
      const patchRequest = new Request(
        "https://example.com/api/users/invalid/path/badges/display",
        {
          method: "PATCH",
        },
      );

      const response = await route!.handler(patchRequest, mockEnv, {
        pathname: "/api/users/invalid/path/badges/display",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Invalid path" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(mockHandleUpdateBadgeDisplay).not.toHaveBeenCalled();
    });

    it("should handle errors from BadgeHandler", async () => {
      const error = new Error("Database error");
      mockHandleUpdateBadgeDisplay.mockRejectedValue(error);

      const patchRequest = new Request(
        "https://example.com/api/users/user-123/badges/display",
        {
          method: "PATCH",
        },
      );

      const response = await route!.handler(patchRequest, mockEnv, {
        pathname: "/api/users/user-123/badges/display",
      });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Failed to update badge display" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });

    it("should extract userId correctly from pathname", async () => {
      const mockResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
      mockHandleUpdateBadgeDisplay.mockResolvedValue(mockResponse);

      const patchRequest = new Request(
        "https://example.com/api/users/another-user-id/badges/display",
        {
          method: "PATCH",
        },
      );

      await route!.handler(patchRequest, mockEnv, {
        pathname: "/api/users/another-user-id/badges/display",
      });

      expect(mockHandleUpdateBadgeDisplay).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "another-user-id",
      );
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(badgesRoutes).toHaveLength(2);
      expect(badgesRoutes.some((r) => r.method === "GET")).toBe(true);
      expect(badgesRoutes.some((r) => r.method === "PATCH")).toBe(true);
    });

    it("should have middleware configured for GET route", () => {
      const getRoute = badgesRoutes.find((r) => r.method === "GET");
      expect(getRoute?.middleware).toBeDefined();
    });

    it("should have middleware configured for PATCH route", () => {
      const patchRoute = badgesRoutes.find((r) => r.method === "PATCH");
      expect(patchRoute?.middleware).toBeDefined();
      expect(patchRoute?.middleware?.length).toBeGreaterThan(0);
    });

    it("should have descriptions for all routes", () => {
      badgesRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
