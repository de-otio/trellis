/**
 * Extended Unit Tests: Post Handler
 *
 * Tests uncovered code paths: deletePost soft-delete behavior, editPost branches,
 * hidePost/unhidePost edge cases, visibility enforcement, feed cache invalidation,
 * serialization error handling, EntityTaggingError, and dev environment error details.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostHandler } from "../../src/lib/post-handler.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

// Mock DataRouter
const mockGetUser = vi.fn();
const mockCreateUser = vi.fn();
const mockCreatePost = vi.fn();
const mockGetPost = vi.fn();
const mockGetDatabaseForRegion = vi.fn();

vi.mock("../../src/lib/data-router", () => ({
  DataRouter: {
    getUser: (...args: any[]) => mockGetUser(...args),
    createUser: (...args: any[]) => mockCreateUser(...args),
    createPost: (...args: any[]) => mockCreatePost(...args),
    getPost: (...args: any[]) => mockGetPost(...args),
    getDatabaseForRegion: (...args: any[]) => mockGetDatabaseForRegion(...args),
  },
}));

// Mock region detection
const mockDetectRegion = vi.fn();
vi.mock("../../src/lib/region-detection", () => ({
  detectRegion: (...args: any[]) => mockDetectRegion(...args),
  RegionDetector: class {
    detectRegion = mockDetectRegion;
  },
}));

// Mock the text-moderation seam (fail-closed provider injection point).
// The mock returns canonical ModerationVerdicts; the real gate logic
// (text-moderation-gate.ts) still runs on top of it.
const mockModerateText = vi.fn().mockResolvedValue({ decision: "approved", labels: [], provider: "mock-text" });
vi.mock("../../src/lib/media/request-text-moderation", () => ({
  getTextModerationProvider: () => ({ moderateText: mockModerateText }),
}));

// Mock FeatureToggleService
const mockIsEnabled = vi.fn().mockResolvedValue(true);
vi.mock("../../src/lib/feature-toggle-service", () => ({
  FeatureToggleService: class {
    isEnabled = mockIsEnabled;
    // Moderation gate now reads through the fail-closed variant; route it to the
    // same control fn so these tests keep steering moderation via mockIsEnabled.
    isEnabledFailClosed = mockIsEnabled;
  },
}));

// Mock db module
vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => ({}) as any),
}));

// Mock withQueryTimeoutAndRetry
const mockWithQueryTimeoutAndRetry = vi.fn();
const mockSharedDatabaseConnectionManager = {
  executeWithRetry: vi.fn(),
};

vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: mockSharedDatabaseConnectionManager,
  DatabaseConnectionManager: class {
    executeWithRetry = mockSharedDatabaseConnectionManager.executeWithRetry;
  },
}));

vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) => mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 3000, retryTimeoutMs: 2000 },
    BACKGROUND: { timeoutMs: 12000, retryTimeoutMs: 5000 },
    CRITICAL: { timeoutMs: 5000, retryTimeoutMs: 3000 },
    STANDARD: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock LinkSecurityHandler
const mockExtractUrls = vi.fn().mockReturnValue([]);
const mockValidateUrlSync = vi.fn().mockReturnValue({
  status: "safe",
  normalizedUrl: null,
});
vi.mock("../../src/lib/link-security-handler", () => ({
  LinkSecurityHandler: class {
    extractUrls = mockExtractUrls;
    validateUrlSync = mockValidateUrlSync;
  },
  LinkStatus: { SAFE: "safe", BLOCKED: "blocked", UNKNOWN: "unknown" },
}));

// Mock InputSanitizer
vi.mock("../../src/lib/input-sanitizer", () => ({
  InputSanitizer: {
    sanitizeText: (text: string) => text,
  },
}));

// Mock validateRequest
const mockValidateRequest = vi.fn().mockResolvedValue({
  success: true,
  data: { text: "Test post", visibility: "public" },
});
vi.mock("../../src/lib/validate-request", () => ({
  validateRequest: (...args: any[]) => mockValidateRequest(...args),
}));

// Mock schemas
vi.mock("../../src/lib/schemas", () => ({
  createPostSchema: {},
  editPostSchema: {},
}));

// Mock entity-tagging-errors
class MockEntityTaggingError extends Error {
  code: string;
  statusCode: number;
  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = "EntityTaggingError";
  }
}
vi.mock("../../src/lib/entity-tagging-errors", () => ({
  EntityTaggingError: MockEntityTaggingError,
}));

// Mock database-wrapper-helper
vi.mock("../../src/lib/database-wrapper-helper", () => ({
  getWrappedDatabase: vi.fn(() => ({
    linkCheck: { findMany: vi.fn().mockResolvedValue([]) },
  })),
}));

// Mock taxonomy-handler
vi.mock("../../src/lib/taxonomy-handler", () => ({
  TaxonomyHandler: class {
    addPostTaxonomyTags = vi.fn();
    getPostTaxonomyTags = vi.fn().mockResolvedValue([]);
  },
}));

// Mock request-context
vi.mock("../../src/lib/request-context", () => ({
  createRequestContext: vi.fn().mockResolvedValue({ session: null }),
}));

describe("PostHandler - Extended", () => {
  let handler: PostHandler;
  let mockEnv: any;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEnabled.mockResolvedValue(true);
    mockDetectRegion.mockResolvedValue("US");
    handler = new PostHandler();

    mockSession = {
      userId: "test-user-id-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    } as any;

    mockDb = {
      post: {
        delete: vi.fn().mockResolvedValue({ id: "post-123" }),
        update: vi.fn().mockResolvedValue({ id: "post-123" }),
        findUnique: vi.fn().mockResolvedValue({
          deletedAt: null,
          taggedEntities: [],
        }),
      },
      postSentiment: {
        groupBy: vi.fn().mockResolvedValue([]),
      },
      postComment: {
        count: vi.fn().mockResolvedValue(0),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "test-user-id-123",
          email: "test@example.com",
          username: "testuser",
        }),
      },
      domainReputation: { upsert: vi.fn().mockResolvedValue({}) },
      linkCheck: {
        create: vi.fn().mockResolvedValue({ id: "lc-1" }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      mediaFile: { findMany: vi.fn().mockResolvedValue([]) },
    };

    mockGetDatabaseForRegion.mockReturnValue(mockDb);

    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (manager: any, region: string, env: any, queryFn: (db: any) => Promise<any>) => {
        return await queryFn(mockDb);
      },
    );

    mockEnv = {
      DATABASE_URL: "postgres://test",
      DEFAULT_REGION: "US",
      ENVIRONMENT: "dev",
      FEED_CACHE_KV: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      } as any,
    };

    mockRequestContext = {
      region: "US" as const,
      config: {
        featureFlags: { authentication: {}, features: {}, performance: {}, security: {} },
        endpoints: { api: "https://api.example.com", frontend: "https://app.example.com", cdn: "https://cdn.example.com" },
        timeouts: { database: 5000, api: 10000 },
      },
      session: mockSession,
    } as any;

    // Re-set default mocks after clearAllMocks
    mockValidateRequest.mockResolvedValue({
      success: true,
      data: { text: "Test post", visibility: "public" },
    });
    mockExtractUrls.mockReturnValue([]);
    mockValidateUrlSync.mockReturnValue({ status: "safe", normalizedUrl: null });
    mockModerateText.mockResolvedValue({ decision: "approved", labels: [], provider: "mock-text" });
  });

  describe("deletePost - soft delete behavior", () => {
    beforeEach(() => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "test-user-id-123",
      });
    });

    it("should return 410 when post is already soft-deleted", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: new Date("2024-01-01") });

      const request = new Request("http://test.com/posts/post-123", { method: "DELETE" });
      const response = await handler.deletePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
      const data = await response.json();
      expect(data.error).toBe("Post already deleted");
    });

    it("should soft-delete post and invalidate feed cache", async () => {
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockDb.post.update.mockResolvedValue({ id: "post-123" });

      const request = new Request("http://test.com/posts/post-123", { method: "DELETE" });
      const response = await handler.deletePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it("should return 500 on database error during deletion", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(new Error("DB timeout"));

      const request = new Request("http://test.com/posts/post-123", { method: "DELETE" });
      const response = await handler.deletePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
    });
  });

  describe("editPost - additional branches", () => {
    beforeEach(() => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "test-user-id-123",
      });
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { text: "Updated text", visibility: "friends-only" },
      });
      mockDb.post.update.mockResolvedValue({
        id: "post-123",
        text: "Updated text",
        visibility: "FRIENDS",
        uri: "http://test.com/posts/post-123",
        createdAt: new Date("2024-01-01"),
        editedAt: new Date(),
        contentWarnings: [],
        author: {
          id: "test-user-id-123",
          email: "test@example.com",
          username: "testuser",
          actorUri: null,
          publicKey: null,
        },
        media: [],
      });
    });

    it("should return 404 if post not found for edit", async () => {
      mockGetPost.mockResolvedValue(null);

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "updated" }),
      });
      const response = await handler.editPost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
    });

    it("should return 403 if user is not post owner for edit", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "other-user",
      });

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "updated" }),
      });
      const response = await handler.editPost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.message).toContain("only edit your own");
    });

    it("should return 410 if editing a deleted post", async () => {
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: "test-user-id-123",
        deletedAt: new Date(),
      });

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "updated" }),
      });
      const response = await handler.editPost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(410);
    });

    it("should reject edit with blocked links", async () => {
      mockExtractUrls.mockReturnValue(["http://evil.com"]);
      mockValidateUrlSync.mockReturnValue({ status: "blocked", reason: "malware" });

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "check http://evil.com" }),
      });
      const response = await handler.editPost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("DANGEROUS_LINKS_DETECTED");
    });

    it("should reject edit with content moderation failure", async () => {
      mockModerateText.mockResolvedValue({ decision: "quarantine", labels: [], provider: "mock-text" });

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "bad content" }),
      });
      const response = await handler.editPost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("CONTENT_REJECTED");
    });

    it("should convert friends-only visibility to FRIENDS enum", async () => {
      mockDb.post.update.mockResolvedValue({
        id: "post-123",
        text: "Updated text",
        visibility: "FRIENDS",
        uri: "",
        createdAt: new Date(),
        editedAt: new Date(),
        contentWarnings: [],
        author: { id: "test-user-id-123", email: "test@example.com", username: "testuser" },
        media: [],
      });

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "updated", visibility: "friends-only" }),
      });
      const response = await handler.editPost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
    });

    it("should return 500 on edit database error", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(new Error("DB error"));

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "updated" }),
      });
      const response = await handler.editPost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
    });

    it("should skip content moderation when feature toggle is disabled", async () => {
      // First call: content_moderation_enabled = false
      mockIsEnabled.mockResolvedValue(false);

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
        body: JSON.stringify({ text: "updated" }),
      });
      const response = await handler.editPost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      expect(mockModerateText).not.toHaveBeenCalled();
    });
  });

  describe("createPost - visibility enforcement", () => {
    beforeEach(() => {
      mockCreateUser.mockResolvedValue({ id: "test-user-id-123", email: "test@example.com" });
      mockCreatePost.mockResolvedValue({
        id: "post-123",
        authorId: "test-user-id-123",
        createdAt: new Date(),
      });
      mockDb.post.findUnique.mockResolvedValue({
        deletedAt: null,
        taggedEntities: [],
        author: { id: "test-user-id-123", username: "testuser", actorUri: null, publicKey: null },
      });
    });

    it("should convert friends_only to FRIENDS visibility", async () => {
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { text: "Test post", visibility: "friends_only" },
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({ text: "Test", visibility: "friends_only" }),
      });
      const response = await handler.createPost(request, mockSession, mockEnv, mockRequestContext);

      expect(response.status).toBe(201);
      // Verify createPost was called with FRIENDS visibility
      expect(mockCreatePost).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: "FRIENDS" }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should return validation error when request validation fails", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Validation failed" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
      mockValidateRequest.mockResolvedValue({
        success: false,
        error: errorResponse,
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const response = await handler.createPost(request, mockSession, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
    });

    it("should skip moderation when content_moderation_enabled is false", async () => {
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { text: "Test post", visibility: "private" },
      });
      // isEnabled calls: first for content_moderation_enabled
      mockIsEnabled.mockResolvedValue(false);

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({ text: "Test", visibility: "private" }),
      });
      const response = await handler.createPost(request, mockSession, mockEnv, mockRequestContext);

      expect(response.status).toBe(201);
      // Moderation should not be called when disabled
      expect(mockModerateText).not.toHaveBeenCalled();
    });
  });

  describe("createPost - error handling in catch block", () => {
    it("should include error details in dev environment on DataRouter failure", async () => {
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { text: "Test post", visibility: "private" },
      });
      mockCreateUser.mockResolvedValue({ id: "test-user-id-123" });
      // isEnabled for content_moderation_enabled
      mockIsEnabled.mockResolvedValue(false);
      mockCreatePost.mockRejectedValue(new Error("Something broke"));

      mockEnv.ENVIRONMENT = "dev";

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({ text: "Test", visibility: "private" }),
      });
      const response = await handler.createPost(request, mockSession, mockEnv, mockRequestContext);

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe("Failed to create post");
      expect(data.details).toBeDefined();
      expect(data.details.message).toBe("Something broke");
    });

    it("should not include error details in production on DataRouter failure", async () => {
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { text: "Test post", visibility: "private" },
      });
      mockCreateUser.mockResolvedValue({ id: "test-user-id-123" });
      mockIsEnabled.mockResolvedValue(false);
      mockCreatePost.mockRejectedValue(new Error("Something broke"));

      mockEnv.ENVIRONMENT = "production";

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({ text: "Test", visibility: "private" }),
      });
      const response = await handler.createPost(request, mockSession, mockEnv, mockRequestContext);

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe("Failed to create post");
      expect(data.details).toBeUndefined();
    });
  });

  describe("hidePost/unhidePost - additional edge cases", () => {
    it("should handle hide when post not found", async () => {
      mockGetPost.mockResolvedValue(null);

      const request = new Request("http://test.com/posts/post-123/hide", { method: "POST" });
      const response = await handler.hidePost(
        "nonexistent",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
    });

    it("should handle hide when user is not owner", async () => {
      mockGetPost.mockResolvedValue({ id: "post-123", authorId: "other-user" });

      const request = new Request("http://test.com/posts/post-123/hide", { method: "POST" });
      const response = await handler.hidePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(403);
    });

    it("should handle unhide when post not found", async () => {
      mockGetPost.mockResolvedValue(null);

      const request = new Request("http://test.com/posts/post-123/unhide", { method: "POST" });
      const response = await handler.unhidePost(
        "nonexistent",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
    });

    it("should handle unhide when user is not owner", async () => {
      mockGetPost.mockResolvedValue({ id: "post-123", authorId: "other-user" });

      const request = new Request("http://test.com/posts/post-123/unhide", { method: "POST" });
      const response = await handler.unhidePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(403);
    });

    it("should return 500 on hide database error", async () => {
      mockGetPost.mockResolvedValue({ id: "post-123", authorId: "test-user-id-123" });
      mockWithQueryTimeoutAndRetry.mockRejectedValue(new Error("DB error"));

      const request = new Request("http://test.com/posts/post-123/hide", { method: "POST" });
      const response = await handler.hidePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
    });

    it("should return 500 on unhide database error", async () => {
      mockGetPost.mockResolvedValue({ id: "post-123", authorId: "test-user-id-123" });
      mockWithQueryTimeoutAndRetry.mockRejectedValue(new Error("DB error"));

      const request = new Request("http://test.com/posts/post-123/unhide", { method: "POST" });
      const response = await handler.unhidePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
    });
  });

  describe("feed cache invalidation edge cases", () => {
    it("should handle feed cache invalidation when FEED_CACHE_KV is absent", async () => {
      mockGetPost.mockResolvedValue({ id: "post-123", authorId: "test-user-id-123" });
      mockDb.post.findUnique.mockResolvedValue({ deletedAt: null });
      mockDb.post.update.mockResolvedValue({ id: "post-123" });
      delete mockEnv.FEED_CACHE_KV;

      const request = new Request("http://test.com/posts/post-123", { method: "DELETE" });
      const response = await handler.deletePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      // Should still succeed without cache
      expect(response.status).toBe(200);
    });

    it("should handle feed cache invalidation error gracefully on hide", async () => {
      mockGetPost.mockResolvedValue({ id: "post-123", authorId: "test-user-id-123" });
      mockDb.post.update.mockResolvedValue({ id: "post-123" });
      mockEnv.FEED_CACHE_KV.get.mockRejectedValue(new Error("KV error"));

      const request = new Request("http://test.com/posts/post-123/hide", { method: "POST" });
      const response = await handler.hidePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      // Should still succeed even if cache invalidation fails
      expect(response.status).toBe(200);
    });
  });
});
