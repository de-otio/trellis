/**
 * AR-SEC T4 / F1 — the moderation feature-toggle read must be FAIL-CLOSED.
 *
 * The text-moderation gate (text-moderation-gate.ts) is itself fail-closed,
 * but it only runs inside `if (moderationEnabled)`. These tests pin the
 * toggle-read semantics on the moderated write path (post create, comment
 * create):
 *
 *   - toggle row MISSING (unseeded DB)        -> moderation MUST run
 *   - toggle read ERROR (DB outage)           -> moderation MUST run
 *   - toggle row explicitly enabled = false   -> moderation is skipped
 *                                                (deliberate dev/test escape
 *                                                hatch — fail-closed-to-
 *                                                enabled, not force-on)
 *   - toggle row explicitly enabled = true    -> moderation runs
 *
 * The FeatureToggleService here is REAL (not mocked) — the whole point is the
 * resolution semantics between the handler and the toggle store. Only the
 * Prisma client underneath it is a controllable mock.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostHandler } from "../../src/lib/post-handler.js";
import { CommentHandler } from "../../src/lib/comment-handler.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

// ---------------------------------------------------------------------------
// Module mocks — everything around the toggle read + moderation gate.
// NOTE: feature-toggle-service is deliberately NOT mocked.
// ---------------------------------------------------------------------------

// DataRouter
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

// Region detection
const mockDetectRegion = vi.fn();
vi.mock("../../src/lib/region-detection", () => ({
  detectRegion: (...args: any[]) => mockDetectRegion(...args),
  RegionDetector: class {
    detectRegion = mockDetectRegion;
  },
}));

// Text-moderation provider seam. The REAL gate logic
// (text-moderation-gate.ts) runs on top of this mock, so "the gate ran" is
// observable via mockModerateText and via the gate's 400 CONTENT_REJECTED.
const mockModerateText = vi
  .fn()
  .mockResolvedValue({ decision: "approved", labels: [], provider: "mock-text" });
vi.mock("../../src/lib/media/request-text-moderation", () => ({
  getTextModerationProvider: () => ({ moderateText: mockModerateText }),
}));

// Prisma — the ONLY seam this suite manipulates for toggle state. The real
// FeatureToggleService -> globalScopedFeatureToggleClient reads global rows
// via `featureToggle.findFirst`.
const mockCreatePrisma = vi.fn();
vi.mock("../../src/db", () => ({
  createPrisma: (...args: any[]) => mockCreatePrisma(...args),
}));

// withQueryTimeoutAndRetry / connection manager
const mockWithQueryTimeoutAndRetry = vi.fn();
const mockSharedDatabaseConnectionManager = { executeWithRetry: vi.fn() };
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

// Link security — always safe here; not under test.
const mockExtractUrls = vi.fn().mockReturnValue([]);
const mockValidateUrlSync = vi.fn().mockReturnValue({ status: "safe", normalizedUrl: null });
vi.mock("../../src/lib/link-security-handler", () => ({
  LinkSecurityHandler: class {
    extractUrls = mockExtractUrls;
    validateUrlSync = mockValidateUrlSync;
  },
  LinkStatus: { SAFE: "safe", BLOCKED: "blocked", SUSPICIOUS: "suspicious", UNKNOWN: "unknown" },
}));

// InputSanitizer
vi.mock("../../src/lib/input-sanitizer", () => ({
  InputSanitizer: { sanitizeText: (text: string) => text },
}));

// validateRequest — body is set per test.
const mockValidateRequest = vi.fn();
vi.mock("../../src/lib/validate-request", () => ({
  validateRequest: (...args: any[]) => mockValidateRequest(...args),
}));

// Schemas (unused because validateRequest is mocked, but imported by handlers)
vi.mock("../../src/lib/schemas", () => ({
  createPostSchema: {},
  editPostSchema: {},
  createCommentSchema: {},
}));

// Misc modules on the post-create path
vi.mock("../../src/lib/database-wrapper-helper", () => ({
  getWrappedDatabase: vi.fn(() => ({
    linkCheck: { findMany: vi.fn().mockResolvedValue([]) },
  })),
}));
vi.mock("../../src/lib/taxonomy-handler", () => ({
  TaxonomyHandler: class {
    addPostTaxonomyTags = vi.fn();
    getPostTaxonomyTags = vi.fn().mockResolvedValue([]);
  },
}));
vi.mock("../../src/lib/request-context", () => ({
  createRequestContext: vi.fn().mockResolvedValue({ session: null }),
}));
vi.mock("../../src/lib/feed-handler", () => ({
  FeedHandler: { invalidateFeedCache: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOGGLE_KEY = "content_moderation_enabled";

function toggleRow(enabled: boolean) {
  return {
    key: TOGGLE_KEY,
    enabled,
    changedAt: new Date("2026-01-01"),
    changedBy: "test@seed",
    description: null,
  };
}

describe("moderation toggle is fail-closed on the moderated write path (F1)", () => {
  let mockDb: any;
  let mockEnv: any;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      // M2: the block seam reads through this delegate. Default = no blocks.
      blockedUser: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      featureToggle: {
        // Default: row missing (unseeded database).
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      post: {
        findUnique: vi.fn().mockResolvedValue({
          deletedAt: null,
          taggedEntities: [],
          author: { id: "user-123", username: "testuser", actorUri: null, publicKey: null },
        }),
        update: vi.fn().mockResolvedValue({ id: "post-123" }),
      },
      postComment: {
        create: vi.fn().mockResolvedValue({
          id: "comment-123",
          text: "Test comment",
          createdAt: new Date("2026-01-01T10:00:00Z"),
        }),
        // Duplicate-check + parent-lookup path: no prior/parent comment.
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
      },
      commentSentiment: { groupBy: vi.fn().mockResolvedValue([]) },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "user-123",
          email: "test@example.com",
          username: "testuser",
        }),
      },
      postSentiment: { groupBy: vi.fn().mockResolvedValue([]) },
      domainReputation: { upsert: vi.fn().mockResolvedValue({}) },
      linkCheck: {
        create: vi.fn().mockResolvedValue({ id: "lc-1" }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      mediaFile: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockCreatePrisma.mockReturnValue(mockDb);
    mockGetDatabaseForRegion.mockReturnValue(mockDb);
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) =>
        queryFn(mockDb),
    );

    mockDetectRegion.mockResolvedValue("US");
    mockModerateText.mockResolvedValue({
      // Quarantine verdict: if (and only if) the gate runs, the write is
      // rejected with 400 CONTENT_REJECTED. A skipped gate publishes (201).
      decision: "quarantine",
      labels: [{ category: "category_a", confidence: 0.99 }],
      provider: "mock-text",
    });

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

    mockSession = {
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    } as any;

    mockRequestContext = {
      region: "US" as const,
      config: {
        featureFlags: { authentication: {}, features: {}, performance: {}, security: {} },
        endpoints: {
          api: "https://api.example.com",
          frontend: "https://app.example.com",
          cdn: "https://cdn.example.com",
        },
        timeouts: { database: 5000, api: 10000 },
      },
      session: mockSession,
    } as any;

    // Post-create happy path (used only when the gate is skipped/approves).
    mockCreateUser.mockResolvedValue({ id: "user-123", email: "test@example.com" });
    mockCreatePost.mockResolvedValue({
      id: "post-123",
      authorId: "user-123",
      createdAt: new Date("2026-01-01T10:00:00Z"),
    });
    // Comment-create needs the parent post.
    mockGetPost.mockResolvedValue({
      id: "post-123",
      authorId: "user-456",
      uri: "at://test/post-123",
      dataRegion: "US",
    });
  });

  // -------------------------------------------------------------------------
  // Post create
  // -------------------------------------------------------------------------

  function postRequest() {
    mockValidateRequest.mockResolvedValue({
      success: true,
      // "private" avoids the unrelated global_public_posting_enabled check.
      data: { text: "Nasty text", visibility: "private" },
    });
    return new Request("http://test.com/posts", {
      method: "POST",
      body: JSON.stringify({ text: "Nasty text", visibility: "private" }),
    });
  }

  describe("createPost", () => {
    it("moderates when the toggle row is MISSING (fail-closed)", async () => {
      mockDb.featureToggle.findFirst.mockResolvedValue(null);

      const handler = new PostHandler();
      const response = await handler.createPost(
        postRequest(), mockSession, mockEnv, mockRequestContext,
      );

      // Fail-closed: the gate must have run and rejected the quarantine text.
      expect(mockModerateText).toHaveBeenCalledWith("Nasty text");
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("CONTENT_REJECTED");
      expect(mockCreatePost).not.toHaveBeenCalled();
    });

    it("moderates when the toggle READ ERRORS (fail-closed)", async () => {
      mockDb.featureToggle.findFirst.mockRejectedValue(
        new Error("connection refused"),
      );

      const handler = new PostHandler();
      const response = await handler.createPost(
        postRequest(), mockSession, mockEnv, mockRequestContext,
      );

      expect(mockModerateText).toHaveBeenCalledWith("Nasty text");
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("CONTENT_REJECTED");
      expect(mockCreatePost).not.toHaveBeenCalled();
    });

    it("skips moderation when the toggle is EXPLICITLY false (escape hatch)", async () => {
      mockDb.featureToggle.findFirst.mockResolvedValue(toggleRow(false));

      const handler = new PostHandler();
      const response = await handler.createPost(
        postRequest(), mockSession, mockEnv, mockRequestContext,
      );

      expect(mockModerateText).not.toHaveBeenCalled();
      expect(response.status).toBe(201);
      expect(mockCreatePost).toHaveBeenCalled();
    });

    it("moderates when the toggle is explicitly true", async () => {
      mockDb.featureToggle.findFirst.mockResolvedValue(toggleRow(true));

      const handler = new PostHandler();
      const response = await handler.createPost(
        postRequest(), mockSession, mockEnv, mockRequestContext,
      );

      expect(mockModerateText).toHaveBeenCalledWith("Nasty text");
      expect(response.status).toBe(400);
      expect(mockCreatePost).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Comment create
  // -------------------------------------------------------------------------

  function commentRequest() {
    mockValidateRequest.mockResolvedValue({
      success: true,
      data: { text: "Nasty comment" },
    });
    return new Request("http://test.com/comments", {
      method: "POST",
      body: JSON.stringify({ text: "Nasty comment" }),
    });
  }

  describe("createComment", () => {
    it("moderates when the toggle row is MISSING (fail-closed)", async () => {
      mockDb.featureToggle.findFirst.mockResolvedValue(null);

      const handler = new CommentHandler();
      const response = await handler.createComment(
        "post-123", commentRequest(), mockSession, mockEnv, mockRequestContext,
        "tenant-test-123",
      );

      expect(mockModerateText).toHaveBeenCalledWith("Nasty comment");
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("CONTENT_REJECTED");
      expect(mockDb.postComment.create).not.toHaveBeenCalled();
    });

    it("moderates when the toggle READ ERRORS (fail-closed)", async () => {
      mockDb.featureToggle.findFirst.mockRejectedValue(
        new Error("connection refused"),
      );

      const handler = new CommentHandler();
      const response = await handler.createComment(
        "post-123", commentRequest(), mockSession, mockEnv, mockRequestContext,
        "tenant-test-123",
      );

      expect(mockModerateText).toHaveBeenCalledWith("Nasty comment");
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("CONTENT_REJECTED");
      expect(mockDb.postComment.create).not.toHaveBeenCalled();
    });

    it("skips moderation when the toggle is EXPLICITLY false (escape hatch)", async () => {
      mockDb.featureToggle.findFirst.mockResolvedValue(toggleRow(false));

      const handler = new CommentHandler();
      const response = await handler.createComment(
        "post-123", commentRequest(), mockSession, mockEnv, mockRequestContext,
        "tenant-test-123",
      );

      expect(mockModerateText).not.toHaveBeenCalled();
      expect(response.status).toBe(201);
      expect(mockDb.postComment.create).toHaveBeenCalled();
    });

    it("moderates when the toggle is explicitly true", async () => {
      mockDb.featureToggle.findFirst.mockResolvedValue(toggleRow(true));

      const handler = new CommentHandler();
      const response = await handler.createComment(
        "post-123", commentRequest(), mockSession, mockEnv, mockRequestContext,
        "tenant-test-123",
      );

      expect(mockModerateText).toHaveBeenCalledWith("Nasty comment");
      expect(response.status).toBe(400);
      expect(mockDb.postComment.create).not.toHaveBeenCalled();
    });
  });
});
