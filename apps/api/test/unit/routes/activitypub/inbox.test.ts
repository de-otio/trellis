/**
 * Unit Tests: ActivityPub Inbox Routes
 *
 * Tests for ActivityPub inbox route handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { inboxRoutes } from "../../../../src/lib/routes/activitypub/inbox.js";

// Mock processInboxActivity
const mockProcessInboxActivity = vi.fn();
vi.mock("../../../../src/lib/activitypub/listeners/inbox", () => ({
  processInboxActivity: (...args: any[]) => mockProcessInboxActivity(...args),
}));

// Mock SessionManager (the inbox collection is owner-only)
const mockGetSession = vi.fn();
vi.mock("../../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
vi.mock("../../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    constructor(env: any) {}
  },
}));

// Mock addCorsHeaders
const mockAddCorsHeaders = vi.fn();
vi.mock("../../../../src/worker", () => ({
  addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args),
}));

// Mock ActivityService
const mockGetInboxActivities = vi.fn();
const mockGetInboxCount = vi.fn();
vi.mock("../../../../src/lib/activitypub/activity-service", () => ({
  ActivityService: {
    getInboxActivities: (...args: any[]) => mockGetInboxActivities(...args),
    getInboxCount: (...args: any[]) => mockGetInboxCount(...args),
  },
}));

// Mock withQueryTimeoutAndRetry
const mockWithQueryTimeoutAndRetry = vi.fn();
vi.mock("../../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    STANDARD: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock detectRegionSync
const mockDetectRegionSync = vi.fn();
vi.mock("../../../../src/lib/region-detection", () => ({
  detectRegionSync: (...args: any[]) => mockDetectRegionSync(...args),
}));

describe("ActivityPub Inbox Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockDb = {
      user: {
        findUnique: vi.fn(),
      },
      inboxActivity: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
    };

    mockRequest = new Request("https://example.com/users/testuser/inbox", {
      method: "POST",
      body: JSON.stringify({ type: "Create", object: { type: "Note" } }),
    });

    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddCorsHeaders.mockImplementation(async (response) => response);
    mockDetectRegionSync.mockReturnValue("US");
    // Default: the owner is logged in. Individual tests override this.
    mockGetSession.mockResolvedValue({ userId: "user-123" });
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (db, region, env, fn) => {
        return await fn(mockDb);
      },
    );
  });

  describe("POST /users/:username/inbox - Receive activity", () => {
    const route = inboxRoutes.find(
      (r) => r.method === "POST" && r.path === "/users/:username/inbox",
    );

    it("should process inbox activity successfully", async () => {
      mockProcessInboxActivity.mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "testuser" },
      });

      expect(mockProcessInboxActivity).toHaveBeenCalledWith(
        mockRequest,
        mockEnv,
        "testuser",
      );
      expect(mockCreateSecureResponse).toHaveBeenCalled();
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(response.status).toBe(202);
    });

    it("should handle errors from processInboxActivity", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Invalid activity" }),
        { status: 400 },
      );
      mockProcessInboxActivity.mockResolvedValue(errorResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "testuser" },
      });

      expect(response.status).toBe(400);
    });
  });

  describe("GET /users/:username/inbox - Get inbox activities", () => {
    const route = inboxRoutes.find(
      (r) => r.method === "GET" && r.path === "/users/:username/inbox",
    );

    it("should get inbox activities successfully", async () => {
      const mockUser = {
        id: "user-123",
        username: "testuser",
        actorUri: "https://example.com/users/testuser",
      };
      const mockActivities = [
        {
          type: "Create",
          actorUri: "actor-1",
          objectId: "object-1",
          published: new Date(),
        },
        {
          type: "Follow",
          actorUri: "actor-2",
          objectId: "object-2",
          published: new Date(),
        },
      ];
      mockDb.user.findUnique.mockResolvedValue(mockUser);
      mockGetInboxActivities.mockResolvedValue(mockActivities);
      mockGetInboxCount.mockResolvedValue(2);
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (db, region, env, fn) => {
          return await fn(mockDb);
        },
      );

      const request = new Request(
        "https://example.com/users/testuser/inbox?page=1&limit=20",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv, {
        params: { username: "testuser" },
      });

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
      expect(mockGetInboxActivities).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 404 when user is not found", async () => {
      mockDb.user.findUnique.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/users/nonexistent/inbox",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv, {
        params: { username: "nonexistent" },
      });

      expect(response.status).toBe(404);
    });

    const OWNER = {
      id: "user-123",
      username: "testuser",
      actorUri: "https://example.com/users/testuser",
    };
    const DENY = JSON.stringify({ error: "Not found" });

    it("refuses an ANONYMOUS reader (DP-12) with the not-found body", async () => {
      mockDb.user.findUnique.mockResolvedValue(OWNER);
      mockGetSession.mockResolvedValue(null);

      const response = await route!.handler(
        new Request("https://example.com/users/testuser/inbox", { method: "GET" }),
        mockEnv,
        { params: { username: "testuser" } },
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe(DENY);
      expect(mockGetInboxActivities).not.toHaveBeenCalled();
    });

    it("refuses ANOTHER user's session with the same body", async () => {
      mockDb.user.findUnique.mockResolvedValue(OWNER);
      mockGetSession.mockResolvedValue({ userId: "user-999" });

      const response = await route!.handler(
        new Request("https://example.com/users/testuser/inbox", { method: "GET" }),
        mockEnv,
        { params: { username: "testuser" } },
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe(DENY);
      expect(mockGetInboxActivities).not.toHaveBeenCalled();
    });

    it("unknown user and wrong user are indistinguishable to the caller", async () => {
      mockDb.user.findUnique.mockResolvedValue(null);
      const unknown = await route!.handler(
        new Request("https://example.com/users/nobody/inbox", { method: "GET" }),
        mockEnv,
        { params: { username: "nobody" } },
      );
      mockDb.user.findUnique.mockResolvedValue(OWNER);
      mockGetSession.mockResolvedValue({ userId: "user-999" });
      const wrong = await route!.handler(
        new Request("https://example.com/users/testuser/inbox", { method: "GET" }),
        mockEnv,
        { params: { username: "testuser" } },
      );
      expect(unknown.status).toBe(wrong.status);
      expect(await unknown.text()).toBe(await wrong.text());
    });

    it("should handle pagination parameters", async () => {
      const mockUser = {
        id: "user-123",
        username: "testuser",
        actorUri: "https://example.com/users/testuser",
      };
      mockDb.user.findUnique.mockResolvedValue(mockUser);
      mockGetInboxActivities.mockResolvedValue([]);
      mockGetInboxCount.mockResolvedValue(0);
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (db, region, env, fn) => {
          return await fn(mockDb);
        },
      );

      const request = new Request(
        "https://example.com/users/testuser/inbox?page=2&limit=10",
        {
          method: "GET",
        },
      );

      await route!.handler(request, mockEnv, {
        params: { username: "testuser" },
      });

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
      expect(mockGetInboxActivities).toHaveBeenCalledWith(
        mockDb,
        mockUser.actorUri,
        2,
        10,
      );
    });

    it("should handle database errors", async () => {
      const error = new Error("Database error");
      mockWithQueryTimeoutAndRetry.mockRejectedValue(error);

      const request = new Request("https://example.com/users/testuser/inbox", {
        method: "GET",
      });

      const response = await route!.handler(request, mockEnv, {
        params: { username: "testuser" },
      });

      // Logger error should be called
      expect(response.status).toBe(500);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(inboxRoutes.length).toBeGreaterThan(0);
    });

    it("should have middleware configured", () => {
      inboxRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions", () => {
      inboxRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
