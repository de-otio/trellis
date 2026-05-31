/**
 * Unit Tests: ActivityPub Audiences Routes
 *
 * Tests for ActivityPub custom audience route handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { audienceRoutes } from "../../../../src/lib/routes/activitypub/audiences.js";

// Mock SessionManager
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

// Mock CustomAudienceService
vi.mock("../../../../src/lib/activitypub/audience-service", () => ({
  CustomAudienceService: {
    createAudience: vi.fn(),
    getAudience: vi.fn(),
  },
}));

describe("ActivityPub Audiences Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;
  let mockSession: any;
  let mockDb: any;
  let mockCreateAudience: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Get the mocked function
    const { CustomAudienceService } = await import(
      "../../../../src/lib/activitypub/audience-service.js"
    );
    mockCreateAudience = (CustomAudienceService as any).createAudience;

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockSession = {
      userId: "user-123",
      email: "user@example.com",
    };

    mockDb = {
      user: {
        findUnique: vi.fn(),
      },
    };

    mockRequest = new Request("https://example.com/api/audiences", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "My Audience",
        memberIds: ["member-1", "member-2"],
      }),
    });

    mockGetSession.mockResolvedValue(mockSession);
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

  describe("POST /api/audiences - Create audience", () => {
    const route = audienceRoutes.find(
      (r) => r.method === "POST" && r.path === "/api/audiences",
    );

    it("should create audience successfully", async () => {
      const mockCreator = {
        id: "user-123",
        username: "creator",
        actorUri: "https://example.com/users/creator",
        publicKey: "public-key",
        suspended: false,
        deletionConfirmedAt: null,
      };
      mockDb.user.findUnique.mockResolvedValue(mockCreator);
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (db, region, env, fn) => {
          return await fn(mockDb);
        },
      );
      mockCreateAudience.mockResolvedValue({
        id: "audience-123",
        name: "My Audience",
        collectionId: "https://example.com/api/audiences/audience-123",
        createdAt: new Date(),
      });

      const response = await route!.handler(mockRequest, mockEnv, {
        url: new URL(mockRequest.url),
      });

      expect(mockGetSession).toHaveBeenCalled();
      expect(mockCreateAudience).toHaveBeenCalled();
      expect(response.status).toBe(201);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv, {
        url: new URL(mockRequest.url),
      });

      expect(response.status).toBe(401);
      expect(mockCreateAudience).not.toHaveBeenCalled();
    });

    it("should return 400 when name is missing", async () => {
      const invalidRequest = new Request("https://example.com/api/audiences", {
        method: "POST",
        body: JSON.stringify({ memberIds: ["member-1"] }),
      });

      const response = await route!.handler(invalidRequest, mockEnv, {
        url: new URL(invalidRequest.url),
      });

      expect(response.status).toBe(400);
    });

    it("should return 400 when memberIds is empty", async () => {
      const invalidRequest = new Request("https://example.com/api/audiences", {
        method: "POST",
        body: JSON.stringify({ name: "My Audience", memberIds: [] }),
      });

      const response = await route!.handler(invalidRequest, mockEnv, {
        url: new URL(invalidRequest.url),
      });

      expect(response.status).toBe(400);
    });

    it("should handle errors", async () => {
      const mockCreator = {
        id: "user-123",
        username: "creator",
        actorUri: "https://example.com/users/creator",
        publicKey: "public-key",
        suspended: false,
        deletionConfirmedAt: null,
      };
      mockDb.user.findUnique.mockResolvedValue(mockCreator);
      const error = new Error("Failed to create audience");
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (db, region, env, fn) => {
          return await fn(mockDb);
        },
      );
      mockCreateAudience.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        url: new URL(mockRequest.url),
      });

      // Logger error should be called
      // Route returns 400 for general errors, 404 for not found errors
      expect(response.status).toBe(400);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(audienceRoutes.length).toBeGreaterThan(0);
    });

    it("should have middleware configured", () => {
      audienceRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions", () => {
      audienceRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
