/**
 * Unit Tests: ActivityPub Outbox Routes
 *
 * Tests for ActivityPub outbox route handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { outboxRoutes } from "../../../../src/lib/routes/activitypub/outbox.js";

// Mock getOutboxActivities
const mockGetOutboxActivities = vi.fn();
vi.mock("../../../../src/lib/activitypub/listeners/outbox", () => ({
  getOutboxActivities: (...args: any[]) => mockGetOutboxActivities(...args),
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

describe("ActivityPub Outbox Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockRequest = new Request("https://example.com/users/testuser/outbox", {
      method: "GET",
    });

    mockGetOutboxActivities.mockResolvedValue(
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

  describe("GET /users/:username/outbox - Get outbox", () => {
    const route = outboxRoutes.find(
      (r) => r.method === "GET" && r.path === "/users/:username/outbox",
    );

    it("should get outbox activities successfully", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "testuser" },
      });

      expect(mockGetOutboxActivities).toHaveBeenCalledWith(
        mockRequest,
        mockEnv,
        "testuser",
      );
      expect(mockCreateSecureResponse).toHaveBeenCalled();
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should handle errors from getOutboxActivities", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 404 },
      );
      mockGetOutboxActivities.mockResolvedValue(errorResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { username: "nonexistent" },
      });

      expect(response.status).toBe(404);
    });

    it("should handle missing username parameter", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        params: {},
      });

      expect(mockGetOutboxActivities).toHaveBeenCalledWith(
        mockRequest,
        mockEnv,
        undefined,
      );
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(outboxRoutes).toHaveLength(1);
      expect(outboxRoutes[0].method).toBe("GET");
    });

    it("should have middleware configured", () => {
      expect(outboxRoutes[0].middleware).toBeDefined();
    });

    it("should have description", () => {
      expect(outboxRoutes[0].description).toBeDefined();
      expect(typeof outboxRoutes[0].description).toBe("string");
    });
  });
});
