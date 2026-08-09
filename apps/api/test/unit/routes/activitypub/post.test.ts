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

    // The vulnerability these routes carried: `objectId` is written when a post
    // first federates and is never cleared, and it was the ONLY audience check
    // here. So narrowing a post to private, or hiding it, left the current text
    // fetchable by any anonymous caller — while every authenticated read path
    // denied it. Editing after narrowing published the new private text.
    it.each([
      ["narrowed to private after federating", { radius: "WHISPER", hiddenByAuthor: false }],
      ["friends-only", { radius: "NORMAL", hiddenByAuthor: false }],
      ["hidden by its author", { radius: "SHOUT", hiddenByAuthor: true }],
    ])("refuses a post %s even though objectId is still set", async (_label, overrides) => {
      mockDb.post.findUnique.mockResolvedValue({
        id: "post-123",
        // Still set from when the post was public — the whole point.
        objectId: "https://example.com/posts/post-123",
        deletedAt: null,
        ...overrides,
        author: {
          id: "user-123",
          username: "author",
          actorUri: "https://example.com/users/author",
          publicKey: "public-key",
        },
      });

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { postId: "post-123" },
        url: new URL(mockRequest.url),
      } as any);

      expect(response.status).toBe(404);
      // Serialization must not have been attempted at all.
      expect(mockCreateNote).not.toHaveBeenCalled();
      expect(mockRespondWithObject).not.toHaveBeenCalled();
    });

    // D10: an unauthenticated caller must not be able to tell "no such post"
    // from "that post is not public". The bodies used to differ, which read the
    // distinction straight off the response.
    it("denies an absent post and a private post byte-identically", async () => {
      mockDb.post.findUnique.mockResolvedValue(null);
      const absent = await route!.handler(mockRequest, mockEnv, {
        params: { postId: "post-123" },
        url: new URL(mockRequest.url),
      } as any);

      mockDb.post.findUnique.mockResolvedValue({
        id: "post-123",
        objectId: "https://example.com/posts/post-123",
        deletedAt: null,
        radius: "WHISPER",
        hiddenByAuthor: false,
        author: {
          id: "user-123",
          username: "author",
          actorUri: "https://example.com/users/author",
          publicKey: "public-key",
        },
      });
      const private_ = await route!.handler(mockRequest, mockEnv, {
        params: { postId: "post-123" },
        url: new URL(mockRequest.url),
      } as any);

      expect(absent.status).toBe(private_.status);
      expect(await absent.text()).toBe(await private_.text());
    });

    it("should get post note successfully", async () => {
      const mockPost = {
        id: "post-123",
        objectId: "https://example.com/posts/post-123",
        deletedAt: null,
        // A federatable post is PUBLIC and not author-hidden. Omitting these is
        // not a harmless shortcut: a fixture with no radius is not public, so
        // without them this test asserted the happy path against a post the
        // route must refuse.
        radius: "SHOUT",
        hiddenByAuthor: false,
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
