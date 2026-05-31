/**
 * Unit Tests: Friends Routes
 *
 * Tests for friend route handlers including getting friends, generating connection codes, and connecting.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { friendsRoutes } from "../../../src/lib/routes/friends.js";
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

// Mock FriendsHandler
const mockHandleGetFriends = vi.fn();
const mockHandleGenerateConnectionCode = vi.fn();
const mockHandleConnect = vi.fn();
const mockHandleConnectFromInvitation = vi.fn();
vi.mock("../../../src/lib/friends-handler", () => ({
  FriendsHandler: class {
    handleGetFriends = mockHandleGetFriends;
    handleGenerateConnectionCode = mockHandleGenerateConnectionCode;
    handleConnect = mockHandleConnect;
    handleConnectFromInvitation = mockHandleConnectFromInvitation;
  },
}));

// Mock Validator
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));


describe("Friends Routes", () => {
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

    mockRequest = new Request("https://example.com/api/friends", {
      method: "GET",
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
  });

  describe("GET /api/friends - Get friends list", () => {
    const route = friendsRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/friends",
    );

    it("should get friends list successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ friends: [], cursor: null }),
        { status: 200 },
      );
      mockHandleGetFriends.mockResolvedValue(mockResponse);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockHandleGetFriends).toHaveBeenCalledWith(
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
      expect(mockHandleGetFriends).not.toHaveBeenCalled();
    });

    it("should handle errors from FriendsHandler", async () => {
      const error = new Error("Database error");
      mockHandleGetFriends.mockRejectedValue(error);
      mockSanitizeError.mockReturnValue("Database error");

      await route!.handler(mockRequest, mockEnv);

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Database error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("POST /api/friends/connection-code - Generate connection code", () => {
    const route = friendsRoutes.find(
      (r) => r.method === "POST" && r.path === "/api/friends/connection-code",
    );

    it("should generate connection code successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ code: "ABC123", expiresAt: new Date().toISOString() }),
        { status: 200 },
      );
      mockHandleGenerateConnectionCode.mockResolvedValue(mockResponse);

      const postRequest = new Request(
        "https://example.com/api/friends/connection-code",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      const response = await route!.handler(postRequest, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(postRequest, "test-secret", mockEnv);
      expect(mockHandleGenerateConnectionCode).toHaveBeenCalledWith(
        postRequest,
        mockSession,
        mockEnv,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const postRequest = new Request(
        "https://example.com/api/friends/connection-code",
        {
          method: "POST",
        },
      );

      await route!.handler(postRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGenerateConnectionCode).not.toHaveBeenCalled();
    });

    it("should handle errors from FriendsHandler", async () => {
      const error = new Error("Failed to generate code");
      mockHandleGenerateConnectionCode.mockRejectedValue(error);
      mockSanitizeError.mockReturnValue("Failed to generate code");

      const postRequest = new Request(
        "https://example.com/api/friends/connection-code",
        {
          method: "POST",
        },
      );

      await route!.handler(postRequest, mockEnv);

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Failed to generate code" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("POST /api/friends/connect - Connect with friend", () => {
    const route = friendsRoutes.find(
      (r) => r.method === "POST" && r.path === "/api/friends/connect",
    );

    it("should connect with friend successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ success: true, friendId: "friend-123" }),
        { status: 200 },
      );
      mockHandleConnect.mockResolvedValue(mockResponse);

      const postRequest = new Request(
        "https://example.com/api/friends/connect",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code: "ABC123" }),
        },
      );

      const response = await route!.handler(postRequest, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(postRequest, "test-secret", mockEnv);
      expect(mockHandleConnect).toHaveBeenCalledWith(
        postRequest,
        mockSession,
        mockEnv,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const postRequest = new Request(
        "https://example.com/api/friends/connect",
        {
          method: "POST",
        },
      );

      await route!.handler(postRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleConnect).not.toHaveBeenCalled();
    });

    it("should handle errors from FriendsHandler", async () => {
      const error = new Error("Invalid connection code");
      mockHandleConnect.mockRejectedValue(error);
      mockSanitizeError.mockReturnValue("Invalid connection code");

      const postRequest = new Request(
        "https://example.com/api/friends/connect",
        {
          method: "POST",
        },
      );

      await route!.handler(postRequest, mockEnv);

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Invalid connection code" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("POST /api/friends/connect-from-invitation - Connect from invitation", () => {
    const route = friendsRoutes.find(
      (r) =>
        r.method === "POST" &&
        r.path === "/api/friends/connect-from-invitation",
    );

    it("should connect from invitation successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ success: true, friendId: "friend-123" }),
        { status: 200 },
      );
      mockHandleConnectFromInvitation.mockResolvedValue(mockResponse);

      const postRequest = new Request(
        "https://example.com/api/friends/connect-from-invitation",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ invitationId: "inv-123" }),
        },
      );

      const response = await route!.handler(postRequest, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(postRequest, "test-secret", mockEnv);
      expect(mockHandleConnectFromInvitation).toHaveBeenCalledWith(
        postRequest,
        mockSession,
        mockEnv,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const postRequest = new Request(
        "https://example.com/api/friends/connect-from-invitation",
        {
          method: "POST",
        },
      );

      await route!.handler(postRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleConnectFromInvitation).not.toHaveBeenCalled();
    });

    it("should handle errors from FriendsHandler", async () => {
      const error = new Error("Invitation not found");
      mockHandleConnectFromInvitation.mockRejectedValue(error);
      mockSanitizeError.mockReturnValue("Invitation not found");

      const postRequest = new Request(
        "https://example.com/api/friends/connect-from-invitation",
        {
          method: "POST",
        },
      );

      await route!.handler(postRequest, mockEnv);

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Invitation not found" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(friendsRoutes).toHaveLength(4);
      expect(friendsRoutes.filter((r) => r.method === "GET")).toHaveLength(1);
      expect(friendsRoutes.filter((r) => r.method === "POST")).toHaveLength(3);
    });

    it("should have middleware configured for GET route", () => {
      const getRoute = friendsRoutes.find((r) => r.method === "GET");
      expect(getRoute?.middleware).toBeDefined();
    });

    it("should have middleware configured for POST routes", () => {
      const postRoutes = friendsRoutes.filter((r) => r.method === "POST");
      postRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
        expect(route.middleware?.length).toBeGreaterThan(0);
      });
    });

    it("should have descriptions for all routes", () => {
      friendsRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
