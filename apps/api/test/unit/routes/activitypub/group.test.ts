/**
 * Unit Tests: ActivityPub Group Routes
 *
 * Tests for ActivityPub group route handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { groupRoutes } from "../../../../src/lib/routes/activitypub/group.js";

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

// Mock GroupService
const mockSerializeActor = vi.fn();
vi.mock("../../../../src/lib/activitypub/group-service", () => ({
  GroupService: {
    serializeActor: (...args: any[]) => mockSerializeActor(...args),
  },
}));

describe("ActivityPub Group Routes", () => {
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
      group: {
        findUnique: vi.fn(),
      },
      follow: {
        count: vi.fn(),
      },
    };

    mockRequest = new Request("https://example.com/groups/group-123", {
      method: "GET",
    });

    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddCorsHeaders.mockImplementation(async (response) => response);
    mockDetectRegionSync.mockReturnValue("US");
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (db, region, env, fn) => {
        return await fn(mockDb);
      },
    );
  });

  describe("GET /groups/:groupId - Get group actor", () => {
    const route = groupRoutes.find(
      (r) => r.method === "GET" && r.path === "/groups/:groupId",
    );

    it("should get group actor successfully", async () => {
      const mockGroup = {
        id: "group-123",
        name: "Test Group",
        description: "A test group",
      };
      mockDb.group.findUnique.mockResolvedValue(mockGroup);
      mockSerializeActor.mockResolvedValue({
        type: "Group",
        id: "https://example.com/groups/group-123",
        name: "Test Group",
      });

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { groupId: "group-123" },
      });

      expect(mockDb.group.findUnique).toHaveBeenCalled();
      expect(mockSerializeActor).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 404 when group is not found", async () => {
      mockDb.group.findUnique.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { groupId: "nonexistent" },
      });

      expect(response.status).toBe(404);
    });

    it("should handle errors", async () => {
      const error = new Error("Database error");
      mockWithQueryTimeoutAndRetry.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { groupId: "group-123" },
      });

      // Logger error should be called
      expect(response.status).toBe(500);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(groupRoutes.length).toBeGreaterThan(0);
    });

    it("should have middleware configured", () => {
      groupRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions", () => {
      groupRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
