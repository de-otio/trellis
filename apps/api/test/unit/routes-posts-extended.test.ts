/**
 * Extended unit tests for Posts Routes
 *
 * Focuses on uncovered branches:
 * - Error paths (EntityTaggingError, generic errors)
 * - Missing requestContext
 * - Rate limiting
 * - Taxonomy tag operations (POST, DELETE, GET)
 * - Tag suggestions
 * - Get single post by ID
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks ---
const { mockGetSession, mockApplyRateLimitKV, mockCreateSecureResponse, mockAddSecurityHeaders, mockCreatePost, mockDeletePost, mockEditPost, mockHidePost, mockUnhidePost, mockGetPost, mockFeedHandlerGetPost, mockSanitizeError, mockDataRouterGetPost, mockDataRouterGetDatabaseForRegion, mockCreateRequestContext, mockGetWrappedDatabase, mockAddPostTaxonomyTags, mockRemovePostTaxonomyTags, mockGetPostTaxonomyTags, mockSuggestTagsFromText, mockGetPopularTags, mockGetUserFrequentTags } = vi.hoisted(() => {
  return {
    mockGetSession: vi.fn(),
    mockApplyRateLimitKV: vi.fn().mockResolvedValue(null),
    mockCreateSecureResponse: vi.fn().mockImplementation((body, init) => new Response(body, init)),
    mockAddSecurityHeaders: vi.fn().mockImplementation((r) => r),
    mockCreatePost: vi.fn(),
    mockDeletePost: vi.fn(),
    mockEditPost: vi.fn(),
    mockHidePost: vi.fn(),
    mockUnhidePost: vi.fn(),
    mockGetPost: vi.fn(),
    mockFeedHandlerGetPost: vi.fn(),
    mockSanitizeError: vi.fn((e) => e?.message || "Unknown error"),
    mockDataRouterGetPost: vi.fn(),
    mockDataRouterGetDatabaseForRegion: vi.fn(),
    mockCreateRequestContext: vi.fn(),

    mockGetWrappedDatabase: vi.fn(),
    mockAddPostTaxonomyTags: vi.fn(),
    mockRemovePostTaxonomyTags: vi.fn(),
    mockGetPostTaxonomyTags: vi.fn(),
    mockSuggestTagsFromText: vi.fn(),
    mockGetPopularTags: vi.fn(),
    mockGetUserFrequentTags: vi.fn(),
  };
});

vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

vi.mock("../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = mockApplyRateLimitKV;
  },
}));

vi.mock("../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
  },
}));

vi.mock("../../src/lib/post-handler", () => ({
  PostHandler: class {
    createPost = mockCreatePost;
    deletePost = mockDeletePost;
    editPost = mockEditPost;
    hidePost = mockHidePost;
    unhidePost = mockUnhidePost;
  },
}));

vi.mock("../../src/lib/feed-handler", () => ({
  FeedHandler: class {
    getPost = mockFeedHandlerGetPost;
  },
}));

vi.mock("../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));

vi.mock("../../src/lib/middleware", () => ({
  corsMiddleware: () => vi.fn(),
  csrfMiddleware: () => vi.fn(),
}));

vi.mock("../../src/lib/entity-tagging-errors", () => {
  class EntityTaggingError extends Error {
    code: string;
    statusCode: number;
    constructor(message: string, code: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  }
  return { EntityTaggingError };
});

vi.mock("../../src/lib/data-router", () => ({
  DataRouter: {
    getPost: (...args: any[]) => mockDataRouterGetPost(...args),
    getDatabaseForRegion: (...args: any[]) => mockDataRouterGetDatabaseForRegion(...args),
  },
}));

vi.mock("../../src/lib/request-context", () => ({
  createRequestContext: (...args: any[]) => mockCreateRequestContext(...args),
}));

const mockAuthMiddleware = vi.fn();
vi.mock("../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const TEST_TENANT_ID = "tenant-test-123";

vi.mock("../../src/lib/database-wrapper-helper", () => ({
  getWrappedDatabase: (...args: any[]) => mockGetWrappedDatabase(...args),
}));

vi.mock("../../src/lib/taxonomy-handler", () => ({
  TaxonomyHandler: class {
    addPostTaxonomyTags = mockAddPostTaxonomyTags;
    removePostTaxonomyTags = mockRemovePostTaxonomyTags;
    getPostTaxonomyTags = mockGetPostTaxonomyTags;
  },
}));

vi.mock("../../src/lib/tag-suggestions-handler", () => ({
  TagSuggestionsHandler: class {
    suggestTagsFromText = mockSuggestTagsFromText;
    getPopularTags = mockGetPopularTags;
    getUserFrequentTags = mockGetUserFrequentTags;
  },
}));

// Helper to create mock Request
function makeRequest(url: string, method = "GET", body?: any, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers } };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

const mockEnv = {
  DATABASE_URL: "postgresql://test",
  SESSION_SECRET: "test-secret",
  TAXONOMY_CACHE_KV: {},
};

const mockSession = { userId: "user-1", email: "test@test.com" };
const mockRequestContext = { region: "US" };

describe("Posts Routes - Extended", () => {
  let postsRoutes: any[];

  beforeAll(async () => {
    const mod = await import("../../src/lib/routes/posts.js");
    postsRoutes = mod.postsRoutes;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(mockSession);
    mockCreateRequestContext.mockResolvedValue({ session: mockSession });

    mockAuthMiddleware.mockResolvedValue({
      userId: "user-1",
      activeTenantId: TEST_TENANT_ID,
    });
    mockGetWrappedDatabase.mockReturnValue({});
  });

  function findRoute(method: string, pathStr: string) {
    return postsRoutes.find((r: any) => {
      const methodMatch = r.method === method;
      if (typeof r.path === "string") return methodMatch && r.path === pathStr;
      return methodMatch && r.path.test(pathStr);
    });
  }

  describe("POST /api/posts - Create post", () => {
    it("should return 401 when not authenticated", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = findRoute("POST", "/api/posts");
      const req = makeRequest("https://example.com/api/posts", "POST");

      await route.handler(req, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Unauthorized"),
        expect.objectContaining({ status: 401 }),
      );
    });

    it("should return rate limit response when rate limited", async () => {
      const rateLimitResponse = new Response("Too Many Requests", { status: 429 });
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);
      const route = findRoute("POST", "/api/posts");
      const req = makeRequest("https://example.com/api/posts", "POST");

      const result = await route.handler(req, mockEnv, { requestContext: mockRequestContext });

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(rateLimitResponse);
    });

    it("should return 500 when requestContext is missing", async () => {
      mockApplyRateLimitKV.mockResolvedValue(null);
      const route = findRoute("POST", "/api/posts");
      const req = makeRequest("https://example.com/api/posts", "POST");

      await route.handler(req, mockEnv, { requestContext: undefined });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Request context not available"),
        expect.objectContaining({ status: 500 }),
      );
    });

    it("should handle EntityTaggingError with proper status code", async () => {
      mockApplyRateLimitKV.mockResolvedValue(null);
      const { EntityTaggingError } = await import("../../src/lib/entity-tagging-errors.js");
      mockCreatePost.mockRejectedValue(new EntityTaggingError("Tag limit exceeded", "TAG_LIMIT", 422));
      const route = findRoute("POST", "/api/posts");
      const req = makeRequest("https://example.com/api/posts", "POST");

      await route.handler(req, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("TAG_LIMIT"),
        expect.objectContaining({ status: 422 }),
      );
    });

    it("should handle generic error in createPost", async () => {
      mockApplyRateLimitKV.mockResolvedValue(null);
      mockCreatePost.mockRejectedValue(new Error("DB connection failed"));
      const route = findRoute("POST", "/api/posts");
      const req = makeRequest("https://example.com/api/posts", "POST");

      await route.handler(req, mockEnv, { requestContext: mockRequestContext });

      expect(mockSanitizeError).toHaveBeenCalled();
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 500 }),
      );
    });
  });

  describe("DELETE /api/posts/:postId", () => {
    it("should return 401 when not authenticated", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = findRoute("DELETE", "/api/posts/post-123");
      const req = makeRequest("https://example.com/api/posts/post-123", "DELETE");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-123", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Unauthorized"),
        expect.objectContaining({ status: 401 }),
      );
    });

    it("should return 500 when requestContext is missing", async () => {
      const route = findRoute("DELETE", "/api/posts/post-123");
      const req = makeRequest("https://example.com/api/posts/post-123", "DELETE");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-123", requestContext: undefined });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Request context not available"),
        expect.objectContaining({ status: 500 }),
      );
    });

    it("should handle error in deletePost", async () => {
      mockDeletePost.mockRejectedValue(new Error("Not found"));
      const route = findRoute("DELETE", "/api/posts/post-123");
      const req = makeRequest("https://example.com/api/posts/post-123", "DELETE");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-123", requestContext: mockRequestContext });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 500 }),
      );
    });
  });

  describe("PATCH /api/posts/:postId - Edit post", () => {
    it("should return 401 when not authenticated", async () => {
      mockGetSession.mockResolvedValue(null);
      // Find the PATCH route that does NOT match /hide or /unhide
      const route = postsRoutes.find(
        (r: any) => r.method === "PATCH" && r.description === "Edit post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1", "PATCH");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Unauthorized"),
        expect.objectContaining({ status: 401 }),
      );
    });

    it("should apply rate limiting for edits", async () => {
      const rateLimitResponse = new Response("Rate limited", { status: 429 });
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);
      const route = postsRoutes.find(
        (r: any) => r.method === "PATCH" && r.description === "Edit post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1", "PATCH");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1", requestContext: mockRequestContext });

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(rateLimitResponse);
    });

    it("should return 500 when requestContext is missing", async () => {
      mockApplyRateLimitKV.mockResolvedValue(null);
      const route = postsRoutes.find(
        (r: any) => r.method === "PATCH" && r.description === "Edit post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1", "PATCH");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1", requestContext: undefined });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Request context not available"),
        expect.objectContaining({ status: 500 }),
      );
    });

    it("should handle error in editPost", async () => {
      mockApplyRateLimitKV.mockResolvedValue(null);
      mockEditPost.mockRejectedValue(new Error("Edit failed"));
      const route = postsRoutes.find(
        (r: any) => r.method === "PATCH" && r.description === "Edit post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1", "PATCH");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1", requestContext: mockRequestContext });

          });
  });

  describe("PATCH /api/posts/:postId/hide", () => {
    it("should return 500 when requestContext is missing", async () => {
      const route = postsRoutes.find(
        (r: any) => r.method === "PATCH" && r.description === "Hide post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/hide", "PATCH");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/hide", requestContext: undefined });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Request context not available"),
        expect.objectContaining({ status: 500 }),
      );
    });

    it("should handle error in hidePost", async () => {
      mockHidePost.mockRejectedValue(new Error("Hide failed"));
      const route = postsRoutes.find(
        (r: any) => r.method === "PATCH" && r.description === "Hide post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/hide", "PATCH");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/hide", requestContext: mockRequestContext });

          });
  });

  describe("PATCH /api/posts/:postId/unhide", () => {
    it("should return 500 when requestContext is missing", async () => {
      const route = postsRoutes.find(
        (r: any) => r.method === "PATCH" && r.description === "Unhide post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/unhide", "PATCH");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/unhide", requestContext: undefined });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Request context not available"),
        expect.objectContaining({ status: 500 }),
      );
    });

    it("should handle error in unhidePost", async () => {
      mockUnhidePost.mockRejectedValue(new Error("Unhide failed"));
      const route = postsRoutes.find(
        (r: any) => r.method === "PATCH" && r.description === "Unhide post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/unhide", "PATCH");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/unhide", requestContext: mockRequestContext });

          });
  });

  describe("POST /api/posts/:postId/taxonomy-tags", () => {
    it("should return 401 when not authenticated", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = postsRoutes.find(
        (r: any) => r.method === "POST" && r.description === "Add taxonomy tags to post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/taxonomy-tags", "POST");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/taxonomy-tags", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Unauthorized"),
        expect.objectContaining({ status: 401 }),
      );
    });

    it("should return 404 when post not found", async () => {
      mockApplyRateLimitKV.mockResolvedValue(null);
      mockDataRouterGetPost.mockResolvedValue(null);
      const route = postsRoutes.find(
        (r: any) => r.method === "POST" && r.description === "Add taxonomy tags to post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/taxonomy-tags", "POST");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/taxonomy-tags", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Post not found"),
        expect.objectContaining({ status: 404 }),
      );
    });

    it("should return 403 when user does not own the post", async () => {
      mockApplyRateLimitKV.mockResolvedValue(null);
      mockDataRouterGetPost.mockResolvedValue({ authorId: "other-user" });
      const route = postsRoutes.find(
        (r: any) => r.method === "POST" && r.description === "Add taxonomy tags to post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/taxonomy-tags", "POST");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/taxonomy-tags", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Forbidden"),
        expect.objectContaining({ status: 403 }),
      );
    });

    it("should return 413 when content-length exceeds 10KB", async () => {
      mockApplyRateLimitKV.mockResolvedValue(null);
      mockDataRouterGetPost.mockResolvedValue({ authorId: "user-1" });
      const route = postsRoutes.find(
        (r: any) => r.method === "POST" && r.description === "Add taxonomy tags to post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/taxonomy-tags", "POST", {}, {
        "content-length": "20000",
      });

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/taxonomy-tags", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Request body too large"),
        expect.objectContaining({ status: 413 }),
      );
    });

    it("should return 400 when taxonIds is missing", async () => {
      mockApplyRateLimitKV.mockResolvedValue(null);
      mockDataRouterGetPost.mockResolvedValue({ authorId: "user-1" });
      const route = postsRoutes.find(
        (r: any) => r.method === "POST" && r.description === "Add taxonomy tags to post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/taxonomy-tags", "POST", { foo: "bar" });

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/taxonomy-tags", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("taxonIds array is required"),
        expect.objectContaining({ status: 400 }),
      );
    });

    it("should return 400 when taxonIds have invalid format", async () => {
      mockApplyRateLimitKV.mockResolvedValue(null);
      mockDataRouterGetPost.mockResolvedValue({ authorId: "user-1" });
      const route = postsRoutes.find(
        (r: any) => r.method === "POST" && r.description === "Add taxonomy tags to post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/taxonomy-tags", "POST", {
        taxonIds: ["INVALID_FORMAT", "breed:dog:labrador"],
      });

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/taxonomy-tags", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Invalid taxon ID format"),
        expect.objectContaining({ status: 400 }),
      );
    });

    it("should successfully add taxonomy tags", async () => {
      mockApplyRateLimitKV.mockResolvedValue(null);
      mockDataRouterGetPost.mockResolvedValue({ authorId: "user-1" });
      mockAddPostTaxonomyTags.mockResolvedValue(undefined);
      mockGetPostTaxonomyTags.mockResolvedValue([
        { taxonId: "breed:dog:labrador", displayName: "Labrador", description: "A friendly dog" },
      ]);
      const route = postsRoutes.find(
        (r: any) => r.method === "POST" && r.description === "Add taxonomy tags to post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/taxonomy-tags", "POST", {
        taxonIds: ["breed:dog:labrador"],
      });

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/taxonomy-tags", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Labrador"),
        expect.objectContaining({ status: 200 }),
      );
    });
  });

  describe("GET /api/posts/:postId - Get single post", () => {
    it("should return 401 when not authenticated", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = postsRoutes.find(
        (r: any) => r.method === "GET" && r.description === "Get single post by ID",
      );
      const req = makeRequest("https://example.com/api/posts/post-1");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Unauthorized"),
        expect.objectContaining({ status: 401 }),
      );
    });

    it("should return 500 when requestContext is missing", async () => {
      const route = postsRoutes.find(
        (r: any) => r.method === "GET" && r.description === "Get single post by ID",
      );
      const req = makeRequest("https://example.com/api/posts/post-1");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1", requestContext: undefined });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Request context not available"),
        expect.objectContaining({ status: 500 }),
      );
    });

    it("should return 404 when post not found", async () => {
      mockFeedHandlerGetPost.mockResolvedValue(null);
      const route = postsRoutes.find(
        (r: any) => r.method === "GET" && r.description === "Get single post by ID",
      );
      const req = makeRequest("https://example.com/api/posts/post-1");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Post not found"),
        expect.objectContaining({ status: 404 }),
      );
    });

    it("should return 200 with post data on success", async () => {
      mockFeedHandlerGetPost.mockResolvedValue({ id: "post-1", text: "Hello" });
      const route = postsRoutes.find(
        (r: any) => r.method === "GET" && r.description === "Get single post by ID",
      );
      const req = makeRequest("https://example.com/api/posts/post-1");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Hello"),
        expect.objectContaining({ status: 200 }),
      );
    });

    it("should handle error in getPost", async () => {
      mockFeedHandlerGetPost.mockRejectedValue(new Error("DB error"));
      const route = postsRoutes.find(
        (r: any) => r.method === "GET" && r.description === "Get single post by ID",
      );
      const req = makeRequest("https://example.com/api/posts/post-1");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1", requestContext: mockRequestContext });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 500 }),
      );
    });
  });

  describe("GET /api/posts/:postId/tags/suggestions", () => {
    it("should return 500 when requestContext is missing", async () => {
      const route = postsRoutes.find(
        (r: any) => r.description === "Get tag suggestions for post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/tags/suggestions");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/tags/suggestions", requestContext: undefined });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Request context not available"),
        expect.objectContaining({ status: 500 }),
      );
    });

    it("should return 404 when post not found", async () => {
      mockDataRouterGetPost.mockResolvedValue(null);
      const route = postsRoutes.find(
        (r: any) => r.description === "Get tag suggestions for post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/tags/suggestions");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/tags/suggestions", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Post not found"),
        expect.objectContaining({ status: 404 }),
      );
    });

    it("should return 404 when full post text not found", async () => {
      mockDataRouterGetPost.mockResolvedValue({ id: "post-1" });
      const mockDb = { post: { findUnique: vi.fn().mockResolvedValue(null) } };
      mockDataRouterGetDatabaseForRegion.mockReturnValue(mockDb);
      const route = postsRoutes.find(
        (r: any) => r.description === "Get tag suggestions for post",
      );
      const req = makeRequest("https://example.com/api/posts/post-1/tags/suggestions");

      await route.handler(req, mockEnv, { pathname: "/api/posts/post-1/tags/suggestions", requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Post not found"),
        expect.objectContaining({ status: 404 }),
      );
    });
  });
});
