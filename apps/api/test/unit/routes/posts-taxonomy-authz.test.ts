/**
 * Regression: V4 residual (a) — the post-scoped taxonomy GETs were an
 * anonymous, cross-tenant existence oracle.
 *
 * `GET /api/posts/:postId/taxonomy-tags` and `GET /api/posts/:postId/tags/
 * suggestions` each called `DataRouter.getPost` — a bare
 * `findUnique({ where: { id } })` with no tenant and no audience predicate —
 * and returned **404 before** the 401. So an unauthenticated caller could walk
 * post ids and read "exists" / "does not exist" off the status code, for every
 * tenant at once. The suggestions route then read the post's `text` with a
 * second bare `findUnique` and returned tags derived from it, which turns the
 * oracle from existence into content.
 *
 * The two properties pinned here are the ones the old code failed:
 *
 *   1. An anonymous caller gets 401 — never 404 — whether or not the id exists,
 *      and no post read is attempted at all.
 *   2. An authenticated viewer the audience/tenant gate refuses gets **the same
 *      404, byte for byte**, as a viewer asking for an id that does not exist,
 *      and nothing derived from the post is computed.
 *
 * These are route-level tests, so `canReadPost` is a mock: whether its
 * predicate is right is decided against real Postgres in
 * test/integration/post-attachment-read-authz.integration.test.ts. What is
 * decided here is that the routes CALL it, before anything else, and that both
 * refusals are indistinguishable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { postsRoutes } from "../../../src/lib/routes/posts.js";
import type { Session } from "../../../src/lib/session-cookie.js";

const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

const mockCreateSecureResponse = vi.fn();
const mockAddSecurityHeaders = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
    constructor(_env: any) {}
  },
}));

vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = vi.fn().mockResolvedValue(null);
  },
}));

vi.mock("../../../src/lib/post-handler", () => ({
  PostHandler: class {},
}));

vi.mock("../../../src/lib/feed-handler", () => ({
  FeedHandler: class {},
}));

vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = vi.fn((error: any) => error?.message || "Unknown error");
  },
}));

const mockGetPost = vi.fn();
const mockGetDatabaseForRegion = vi.fn();
vi.mock("../../../src/lib/data-router", () => ({
  DataRouter: {
    getPost: (...args: any[]) => mockGetPost(...args),
    getDatabaseForRegion: (...args: any[]) => mockGetDatabaseForRegion(...args),
  },
}));

const mockGetPostTaxonomyTags = vi.fn();
vi.mock("../../../src/lib/taxonomy-handler", () => ({
  TaxonomyHandler: class {
    getPostTaxonomyTags = mockGetPostTaxonomyTags;
    constructor(_db: any, _tenantId: string, _kv: any) {}
  },
}));

const mockSuggestTagsFromText = vi.fn();
const mockGetPopularTags = vi.fn();
const mockGetUserFrequentTags = vi.fn();
vi.mock("../../../src/lib/tag-suggestions-handler", () => ({
  TagSuggestionsHandler: class {
    suggestTagsFromText = mockSuggestTagsFromText;
    getPopularTags = mockGetPopularTags;
    getUserFrequentTags = mockGetUserFrequentTags;
    constructor(_taxonomyHandler: any) {}
  },
}));

vi.mock("../../../src/lib/request-context", () => ({
  createRequestContext: vi.fn(),
}));

const mockGetWrappedDatabase = vi.fn();
vi.mock("../../../src/lib/database-wrapper-helper", () => ({
  getWrappedDatabase: (...args: any[]) => mockGetWrappedDatabase(...args),
}));

const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const mockCanReadPost = vi.fn();
vi.mock("../../../src/lib/post-read-authorizer", () => ({
  canReadPost: (...args: any[]) => mockCanReadPost(...args),
}));

const VIEWER_TENANT = "tenant-viewer";
const EXISTING_POST = "post-exists";
const ABSENT_POST = "post-does-not-exist";

// `/api/posts/...`, matching the pathname the cases below hand the handler.
// This lookup used to probe `/posts/post-123/taxonomy-tags` — the route's old,
// prefix-less pattern — while passing `pathname: "/api/posts/..."`. The two
// halves cancelled: the lookup succeeded because the pattern lacked `/api`,
// and the handler's `pathname.split("/api/posts/")` succeeded because the
// pathname had it. So every case below passed against a route that, in the
// real router, no request could reach at all.
const taxonomyRoute = postsRoutes.find(
  (r) =>
    r.path instanceof RegExp &&
    r.path.test("/api/posts/post-123/taxonomy-tags") &&
    r.method === "GET",
)!;

const suggestionsRoute = postsRoutes.find(
  (r) =>
    r.path instanceof RegExp &&
    r.path.test("/api/posts/post-123/tags/suggestions") &&
    r.method === "GET",
)!;

describe("post taxonomy GETs — V4 residual (a)", () => {
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
      userId: "user-viewer",
      email: "viewer@example.com",
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

    mockDb = { post: { findUnique: vi.fn() } };

    mockCreateSecureResponse.mockImplementation(
      (body: string, options: any) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((r: Response) => r);
    mockGetDatabaseForRegion.mockReturnValue(mockDb);
    mockGetWrappedDatabase.mockReturnValue(mockDb);

    mockGetSession.mockResolvedValue(mockSession);
    mockAuthMiddleware.mockResolvedValue({
      userId: "user-viewer",
      activeTenantId: VIEWER_TENANT,
    });

    // The store below is what a bare, unfiltered existence check would see: one
    // post exists, the other does not. The gate is what decides readability.
    mockGetPost.mockImplementation(async (postId: string) =>
      postId === EXISTING_POST ? { id: EXISTING_POST, authorId: "author-other-tenant" } : null,
    );
    mockDb.post.findUnique.mockResolvedValue({ text: "the post body" });
    mockGetPostTaxonomyTags.mockResolvedValue([]);
    mockSuggestTagsFromText.mockResolvedValue([]);
    mockGetPopularTags.mockResolvedValue([]);
    mockGetUserFrequentTags.mockResolvedValue([]);
    mockCanReadPost.mockResolvedValue(true);
  });

  const taxonomyCall = (postId: string) =>
    taxonomyRoute.handler(new Request(`http://test.com/api/posts/${postId}/taxonomy-tags`), mockEnv, {
      pathname: `/api/posts/${postId}/taxonomy-tags`,
      requestContext: mockRequestContext,
    } as any);

  const suggestionsCall = (postId: string) =>
    suggestionsRoute.handler(
      new Request(`http://test.com/api/posts/${postId}/tags/suggestions`),
      mockEnv,
      {
        pathname: `/api/posts/${postId}/tags/suggestions`,
        requestContext: mockRequestContext,
      } as any,
    );

  describe("anonymous callers get 401, never 404", () => {
    beforeEach(() => {
      mockGetSession.mockResolvedValue(null);
      mockAuthMiddleware.mockResolvedValue(null);
    });

    // The discriminating case. On the old ordering an anonymous request for an
    // id that does not exist returned 404 and one for an id that does returned
    // 401 — which is the oracle, spelled out.
    it.each([
      ["an existing id", EXISTING_POST],
      ["an absent id", ABSENT_POST],
    ])("taxonomy-tags: %s → 401", async (_label, postId) => {
      const response = await taxonomyCall(postId);
      expect(response.status).toBe(401);
      expect(mockGetPost).not.toHaveBeenCalled();
      expect(mockCanReadPost).not.toHaveBeenCalled();
    });

    it.each([
      ["an existing id", EXISTING_POST],
      ["an absent id", ABSENT_POST],
    ])("suggestions: %s → 401", async (_label, postId) => {
      const response = await suggestionsCall(postId);
      expect(response.status).toBe(401);
      expect(mockGetPost).not.toHaveBeenCalled();
      expect(mockDb.post.findUnique).not.toHaveBeenCalled();
      expect(mockSuggestTagsFromText).not.toHaveBeenCalled();
    });

    it("taxonomy-tags: the two anonymous refusals are byte-identical", async () => {
      const existing = await (await taxonomyCall(EXISTING_POST)).text();
      const absent = await (await taxonomyCall(ABSENT_POST)).text();
      expect(existing).toBe(absent);
    });
  });

  describe("a viewer the gate refuses is told nothing", () => {
    it("taxonomy-tags: refused post and absent post are the same response", async () => {
      mockCanReadPost.mockResolvedValue(false);
      const refused = await taxonomyCall(EXISTING_POST);

      mockCanReadPost.mockResolvedValue(true);
      const absent = await taxonomyCall(ABSENT_POST);

      expect(refused.status).toBe(404);
      expect(absent.status).toBe(404);
      expect(await refused.text()).toBe(await absent.text());
    });

    it("taxonomy-tags: a refused post yields no tags", async () => {
      mockCanReadPost.mockResolvedValue(false);
      const response = await taxonomyCall(EXISTING_POST);

      expect(response.status).toBe(404);
      expect(mockGetPostTaxonomyTags).not.toHaveBeenCalled();
    });

    it("suggestions: a refused post is never read, so nothing is derived from it", async () => {
      mockCanReadPost.mockResolvedValue(false);
      const response = await suggestionsCall(EXISTING_POST);

      expect(response.status).toBe(404);
      expect(mockDb.post.findUnique).not.toHaveBeenCalled();
      expect(mockSuggestTagsFromText).not.toHaveBeenCalled();
    });

    it("suggestions: refused post and absent post are the same response", async () => {
      mockCanReadPost.mockResolvedValue(false);
      const refused = await suggestionsCall(EXISTING_POST);

      mockCanReadPost.mockResolvedValue(true);
      const absent = await suggestionsCall(ABSENT_POST);

      expect(await refused.text()).toBe(await absent.text());
    });

    it("the gate is asked about the VIEWER's tenant, not the post's", async () => {
      mockCanReadPost.mockResolvedValue(false);
      await taxonomyCall(EXISTING_POST);

      expect(mockCanReadPost).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: EXISTING_POST,
          viewerUserId: "user-viewer",
          tenantId: VIEWER_TENANT,
        }),
      );
    });
  });

  describe("a readable post still works", () => {
    it("taxonomy-tags returns 200", async () => {
      mockGetPostTaxonomyTags.mockResolvedValue([
        {
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Training for recall commands",
          category: null,
        },
      ]);

      const response = await taxonomyCall(EXISTING_POST);
      expect(response.status).toBe(200);
      expect((await response.json()).tags).toHaveLength(1);
    });

    it("suggestions returns 200 and derives from the post text", async () => {
      const response = await suggestionsCall(EXISTING_POST);
      expect(response.status).toBe(200);
      expect(mockSuggestTagsFromText).toHaveBeenCalledWith("the post body", expect.anything());
    });
  });
});
