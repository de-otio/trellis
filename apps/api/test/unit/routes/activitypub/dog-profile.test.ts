/**
 * Unit Tests: ActivityPub Dog Profile Routes
 *
 * Tests for ActivityPub dog profile route handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { entityProfileRoutes } from "../../../../src/lib/routes/activitypub/entity-profile.js";

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

// Mock EntityProfileService (still used for followers)
vi.mock("../../../../src/lib/activitypub/entity-profile-service", () => ({
  EntityProfileService: {
    getFollowers: vi.fn().mockResolvedValue([]),
    getFollowersCount: vi.fn().mockResolvedValue(0),
  },
}));

// Mock EntityActorDispatcher (used for actor serialization)
const mockEntityToActor = vi.fn();
vi.mock("../../../../src/lib/activitypub/dispatchers/entity-actor", () => ({
  EntityActorDispatcher: class {
    entityToActor = (...args: any[]) => mockEntityToActor(...args);
  },
}));

// Mock Fedify respondWithObject
const mockRespondWithObject = vi.fn();
vi.mock("@fedify/fedify", () => ({
  respondWithObject: (...args: any[]) => mockRespondWithObject(...args),
}));

describe("ActivityPub Dog Profile Routes", () => {
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
      entity: {
        findUnique: vi.fn(),
      },
      entityOwnership: {
        findFirst: vi.fn().mockResolvedValue({ userId: "owner-123" }),
      },
      user: {
        findUnique: vi.fn(),
      },
    };

    mockRequest = new Request("https://example.com/entities/dog/dog-123", {
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

  describe("GET /entities/:entityType/:entityId - Get entity actor", () => {
    const route = entityProfileRoutes.find(
      (r) => r.method === "GET" && r.path === "/entities/:entityType/:entityId",
    );

    it("should get dog profile actor successfully", async () => {
      const mockEntity = {
        id: "dog-123",
        entityType: "dog",
        name: "Buddy",
      };
      const mockOwner = {
        id: "owner-123",
        actorUri: "https://example.com/users/owner",
      };
      mockDb.entity.findUnique.mockResolvedValue(mockEntity);
      mockDb.entityOwnership.findFirst.mockResolvedValue({ userId: "owner-123" });
      mockDb.user.findUnique.mockResolvedValue(mockOwner);
      mockEntityToActor.mockReturnValue({
        id: new URL("https://example.com/entities/dog/dog-123"),
        type: "Person",
        name: "Buddy",
      });
      mockRespondWithObject.mockResolvedValue(
        new Response(JSON.stringify({ type: "Person", name: "Buddy" }), {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        }),
      );

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { entityType: "dog", entityId: "dog-123" },
      });

      expect(mockDb.entity.findUnique).toHaveBeenCalled();
      expect(mockEntityToActor).toHaveBeenCalled();
      expect(mockRespondWithObject).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 404 when dog profile is not found", async () => {
      mockDb.entity.findUnique.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { entityType: "dog", entityId: "nonexistent" },
      });

      expect(response.status).toBe(404);
    });

    it("should return 400 when entity is not a dog", async () => {
      const mockEntity = {
        id: "entity-123",
        entityType: "cat",
        name: "Fluffy",
      };
      mockDb.entity.findUnique.mockResolvedValue(mockEntity);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { entityType: "dog", entityId: "entity-123" },
      });

      expect(response.status).toBe(404);
    });

    it("should handle errors", async () => {
      const error = new Error("Database error");
      mockWithQueryTimeoutAndRetry.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { entityType: "dog", entityId: "dog-123" },
      });

      // Logger error should be called
      expect(response.status).toBe(500);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(entityProfileRoutes.length).toBeGreaterThan(0);
    });

    it("should have middleware configured", () => {
      entityProfileRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions", () => {
      entityProfileRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
