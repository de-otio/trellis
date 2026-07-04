/**
 * Unit Tests: Post Handler
 *
 * Tests PostHandler with DataRouter integration for region-aware operations.
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
vi.mock("../../src/lib/region-detection", () => {
  return {
    detectRegion: (...args: any[]) => mockDetectRegion(...args),
    RegionDetector: class RegionDetector {
      detectRegion = mockDetectRegion;
    },
  };
});

// Mock the text-moderation seam (fail-closed provider injection point).
// The mock returns canonical ModerationVerdicts; the real gate logic
// (text-moderation-gate.ts) still runs on top of it.
const mockModerateText = vi
  .fn()
  .mockResolvedValue({ decision: "approved", labels: [], provider: "mock-text" });
vi.mock("../../src/lib/media/request-text-moderation", () => ({
  getTextModerationProvider: () => ({ moderateText: mockModerateText }),
}));

// Mock FeatureToggleService
const mockIsEnabled = vi.fn().mockResolvedValue(true);
vi.mock("../../src/lib/feature-toggle-service", () => {
  class MockFeatureToggleService {
    isEnabled = mockIsEnabled;
  }
  return {
    FeatureToggleService: MockFeatureToggleService,
  };
});

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
  DatabaseConnectionManager: class DatabaseConnectionManager {
    executeWithRetry = mockSharedDatabaseConnectionManager.executeWithRetry;
  },
}));

vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
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
const mockLinkStatus = {
  SAFE: "safe",
  BLOCKED: "blocked",
  UNKNOWN: "unknown",
};
vi.mock("../../src/lib/link-security-handler", () => ({
  LinkSecurityHandler: class {
    extractUrls = mockExtractUrls;
    validateUrlSync = mockValidateUrlSync;
  },
  LinkStatus: mockLinkStatus,
}));

// Mock InputSanitizer
const mockSanitizeText = vi.fn((text: string) => text);
vi.mock("../../src/lib/input-sanitizer", () => ({
  InputSanitizer: {
    sanitizeText: (...args: any[]) => mockSanitizeText(...args),
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
  editPostSchema: {}, // ADD: editPost tests need this
}));

describe("PostHandler", () => {
  let handler: PostHandler;
  let mockEnv: any;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEnabled.mockResolvedValue(true); // Default: allow public posting
    mockDetectRegion.mockResolvedValue("US"); // Default region
    handler = new PostHandler();

    mockSession = {
      userId: "test-user-id-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    };

    // Create mock database that will be returned by getDatabaseForRegion
    mockDb = {
      post: {
        delete: vi.fn().mockResolvedValue({ id: "post-123" }),
        update: vi.fn().mockResolvedValue({ id: "post-123", hidden: true }),
        findUnique: vi.fn().mockResolvedValue({
          deletedAt: null,
          taggedEntities: [],
        }),
      },
      postSentiment: {
        groupBy: vi.fn().mockResolvedValue([]), // Default: no sentiments
      },
      postComment: {
        count: vi.fn().mockResolvedValue(0), // Default: no comments
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: mockSession.userId,
          email: mockSession.email,
          username: "testuser",
        }),
      },
    };

    // Setup default return for getDatabaseForRegion
    mockGetDatabaseForRegion.mockReturnValue(mockDb);

    // Default mock: withQueryTimeoutAndRetry executes the query function with mockDb
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (
        manager: any,
        region: string,
        env: any,
        queryFn: (db: any) => Promise<any>,
      ) => {
        return await queryFn(mockDb);
      },
    );

    mockEnv = {
      DATABASE_URL: "postgres://test",
      US_DATABASE_URL: "postgres://us-test",
      EU_DATABASE_URL: "postgres://eu-test",
      CN_DATABASE_URL: "postgres://cn-test",
      OPENAI_API_KEY: "test-key",
      MODERATION_CACHE_KV: {} as any,
      FEED_CACHE_KV: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined), // ADD: editPost needs this
      } as any,
      DEFAULT_REGION: "US",
    };

    mockSession = {
      userId: "test-user-id-123",
      email: "test@example.com",
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

    // Default mock implementations
    // Feature toggle is mocked at module level above
    mockGetUser.mockResolvedValue({
      id: mockSession.userId,
      email: mockSession.email,
      region: "US",
      dataRegion: "US",
    });

    mockCreatePost.mockResolvedValue({
      id: "post-123",
      authorId: mockSession.userId,
      dataRegion: "US",
    });

    mockGetPost.mockResolvedValue({
      id: "post-123",
      authorId: mockSession.userId,
      dataRegion: "US",
    });
  });

  describe("createPost", () => {
    beforeEach(() => {
      // Setup default mocks for createPost tests
      mockGetUser.mockResolvedValue({
        id: mockSession.userId,
        email: mockSession.email,
      });
      mockCreatePost.mockResolvedValue({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Test post",
        visibility: "PUBLIC",
      });
    });

    it("should validate text is required", async () => {
      mockValidateRequest.mockResolvedValueOnce({
        success: false,
        error: new Response(
          JSON.stringify({
            error: "Validation failed",
            details: [{ path: "text", message: "Required" }],
          }),
          { status: 400 },
        ),
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Validation failed");
      expect(data.details).toBeDefined();
      expect(data.details.some((d: any) => d.path === "text")).toBe(true);
      expect(mockCreatePost).not.toHaveBeenCalled();
    });

    it("should validate text length", async () => {
      const longText = "a".repeat(3001);
      mockValidateRequest.mockResolvedValueOnce({
        success: false,
        error: new Response(
          JSON.stringify({
            error: "Validation failed",
            details: [{ path: "text", message: "Text too long" }],
          }),
          { status: 400 },
        ),
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: longText,
          visibility: "public",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Validation failed");
      expect(data.details).toBeDefined();
      expect(data.details.some((d: any) => d.path === "text")).toBe(true);
      expect(mockCreatePost).not.toHaveBeenCalled();
    });

    it("should validate visibility", async () => {
      mockValidateRequest.mockResolvedValueOnce({
        success: false,
        error: new Response(
          JSON.stringify({
            error: "Validation failed",
            details: [{ path: "visibility", message: "Invalid visibility" }],
          }),
          { status: 400 },
        ),
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "invalid",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Validation failed");
      expect(data.details).toBeDefined();
      expect(data.details.some((d: any) => d.path === "visibility")).toBe(true);
      expect(mockCreatePost).not.toHaveBeenCalled();
    });

    it("should reject content that fails moderation", async () => {
      mockIsEnabled.mockResolvedValueOnce(true); // Allow public posting
      mockModerateText.mockResolvedValueOnce({
        decision: "quarantine",
        labels: [{ category: "category_a", confidence: 0.9 }],
        provider: "mock-text",
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Bad content",
          visibility: "public",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("CONTENT_REJECTED");
      expect(mockCreatePost).not.toHaveBeenCalled();
    });

    it("should create post using DataRouter with correct region", async () => {
      mockIsEnabled.mockResolvedValueOnce(true); // Allow public posting
      mockCreateUser.mockResolvedValueOnce({
        id: mockSession.userId,
        email: mockSession.email,
        region: "US",
        dataRegion: "US",
      });
      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.id).toBe("post-123");
      expect(mockCreateUser).toHaveBeenCalledWith(
        {
          id: mockSession.userId,
          email: mockSession.email,
        },
        "US",
        mockEnv,
        request,
        expect.any(String),
      );
      expect(mockCreatePost).toHaveBeenCalledWith(
        expect.objectContaining({
          authorId: mockSession.userId,
          text: "Test post",
          // Legacy visibility "public" maps to radius SHOUT — the Post model
          // has no visibility column.
          radius: "SHOUT",
        }),
        "US",
        mockEnv,
        request,
        expect.any(String),
        mockSession,
      );
    });

    it("should create user using upsert (createUser)", async () => {
      mockIsEnabled.mockResolvedValueOnce(true); // Allow public posting
      mockCreateUser.mockResolvedValueOnce({
        id: mockSession.userId,
        email: mockSession.email,
        region: "US",
        dataRegion: "US",
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(mockCreateUser).toHaveBeenCalledWith(
        {
          id: mockSession.userId,
          email: mockSession.email,
        },
        "US",
        mockEnv,
        request,
        expect.any(String),
      );
      expect(mockCreatePost).toHaveBeenCalled();
    });

    it("should use region from requestContext", async () => {
      mockIsEnabled.mockResolvedValueOnce(true); // Allow public posting
      const cnRequestContext = {
        ...mockRequestContext,
        region: "CN" as const,
      };

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        cnRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(mockCreatePost).toHaveBeenCalledWith(
        expect.any(Object),
        "CN",
        mockEnv,
        request,
        expect.any(String),
        mockSession,
      );
    });

    it("should handle DataRouter errors gracefully", async () => {
      mockIsEnabled.mockResolvedValueOnce(true); // Allow public posting
      mockCreatePost.mockRejectedValueOnce(new Error("Database error"));

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Failed to create post");
    });

    it("should create post with entityRefs", async () => {
      mockIsEnabled.mockResolvedValueOnce(true); // Allow public posting
      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Test post",
          visibility: "public",
          entityRefs: ["clx123abc456def789", "clx987xyz654ghi321"],
        },
      });
      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Test post",
        visibility: "PUBLIC",
        dataRegion: "US",
      });

      // Mock database for fetching tagged entities
      mockWithQueryTimeoutAndRetry
        .mockResolvedValueOnce({
          id: "post-123",
          taggedEntities: [
            {
              entity: {
                id: "clx123abc456def789",
                name: "Dog 1",
                entityType: "dog",
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          id: mockSession.userId,
          email: mockSession.email,
          username: "testuser",
        });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
          entityRefs: ["clx123abc456def789", "clx987xyz654ghi321"],
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.id).toBe("post-123");
      expect(mockCreatePost).toHaveBeenCalled();
    });

    it("should handle entity tagging permission errors", async () => {
      mockIsEnabled.mockResolvedValueOnce(true); // Allow public posting
      const { EntityTaggingPermissionError } = await import(
        "../../src/lib/entity-tagging-errors.js"
      );
      mockCreatePost.mockRejectedValueOnce(
        new EntityTaggingPermissionError("Permission denied"),
      );

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
          entityRefs: ["clx123abc456def789"],
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe("PERMISSION_DENIED");
      expect(data.message.toLowerCase()).toContain("permission");
    });

    it("should handle invalid entities errors", async () => {
      mockIsEnabled.mockResolvedValueOnce(true); // Allow public posting
      const { InvalidEntitiesError } = await import(
        "../../src/lib/entity-tagging-errors.js"
      );
      mockCreatePost.mockRejectedValueOnce(
        new InvalidEntitiesError("Invalid entities"),
      );

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
          entityRefs: ["clx999nonexistent999"],
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("INVALID_ENTITIES");
    });

    it("should create post without entityRefs", async () => {
      mockIsEnabled.mockResolvedValueOnce(true); // Allow public posting
      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Test post",
        visibility: "PUBLIC",
        dataRegion: "US",
      });

      mockDb.post.findUnique = vi.fn().mockResolvedValue({
        id: "post-123",
        taggedEntities: [],
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(mockCreatePost).toHaveBeenCalledWith(
        expect.objectContaining({
          entityRefs: undefined,
        }),
        "US",
        mockEnv,
        request,
        expect.any(String),
        mockSession,
      );
    });

    it("should reject public posting when feature toggle is disabled", async () => {
      mockIsEnabled.mockResolvedValueOnce(false); // Disable public posting

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe("PUBLIC_POSTING_DISABLED");
      expect(data.message).toContain("Public posting is currently disabled");
      expect(mockCreatePost).not.toHaveBeenCalled();
    });

    it("should allow friends-only posting when public posting is disabled", async () => {
      // Feature toggle check only happens for 'public' visibility
      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Test post",
          visibility: "friends-only",
        },
      });
      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Test post",
        visibility: "FRIENDS",
        dataRegion: "US",
      });

      mockDb.post.findUnique = vi.fn().mockResolvedValue({
        id: "post-123",
        taggedEntities: [],
      });
      mockDb.user.findUnique = vi.fn().mockResolvedValue({
        id: mockSession.userId,
        email: mockSession.email,
        username: "testuser",
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "friends-only",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      // Should succeed because friends-only doesn't require public posting toggle
      expect(response.status).toBe(201);
      // Feature toggle should not be checked for global_public_posting_enabled
      // but IS checked for content_moderation_enabled
      expect(mockIsEnabled).not.toHaveBeenCalledWith("global_public_posting_enabled");
    });

    it("should allow private posting when public posting is disabled", async () => {
      // Feature toggle check only happens for 'public' visibility
      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Test post",
          visibility: "private",
        },
      });
      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Test post",
        visibility: "PRIVATE",
        dataRegion: "US",
      });

      mockDb.post.findUnique = vi.fn().mockResolvedValue({
        id: "post-123",
        taggedEntities: [],
      });
      mockDb.user.findUnique = vi.fn().mockResolvedValue({
        id: mockSession.userId,
        email: mockSession.email,
        username: "testuser",
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "private",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      // Should succeed because private doesn't require public posting toggle
      expect(response.status).toBe(201);
      // Feature toggle should not be checked for global_public_posting_enabled
      // but IS checked for content_moderation_enabled
      expect(mockIsEnabled).not.toHaveBeenCalledWith("global_public_posting_enabled");
    });

    it("should reject posts with dangerous links", async () => {
      mockIsEnabled.mockResolvedValueOnce(true);
      mockExtractUrls.mockReturnValue(["http://malicious-site.com"]);
      mockValidateUrlSync.mockReturnValue({
        status: "blocked",
        reason: "Known malicious domain",
        normalizedUrl: null,
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Check out http://malicious-site.com",
          visibility: "public",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("DANGEROUS_LINKS_DETECTED");
      expect(data.message).toContain("dangerous or blocked links");
      expect(mockCreatePost).not.toHaveBeenCalled();
    });

    it("should allow posts with safe links", async () => {
      mockIsEnabled.mockResolvedValueOnce(true);
      mockExtractUrls.mockReturnValue(["https://example.com"]);
      mockValidateUrlSync.mockReturnValue({
        status: "safe",
        normalizedUrl: {
          normalized: "https://example.com",
          domain: "example.com",
        },
      });
      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Check out https://example.com",
        visibility: "PUBLIC",
        dataRegion: "US",
      });

      mockDb.post.findUnique = vi.fn().mockResolvedValue({
        id: "post-123",
        taggedEntities: [],
      });
      mockDb.domainReputation = {
        upsert: vi.fn().mockResolvedValue({}),
      };
      mockDb.linkCheck = {
        create: vi.fn().mockResolvedValue({
          id: "link-check-123",
          postId: "post-123",
          originalUrl: "https://example.com",
          normalizedUrl: "https://example.com",
          domain: "example.com",
          status: "safe",
        }),
      };
      mockEnv.LINK_CHECK_QUEUE = {
        send: vi.fn().mockResolvedValue(undefined),
      };

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Check out https://example.com",
          visibility: "public",
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(201);
      expect(mockCreatePost).toHaveBeenCalled();
    });

    it("should handle queue send errors gracefully when sending link checks", async () => {
      mockIsEnabled.mockResolvedValueOnce(true);
      mockExtractUrls.mockReturnValue(["https://example.com"]);
      mockValidateUrlSync.mockReturnValue({
        status: "safe",
        normalizedUrl: {
          normalized: "https://example.com",
          domain: "example.com",
        },
      });
      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Check out https://example.com",
        visibility: "PUBLIC",
        dataRegion: "US",
      });
      mockDb.domainReputation = {
        upsert: vi.fn().mockResolvedValue({}),
      };
      mockDb.linkCheck = {
        create: vi.fn().mockResolvedValue({
          id: "link-check-123",
          postId: "post-123",
          originalUrl: "https://example.com",
          normalizedUrl: "https://example.com",
          domain: "example.com",
          status: "safe",
        }),
      };
      // Mock queue to fail
      mockEnv.LINK_CHECK_QUEUE = {
        send: vi.fn().mockRejectedValue(new Error("Queue error")),
      };

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Check out https://example.com",
          visibility: "public",
        }),
      });

      // Should still succeed - queue errors are logged but don't fail post creation
      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(201);
      expect(mockCreatePost).toHaveBeenCalled();
    });

    it("should handle link check creation errors gracefully", async () => {
      mockIsEnabled.mockResolvedValueOnce(true);
      mockExtractUrls.mockReturnValue(["https://example.com"]);
      mockValidateUrlSync.mockReturnValue({
        status: "safe",
        normalizedUrl: {
          normalized: "https://example.com",
          domain: "example.com",
        },
      });
      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Check out https://example.com",
        visibility: "PUBLIC",
        dataRegion: "US",
      });

      mockDb.post.findUnique = vi.fn().mockResolvedValue({
        id: "post-123",
        taggedEntities: [],
      });
      mockDb.domainReputation = {
        upsert: vi.fn().mockRejectedValue(new Error("DB error")),
      };

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Check out https://example.com",
          visibility: "public",
        }),
      });

      // Should still succeed - link check errors don't fail post creation
      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(201);
    });

    it("should sanitize text input to prevent XSS", async () => {
      mockIsEnabled.mockResolvedValueOnce(true);
      mockSanitizeText.mockImplementation((text) =>
        text.replace(/<script>/gi, ""),
      );
      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Test post",
        visibility: "PUBLIC",
        dataRegion: "US",
      });

      mockDb.post.findUnique = vi.fn().mockResolvedValue({
        id: "post-123",
        taggedEntities: [],
      });
      mockDb.user.findUnique = vi.fn().mockResolvedValue({
        id: mockSession.userId,
        email: mockSession.email,
        username: "testuser",
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: 'Test <script>alert("xss")</script> post',
          visibility: "public",
        }),
      });

      await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      // InputSanitizer.sanitizeText is called internally
      expect(mockSanitizeText).toHaveBeenCalled();
    });

    it("should handle taxonomy tag errors gracefully", async () => {
      mockIsEnabled.mockResolvedValueOnce(true);
      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Test post",
          visibility: "public",
          taxonomyTags: ["dimension:category:taxon1"],
        },
      });
      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Test post",
        visibility: "PUBLIC",
        dataRegion: "US",
      });

      mockDb.post.findUnique = vi.fn().mockResolvedValue({
        id: "post-123",
        taggedEntities: [],
      });
      mockDb.user.findUnique = vi.fn().mockResolvedValue({
        id: mockSession.userId,
        email: mockSession.email,
        username: "testuser",
      });

      // Mock taxonomy handler to throw error (will be caught and logged)
      const mockAddPostTaxonomyTags = vi
        .fn()
        .mockRejectedValue(new Error("Taxonomy error"));
      vi.doMock("../../src/lib/taxonomy-handler", () => ({
        TaxonomyHandler: class {
          addPostTaxonomyTags = mockAddPostTaxonomyTags;
        },
      }));

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
          taxonomyTags: ["dimension:category:taxon1"],
        }),
      });

      // Should still succeed - taxonomy tag errors don't fail post creation
      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(201);
    });

    it("should handle feed cache invalidation errors gracefully", async () => {
      mockIsEnabled.mockResolvedValueOnce(true);
      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Test post",
          visibility: "public",
        },
      });
      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Test post",
        visibility: "PUBLIC",
        dataRegion: "US",
      });

      mockDb.post.findUnique = vi.fn().mockResolvedValue({
        id: "post-123",
        taggedEntities: [],
      });
      mockDb.user.findUnique = vi.fn().mockResolvedValue({
        id: mockSession.userId,
        email: mockSession.email,
        username: "testuser",
      });

      // Mock invalidateFeedCache to throw error - but it's awaited, so it will propagate
      // The actual implementation doesn't wrap it in try-catch, so errors will fail the request
      const originalInvalidateFeedCache =
        handler.invalidateFeedCache.bind(handler);
      handler.invalidateFeedCache = vi
        .fn()
        .mockRejectedValue(new Error("Cache error"));

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
        }),
      });

      // Cache invalidation errors will cause the request to fail
      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
      handler.invalidateFeedCache = originalInvalidateFeedCache;
    });

    it("should handle author fetch errors gracefully", async () => {
      mockIsEnabled.mockResolvedValueOnce(true);
      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Test post",
          visibility: "public",
        },
      });
      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Test post",
        visibility: "PUBLIC",
        dataRegion: "US",
      });

      mockDb.post.findUnique = vi.fn().mockResolvedValue({
        id: "post-123",
        taggedEntities: [],
      });
      mockWithQueryTimeoutAndRetry
        .mockResolvedValueOnce({
          id: "post-123",
          taggedEntities: [],
        })
        .mockRejectedValueOnce(new Error("Author fetch failed"));

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
        }),
      });

      // Author fetch errors will cause the request to fail (not wrapped in try-catch)
      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
    });

    it("should handle taxonomy tags fetch errors gracefully", async () => {
      mockIsEnabled.mockResolvedValueOnce(true);
      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Test post",
          visibility: "public",
          taxonomyTags: ["dimension:category:taxon1"],
        },
      });
      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Test post",
        visibility: "PUBLIC",
        dataRegion: "US",
      });

      mockDb.post.findUnique = vi.fn().mockResolvedValue({
        id: "post-123",
        taggedEntities: [],
      });
      mockDb.user.findUnique = vi.fn().mockResolvedValue({
        id: mockSession.userId,
        email: mockSession.email,
        username: "testuser",
      });

      // Mock taxonomy handler to throw error when fetching tags
      vi.doMock("../../src/lib/taxonomy-handler", () => ({
        TaxonomyHandler: class {
          getPostTaxonomyTags = vi
            .fn()
            .mockRejectedValue(new Error("Tag fetch failed"));
        },
      }));

      const request = new Request("http://test.com/posts", {
        method: "POST",
        body: JSON.stringify({
          text: "Test post",
          visibility: "public",
          taxonomyTags: ["dimension:category:taxon1"],
        }),
      });

      // Should still succeed - taxonomy tag fetch errors don't fail post creation
      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      // Taxonomy tags might be empty or missing, but post should still be created
      expect(data.id).toBe("post-123");
    });
  });

  describe("createPost with media", () => {
    beforeEach(() => {
      // Setup default mocks for media tests
      mockGetUser.mockResolvedValue({
        id: mockSession.userId,
        email: mockSession.email,
      });
      mockIsEnabled.mockResolvedValue(true);
      mockModerateText.mockResolvedValue({ decision: "approved", labels: [], provider: "mock-text" });
      mockExtractUrls.mockReturnValue([]);
      mockValidateUrlSync.mockReturnValue({
        status: "safe",
        normalizedUrl: null,
      });

      // Setup user fetch mock
      mockDb.user.findUnique.mockResolvedValue({
        id: mockSession.userId,
        email: mockSession.email,
        username: "testuser",
        actorUri: "https://example.com/users/testuser",
      });
    });

    it("should create post with media attachments", async () => {
      // Mock media validation
      const mockMediaFiles = [
        {
          id: "media-1",
          uploadedBy: mockSession.userId,
          deletedAt: null,
          originalKey: "uploads/media-1.jpg",
          thumbnailKey: "uploads/media-1-thumb.jpg",
          mimeType: "image/jpeg",
          width: 1920,
          height: 1080,
        },
        {
          id: "media-2",
          uploadedBy: mockSession.userId,
          deletedAt: null,
          originalKey: "uploads/media-2.png",
          thumbnailKey: "uploads/media-2-thumb.png",
          mimeType: "image/png",
          width: 1280,
          height: 720,
        },
      ];

      mockDb.mediaFile = {
        findMany: vi.fn().mockResolvedValueOnce(mockMediaFiles),
      };

      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Post with images",
          visibility: "public",
          media: [
            { id: "media-1", alt: "Image 1" },
            { id: "media-2", alt: "Image 2" },
          ],
        },
      });

      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        text: "Post with images",
        visibility: "PUBLIC",
        dataRegion: "US",
      });

      // Mock post fetch for ActivityPub (first call)
      // Mock post fetch for media (second call)
      mockDb.post.findUnique
        .mockResolvedValueOnce({
          id: "post-123",
          text: "Post with images",
          visibility: "PUBLIC",
          createdAt: new Date("2024-01-01"),
          author: {
            id: mockSession.userId,
            email: "test@example.com",
            username: "testuser",
            actorUri: null, // No ActivityPub
            publicKey: null,
          },
          taggedEntities: [],
        })
        .mockResolvedValueOnce({
          id: "post-123",
          text: "Post with images",
          visibility: "PUBLIC",
          createdAt: new Date("2024-01-01"),
          author: {
            id: mockSession.userId,
            email: "test@example.com",
            username: "testuser",
            actorUri: "https://example.com/users/testuser",
          },
          media: [
            {
              mediaId: "media-1",
              alt: "Image 1",
              order: 0,
              media: mockMediaFiles[0],
            },
            {
              mediaId: "media-2",
              alt: "Image 2",
              order: 1,
              media: mockMediaFiles[1],
            },
          ],
          taggedEntities: [],
        });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Post with images",
          visibility: "public",
          media: [
            { id: "media-1", alt: "Image 1" },
            { id: "media-2", alt: "Image 2" },
          ],
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.media).toHaveLength(2);
      expect(data.media[0].mediaId).toBe("media-1");
      expect(data.media[0].alt).toBe("Image 1");
      expect(data.media[0].file.mimeType).toBe("image/jpeg");
      expect(data.media[1].mediaId).toBe("media-2");
      expect(data.media[1].alt).toBe("Image 2");
      expect(data.media[1].file.mimeType).toBe("image/png");
    });

    it("should reject post with invalid media IDs", async () => {
      // Mock media validation - only 1 of 2 media found
      mockDb.mediaFile = {
        findMany: vi.fn().mockResolvedValueOnce([
          {
            id: "media-1",
            uploadedBy: mockSession.userId,
            deletedAt: null,
          },
        ]),
      };

      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Post with images",
          visibility: "public",
          media: [{ id: "media-1" }, { id: "media-invalid" }],
        },
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Post with images",
          visibility: "public",
          media: [{ id: "media-1" }, { id: "media-invalid" }],
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("INVALID_MEDIA");
      expect(mockCreatePost).not.toHaveBeenCalled();
    });

    it("should reject post with media not owned by user", async () => {
      // Mock media validation - no media found (wrong owner)
      mockDb.mediaFile = {
        findMany: vi.fn().mockResolvedValueOnce([]),
      };

      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Post with images",
          visibility: "public",
          media: [{ id: "media-other-user" }],
        },
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Post with images",
          visibility: "public",
          media: [{ id: "media-other-user" }],
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("INVALID_MEDIA");
      expect(mockCreatePost).not.toHaveBeenCalled();
    });

    it("should reject post with deleted media", async () => {
      // Mock media validation - media is deleted (not returned by query)
      mockDb.mediaFile = {
        findMany: vi.fn().mockResolvedValueOnce([]),
      };

      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Post with images",
          visibility: "public",
          media: [{ id: "media-deleted" }],
        },
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Post with images",
          visibility: "public",
          media: [{ id: "media-deleted" }],
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("INVALID_MEDIA");
    });

    it("should reject post with more than 4 media", async () => {
      mockValidateRequest.mockResolvedValueOnce({
        success: false,
        error: new Response(
          JSON.stringify({
            error: "Validation failed",
            details: [
              {
                path: "media",
                message: "Maximum 4 media attachments allowed",
              },
            ],
          }),
          { status: 400 },
        ),
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Post with too many images",
          visibility: "public",
          media: [
            { id: "media-1" },
            { id: "media-2" },
            { id: "media-3" },
            { id: "media-4" },
            { id: "media-5" },
          ],
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Validation failed");
      expect(mockCreatePost).not.toHaveBeenCalled();
    });

    it("should preserve media order", async () => {
      const mockMediaFiles = [
        {
          id: "media-3",
          uploadedBy: mockSession.userId,
          deletedAt: null,
          originalKey: "uploads/media-3.jpg",
        },
        {
          id: "media-1",
          uploadedBy: mockSession.userId,
          deletedAt: null,
          originalKey: "uploads/media-1.jpg",
        },
        {
          id: "media-2",
          uploadedBy: mockSession.userId,
          deletedAt: null,
          originalKey: "uploads/media-2.jpg",
        },
      ];

      mockDb.mediaFile = {
        findMany: vi.fn().mockResolvedValueOnce(mockMediaFiles),
      };

      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Post with ordered images",
          visibility: "public",
          media: [{ id: "media-3" }, { id: "media-1" }, { id: "media-2" }],
        },
      });

      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        dataRegion: "US",
      });

      // Mock post fetch for ActivityPub (first call)
      // Mock post fetch for media (second call)
      mockDb.post.findUnique
        .mockResolvedValueOnce({
          id: "post-123",
          text: "Post with ordered images",
          visibility: "PUBLIC",
          createdAt: new Date("2024-01-01"),
          author: {
            id: mockSession.userId,
            email: "test@example.com",
            username: "testuser",
            actorUri: null,
            publicKey: null,
          },
          taggedEntities: [],
        })
        .mockResolvedValueOnce({
          id: "post-123",
          text: "Post with ordered images",
          visibility: "PUBLIC",
          createdAt: new Date("2024-01-01"),
          author: {
            id: mockSession.userId,
            email: "test@example.com",
            username: "testuser",
            actorUri: "https://example.com/users/testuser",
          },
          media: [
            { mediaId: "media-3", order: 0, media: mockMediaFiles[0] },
            { mediaId: "media-1", order: 1, media: mockMediaFiles[1] },
            { mediaId: "media-2", order: 2, media: mockMediaFiles[2] },
          ],
          taggedEntities: [],
        });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Post with ordered images",
          visibility: "public",
          media: [{ id: "media-3" }, { id: "media-1" }, { id: "media-2" }],
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.media[0].mediaId).toBe("media-3");
      expect(data.media[1].mediaId).toBe("media-1");
      expect(data.media[2].mediaId).toBe("media-2");
    });

    it("should handle empty media array", async () => {
      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Post without images",
          visibility: "public",
          media: [],
        },
      });

      mockCreatePost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        dataRegion: "US",
      });

      // Mock post fetch for ActivityPub (first call)
      mockDb.post.findUnique.mockResolvedValueOnce({
        id: "post-123",
        text: "Post without images",
        visibility: "PUBLIC",
        createdAt: new Date("2024-01-01"),
        author: {
          id: mockSession.userId,
          email: "test@example.com",
          username: "testuser",
          actorUri: null,
          publicKey: null,
        },
        media: [],
        taggedEntities: [],
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Post without images",
          visibility: "public",
          media: [],
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      // Empty media arrays are not included in the response
      expect(data.media).toBeUndefined();
    });

    it("should validate alt text length", async () => {
      const longAltText = "a".repeat(501);

      mockValidateRequest.mockResolvedValueOnce({
        success: false,
        error: new Response(
          JSON.stringify({
            error: "Validation failed",
            details: [
              {
                path: "media[0].alt",
                message: "Alt text exceeds maximum length of 500 characters",
              },
            ],
          }),
          { status: 400 },
        ),
      });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Post with long alt text",
          visibility: "public",
          media: [{ id: "media-1", alt: longAltText }],
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Validation failed");
      expect(mockCreatePost).not.toHaveBeenCalled();
    });

    it("should create post with media using contentHash instead of database ID", async () => {
      // This test verifies the fix for the media ID mapping bug
      // Frontend sends contentHash (SHA-256), backend must search by contentHash and remap to database ID

      const contentHash =
        "e39839560f1500a2ccd2bd8e7322a50fca79e2c004ba8b6b2a4c0ecacbafd8ed";
      const databaseId = "clxxx123abc";

      const mockMediaFiles = [
        {
          id: databaseId, // Database CUID
          contentHash: contentHash, // SHA-256 hash
          uploadedBy: mockSession.userId,
          deletedAt: null,
          originalKey: "uploads/media-1.jpg",
          thumbnailKey: "uploads/media-1-thumb.jpg",
          mimeType: "image/jpeg",
          width: 1920,
          height: 1080,
        },
      ];

      // Mock findMany to verify it searches by both id and contentHash
      mockDb.mediaFile = {
        findMany: vi.fn().mockImplementation((query) => {
          // Verify the query includes OR with both id and contentHash
          expect(query.where.OR).toBeDefined();
          expect(query.where.OR).toEqual(
            expect.arrayContaining([
              { contentHash: { in: expect.arrayContaining([contentHash]) } },
              { id: { in: expect.arrayContaining([contentHash]) } },
            ]),
          );
          return Promise.resolve(mockMediaFiles);
        }),
      };

      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: {
          text: "Post with image using contentHash",
          visibility: "public",
          media: [
            {
              id: contentHash, // Frontend sends contentHash, not database ID
              alt: "Test image",
            },
          ],
        },
      });

      // Mock DataRouter.createPost to verify it receives database ID (not contentHash)
      mockCreatePost.mockImplementation((postData) => {
        // Verify media was remapped to database ID
        expect(postData.media).toBeDefined();
        expect(postData.media).toHaveLength(1);
        expect(postData.media[0].id).toBe(databaseId); // Should be remapped to database ID
        expect(postData.media[0].id).not.toBe(contentHash); // Should NOT be contentHash

        return Promise.resolve({
          id: "post-123",
          authorId: mockSession.userId,
          text: "Post with image using contentHash",
          visibility: "PUBLIC",
          dataRegion: "US",
        });
      });

      // Mock post fetch for ActivityPub (first call)
      // Mock post fetch for media (second call)
      mockDb.post.findUnique
        .mockResolvedValueOnce({
          id: "post-123",
          text: "Post with image using contentHash",
          visibility: "PUBLIC",
          createdAt: new Date("2024-01-01"),
          author: {
            id: mockSession.userId,
            email: "test@example.com",
            username: "testuser",
            actorUri: null,
            publicKey: null,
          },
          taggedEntities: [],
        })
        .mockResolvedValueOnce({
          id: "post-123",
          text: "Post with image using contentHash",
          visibility: "PUBLIC",
          createdAt: new Date("2024-01-01"),
          author: {
            id: mockSession.userId,
            email: "test@example.com",
            username: "testuser",
            actorUri: "https://example.com/users/testuser",
          },
          media: [
            {
              mediaId: databaseId, // Database ID in response
              alt: "Test image",
              order: 0,
              media: mockMediaFiles[0],
            },
          ],
          taggedEntities: [],
        });

      const request = new Request("http://test.com/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Post with image using contentHash",
          visibility: "public",
          media: [
            {
              id: contentHash, // Frontend sends contentHash
              alt: "Test image",
            },
          ],
        }),
      });

      const response = await handler.createPost(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.media).toHaveLength(1);
      expect(data.media[0].mediaId).toBe(databaseId); // Response contains database ID
      expect(data.media[0].alt).toBe("Test image");

      // Verify DataRouter.createPost was called with remapped database ID
      expect(mockCreatePost).toHaveBeenCalled();
    });
  });

  describe("deletePost", () => {
    beforeEach(() => {
      // Setup default mocks for deletePost tests
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: mockSession.userId,
        dataRegion: "US",
      });
      mockGetDatabaseForRegion.mockReturnValue(mockDb);
    });

    it("should delete post using DataRouter for region validation", async () => {
      const request = new Request("http://test.com/posts/post-123", {
        method: "DELETE",
      });

      const response = await handler.deletePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGetPost).toHaveBeenCalledWith(
        "post-123",
        "US",
        mockEnv,
        undefined,
        expect.any(String),
        mockSession.userId,
      );
      expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
        "US",
        mockEnv,
        expect.any(Request),
        mockSession.userId,
      );
    });

    it("should return 404 if post not found", async () => {
      mockGetPost.mockResolvedValueOnce(null);
      const request = new Request("http://test.com/posts/non-existent", {
        method: "DELETE",
      });

      const response = await handler.deletePost(
        "non-existent",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe("Post not found");
    });

    it("should return 403 if user is not the owner", async () => {
      mockGetPost.mockResolvedValueOnce({
        id: "post-123",
        authorId: "other-user",
        dataRegion: "US",
      });
      const request = new Request("http://test.com/posts/post-123", {
        method: "DELETE",
      });

      const response = await handler.deletePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe("Forbidden");
    });

    it("should return 410 if post is already deleted", async () => {
      mockGetPost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        dataRegion: "US",
      });
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce({
        deletedAt: new Date(), // Post is already deleted
      });

      const request = new Request("http://test.com/posts/post-123", {
        method: "DELETE",
      });

      const response = await handler.deletePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(410);
      expect(data.error).toBe("Post already deleted");
    });

    it("should handle errors when deleting post", async () => {
      mockGetPost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        dataRegion: "US",
      });
      // First call succeeds (check if deleted), second call fails (actual delete)
      mockWithQueryTimeoutAndRetry
        .mockResolvedValueOnce({ deletedAt: null })
        .mockRejectedValueOnce(new Error("Database error"));

      const request = new Request("http://test.com/posts/post-123", {
        method: "DELETE",
      });

      const response = await handler.deletePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Failed to delete post");
    });

    it("should use region from requestContext", async () => {
      mockGetPost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        dataRegion: "CN",
      });
      mockGetDatabaseForRegion.mockReturnValueOnce(mockDb);
      const request = new Request("http://test.com/posts/post-123", {
        method: "DELETE",
      });

      const cnRequestContext = {
        ...mockRequestContext,
        region: "CN" as const,
      };

      await handler.deletePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        cnRequestContext,
      );

      expect(mockGetPost).toHaveBeenCalledWith(
        "post-123",
        "CN",
        mockEnv,
        undefined,
        expect.any(String),
        mockSession.userId,
      );
      expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
        "CN",
        mockEnv,
        expect.any(Request),
        mockSession.userId,
      );
    });
  });

  describe("hidePost", () => {
    beforeEach(() => {
      // Setup default mocks for hidePost tests
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: mockSession.userId,
        dataRegion: "US",
      });
      // mockDb is already set up in outer beforeEach
    });

    it("should hide post using timeout/retry logic", async () => {
      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
      });

      const response = await handler.hidePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGetPost).toHaveBeenCalledWith(
        "post-123",
        "US",
        mockEnv,
        undefined,
        expect.any(String),
        mockSession.userId,
      );
      // Verify timeout/retry was used instead of direct database access
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US",
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          context: expect.objectContaining({
            operation: "hidePost",
          }),
        }),
      );
    });

    it("should return 404 if post not found", async () => {
      mockGetPost.mockResolvedValueOnce(null);
      const request = new Request("http://test.com/posts/non-existent", {
        method: "PATCH",
      });

      const response = await handler.hidePost(
        "non-existent",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe("Post not found");
    });

    it("should return 403 if user is not the owner", async () => {
      mockGetPost.mockResolvedValueOnce({
        id: "post-123",
        authorId: "other-user",
        dataRegion: "US",
      });
      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
      });

      const response = await handler.hidePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe("Forbidden");
    });

    it("should handle errors when hiding post", async () => {
      mockGetPost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        dataRegion: "US",
      });
      mockWithQueryTimeoutAndRetry.mockRejectedValueOnce(
        new Error("Database error"),
      );

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
      });

      const response = await handler.hidePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Failed to hide post");
    });
  });

  describe("unhidePost", () => {
    beforeEach(() => {
      // Setup default mocks for unhidePost tests
      mockGetPost.mockResolvedValue({
        id: "post-123",
        authorId: mockSession.userId,
        dataRegion: "US",
      });
      // mockDb is already set up in outer beforeEach
    });

    it("should unhide post using timeout/retry logic", async () => {
      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
      });

      const response = await handler.unhidePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGetPost).toHaveBeenCalledWith(
        "post-123",
        "US",
        mockEnv,
        undefined,
        expect.any(String),
        mockSession.userId,
      );
      // Verify timeout/retry was used instead of direct database access
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US",
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          context: expect.objectContaining({
            operation: "unhidePost",
          }),
        }),
      );
    });

    it("should return 404 if post not found", async () => {
      mockGetPost.mockResolvedValueOnce(null);
      const request = new Request("http://test.com/posts/non-existent", {
        method: "PATCH",
      });

      const response = await handler.unhidePost(
        "non-existent",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe("Post not found");
    });

    it("should return 403 if user is not the owner", async () => {
      mockGetPost.mockResolvedValueOnce({
        id: "post-123",
        authorId: "other-user",
        dataRegion: "US",
      });
      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
      });

      const response = await handler.unhidePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe("Forbidden");
    });

    it("should handle errors when unhiding post", async () => {
      mockGetPost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        dataRegion: "US",
      });
      mockWithQueryTimeoutAndRetry.mockRejectedValueOnce(
        new Error("Database error"),
      );

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
      });

      const response = await handler.unhidePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Failed to unhide post");
    });

    it("should handle errors when invalidating feed cache during unhide", async () => {
      mockGetPost.mockResolvedValueOnce({
        id: "post-123",
        authorId: mockSession.userId,
        dataRegion: "US",
      });
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce(undefined);

      // Mock FEED_CACHE_KV to throw an error
      const originalKV = mockEnv.FEED_CACHE_KV;
      mockEnv.FEED_CACHE_KV = {
        get: vi.fn().mockRejectedValue(new Error("KV error")),
        put: vi.fn(),
      } as any;

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
      });

      const response = await handler.unhidePost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      // Should still succeed (cache invalidation errors are logged but don't fail the request)
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Restore original KV
      mockEnv.FEED_CACHE_KV = originalKV;
    });
  });

  describe("editPost", () => {
    it("should return actorUri in author object (not did)", async () => {
      const mockPost = {
        id: "post-123",
        authorId: mockSession.userId,
        text: "Original text",
        visibility: "PUBLIC",
        dataRegion: "US",
        deletedAt: null,
      };

      const mockUpdatedPost = {
        id: "post-123",
        uri: "https://example.com/posts/post-123",
        text: "Updated text",
        visibility: "PUBLIC",
        createdAt: new Date("2024-01-01"),
        editedAt: new Date("2024-01-02"),
        contentWarnings: [],
        author: {
          id: mockSession.userId,
          email: "test@example.com",
          username: "testuser",
          actorUri: "https://example.com/users/testuser",
          publicKey: "test-public-key",
        },
        media: [],
      };

      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: { text: "Updated text" },
      });
      mockGetPost.mockResolvedValueOnce(mockPost);
      mockModerateText.mockResolvedValueOnce({ decision: "approved", labels: [], provider: "mock-text" });
      mockExtractUrls.mockReturnValue([]);

      // Mock the database update to return the full updated post
      mockDb.post.update.mockResolvedValueOnce(mockUpdatedPost);

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Updated text" }),
      });

      const response = await handler.editPost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      if (response.status !== 200) {
        console.error(
          "Test failed with response:",
          JSON.stringify(data, null, 2),
        );
      }

      expect(response.status).toBe(200);
      expect(data.author).toBeDefined();
      expect(data.author.actorUri).toBe("https://example.com/users/testuser");
      expect(data.author.did).toBeUndefined(); // Should NOT have 'did' field
    });

    it("should use actorUri fallback to user ID if actorUri is null", async () => {
      const mockPost = {
        id: "post-123",
        authorId: mockSession.userId,
        text: "Original text",
        visibility: "PUBLIC",
        dataRegion: "US",
        deletedAt: null,
      };

      const mockUpdatedPost = {
        id: "post-123",
        uri: "https://example.com/posts/post-123",
        text: "Updated text",
        visibility: "PUBLIC",
        createdAt: new Date("2024-01-01"),
        editedAt: new Date("2024-01-02"),
        contentWarnings: [],
        author: {
          id: mockSession.userId,
          email: "test@example.com",
          username: "testuser",
          actorUri: null, // No actorUri set
          publicKey: null,
        },
        media: [],
      };

      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: { text: "Updated text" },
      });
      mockGetPost.mockResolvedValueOnce(mockPost);
      mockModerateText.mockResolvedValueOnce({ decision: "approved", labels: [], provider: "mock-text" });
      mockExtractUrls.mockReturnValue([]);

      // Mock the database update to return the full updated post
      mockDb.post.update.mockResolvedValueOnce(mockUpdatedPost);

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Updated text" }),
      });

      const response = await handler.editPost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.author).toBeDefined();
      expect(data.author.actorUri).toBe(mockSession.userId); // Falls back to user ID
    });

    it("should include editedAt timestamp in response", async () => {
      const mockPost = {
        id: "post-123",
        authorId: mockSession.userId,
        text: "Original text",
        visibility: "PUBLIC",
        dataRegion: "US",
        deletedAt: null,
      };

      const editedAt = new Date("2024-01-02T10:00:00Z");
      const mockUpdatedPost = {
        id: "post-123",
        uri: "https://example.com/posts/post-123",
        text: "Updated text",
        visibility: "PUBLIC",
        createdAt: new Date("2024-01-01"),
        editedAt: editedAt,
        contentWarnings: [],
        author: {
          id: mockSession.userId,
          email: "test@example.com",
          username: "testuser",
          actorUri: "https://example.com/users/testuser",
          publicKey: "test-public-key",
        },
        media: [],
      };

      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: { text: "Updated text" },
      });
      mockGetPost.mockResolvedValueOnce(mockPost);
      mockModerateText.mockResolvedValueOnce({ decision: "approved", labels: [], provider: "mock-text" });
      mockExtractUrls.mockReturnValue([]);

      // Mock the database update to return the full updated post
      mockDb.post.update.mockResolvedValueOnce(mockUpdatedPost);

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Updated text" }),
      });

      const response = await handler.editPost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.editedAt).toBe(editedAt.toISOString());
    });

    it("should reject edit if user is not the post owner", async () => {
      const mockPost = {
        id: "post-123",
        authorId: "different-user-id",
        text: "Original text",
        visibility: "PUBLIC",
        dataRegion: "US",
        deletedAt: null,
      };

      mockValidateRequest.mockResolvedValueOnce({
        success: true,
        data: { text: "Updated text" },
      });
      mockGetPost.mockResolvedValueOnce(mockPost);

      const request = new Request("http://test.com/posts/post-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Updated text" }),
      });

      const response = await handler.editPost(
        "post-123",
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe("Forbidden");
      expect(data.message).toBe("You can only edit your own posts");
    });
  });
});
