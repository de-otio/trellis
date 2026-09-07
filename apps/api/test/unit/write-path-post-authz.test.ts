/**
 * Regression: V4 residual (b) — the reaction and comment WRITES gated on bare
 * existence.
 *
 * `ReactionHandler.addPostSentiment` and `CommentHandler.createComment` each
 * tested only that the post row EXISTED, via `DataRouter.getPost` — a
 * `findUnique({ where: { id } })` with no tenant and no audience predicate. So
 * an ordinary authenticated account in tenant A could react to, or comment on,
 * a post in tenant B that it could not read; and because the write inherits the
 * POST's tenant (`reaction-handler.ts`, the `create` branch of the upsert), the
 * row landed inside the target's scope. The read side of both endpoints had
 * been fixed (H3) and the block guard was already in place on both writes —
 * what was missing was tenancy and audience, which is exactly the pair
 * `canReadPost` carries.
 *
 * A write is not a weaker permission than a read. These tests pin that:
 *
 *   1. When the gate refuses, NOTHING is written — no `postSentiment.upsert`,
 *      no `postComment.create` — and the refusal is the same 404 body the
 *      not-found branch returns, so it is not an oracle either.
 *   2. When the gate permits, both writes still work exactly as before.
 *   3. The gate is asked about the WRITER's active tenant, which is why
 *      `addPostSentiment` grew an `activeTenantId` parameter (`createComment`
 *      already had one and simply never used it for this).
 *
 * As with the other unit-level authz tests, `canReadPost` is mocked here: this
 * decides that the writes CALL it before touching anything, not that its
 * predicate is right. That is settled against real Postgres in
 * test/integration/post-attachment-read-authz.integration.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommentHandler } from "../../src/lib/comment-handler.js";
import { ReactionHandler } from "../../src/lib/reaction-handler.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

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

const mockGetPost = vi.fn();
const mockGetDatabaseForRegion = vi.fn();
vi.mock("../../src/lib/data-router", () => ({
  DataRouter: {
    getPost: (...args: any[]) => mockGetPost(...args),
    getDatabaseForRegion: (...args: any[]) => mockGetDatabaseForRegion(...args),
  },
}));

vi.mock("../../src/lib/feed-handler", () => ({
  FeedHandler: { invalidateFeedCache: vi.fn() },
}));

vi.mock("../../src/lib/validate-request", () => ({
  validateRequest: vi.fn().mockResolvedValue({
    success: true,
    data: { text: "Test comment" },
  }),
}));

vi.mock("../../src/lib/input-sanitizer", () => ({
  InputSanitizer: { sanitizeText: (text: string) => text.trim() },
}));

const mockExtractUrls = vi.fn().mockReturnValue([]);
vi.mock("../../src/lib/link-security-handler", () => ({
  LinkSecurityHandler: class {
    extractUrls = mockExtractUrls;
    validateUrlSync = vi.fn().mockReturnValue({ status: "safe" });
  },
  LinkStatus: { BLOCKED: "blocked", SUSPICIOUS: "suspicious", SAFE: "safe" },
}));

vi.mock("../../src/lib/media/request-text-moderation", () => ({
  getTextModerationProvider: () => ({
    moderateText: vi.fn().mockResolvedValue({
      decision: "approved",
      labels: [],
      provider: "mock-text",
    }),
  }),
}));

vi.mock("../../src/lib/feature-toggle-service", () => ({
  FeatureToggleService: class {
    isEnabled = vi.fn().mockResolvedValue(false);
    isEnabledFailClosed = vi.fn().mockResolvedValue(false);
  },
}));

const mockCreatePrisma = vi.fn();
vi.mock("../../src/db", () => ({
  createPrisma: (...args: any[]) => mockCreatePrisma(...args),
}));

const mockCanReadPost = vi.fn();
vi.mock("../../src/lib/post-read-authorizer", () => ({
  canReadPost: (...args: any[]) => mockCanReadPost(...args),
}));

/** The writer's own tenant — NOT the tenant the target post lives in. */
const WRITER_TENANT = "tenant-writer";
const POST_ID = "post-in-another-tenant";

