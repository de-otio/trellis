/**
 * Unit Tests: Notifications Routes
 *
 * Tests for notification route handlers including list, mark read, and preferences management.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { notificationsRoutes } from "../../../src/lib/routes/notifications.js";
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

// Mock Validator
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));

// Mock NotificationHandler and NotificationNotFoundError
const mockGetNotifications = vi.fn();
const mockMarkRead = vi.fn();
const mockMarkAllRead = vi.fn();
const mockGetUnreadCount = vi.fn();
vi.mock("../../../src/lib/notification-handler", () => ({
  NotificationHandler: class {
    getNotifications = mockGetNotifications;
    markRead = mockMarkRead;
    markAllRead = mockMarkAllRead;
    getUnreadCount = mockGetUnreadCount;
  },
  NotificationNotFoundError: class NotificationNotFoundError extends Error {
    constructor(message?: string) {
      super(message || "Notification not found");
      this.name = "NotificationNotFoundError";
    }
  },
}));

// Mock NotificationPreferencesHandler
const mockGetPreferences = vi.fn();
const mockUpdatePreferences = vi.fn();
vi.mock("../../../src/lib/notification-preferences-handler", () => ({
  NotificationPreferencesHandler: class {
    getPreferences = mockGetPreferences;
    updatePreferences = mockUpdatePreferences;
  },
}));


// Mock authMiddleware
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const TEST_TENANT_ID = "tenant-test-123";

describe("Notifications Routes", () => {
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
      ageTier: "ADULT",
      expiresAt: new Date(Date.now() + 3600000),
    } as any;

    mockRequestContext = {
      tenantId: "tenant-123",
      userId: "user-123",
      region: "us-east-1",
    } as TrellisRequestContext;

    mockRequest = new Request("https://example.com/api/notifications", {
      method: "GET",
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
    // NotificationHandler methods return plain objects/void; the route handler
    // wraps them in a Response itself.
    mockGetNotifications.mockResolvedValue({ notifications: [], cursor: null });
    mockMarkRead.mockResolvedValue(undefined);
    mockMarkAllRead.mockResolvedValue(undefined);
    mockGetUnreadCount.mockResolvedValue({ hasUnread: false, count: 0 });
    // NotificationPreferencesHandler methods return Response directly.
    mockGetPreferences.mockResolvedValue(
      new Response(JSON.stringify({ preferences: {} }), { status: 200 }),
    );
    mockUpdatePreferences.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
  });

  describe("GET /api/notifications - List notifications", () => {
    const route = notificationsRoutes.find(
      (r) => r.method === "GET" && r.description === "List notifications",
    );

    it("should list notifications successfully", async () => {
      const mockResult = {
        notifications: [
          {
            id: "notif-1",
            message: "Test notification",
            read: false,
          },
        ],
        cursor: null,
      };
      mockGetNotifications.mockResolvedValue(mockResult);

      const url = new URL("https://example.com/api/notifications?limit=20");
      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/notifications",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        mockRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockGetNotifications).toHaveBeenCalledWith(
        "user-123",
        null,
        20,
        mockEnv,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(mockResult);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const url = new URL("https://example.com/api/notifications");
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/notifications",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockGetNotifications).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/notifications/:id/read - Mark single notification as read", () => {
    const route = notificationsRoutes.find(
      (r) =>
        r.method === "POST" &&
        r.description === "Mark notification as read",
    );

    it("should mark notification as read successfully", async () => {
      const markReadRequest = new Request(
        "https://example.com/api/notifications/notif-123/read",
        { method: "POST" },
      );

      const response = await route!.handler(markReadRequest, mockEnv, {
        pathname: "/api/notifications/notif-123/read",
        url: new URL("https://example.com/api/notifications/notif-123/read"),
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        markReadRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockMarkRead).toHaveBeenCalledWith(
        "user-123",
        "notif-123",
        mockEnv,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const markReadRequest = new Request(
        "https://example.com/api/notifications/notif-123/read",
        { method: "POST" },
      );

      await route!.handler(markReadRequest, mockEnv, {
        pathname: "/api/notifications/notif-123/read",
        url: new URL("https://example.com/api/notifications/notif-123/read"),
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockMarkRead).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/notifications/read-all - Mark all notifications as read", () => {
    const route = notificationsRoutes.find(
      (r) =>
        r.method === "POST" &&
        r.description === "Mark all notifications as read",
    );

    it("should mark all notifications as read successfully", async () => {
      const readAllRequest = new Request(
        "https://example.com/api/notifications/read-all",
        { method: "POST" },
      );

      const response = await route!.handler(readAllRequest, mockEnv, {
        pathname: "/api/notifications/read-all",
        url: new URL("https://example.com/api/notifications/read-all"),
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        readAllRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockMarkAllRead).toHaveBeenCalledWith("user-123", mockEnv, TEST_TENANT_ID);
      expect(mockAddSecurityHeaders).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const readAllRequest = new Request(
        "https://example.com/api/notifications/read-all",
        { method: "POST" },
      );

      await route!.handler(readAllRequest, mockEnv, {
        pathname: "/api/notifications/read-all",
        url: new URL("https://example.com/api/notifications/read-all"),
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockMarkAllRead).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/notifications/unread-count - Get unread notification count", () => {
    const route = notificationsRoutes.find(
      (r) =>
        r.method === "GET" &&
        r.description === "Get unread notification count",
    );

    it("should get unread count successfully", async () => {
      const mockResult = { hasUnread: true, count: 5 };
      mockGetUnreadCount.mockResolvedValue(mockResult);

      const url = new URL("https://example.com/api/notifications/unread-count");
      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/notifications/unread-count",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        mockRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockGetUnreadCount).toHaveBeenCalledWith(
        "user-123",
        "ADULT",
        mockEnv,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(mockResult);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const url = new URL("https://example.com/api/notifications/unread-count");
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/notifications/unread-count",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockGetUnreadCount).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/notifications/preferences - Get notification preferences", () => {
    const route = notificationsRoutes.find(
      (r) =>
        r.method === "GET" &&
        r.description === "Get notification preferences",
    );

    it("should get notification preferences successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({
          emailNotifications: true,
          pushNotifications: false,
        }),
        { status: 200 },
      );
      mockGetPreferences.mockResolvedValue(mockResponse);

      const url = new URL("https://example.com/api/notifications/preferences");
      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/notifications/preferences",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        mockRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockGetPreferences).toHaveBeenCalledWith("user-123", mockEnv);
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const url = new URL("https://example.com/api/notifications/preferences");
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/notifications/preferences",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockGetPreferences).not.toHaveBeenCalled();
    });
  });

  describe("PUT /api/notifications/preferences - Update notification preferences", () => {
    const route = notificationsRoutes.find(
      (r) =>
        r.method === "PUT" &&
        r.description === "Update notification preferences",
    );

    it("should update notification preferences successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ success: true }),
        { status: 200 },
      );
      mockUpdatePreferences.mockResolvedValue(mockResponse);

      const updateRequest = new Request(
        "https://example.com/api/notifications/preferences",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emailNotifications: true }),
        },
      );

      const response = await route!.handler(updateRequest, mockEnv, {
        pathname: "/api/notifications/preferences",
        url: new URL("https://example.com/api/notifications/preferences"),
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        updateRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockUpdatePreferences).toHaveBeenCalledWith(
        "user-123",
        "ADULT",
        { emailNotifications: true },
        mockEnv,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const updateRequest = new Request(
        "https://example.com/api/notifications/preferences",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emailNotifications: true }),
        },
      );

      await route!.handler(updateRequest, mockEnv, {
        pathname: "/api/notifications/preferences",
        url: new URL("https://example.com/api/notifications/preferences"),
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    });
  });

  describe("Route configuration", () => {
    it("should have 6 routes total", () => {
      expect(notificationsRoutes).toHaveLength(6);
    });

    it("should have correct methods for each route", () => {
      const listRoute = notificationsRoutes.find(
        (r) => r.description === "List notifications",
      );
      const markReadRoute = notificationsRoutes.find(
        (r) => r.description === "Mark notification as read",
      );
      const markAllRoute = notificationsRoutes.find(
        (r) => r.description === "Mark all notifications as read",
      );
      const unreadCountRoute = notificationsRoutes.find(
        (r) => r.description === "Get unread notification count",
      );
      const getPrefsRoute = notificationsRoutes.find(
        (r) => r.description === "Get notification preferences",
      );
      const updatePrefsRoute = notificationsRoutes.find(
        (r) => r.description === "Update notification preferences",
      );

      expect(listRoute!.method).toBe("GET");
      expect(markReadRoute!.method).toBe("POST");
      expect(markAllRoute!.method).toBe("POST");
      expect(unreadCountRoute!.method).toBe("GET");
      expect(getPrefsRoute!.method).toBe("GET");
      expect(updatePrefsRoute!.method).toBe("PUT");
    });

    it("should have middleware configured for all routes", () => {
      notificationsRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
        expect(Array.isArray(route.middleware)).toBe(true);
      });
    });

    it("should have descriptions for all routes", () => {
      notificationsRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
