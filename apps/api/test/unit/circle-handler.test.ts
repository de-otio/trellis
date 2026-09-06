import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

// ---------------------------------------------------------------------------
// Graph service mock (hoisted so vi.mock factories can close over it)
// ---------------------------------------------------------------------------

const { mockGraphService } = vi.hoisted(() => ({
  mockGraphService: {
    getCircleMembers: vi.fn(),
    getVisiblePostIds: vi.fn(),
    getGlanceItems: vi.fn(),
    getDepthPostIds: vi.fn(),
    getCircleStatus: vi.fn(),
    getCircleEntityStatus: vi.fn(),
    markCircleRead: vi.fn(),
  }}));

vi.mock("../../src/lib/graph", () => ({
  createGraphServiceFromEnv: vi.fn().mockResolvedValue(mockGraphService),
}));

import { CircleHandler } from "../../src/lib/circle-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class GraphConnectionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "GraphConnectionError";
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    userId: "user-123",
    email: "u@example.com",
    role: "END_USER",
    expiresAt: Date.now() + 3_600_000,
    sessionType: "user",
    lastActivityAt: Date.now(),
    ...overrides,
  } as Session;
}

const mockEnv = { DATABASE_URL: "postgresql://test:test@localhost/test" } as unknown as Env;
const mockRequestContext = {} as TrellisRequestContext;
/** The caller's verified active tenant (H1) — every circle read requires one. */
const TENANT = "tenant-1";

function buildUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://api.example.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function getRequest(path: string, params: Record<string, string> = {}): Request {
  return new Request(buildUrl(path, params), { method: "GET" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CircleHandler", () => {
  let handler: CircleHandler;
  let session: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CircleHandler();
    session = makeSession();
  });

  // -------------------------------------------------------------------------
  // handleGetMembers
  // -------------------------------------------------------------------------

  describe("handleGetMembers", () => {
    it("returns 200 with members list for a valid tier", async () => {
      const members = [{ id: "user-456" }];
      mockGraphService.getCircleMembers.mockResolvedValue(members);

      const response = await handler.handleGetMembers(
        getRequest("/api/circles/members", { tier: "1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ members });
      expect(mockGraphService.getCircleMembers).toHaveBeenCalledWith("user-123", 1, TENANT);
    });

    it("accepts all valid tier values (0, 1, 2, 3)", async () => {
      mockGraphService.getCircleMembers.mockResolvedValue([]);

      for (const tier of ["0", "1", "2", "3"]) {
        vi.clearAllMocks();
        mockGraphService.getCircleMembers.mockResolvedValue([]);

        const response = await handler.handleGetMembers(
          getRequest("/api/circles/members", { tier }),
          session,
          mockEnv,
          mockRequestContext,
          TENANT,
        );
        expect(response.status).toBe(200);
        expect(mockGraphService.getCircleMembers).toHaveBeenCalledWith(
          "user-123",
          Number(tier),
          TENANT,
        );
      }
    });

    it("returns 400 when tier is missing", async () => {
      const response = await handler.handleGetMembers(
        getRequest("/api/circles/members"),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/tier/i);
    });

    it("returns 400 when tier is not a valid integer (NaN)", async () => {
      const response = await handler.handleGetMembers(
        getRequest("/api/circles/members", { tier: "abc" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when tier is out of range (4)", async () => {
      const response = await handler.handleGetMembers(
        getRequest("/api/circles/members", { tier: "4" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when tier is negative", async () => {
      const response = await handler.handleGetMembers(
        getRequest("/api/circles/members", { tier: "-1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.getCircleMembers.mockRejectedValue(new GraphConnectionError("down"));

      const response = await handler.handleGetMembers(
        getRequest("/api/circles/members", { tier: "1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
    });

    it("returns 503 with Retry-After and no URI on GraphConnectionError (E2)", async () => {
      mockGraphService.getCircleMembers.mockRejectedValue(
        new GraphConnectionError("bolt+s://abc.databases.neo4j.io:7687 connection refused"),
      );

      const response = await handler.handleGetMembers(
        getRequest("/api/circles/members", { tier: "1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
      expect(JSON.stringify(body)).not.toMatch(/bolt|neo4j\.io|username|password/i);
    });

    it("returns 503 with jitter delay on pool-acquire-timeout (E3)", async () => {
      mockGraphService.getCircleMembers.mockRejectedValue(
        new GraphConnectionError("connection acquisition timed out"),
      );

      const start = Date.now();
      const response = await handler.handleGetMembers(
        getRequest("/api/circles/members", { tier: "1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );
      const elapsed = Date.now() - start;

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
      expect(elapsed).toBeGreaterThanOrEqual(50);
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.getCircleMembers.mockRejectedValue(new Error("boom"));

      const response = await handler.handleGetMembers(
        getRequest("/api/circles/members", { tier: "1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("INTERNAL_ERROR");
          });
  });

  // -------------------------------------------------------------------------
  // handleGetFeed
  // -------------------------------------------------------------------------

  describe("handleGetFeed", () => {
    it("returns 200 with feed result using defaults", async () => {
      const result = { postIds: ["p1", "p2"], nextCursor: null };
      mockGraphService.getVisiblePostIds.mockResolvedValue(result);

      const response = await handler.handleGetFeed(
        getRequest("/api/circles/feed", { tier: "2" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      // The circles feed reports its declared order like the home feed does
      // (FeedResponse.ranker) — the same chronological@1, on the wire.
      expect(body).toEqual({ ...result, ranker: "chronological@1" });
      expect(mockGraphService.getVisiblePostIds).toHaveBeenCalledWith(
        "user-123",
        2,
        expect.any(Date),
        { limit: 20, cursor: undefined },
        TENANT,
        undefined, // orgFilter (T2): no org-category params on this request
      );
    });

    it("accepts explicit since, limit, and cursor params", async () => {
      mockGraphService.getVisiblePostIds.mockResolvedValue({ postIds: [] });

      await handler.handleGetFeed(
        getRequest("/api/circles/feed", {
          tier: "0",
          since: "2025-01-01T00:00:00.000Z",
          limit: "10",
          cursor: "tok-123",
        }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(mockGraphService.getVisiblePostIds).toHaveBeenCalledWith(
        "user-123",
        0,
        new Date("2025-01-01T00:00:00.000Z"),
        { limit: 10, cursor: "tok-123" },
        TENANT,
        undefined, // orgFilter (T2): no org-category params on this request
      );
    });

    it("clamps limit to max 50", async () => {
      mockGraphService.getVisiblePostIds.mockResolvedValue({ postIds: [] });

      await handler.handleGetFeed(
        getRequest("/api/circles/feed", { tier: "1", limit: "999" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(mockGraphService.getVisiblePostIds).toHaveBeenCalledWith(
        "user-123",
        1,
        expect.any(Date),
        { limit: 50, cursor: undefined },
        TENANT,
        undefined, // orgFilter (T2): no org-category params on this request
      );
    });

    it("clamps limit to min 1", async () => {
      mockGraphService.getVisiblePostIds.mockResolvedValue({ postIds: [] });

      await handler.handleGetFeed(
        getRequest("/api/circles/feed", { tier: "1", limit: "-5" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(mockGraphService.getVisiblePostIds).toHaveBeenCalledWith(
        "user-123",
        1,
        expect.any(Date),
        { limit: 1, cursor: undefined },
        TENANT,
        undefined, // orgFilter (T2): no org-category params on this request
      );
    });

    it("returns 400 when tier is missing", async () => {
      const response = await handler.handleGetFeed(
        getRequest("/api/circles/feed"),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when tier is invalid", async () => {
      const response = await handler.handleGetFeed(
        getRequest("/api/circles/feed", { tier: "5" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when since is an invalid date string", async () => {
      const response = await handler.handleGetFeed(
        getRequest("/api/circles/feed", { tier: "1", since: "not-a-date" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/since/i);
    });

    it("uses a default since date 7 days ago when not provided", async () => {
      mockGraphService.getVisiblePostIds.mockResolvedValue({ postIds: [] });
      const before = Date.now() - 7 * 24 * 60 * 60 * 1000;

      await handler.handleGetFeed(
        getRequest("/api/circles/feed", { tier: "1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      const after = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const [, , sincePassed] = mockGraphService.getVisiblePostIds.mock.calls[0]!;
      expect((sincePassed as Date).getTime()).toBeGreaterThanOrEqual(before - 100);
      expect((sincePassed as Date).getTime()).toBeLessThanOrEqual(after + 100);
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.getVisiblePostIds.mockRejectedValue(new GraphConnectionError("down"));

      const response = await handler.handleGetFeed(
        getRequest("/api/circles/feed", { tier: "1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(503);
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.getVisiblePostIds.mockRejectedValue(new Error("unexpected"));

      const response = await handler.handleGetFeed(
        getRequest("/api/circles/feed", { tier: "1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // handleGetGlance
  // -------------------------------------------------------------------------

  describe("handleGetGlance", () => {
    it("returns 200 with glance items", async () => {
      const items = [{ userId: "user-456", preview: "hello" }];
      mockGraphService.getGlanceItems.mockResolvedValue(items);

      const response = await handler.handleGetGlance(
        getRequest("/api/circles/glance", { tier: "3" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ items });
      expect(mockGraphService.getGlanceItems).toHaveBeenCalledWith(
        "user-123",
        3,
        20,
        TENANT,
        undefined,
      );
    });

    it("passes custom limit", async () => {
      mockGraphService.getGlanceItems.mockResolvedValue([]);

      await handler.handleGetGlance(
        getRequest("/api/circles/glance", { tier: "1", limit: "5" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(mockGraphService.getGlanceItems).toHaveBeenCalledWith(
        "user-123",
        1,
        5,
        TENANT,
        undefined,
      );
    });

    it("clamps limit to max 50", async () => {
      mockGraphService.getGlanceItems.mockResolvedValue([]);

      await handler.handleGetGlance(
        getRequest("/api/circles/glance", { tier: "1", limit: "100" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(mockGraphService.getGlanceItems).toHaveBeenCalledWith(
        "user-123",
        1,
        50,
        TENANT,
        undefined,
      );
    });

    it("returns 400 when tier is missing", async () => {
      const response = await handler.handleGetGlance(
        getRequest("/api/circles/glance"),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when tier is invalid", async () => {
      const response = await handler.handleGetGlance(
        getRequest("/api/circles/glance", { tier: "99" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.getGlanceItems.mockRejectedValue(new GraphConnectionError("down"));

      const response = await handler.handleGetGlance(
        getRequest("/api/circles/glance", { tier: "0" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(503);
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.getGlanceItems.mockRejectedValue(new Error("oops"));

      const response = await handler.handleGetGlance(
        getRequest("/api/circles/glance", { tier: "0" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // handleGetDepth
  // -------------------------------------------------------------------------

  describe("handleGetDepth", () => {
    it("returns 200 with post IDs", async () => {
      const postIds = ["post-1", "post-2"];
      mockGraphService.getDepthPostIds.mockResolvedValue(postIds);

      const response = await handler.handleGetDepth(
        getRequest("/api/circles/depth", { targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ postIds });
      expect(mockGraphService.getDepthPostIds).toHaveBeenCalledWith(
        "user-123",
        "user",
        "user-456",
        expect.any(Date),
        20,
        TENANT,
      );
    });

    it("works with entity targetType", async () => {
      mockGraphService.getDepthPostIds.mockResolvedValue([]);

      const response = await handler.handleGetDepth(
        getRequest("/api/circles/depth", { targetType: "entity", targetId: "ent-1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(200);
      expect(mockGraphService.getDepthPostIds).toHaveBeenCalledWith(
        "user-123",
        "entity",
        "ent-1",
        expect.any(Date),
        20,
        TENANT,
      );
    });

    it("accepts explicit since and limit", async () => {
      mockGraphService.getDepthPostIds.mockResolvedValue([]);

      await handler.handleGetDepth(
        getRequest("/api/circles/depth", {
          targetType: "user",
          targetId: "user-456",
          since: "2025-06-01T00:00:00.000Z",
          limit: "30",
        }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(mockGraphService.getDepthPostIds).toHaveBeenCalledWith(
        "user-123",
        "user",
        "user-456",
        new Date("2025-06-01T00:00:00.000Z"),
        30,
        TENANT,
      );
    });

    it("clamps limit to max 50", async () => {
      mockGraphService.getDepthPostIds.mockResolvedValue([]);

      await handler.handleGetDepth(
        getRequest("/api/circles/depth", { targetType: "user", targetId: "u-1", limit: "500" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(mockGraphService.getDepthPostIds).toHaveBeenCalledWith(
        "user-123",
        "user",
        "u-1",
        expect.any(Date),
        50,
        TENANT,
      );
    });

    it("uses a default since date 30 days ago when not provided", async () => {
      mockGraphService.getDepthPostIds.mockResolvedValue([]);
      const before = Date.now() - 30 * 24 * 60 * 60 * 1000;

      await handler.handleGetDepth(
        getRequest("/api/circles/depth", { targetType: "user", targetId: "u-1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      const after = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const [, , , sincePassed] = mockGraphService.getDepthPostIds.mock.calls[0]!;
      expect((sincePassed as Date).getTime()).toBeGreaterThanOrEqual(before - 100);
      expect((sincePassed as Date).getTime()).toBeLessThanOrEqual(after + 100);
    });

    it("returns 400 when targetType is missing", async () => {
      const response = await handler.handleGetDepth(
        getRequest("/api/circles/depth", { targetId: "u-1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when targetId is missing", async () => {
      const response = await handler.handleGetDepth(
        getRequest("/api/circles/depth", { targetType: "user" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when targetType is invalid", async () => {
      const response = await handler.handleGetDepth(
        getRequest("/api/circles/depth", { targetType: "org", targetId: "o-1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when since is an invalid date", async () => {
      const response = await handler.handleGetDepth(
        getRequest("/api/circles/depth", {
          targetType: "user",
          targetId: "u-1",
          since: "not-a-date",
        }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/since/i);
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.getDepthPostIds.mockRejectedValue(new GraphConnectionError("down"));

      const response = await handler.handleGetDepth(
        getRequest("/api/circles/depth", { targetType: "user", targetId: "u-1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(503);
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.getDepthPostIds.mockRejectedValue(new Error("bang"));

      const response = await handler.handleGetDepth(
        getRequest("/api/circles/depth", { targetType: "user", targetId: "u-1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // handleGetStatus
  // -------------------------------------------------------------------------

  describe("handleGetStatus", () => {
    it("returns 200 with tiers status", async () => {
      const status = [{ tier: 1, count: 5, unread: 2 }];
      mockGraphService.getCircleStatus.mockResolvedValue(status);

      const response = await handler.handleGetStatus(
        new Request("https://api.example.com/api/circles/status", { method: "GET" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ tiers: status });
      expect(mockGraphService.getCircleStatus).toHaveBeenCalledWith("user-123", TENANT);
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.getCircleStatus.mockRejectedValue(new GraphConnectionError("down"));

      const response = await handler.handleGetStatus(
        new Request("https://api.example.com/api/circles/status", { method: "GET" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(503);
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.getCircleStatus.mockRejectedValue(new Error("crash"));

      const response = await handler.handleGetStatus(
        new Request("https://api.example.com/api/circles/status", { method: "GET" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(500);
          });
  });

  // -------------------------------------------------------------------------
  // handleGetEntityStatus
  // -------------------------------------------------------------------------

  describe("handleGetEntityStatus", () => {
    it("returns 200 with entities for valid tier", async () => {
      const entities = [{ entityId: "ent-1", tier: 2 }];
      mockGraphService.getCircleEntityStatus.mockResolvedValue(entities);

      const response = await handler.handleGetEntityStatus(
        getRequest("/api/circles/entity-status", { tier: "2" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ entities });
      expect(mockGraphService.getCircleEntityStatus).toHaveBeenCalledWith(
        "user-123",
        2,
        TENANT,
      );
    });

    it("returns 400 when tier is missing", async () => {
      const response = await handler.handleGetEntityStatus(
        getRequest("/api/circles/entity-status"),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when tier is out of range", async () => {
      const response = await handler.handleGetEntityStatus(
        getRequest("/api/circles/entity-status", { tier: "10" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when tier is NaN", async () => {
      const response = await handler.handleGetEntityStatus(
        getRequest("/api/circles/entity-status", { tier: "nope" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(400);
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.getCircleEntityStatus.mockRejectedValue(new GraphConnectionError("down"));

      const response = await handler.handleGetEntityStatus(
        getRequest("/api/circles/entity-status", { tier: "1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(503);
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.getCircleEntityStatus.mockRejectedValue(new Error("err"));

      const response = await handler.handleGetEntityStatus(
        getRequest("/api/circles/entity-status", { tier: "1" }),
        session,
        mockEnv,
        mockRequestContext,
        TENANT,
      );

      expect(response.status).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // handleMarkRead
  // -------------------------------------------------------------------------

  describe("handleMarkRead", () => {
    function postRequest(body: unknown): Request {
      return new Request("https://api.example.com/api/circles/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("marks circle as read and returns 204", async () => {
      mockGraphService.markCircleRead.mockResolvedValue(undefined);

      const response = await handler.handleMarkRead(
        postRequest({ tier: 1 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(204);
      expect(mockGraphService.markCircleRead).toHaveBeenCalledWith("user-123", 1);
    });

    it("accepts all valid tier values (0, 1, 2, 3)", async () => {
      mockGraphService.markCircleRead.mockResolvedValue(undefined);

      for (const tier of [0, 1, 2, 3]) {
        vi.clearAllMocks();
        mockGraphService.markCircleRead.mockResolvedValue(undefined);

        const response = await handler.handleMarkRead(
          postRequest({ tier }),
          session,
          mockEnv,
          mockRequestContext,
        );
        expect(response.status).toBe(204);
        expect(mockGraphService.markCircleRead).toHaveBeenCalledWith("user-123", tier);
      }
    });

    it("returns 400 when tier is missing from body", async () => {
      const response = await handler.handleMarkRead(
        postRequest({}),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/tier/i);
    });

    it("returns 400 when tier is a string (not a number)", async () => {
      const response = await handler.handleMarkRead(
        postRequest({ tier: "1" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when tier is out of range (4)", async () => {
      const response = await handler.handleMarkRead(
        postRequest({ tier: 4 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when tier is negative", async () => {
      const response = await handler.handleMarkRead(
        postRequest({ tier: -1 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when tier is a non-integer float", async () => {
      const response = await handler.handleMarkRead(
        postRequest({ tier: 1.5 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 on invalid JSON body (SyntaxError)", async () => {
      const request = new Request("https://api.example.com/api/circles/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not valid json",
      });

      const response = await handler.handleMarkRead(
        request,
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/invalid json/i);
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.markCircleRead.mockRejectedValue(new GraphConnectionError("down"));

      const response = await handler.handleMarkRead(
        postRequest({ tier: 0 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.markCircleRead.mockRejectedValue(new Error("explosion"));

      const response = await handler.handleMarkRead(
        postRequest({ tier: 0 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("INTERNAL_ERROR");
          });
  });
});