describe("post write paths — V4 residual (b)", () => {
  let reactions: ReactionHandler;
  let comments: CommentHandler;
  let mockEnv: any;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockDb: any;

  const commentRequest = () =>
    new Request("http://test.com/comments", {
      method: "POST",
      body: JSON.stringify({ text: "Test comment" }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    reactions = new ReactionHandler();
    comments = new CommentHandler();

    mockDb = {
      post: { findUnique: vi.fn().mockResolvedValue({ deletedAt: null }) },
      postComment: {
        create: vi.fn().mockResolvedValue({
          id: "comment-123",
          text: "Test comment",
          createdAt: new Date("2026-01-01T10:00:00Z"),
        }),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      postSentiment: { upsert: vi.fn().mockResolvedValue({ id: "s-1" }) },
      commentSentiment: { groupBy: vi.fn().mockResolvedValue([]) },
      domainReputation: { upsert: vi.fn() },
      linkCheck: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      blockedUser: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    mockCreatePrisma.mockReturnValue(mockDb);
    mockGetDatabaseForRegion.mockReturnValue(mockDb);
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (_manager: any, _region: string, _env: any, queryFn: (db: any) => Promise<any>) =>
        queryFn(mockDb),
    );

    mockEnv = {
      DATABASE_URL: "postgres://test",
      DEFAULT_REGION: "US",
      ENVIRONMENT: "dev",
    };

    mockSession = {
      userId: "user-writer",
      email: "writer@example.com",
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
        timeouts: { database: 5000, api: 10000 },
      },
      session: mockSession,
    } as unknown as TrellisRequestContext;

    // The post EXISTS and is in somebody else's tenant. A bare existence check
    // — which is what both writes used to do — is satisfied by exactly this.
    mockGetPost.mockResolvedValue({
      id: POST_ID,
      authorId: "author-other-tenant",
      tenantId: "tenant-target",
      uri: `at://test/${POST_ID}`,
      dataRegion: "US",
    });

    mockCanReadPost.mockResolvedValue(true);
  });

  describe("a post the writer cannot read", () => {
    beforeEach(() => {
      mockCanReadPost.mockResolvedValue(false);
    });

    it("refuses the reaction and writes nothing", async () => {
      const response = await reactions.addPostSentiment(
        POST_ID,
        "joy",
        mockSession,
        mockEnv,
        mockRequestContext,
        WRITER_TENANT,
      );

      expect(response.status).toBe(404);
      expect(mockDb.postSentiment.upsert).not.toHaveBeenCalled();
    });

    it("refuses the comment and writes nothing", async () => {
      const response = await comments.createComment(
        POST_ID,
        commentRequest(),
        mockSession,
        mockEnv,
        mockRequestContext,
        WRITER_TENANT,
      );

      expect(response.status).toBe(404);
      expect(mockDb.postComment.create).not.toHaveBeenCalled();
    });

    it("refuses BEFORE reading the post row at all", async () => {
      await reactions.addPostSentiment(
        POST_ID,
        "joy",
        mockSession,
        mockEnv,
        mockRequestContext,
        WRITER_TENANT,
      );
      await comments.createComment(
        POST_ID,
        commentRequest(),
        mockSession,
        mockEnv,
        mockRequestContext,
        WRITER_TENANT,
      );

      expect(mockGetPost).not.toHaveBeenCalled();
    });

    it("refuses with the same body as a post that does not exist", async () => {
      const refused = await reactions.addPostSentiment(
        POST_ID,
        "joy",
        mockSession,
        mockEnv,
        mockRequestContext,
        WRITER_TENANT,
      );

      mockCanReadPost.mockResolvedValue(true);
      mockGetPost.mockResolvedValue(null);
      const absent = await reactions.addPostSentiment(
        POST_ID,
        "joy",
        mockSession,
        mockEnv,
        mockRequestContext,
        WRITER_TENANT,
      );

      expect(refused.status).toBe(absent.status);
      expect(await refused.text()).toBe(await absent.text());
    });

    it("asks the gate about the WRITER's tenant, not the post's", async () => {
      await reactions.addPostSentiment(
        POST_ID,
        "joy",
        mockSession,
        mockEnv,
        mockRequestContext,
        WRITER_TENANT,
      );

      expect(mockCanReadPost).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: POST_ID,
          viewerUserId: "user-writer",
          tenantId: WRITER_TENANT,
        }),
      );
    });
  });

  describe("a post the writer can read", () => {
    it("still accepts the reaction", async () => {
      const response = await reactions.addPostSentiment(
        POST_ID,
        "joy",
        mockSession,
        mockEnv,
        mockRequestContext,
        WRITER_TENANT,
      );

      expect(response.status).toBe(200);
      expect(mockDb.postSentiment.upsert).toHaveBeenCalled();
    });

    it("still accepts the comment", async () => {
      const response = await comments.createComment(
        POST_ID,
        commentRequest(),
        mockSession,
        mockEnv,
        mockRequestContext,
        WRITER_TENANT,
      );

      expect(response.status).toBe(201);
      expect(mockDb.postComment.create).toHaveBeenCalled();
    });
  });
});
