/**
 * Unit Tests: RecapService (year-in-review core primitive)
 *
 * Covers the core aggregation service directly, plus the ownership /
 * minor-account gates that live in the recap route handler (recap.ts is not
 * mounted in app.ts yet, so its handler is exercised directly here).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

const { mockPrisma, mockKV, mockGetExtensions, mockCreateExtensionContext, mockGetSession, mockAuthMiddleware } =
  vi.hoisted(() => ({
    mockPrisma: {
      post: { count: vi.fn(), findMany: vi.fn() },
      relationship: { count: vi.fn() },
      entityOwnership: { findFirst: vi.fn() },
      user: { findUnique: vi.fn() },
      release: vi.fn(),
    },
    mockKV: {
      get: vi.fn(),
      put: vi.fn(),
    },
    mockGetExtensions: vi.fn(),
    mockCreateExtensionContext: vi.fn(),
    mockGetSession: vi.fn(),
    mockAuthMiddleware: vi.fn(),
  }));

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

vi.mock("../../src/extensions", () => ({
  getExtensions: mockGetExtensions,
}));

vi.mock("../../src/lib/extension-context", () => ({
  createExtensionContext: mockCreateExtensionContext,
}));

vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

vi.mock("../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: mockAuthMiddleware,
}));

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    SESSION_SECRET: "test-secret-32-characters-long!!",
    FEED_CACHE_KV: mockKV,
  } as unknown as Env;
}

const WINDOW = {
  from: new Date("2026-01-01T00:00:00.000Z"),
  to: new Date("2026-12-31T23:59:59.999Z"),
};

describe("RecapService", () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RECAP_CACHE_TTL_DAYS;
    mockEnv = makeEnv();
    mockPrisma.release.mockResolvedValue(undefined);
    mockKV.put.mockResolvedValue(undefined);
    mockGetExtensions.mockReturnValue([]);
    mockCreateExtensionContext.mockReturnValue({});
  });

  describe("own-data-only aggregation", () => {
    it("aggregates a user's own posts, received sentiments, and connections, scoped to that user only", async () => {
      const { RecapService } = await import("../../src/lib/recap-service.js");

      mockKV.get.mockResolvedValue(null);
      mockPrisma.post.count.mockResolvedValue(3); // true count, independent of the bounded fetch below
      mockPrisma.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          createdAt: new Date("2026-02-01T00:00:00.000Z"),
          sentiments: [{ sentiment: "joy" }, { sentiment: "joy" }],
        },
        {
          id: "post-2",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          sentiments: [{ sentiment: "gratitude" }],
        },
      ]);
      mockPrisma.relationship.count.mockResolvedValue(5);

      const service = new RecapService();
      const result = await service.generateRecap(
        { subjectType: "user", subjectId: "user-1", window: WINDOW, tenantId: "tenant-1" },
        mockEnv,
      );

      // Counts reflect the subject's own data.
      expect(result.posts.count).toBe(3);
      expect(result.posts.firstAt).toBe("2026-02-01T00:00:00.000Z");
      expect(result.posts.mostReactedPostId).toBe("post-1");
      expect(result.sentimentsReceived).toEqual({ joy: 2, gratitude: 1 });
      expect(result.connectionsMade).toBe(5);
      expect(result.topMoments[0]).toEqual({ postId: "post-1", at: "2026-02-01T00:00:00.000Z" });

      // Every query is scoped to the single subject — own data only.
      expect(mockPrisma.post.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ authorId: "user-1", tenantId: "tenant-1" }) }),
      );
      expect(mockPrisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ authorId: "user-1", tenantId: "tenant-1" }) }),
      );
      expect(mockPrisma.relationship.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: "user-1", tenantId: "tenant-1" }) }),
      );
    });

    it("aggregates an entity's own posts (by primaryEntityId) and connections made toward it", async () => {
      const { RecapService } = await import("../../src/lib/recap-service.js");

      mockKV.get.mockResolvedValue(null);
      mockPrisma.post.count.mockResolvedValue(0);
      mockPrisma.post.findMany.mockResolvedValue([]);
      mockPrisma.relationship.count.mockResolvedValue(2);

      const service = new RecapService();
      const result = await service.generateRecap(
        { subjectType: "entity", subjectId: "dog-1", window: WINDOW, tenantId: "tenant-1" },
        mockEnv,
      );

      expect(result.connectionsMade).toBe(2);
      expect(mockPrisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ primaryEntityId: "dog-1" }) }),
      );
      expect(mockPrisma.relationship.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ targetType: "entity", targetId: "dog-1" }),
        }),
      );
    });

    it("emits no cross-user comparison, leaderboard, rank, or percentile fields", async () => {
      const { RecapService } = await import("../../src/lib/recap-service.js");

      mockKV.get.mockResolvedValue(null);
      mockPrisma.post.count.mockResolvedValue(1);
      mockPrisma.post.findMany.mockResolvedValue([
        { id: "post-1", createdAt: new Date("2026-05-01T00:00:00.000Z"), sentiments: [] },
      ]);
      mockPrisma.relationship.count.mockResolvedValue(0);

      const service = new RecapService();
      const result = await service.generateRecap(
        { subjectType: "user", subjectId: "user-1", window: WINDOW, tenantId: "tenant-1" },
        mockEnv,
      );

      // The neutral payload has exactly this shape — no vanity/comparison fields.
      expect(Object.keys(result).sort()).toEqual(
        ["connectionsMade", "posts", "sentimentsReceived", "topMoments", "window"].sort(),
      );
      for (const forbidden of ["rank", "percentile", "leaderboard", "comparedTo", "otherUsers"]) {
        expect(result).not.toHaveProperty(forbidden);
      }
      // A post with zero sentiments in the window must not fabricate a "most reacted" winner.
      expect(result.posts.mostReactedPostId).toBeUndefined();
    });
  });

  describe("caching", () => {
    it("returns the cached payload without recomputing on a cache hit", async () => {
      const { RecapService } = await import("../../src/lib/recap-service.js");

      const cached = {
        window: { from: WINDOW.from.toISOString(), to: WINDOW.to.toISOString() },
        posts: { count: 7 },
        sentimentsReceived: { joy: 1 },
        connectionsMade: 1,
        topMoments: [],
      };
      mockKV.get.mockResolvedValue(JSON.stringify(cached));

      const service = new RecapService();
      const result = await service.generateRecap(
        { subjectType: "user", subjectId: "user-1", window: WINDOW, tenantId: "tenant-1" },
        mockEnv,
      );

      expect(result).toEqual(cached);
      expect(mockPrisma.post.count).not.toHaveBeenCalled();
      expect(mockPrisma.post.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.relationship.count).not.toHaveBeenCalled();
    });

    it("computes and stores the payload in KV on a cache miss", async () => {
      const { RecapService } = await import("../../src/lib/recap-service.js");

      mockKV.get.mockResolvedValue(null);
      mockPrisma.post.count.mockResolvedValue(0);
      mockPrisma.post.findMany.mockResolvedValue([]);
      mockPrisma.relationship.count.mockResolvedValue(0);

      const service = new RecapService();
      const result = await service.generateRecap(
        { subjectType: "user", subjectId: "user-1", window: WINDOW, tenantId: "tenant-1" },
        mockEnv,
      );

      expect(mockKV.put).toHaveBeenCalledTimes(1);
      const [key, value, options] = mockKV.put.mock.calls[0];
      expect(key).toContain("recap:tenant-1:user:user-1:");
      expect(JSON.parse(value)).toEqual(result);
      // Default TTL: 90 days, in seconds.
      expect(options.expirationTtl).toBe(90 * 24 * 60 * 60);
    });
  });

  describe("extendRecap hook", () => {
    it("calls extendRecap when the registered extension provides one, and merges its fields under `extension`", async () => {
      const { RecapService } = await import("../../src/lib/recap-service.js");

      mockKV.get.mockResolvedValue(null);
      mockPrisma.post.count.mockResolvedValue(0);
      mockPrisma.post.findMany.mockResolvedValue([]);
      mockPrisma.relationship.count.mockResolvedValue(0);

      const extendRecap = vi.fn().mockResolvedValue({ walksLogged: 12, packMatesMet: 3 });
      mockGetExtensions.mockReturnValue([{ id: "dog", extendRecap }]);
      const fakeCtx = { appDomain: "example.com" };
      mockCreateExtensionContext.mockReturnValue(fakeCtx);

      const service = new RecapService();
      const result = await service.generateRecap(
        { subjectType: "entity", subjectId: "dog-1", window: WINDOW, tenantId: "tenant-1" },
        mockEnv,
      );

      expect(extendRecap).toHaveBeenCalledTimes(1);
      const [payloadArg, subjectArg, ctxArg] = extendRecap.mock.calls[0];
      expect(payloadArg.window).toEqual(result.window);
      expect(subjectArg).toEqual({
        subjectType: "entity",
        subjectId: "dog-1",
        window: result.window,
      });
      expect(ctxArg).toBe(fakeCtx);
      expect(result.extension).toEqual({ walksLogged: 12, packMatesMet: 3 });
    });

    it("does not fail the recap when extendRecap throws — core payload still returns without `extension`", async () => {
      const { RecapService } = await import("../../src/lib/recap-service.js");

      mockKV.get.mockResolvedValue(null);
      mockPrisma.post.count.mockResolvedValue(0);
      mockPrisma.post.findMany.mockResolvedValue([]);
      mockPrisma.relationship.count.mockResolvedValue(0);

      const extendRecap = vi.fn().mockRejectedValue(new Error("boom"));
      mockGetExtensions.mockReturnValue([{ id: "dog", extendRecap }]);
      mockCreateExtensionContext.mockReturnValue({});

      const service = new RecapService();
      const result = await service.generateRecap(
        { subjectType: "entity", subjectId: "dog-1", window: WINDOW, tenantId: "tenant-1" },
        mockEnv,
      );

      expect(result.extension).toBeUndefined();
      expect(result.posts.count).toBe(0);
    });

    it("leaves `extension` unset when no registered extension provides extendRecap", async () => {
      const { RecapService } = await import("../../src/lib/recap-service.js");

      mockKV.get.mockResolvedValue(null);
      mockPrisma.post.count.mockResolvedValue(0);
      mockPrisma.post.findMany.mockResolvedValue([]);
      mockPrisma.relationship.count.mockResolvedValue(0);
      mockGetExtensions.mockReturnValue([{ id: "dog" /* no extendRecap */ }]);

      const service = new RecapService();
      const result = await service.generateRecap(
        { subjectType: "entity", subjectId: "dog-1", window: WINDOW, tenantId: "tenant-1" },
        mockEnv,
      );

      expect(result.extension).toBeUndefined();
      expect(mockCreateExtensionContext).not.toHaveBeenCalled();
    });
  });
});

