/**
 * Unit Tests: Posts Routes
 *
 * Tests for post route handlers including creation, deletion, hiding, and taxonomy tags.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { postsRoutes } from "../../../src/lib/routes/posts.js";
import type { Session } from "../../../src/lib/session-cookie.js";

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
const mockAddSecurityHeaders = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
    constructor(env: any) {}
  },
}));

// Mock RateLimiter
const mockApplyRateLimitKV = vi.fn();
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = mockApplyRateLimitKV;
  },
}));

// Mock PostHandler
const mockCreatePost = vi.fn();
const mockDeletePost = vi.fn();
const mockHidePost = vi.fn();
const mockUnhidePost = vi.fn();
vi.mock("../../../src/lib/post-handler", () => ({
  PostHandler: class {
    createPost = mockCreatePost;
    deletePost = mockDeletePost;
    hidePost = mockHidePost;
    unhidePost = mockUnhidePost;
  },
}));

// Mock Validator
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));

// Mock DataRouter
const mockGetPost = vi.fn();
const mockGetDatabaseForRegion = vi.fn();
vi.mock("../../../src/lib/data-router", () => ({
  DataRouter: {
    getPost: (...args: any[]) => mockGetPost(...args),
    getDatabaseForRegion: (...args: any[]) => mockGetDatabaseForRegion(...args),
  },
}));

// Mock TaxonomyHandler
const mockAddPostTaxonomyTags = vi.fn();
const mockRemovePostTaxonomyTags = vi.fn();
const mockGetPostTaxonomyTags = vi.fn();
vi.mock("../../../src/lib/taxonomy-handler", () => ({
  TaxonomyHandler: class {
    addPostTaxonomyTags = mockAddPostTaxonomyTags;
    removePostTaxonomyTags = mockRemovePostTaxonomyTags;
    getPostTaxonomyTags = mockGetPostTaxonomyTags;
    constructor(db: any, tenantId: string, kv: any) {}
  },
}));

// Mock TagSuggestionsHandler
const mockSuggestTagsFromText = vi.fn();
const mockGetPopularTags = vi.fn();
const mockGetUserFrequentTags = vi.fn();
vi.mock("../../../src/lib/tag-suggestions-handler", () => ({
  TagSuggestionsHandler: class {
    suggestTagsFromText = mockSuggestTagsFromText;
    getPopularTags = mockGetPopularTags;
    getUserFrequentTags = mockGetUserFrequentTags;
    constructor(taxonomyHandler: any) {}
  },
}));

// Mock tenant context

// Mock request context
const mockCreateRequestContext = vi.fn();
vi.mock("../../../src/lib/request-context", () => ({
  createRequestContext: (...args: any[]) => mockCreateRequestContext(...args),
}));

// Mock database wrapper helper
const mockGetWrappedDatabase = vi.fn();
vi.mock("../../../src/lib/database-wrapper-helper", () => ({
  getWrappedDatabase: (...args: any[]) => mockGetWrappedDatabase(...args),
}));

// Mock authMiddleware
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const TEST_TENANT_ID = "tenant-test-123";

// Mock EntityTaggingError
vi.mock("../../../src/lib/entity-tagging-errors", () => ({
  EntityTaggingError: class extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  },
}));

describe("Posts Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret",
      DEFAULT_REGION: "US",
      TAXONOMY_CACHE_KV: {} as any,
    } as Env;

    mockSession = {
      userId: "user-123",
      email: "user@example.com",
      expiresAt: Date.now() + 3600000,
    };

    mockRequestContext = {
      region: "US" as const,
      config: {
        featureFlags: {
          authentication: {},
          features: {},
          performance: {},
          security: {},
        },
        endpoints: {
          api: "https://api.example.com",
          frontend: "https://app.example.com",
          cdn: "https://cdn.example.com",
        },
        timeouts: {
          database: 5000,
          api: 10000,
        },
      },
      session: mockSession,
    };

    mockDb = {
      post: {
        findUnique: vi.fn(),
      },
    };

    mockGetSession.mockResolvedValue(mockSession);
    mockAuthMiddleware.mockResolvedValue({
      userId: "user-123",
      activeTenantId: TEST_TENANT_ID,
    });
    mockCreateSecureResponse.mockImplementation(
      (body, options) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockApplyRateLimitKV.mockResolvedValue(null);
    mockGetDatabaseForRegion.mockReturnValue(mockDb);
    mockGetWrappedDatabase.mockReturnValue(mockDb);
    mockCreateRequestContext.mockResolvedValue({
      session: mockSession,
      region: "US",
    });

  });

  describe("POST /api/posts", () => {
    const route = postsRoutes.find(
      (r) => r.path === "/api/posts" && r.method === "POST",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("http://test.com/api/posts", {
        method: "POST",
        body: JSON.stringify({ text: "Test post" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await route.handler(request, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Unauthorized");
    });

    it("should return rate limit response when rate limited", async () => {
      const rateLimitResponse = new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429 },
      );
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      const request = new Request("http://test.com/api/posts", {
        method: "POST",
        body: JSON.stringify({ text: "Test post" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await route.handler(request, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(429);
    });

    it("should return 500 when requestContext is missing", async () => {
      const request = new Request("http://test.com/api/posts", {
        method: "POST",
        body: JSON.stringify({ text: "Test post" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await route.handler(request, mockEnv, {});

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe("Request context not available");
    });

    it("should create post successfully", async () => {
      const postResponse = new Response(
        JSON.stringify({ id: "post-123", text: "Test post" }),
        { status: 201 },
      );
      mockCreatePost.mockResolvedValue(postResponse);

      const request = new Request("http://test.com/api/posts", {
        method: "POST",
        body: JSON.stringify({ text: "Test post" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await route.handler(request, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockCreatePost).toHaveBeenCalled();
      expect(mockAddSecurityHeaders).toHaveBeenCalled();
    });

    it("should handle EntityTaggingError with proper status code", async () => {
      const { EntityTaggingError } = await import(
        "../../../src/lib/entity-tagging-errors.js"
      );
      const taggingError = new EntityTaggingError(
        "INVALID_TAXON",
        "Invalid taxon ID",
        400,
      );
      mockCreatePost.mockRejectedValue(taggingError);

      const request = new Request("http://test.com/api/posts", {
        method: "POST",
        body: JSON.stringify({ text: "Test post" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await route.handler(request, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("INVALID_TAXON");
    });

    it("should handle general errors", async () => {
      mockCreatePost.mockRejectedValue(new Error("Database error"));

      const request = new Request("http://test.com/api/posts", {
        method: "POST",
        body: JSON.stringify({ text: "Test post" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await route.handler(request, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(500);
    });
  });

  describe("DELETE /api/posts/:id", () => {
    const route = postsRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/posts/post-123") &&
        r.method === "DELETE",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("http://test.com/api/posts/post-123", {
        method: "DELETE",
      });
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(401);
    });

    it("should return 500 when requestContext is missing", async () => {
      const request = new Request("http://test.com/api/posts/post-123", {
        method: "DELETE",
      });
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123",
      });

      expect(response.status).toBe(500);
    });

    it("should delete post successfully", async () => {
      const deleteResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
      mockDeletePost.mockResolvedValue(deleteResponse);

      const request = new Request("http://test.com/api/posts/post-123", {
        method: "DELETE",
      });
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123",
        requestContext: mockRequestContext,
      });

      expect(mockDeletePost).toHaveBeenCalledWith(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalled();
    });

    it("should handle errors gracefully", async () => {
      mockDeletePost.mockRejectedValue(new Error("Database error"));

      const request = new Request("http://test.com/api/posts/post-123", {
        method: "DELETE",
      });
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(500);
    });
  });

  describe("PATCH /api/posts/:id/hide", () => {
    const route = postsRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/posts/post-123/hide") &&
        r.method === "PATCH",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("http://test.com/api/posts/post-123/hide", {
        method: "PATCH",
      });
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/hide",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(401);
    });

    it("should hide post successfully", async () => {
      const hideResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
      mockHidePost.mockResolvedValue(hideResponse);

      const request = new Request("http://test.com/api/posts/post-123/hide", {
        method: "PATCH",
      });
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/hide",
        requestContext: mockRequestContext,
      });

      expect(mockHidePost).toHaveBeenCalledWith(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
    });

    it("should handle errors gracefully", async () => {
      mockHidePost.mockRejectedValue(new Error("Database error"));

      const request = new Request("http://test.com/api/posts/post-123/hide", {
        method: "PATCH",
      });
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/hide",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(500);
    });
  });

  describe("PATCH /api/posts/:id/unhide", () => {
    const route = postsRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/posts/post-123/unhide") &&
        r.method === "PATCH",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("http://test.com/api/posts/post-123/unhide", {
        method: "PATCH",
      });
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/unhide",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(401);
    });

    it("should unhide post successfully", async () => {
      const unhideResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
      mockUnhidePost.mockResolvedValue(unhideResponse);

      const request = new Request("http://test.com/api/posts/post-123/unhide", {
        method: "PATCH",
      });
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/unhide",
        requestContext: mockRequestContext,
      });

      expect(mockUnhidePost).toHaveBeenCalledWith(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
    });

    it("should handle errors gracefully", async () => {
      mockUnhidePost.mockRejectedValue(new Error("Database error"));

      const request = new Request("http://test.com/api/posts/post-123/unhide", {
        method: "PATCH",
      });
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/unhide",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(500);
    });
  });

  describe("POST /api/posts/:id/taxonomy-tags", () => {
    const route = postsRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/posts/post-123/taxonomy-tags") &&
        r.method === "POST",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/posts/post-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(401);
    });

    it("should return 500 when requestContext is missing", async () => {
      const request = new Request(
        "http://test.com/api/posts/post-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags",
      });

      expect(response.status).toBe(500);
    });

    it("should return rate limit response when rate limited", async () => {
      const rateLimitResponse = new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429 },
      );
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      const request = new Request(
        "http://test.com/api/posts/post-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(429);
    });

    it("should return 404 when post not found", async () => {
      mockGetPost.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/posts/post-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe("Post not found");
    });

    it("should return 403 when user does not own post", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "other-user",
      });

      const request = new Request(
        "http://test.com/api/posts/post-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("Forbidden");
    });

    it("should return 413 when request body too large", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });

      const request = new Request(
        "http://test.com/api/posts/post-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: {
            "Content-Type": "application/json",
            "content-length": "11000", // > 10KB
          },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(413);
      const data = await response.json();
      expect(data.error).toBe("Request body too large");
    });

    it("should return 400 when taxonIds is missing", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });

      const request = new Request(
        "http://test.com/api/posts/post-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("taxonIds array is required");
    });

    it("should return 400 for invalid taxon ID format", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });

      const request = new Request(
        "http://test.com/api/posts/post-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["invalid-format"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Invalid taxon ID format");
    });

    it("should add taxonomy tags successfully", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });
      mockGetPostTaxonomyTags.mockResolvedValue([
        {
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Training for recall commands",
        },
      ]);

      const request = new Request(
        "http://test.com/api/posts/post-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({
            taxonIds: ["behavior:training:recall"],
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(200);
      expect(mockAddPostTaxonomyTags).toHaveBeenCalledWith(
        "post-123",
        ["behavior:training:recall"],
        "user-123",
      );
      const data = await response.json();
      expect(data).toHaveProperty("tags");
    });

    it("should handle errors gracefully", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });
      mockAddPostTaxonomyTags.mockRejectedValue(new Error("Database error"));

      const request = new Request(
        "http://test.com/api/posts/post-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({
            taxonIds: ["behavior:training:recall"],
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(500);
    });
  });

  describe("DELETE /posts/:id/taxonomy-tags", () => {
    const route = postsRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/posts/post-123/taxonomy-tags") &&
        r.method === "DELETE",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/posts/post-123/taxonomy-tags",
        {
          method: "DELETE",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags", // Router may normalize to include /api
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(401);
    });

    it("should remove taxonomy tags successfully", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });

      const request = new Request(
        "http://test.com/posts/post-123/taxonomy-tags",
        {
          method: "DELETE",
          body: JSON.stringify({
            taxonIds: ["behavior:training:recall"],
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags", // Router may normalize to include /api
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(200);
      expect(mockRemovePostTaxonomyTags).toHaveBeenCalledWith("post-123", [
        "behavior:training:recall",
      ]);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it("should handle errors gracefully", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });
      mockRemovePostTaxonomyTags.mockRejectedValue(new Error("Database error"));

      const request = new Request(
        "http://test.com/posts/post-123/taxonomy-tags",
        {
          method: "DELETE",
          body: JSON.stringify({
            taxonIds: ["behavior:training:recall"],
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags", // Router may normalize to include /api
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(500);
    });
  });

  describe("GET /posts/:id/taxonomy-tags", () => {
    const route = postsRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/posts/post-123/taxonomy-tags") &&
        r.method === "GET",
    )!;

    it("should return 500 when requestContext is missing", async () => {
      const request = new Request(
        "http://test.com/posts/post-123/taxonomy-tags",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags", // Router may normalize to include /api
      });

      expect(response.status).toBe(500);
    });

    it("should return 404 when post not found", async () => {
      mockGetPost.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/posts/post-123/taxonomy-tags",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags", // Router may normalize to include /api
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(404);
    });

    it("should get taxonomy tags successfully", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });
      mockGetPostTaxonomyTags.mockResolvedValue([
        {
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Training for recall commands",
          category: null,
        },
      ]);

      const request = new Request(
        "http://test.com/posts/post-123/taxonomy-tags",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags", // Router may normalize to include /api
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("tags");
      expect(data.tags).toHaveLength(1);
    });

    it("should handle errors gracefully", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });
      mockGetPostTaxonomyTags.mockRejectedValue(new Error("Database error"));

      const request = new Request(
        "http://test.com/posts/post-123/taxonomy-tags",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/taxonomy-tags", // Router may normalize to include /api
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/posts/:id/tags/suggestions", () => {
    const route = postsRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/posts/post-123/tags/suggestions") &&
        r.method === "GET",
    )!;

    it("should return 500 when requestContext is missing", async () => {
      const request = new Request(
        "http://test.com/api/posts/post-123/tags/suggestions",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/tags/suggestions",
      });

      expect(response.status).toBe(500);
    });

    it("should return 404 when post not found", async () => {
      mockGetPost.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/posts/post-123/tags/suggestions",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/tags/suggestions",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(404);
    });

    it("should return tag suggestions successfully", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });
      mockDb.post.findUnique.mockResolvedValue({
        text: "Training my dog to recall",
      });
      mockSuggestTagsFromText.mockResolvedValue([
        {
          taxonId: "behavior:training:recall",
          confidence: 0.9,
        },
      ]);
      mockGetPopularTags.mockResolvedValue([]);
      mockGetUserFrequentTags.mockResolvedValue([]);

      const request = new Request(
        "http://test.com/api/posts/post-123/tags/suggestions",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/tags/suggestions",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("taxonomySuggestions");
      expect(data).toHaveProperty("popularTags");
      expect(data).toHaveProperty("userTags");
    });

    it("should include popular tags when requested", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });
      mockDb.post.findUnique.mockResolvedValue({
        text: "Training my dog",
      });
      mockSuggestTagsFromText.mockResolvedValue([]);
      mockGetPopularTags.mockResolvedValue([
        {
          taxonId: "behavior:training:recall",
          count: 100,
        },
      ]);
      mockGetUserFrequentTags.mockResolvedValue([]);

      const request = new Request(
        "http://test.com/api/posts/post-123/tags/suggestions?includePopular=true",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/tags/suggestions",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(200);
      expect(mockGetPopularTags).toHaveBeenCalled();
    });

    it("should include user tags when requested and authenticated", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });
      mockDb.post.findUnique.mockResolvedValue({
        text: "Training my dog",
      });
      mockSuggestTagsFromText.mockResolvedValue([]);
      mockGetPopularTags.mockResolvedValue([]);
      mockGetUserFrequentTags.mockResolvedValue([
        {
          taxonId: "behavior:training:recall",
          count: 5,
        },
      ]);

      const request = new Request(
        "http://test.com/api/posts/post-123/tags/suggestions?includeUserTags=true",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/tags/suggestions",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(200);
      expect(mockGetUserFrequentTags).toHaveBeenCalledWith("user-123", 5);
    });

    it("should respect limit parameter", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });
      mockDb.post.findUnique.mockResolvedValue({
        text: "Training my dog",
      });
      mockSuggestTagsFromText.mockResolvedValue([]);
      mockGetPopularTags.mockResolvedValue([]);
      mockGetUserFrequentTags.mockResolvedValue([]);

      const request = new Request(
        "http://test.com/api/posts/post-123/tags/suggestions?limit=5",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/tags/suggestions",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(200);
      expect(mockSuggestTagsFromText).toHaveBeenCalledWith(
        "Training my dog",
        expect.objectContaining({
          limit: 5,
        }),
      );
    });

    it("should cap limit at 20", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });
      mockDb.post.findUnique.mockResolvedValue({
        text: "Training my dog",
      });
      mockSuggestTagsFromText.mockResolvedValue([]);
      mockGetPopularTags.mockResolvedValue([]);
      mockGetUserFrequentTags.mockResolvedValue([]);

      const request = new Request(
        "http://test.com/api/posts/post-123/tags/suggestions?limit=100",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/tags/suggestions",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(200);
      expect(mockSuggestTagsFromText).toHaveBeenCalledWith(
        "Training my dog",
        expect.objectContaining({
          limit: 20, // Capped at 20
        }),
      );
    });

    it("should handle errors gracefully", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "user-123",
      });
      mockDb.post.findUnique.mockRejectedValue(new Error("Database error"));

      const request = new Request(
        "http://test.com/api/posts/post-123/tags/suggestions",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/tags/suggestions",
        requestContext: mockRequestContext,
      });

      expect(response.status).toBe(500);
    });
  });
});
