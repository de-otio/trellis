/**
 * Unit Tests: ActivityPub Friends Routes
 *
 * Tests for ActivityPub friends collection route handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { friendsRoutes } from "../../../../src/lib/routes/activitypub/friends.js";

// Mock getFriendsCollection
const mockGetFriendsCollection = vi.fn();
vi.mock("../../../../src/lib/activitypub/listeners/friends-collection", () => ({
  getFriendsCollection: (...args: any[]) => mockGetFriendsCollection(...args),
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

describe("ActivityPub Friends Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockRequest = new Request("https://example.com/users/testuser/friends", {
      method: "GET",
    });

    mockGetFriendsCollection.mockResolvedValue(
      new Response(
        JSON.stringify({ type: "OrderedCollection", totalItems: 0 }),
        {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        },
      ),
    );
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddCorsHeaders.mockImplementation(async (response) => response);
  });

  describe("GET /users/:username/friends - Get friends collection", () => {
    const route = friendsRoutes.find(
      (r) => r.method === "GET" && r.path === "/users/:username/friends",
    );

    it("should get friends collection successfully", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "testuser" },
      });

      expect(mockGetFriendsCollection).toHaveBeenCalledWith(
        mockRequest,
        mockEnv,
        "testuser",
      );
      expect(mockCreateSecureResponse).toHaveBeenCalled();
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should handle errors from getFriendsCollection", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 404 },
      );
      mockGetFriendsCollection.mockResolvedValue(errorResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "nonexistent" },
      });

      expect(response.status).toBe(404);
    });

    it("should handle missing username parameter", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        params: {},
      });

      expect(mockGetFriendsCollection).toHaveBeenCalledWith(
        mockRequest,
        mockEnv,
        undefined,
      );
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(friendsRoutes).toHaveLength(1);
      expect(friendsRoutes[0].method).toBe("GET");
    });

    it("should have middleware configured", () => {
      expect(friendsRoutes[0].middleware).toBeDefined();
    });

    it("should have description", () => {
      expect(friendsRoutes[0].description).toBeDefined();
      expect(typeof friendsRoutes[0].description).toBe("string");
    });
  });
});
