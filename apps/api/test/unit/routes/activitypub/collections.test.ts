/**
 * Unit Tests: ActivityPub Collections Routes
 *
 * Tests for ActivityPub collection route handlers (followers, following).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { collectionRoutes } from "../../../../src/lib/routes/activitypub/collections.js";

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
vi.mock("../../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    constructor(env: any) {}
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

// Mock UserActorDispatcher
const mockGenerateActorUri = vi.fn();
vi.mock("../../../../src/lib/activitypub/dispatchers/user-actor", () => ({
  UserActorDispatcher: {
    generateActorUri: (...args: any[]) => mockGenerateActorUri(...args),
  },
}));

// Mock getFedifyContext
const mockGetFedifyContext = vi.fn();
vi.mock("../../../../src/lib/activitypub/fedify/context", () => ({
  getFedifyContext: (...args: any[]) => mockGetFedifyContext(...args),
}));

// Mock respondWithObject
const mockRespondWithObject = vi.fn();
vi.mock("@fedify/fedify", () => ({
  respondWithObject: (...args: any[]) => mockRespondWithObject(...args),
  OrderedCollection: class {
    constructor(data: any) {
      Object.assign(this, data);
    }
  },
}));

describe("ActivityPub Collections Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
      ACTIVITYPUB_BASE_URL: "https://example.com",
    } as any;

    mockDb = {
      user: {
        findUnique: vi.fn(),
      },
      follow: {
        count: vi.fn(),
      },
    };

    mockRequest = new Request("https://example.com/users/testuser/followers", {
      method: "GET",
    });

    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockDetectRegionSync.mockReturnValue("US");
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (db, region, env, fn) => {
        return await fn(mockDb);
      },
    );
    mockGenerateActorUri.mockReturnValue("https://example.com/users/testuser");
    mockRespondWithObject.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/activity+json" },
      }),
    );
  });

  describe("GET /users/:username/followers - Get followers collection", () => {
    const route = collectionRoutes.find(
      (r) => r.method === "GET" && r.path === "/users/:username/followers",
    );

    it("should get followers collection successfully", async () => {
      const mockUser = {
        id: "user-123",
        username: "testuser",
        actorUri: "https://example.com/users/testuser",
        suspended: false,
        deletionConfirmedAt: null,
      };
      mockDb.user.findUnique.mockResolvedValue(mockUser);
      // follow.count is no longer called — followers count comes from the graph DB (returns 0)

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "testuser" },
        url: new URL(mockRequest.url),
      });

      expect(mockDb.user.findUnique).toHaveBeenCalled();
      expect(mockRespondWithObject).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 400 when username is missing", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        params: {},
        url: new URL(mockRequest.url),
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Username is required" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
      expect(response.status).toBe(400);
    });

    it("should return 404 when user is not found", async () => {
      mockDb.user.findUnique.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "nonexistent" },
        url: new URL(mockRequest.url),
      });

      expect(response.status).toBe(404);
    });

    it("should return 404 when user is suspended", async () => {
      const mockUser = {
        id: "user-123",
        username: "testuser",
        actorUri: "https://example.com/users/testuser",
        suspended: true,
        deletionConfirmedAt: null,
      };
      mockDb.user.findUnique.mockResolvedValue(mockUser);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "testuser" },
        url: new URL(mockRequest.url),
      });

      expect(response.status).toBe(404);
    });

    it("should return 404 when user does not have ActivityPub fields", async () => {
      const mockUser = {
        id: "user-123",
        username: "testuser",
        actorUri: null,
        suspended: false,
        deletionConfirmedAt: null,
      };
      mockDb.user.findUnique.mockResolvedValue(mockUser);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "testuser" },
        url: new URL(mockRequest.url),
      });

      // Logger warning should be called
      expect(response.status).toBe(404);
    });

    it("should handle database errors", async () => {
      const error = new Error("Database error");
      mockWithQueryTimeoutAndRetry.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "testuser" },
        url: new URL(mockRequest.url),
      });

      // Logger error should be called
      expect(response.status).toBe(500);
    });

    it("should decode URL-encoded username", async () => {
      const mockUser = {
        id: "user-123",
        username: "test user",
        actorUri: "https://example.com/users/test%20user",
        suspended: false,
        deletionConfirmedAt: null,
      };
      mockDb.user.findUnique.mockResolvedValue(mockUser);
      mockDb.follow.count.mockResolvedValue(0);

      const encodedRequest = new Request(
        "https://example.com/users/test%20user/followers",
        {
          method: "GET",
        },
      );

      await route!.handler(encodedRequest, mockEnv, {
        params: { username: "test%20user" },
        url: new URL(encodedRequest.url),
      });

      expect(mockDb.user.findUnique).toHaveBeenCalledWith({
        where: { username: "test user" },
        select: expect.any(Object),
      });
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(collectionRoutes.length).toBeGreaterThan(0);
    });

    it("should have middleware configured", () => {
      collectionRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions", () => {
      collectionRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
