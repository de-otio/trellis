/**
 * Unit Tests: ActivityPub Actor Routes
 *
 * Tests for ActivityPub actor document route handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { actorRoutes } from "../../../../src/lib/routes/activitypub/actor.js";

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

// Mock sharedDatabaseConnectionManager
vi.mock("../../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    getConnection: vi.fn(),
  },
}));

// Mock UserActorDispatcher
const mockGetActor = vi.fn();
vi.mock("../../../../src/lib/activitypub/dispatchers/user-actor", () => ({
  UserActorDispatcher: class {
    getActor = mockGetActor;
    constructor(env: any) {}
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
}));

describe("ActivityPub Actor Routes", () => {
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
    };

    mockRequest = new Request("https://example.com/users/testuser", {
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
  });

  describe("GET /users/:username - Get actor document", () => {
    const route = actorRoutes.find(
      (r) => r.method === "GET" && r.path === "/users/:username",
    );

    it("should get actor document successfully", async () => {
      const mockUser = {
        id: "user-123",
        username: "testuser",
        actorUri: "https://example.com/users/testuser",
        inboxUrl: "https://example.com/users/testuser/inbox",
        outboxUrl: "https://example.com/users/testuser/outbox",
        followersUrl: "https://example.com/users/testuser/followers",
        followingUrl: "https://example.com/users/testuser/following",
        friendsUrl: "https://example.com/users/testuser/friends",
        publicKey: "public-key",
        suspended: false,
        deletionConfirmedAt: null,
      };
      const mockActor = {
        id: "https://example.com/users/testuser",
        type: "Person",
      };
      const mockResponse = new Response(JSON.stringify(mockActor), {
        status: 200,
        headers: { "content-type": "application/activity+json" },
      });

      mockDb.user.findUnique.mockResolvedValue(mockUser);
      mockGetActor.mockResolvedValue(mockActor);
      mockRespondWithObject.mockResolvedValue(mockResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "testuser" },
        url: new URL(mockRequest.url),
      });

      expect(mockDb.user.findUnique).toHaveBeenCalledWith({
        where: { username: "testuser" },
        select: expect.objectContaining({
          id: true,
          username: true,
          actorUri: true,
        }),
      });
      expect(mockGetActor).toHaveBeenCalledWith(mockUser.actorUri);
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

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "User not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
      expect(response.status).toBe(404);
    });

    it("should return 404 when user is suspended", async () => {
      const mockUser = {
        id: "user-123",
        username: "testuser",
        actorUri: "https://example.com/users/testuser",
        publicKey: "public-key",
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

    it("should return 404 when user is deleted", async () => {
      const mockUser = {
        id: "user-123",
        username: "testuser",
        actorUri: "https://example.com/users/testuser",
        publicKey: "public-key",
        suspended: false,
        deletionConfirmedAt: new Date(),
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
        publicKey: null,
        suspended: false,
        deletionConfirmedAt: null,
      };
      mockDb.user.findUnique.mockResolvedValue(mockUser);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "testuser" },
        url: new URL(mockRequest.url),
      });

            expect(response.status).toBe(404);
    });

    it("should handle Fedify serialization errors", async () => {
      const mockUser = {
        id: "user-123",
        username: "testuser",
        actorUri: "https://example.com/users/testuser",
        publicKey: "public-key",
        suspended: false,
        deletionConfirmedAt: null,
      };
      mockDb.user.findUnique.mockResolvedValue(mockUser);
      mockGetActor.mockResolvedValue({ id: "actor-id" });
      const error = new Error("Serialization failed");
      mockRespondWithObject.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "testuser" },
        url: new URL(mockRequest.url),
      });

            expect(response.status).toBe(500);
    });

    it("should handle database errors", async () => {
      const error = new Error("Database error");
      mockWithQueryTimeoutAndRetry.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "testuser" },
        url: new URL(mockRequest.url),
      });

            expect(response.status).toBe(500);
    });

    it("should decode URL-encoded username", async () => {
      const mockUser = {
        id: "user-123",
        username: "test user",
        actorUri: "https://example.com/users/test%20user",
        publicKey: "public-key",
        suspended: false,
        deletionConfirmedAt: null,
      };
      mockDb.user.findUnique.mockResolvedValue(mockUser);
      mockGetActor.mockResolvedValue({ id: "actor-id" });
      mockRespondWithObject.mockResolvedValue(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        }),
      );

      const encodedRequest = new Request(
        "https://example.com/users/test%20user",
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
      expect(actorRoutes).toHaveLength(1);
      expect(actorRoutes[0].method).toBe("GET");
    });

    it("should have middleware configured", () => {
      expect(actorRoutes[0].middleware).toBeDefined();
    });

    it("should have description", () => {
      expect(actorRoutes[0].description).toBeDefined();
      expect(typeof actorRoutes[0].description).toBe("string");
    });
  });
});