describe("recap route (apps/api/src/lib/routes/recap.ts)", () => {
  let mockEnv: Env;
  let mockSession: { userId: string; email: string };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RECAP_CACHE_TTL_DAYS;
    mockEnv = makeEnv();
    mockPrisma.release.mockResolvedValue(undefined);
    mockKV.put.mockResolvedValue(undefined);
    mockGetExtensions.mockReturnValue([]);
    mockCreateExtensionContext.mockReturnValue({});

    mockSession = { userId: "user-1", email: "user@example.com" };
    mockGetSession.mockResolvedValue(mockSession);
    mockAuthMiddleware.mockResolvedValue({ activeTenantId: "tenant-1" });
    mockPrisma.user.findUnique.mockResolvedValue({ ageTier: "ADULT" });
  });

  function makeRequest(path: string): Request {
    return new Request(`https://api.example.com${path}`, { method: "GET" });
  }

  async function callHandler(path: string) {
    const { recapRoutes } = await import("../../src/lib/routes/recap.js");
    const route = recapRoutes[0];
    const request = makeRequest(path);
    const pathname = new URL(request.url).pathname;
    return route.handler(request, mockEnv as any, { url: new URL(request.url), pathname, params: {} });
  }

  it("returns 401 when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const response = await callHandler("/api/recap/user/user-1?window=2026");
    expect(response.status).toBe(401);
  });

  it("returns 400 when no window/from/to is provided", async () => {
    const response = await callHandler("/api/recap/user/user-1");
    expect(response.status).toBe(400);
  });

  it("rejects a user subject that is not the session user (403)", async () => {
    const response = await callHandler("/api/recap/user/some-other-user?window=2026");
    expect(response.status).toBe(403);
    expect(mockPrisma.post.count).not.toHaveBeenCalled();
  });

  it("allows a user subject viewing their own recap (200)", async () => {
    mockPrisma.post.count.mockResolvedValue(0);
    mockPrisma.post.findMany.mockResolvedValue([]);
    mockPrisma.relationship.count.mockResolvedValue(0);
    mockKV.get.mockResolvedValue(null);

    const response = await callHandler("/api/recap/user/user-1?window=2026");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.posts.count).toBe(0);
  });

  it("rejects an entity subject the caller does not own (403)", async () => {
    mockPrisma.entityOwnership.findFirst.mockResolvedValue(null);
    const response = await callHandler("/api/recap/entity/dog-1?window=2026");
    expect(response.status).toBe(403);
    expect(mockPrisma.post.count).not.toHaveBeenCalled();
  });

  it("allows an entity subject the caller owns via an ACTIVE EntityOwnership (200)", async () => {
    mockPrisma.entityOwnership.findFirst.mockResolvedValue({ id: "own-1", status: "ACTIVE" });
    mockPrisma.post.count.mockResolvedValue(0);
    mockPrisma.post.findMany.mockResolvedValue([]);
    mockPrisma.relationship.count.mockResolvedValue(0);
    mockKV.get.mockResolvedValue(null);

    const response = await callHandler("/api/recap/entity/dog-1?window=2026");
    expect(response.status).toBe(200);
    expect(mockPrisma.entityOwnership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityId: "dog-1", userId: "user-1", status: "ACTIVE" }),
      }),
    );
  });

  it("is off by default for minor accounts (403), even for the account's own recap", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ageTier: "TEEN" });
    const response = await callHandler("/api/recap/user/user-1?window=2026");
    expect(response.status).toBe(403);
    expect(mockPrisma.post.count).not.toHaveBeenCalled();
  });
});
