/**
 * Unit Tests: ActivityPub Post Routes
 *
 * Tests for ActivityPub post route handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { postRoutes } from "../../../../src/lib/routes/activitypub/post.js";

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

// Mock PostActivityServiceFedify
vi.mock("../../../../src/lib/activitypub/services/post-service-fedify", () => ({
  PostActivityServiceFedify: {
    createNote: vi.fn(),
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

describe("ActivityPub Post Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;
  let mockDb: any;
  let mockCreateNote: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Get the mocked function
    const { PostActivityServiceFedify } = await import(
      "../../../../src/lib/activitypub/services/post-service-fedify.js"
    );
    mockCreateNote = (PostActivityServiceFedify as any).createNote;

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockDb = {
      post: {
        findUnique: vi.fn(),
      },
    };

    mockRequest = new Request("https://example.com/posts/post-123", {
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
    mockRespondWithObject.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/activity+json" },
      }),
    );
  });

  describe("GET /posts/:postId - Get post note", () => {
    const route = postRoutes.find(
      (r) => r.method === "GET" && r.path === "/posts/:postId",
    );

    it("should get post note successfully", async () => {
      const mockPost = {
        id: "post-123",
        objectId: "https://example.com/posts/post-123",
        deletedAt: null,
        author: {
          id: "user-123",
          username: "author",
          actorUri: "https://example.com/users/author",
          publicKey: "public-key",
        },
      };
      mockDb.post.findUnique.mockResolvedValue(mockPost);
      const mockNote = {
        type: "Note",
        id: "https://example.com/posts/post-123",
        content: "Test post",
      };
      mockCreateNote.mockResolvedValue(mockNote);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { postId: "post-123" },
        url: new URL(mockRequest.url),
      });

      expect(mockDb.post.findUnique).toHaveBeenCalled();
      expect(mockCreateNote).toHaveBeenCalled();
      expect(mockRespondWithObject).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 400 when postId is missing", async () => {
      const response = await route!.handler(mockRequest, mockEnv, {
        params: {},
        url: new URL(mockRequest.url),
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Post ID is required" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
      expect(response.status).toBe(400);
    });

    it("should return 404 when post is not found", async () => {
      mockDb.post.findUnique.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { postId: "nonexistent" },
        url: new URL(mockRequest.url),
      });

      expect(response.status).toBe(404);
    });

    it("should return 404 when post is deleted", async () => {
      const mockPost = {
        id: "post-123",
        objectId: "https://example.com/posts/post-123",
        deletedAt: new Date(),
        author: {
          id: "user-123",
          username: "author",
          actorUri: "https://example.com/users/author",
          publicKey: "public-key",
        },
      };
      mockDb.post.findUnique.mockResolvedValue(mockPost);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { postId: "post-123" },
        url: new URL(mockRequest.url),
      });

      expect(response.status).toBe(404);
    });

    it("should return 404 when post does not have ActivityPub fields", async () => {
      const mockPost = {
        id: "post-123",
        objectId: null,
        deletedAt: null,
        author: {
          id: "user-123",
          username: "author",
          actorUri: null,
          publicKey: "public-key",
        },
      };
      mockDb.post.findUnique.mockResolvedValue(mockPost);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { postId: "post-123" },
        url: new URL(mockRequest.url),
      });

      // Logger warning should be called
      expect(response.status).toBe(404);
    });

    it("should handle database errors", async () => {
      const error = new Error("Database error");
      mockWithQueryTimeoutAndRetry.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { postId: "post-123" },
        url: new URL(mockRequest.url),
      });

      // Logger error should be called
      expect(response.status).toBe(500);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(postRoutes.length).toBeGreaterThan(0);
    });

    it("should have middleware configured", () => {
      postRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions", () => {
      postRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
