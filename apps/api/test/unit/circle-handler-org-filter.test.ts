/**
 * Unit Tests: CircleHandler org-category feed-filter param parsing (T2).
 *
 * Verifies that `excludeOrgRootCategories` / `includeOrgRootCategories` query
 * params are parsed and forwarded to the graph service on the feed and glance
 * paths (and ONLY those paths), that malformed/blank input degrades to "no
 * filter" (undefined), and that codes are trimmed, deduped, charset-validated,
 * and capped. The graph service is mocked, so these assert the handler→service
 * hand-off, not the SQL.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

const { mockGraphService } = vi.hoisted(() => ({
  mockGraphService: {
    getVisiblePostIds: vi.fn(),
    getGlanceItems: vi.fn(),
  },
}));

vi.mock("../../src/lib/graph", () => ({
  createGraphServiceFromEnv: vi.fn().mockResolvedValue(mockGraphService),
}));

import { CircleHandler } from "../../src/lib/circle-handler.js";

function makeSession(): Session {
  return {
    userId: "user-123",
    email: "u@example.com",
    role: "END_USER",
    expiresAt: Date.now() + 3_600_000,
    sessionType: "user",
    lastActivityAt: Date.now(),
  } as Session;
}

const mockEnv = { DATABASE_URL: "postgresql://test:test@localhost/test" } as unknown as Env;
const mockRequestContext = {} as TrellisRequestContext;

function feedRequest(params: Record<string, string>): Request {
  const url = new URL("https://api.example.com/api/circles/feed");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString(), { method: "GET" });
}

function glanceRequest(params: Record<string, string>): Request {
  const url = new URL("https://api.example.com/api/circles/glance");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString(), { method: "GET" });
}

describe("CircleHandler org-category filter parsing", () => {
  let handler: CircleHandler;
  let session: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CircleHandler();
    session = makeSession();
    mockGraphService.getVisiblePostIds.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    mockGraphService.getGlanceItems.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // handleGetFeed
  // -------------------------------------------------------------------------

  describe("handleGetFeed", () => {
    it("passes undefined orgFilter when neither param is present", async () => {
      await handler.handleGetFeed(feedRequest({ tier: "1" }), session, mockEnv, mockRequestContext);

      const call = mockGraphService.getVisiblePostIds.mock.calls[0]!;
      expect(call[4]).toBeUndefined();
    });

    it("parses excludeOrgRootCategories into { exclude: [...] }", async () => {
      await handler.handleGetFeed(
        feedRequest({ tier: "1", excludeOrgRootCategories: "business,government" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(mockGraphService.getVisiblePostIds.mock.calls[0]![4]).toEqual({
        exclude: ["business", "government"],
      });
    });

    it("parses includeOrgRootCategories into { include: [...] }", async () => {
      await handler.handleGetFeed(
        feedRequest({ tier: "0", includeOrgRootCategories: "nonprofit" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(mockGraphService.getVisiblePostIds.mock.calls[0]![4]).toEqual({
        include: ["nonprofit"],
      });
    });

    it("parses both params together", async () => {
      await handler.handleGetFeed(
        feedRequest({
          tier: "2",
          excludeOrgRootCategories: "business",
          includeOrgRootCategories: "nonprofit,community-group",
        }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(mockGraphService.getVisiblePostIds.mock.calls[0]![4]).toEqual({
        exclude: ["business"],
        include: ["nonprofit", "community-group"],
      });
    });

    it("trims whitespace, drops empties, and dedupes", async () => {
      await handler.handleGetFeed(
        feedRequest({ tier: "1", excludeOrgRootCategories: " business , , business ,nonprofit " }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(mockGraphService.getVisiblePostIds.mock.calls[0]![4]).toEqual({
        exclude: ["business", "nonprofit"],
      });
    });

    it("drops codes that fail the charset validation", async () => {
      await handler.handleGetFeed(
        feedRequest({ tier: "1", excludeOrgRootCategories: "business,;DROP TABLE posts;--,non profit" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      // Only the well-formed slug survives; the injection-ish / spaced tokens are rejected.
      expect(mockGraphService.getVisiblePostIds.mock.calls[0]![4]).toEqual({
        exclude: ["business"],
      });
    });

    it("treats an all-invalid list as no filter (undefined)", async () => {
      await handler.handleGetFeed(
        feedRequest({ tier: "1", excludeOrgRootCategories: " , ,%%%" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(mockGraphService.getVisiblePostIds.mock.calls[0]![4]).toBeUndefined();
    });

    it("caps the number of codes to the abuse ceiling", async () => {
      const many = Array.from({ length: 100 }, (_, i) => `cat${i}`).join(",");
      await handler.handleGetFeed(
        feedRequest({ tier: "1", excludeOrgRootCategories: many }),
        session,
        mockEnv,
        mockRequestContext,
      );

      const filter = mockGraphService.getVisiblePostIds.mock.calls[0]![4] as { exclude: string[] };
      expect(filter.exclude.length).toBeLessThanOrEqual(24);
      expect(filter.exclude.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // handleGetGlance
  // -------------------------------------------------------------------------

  describe("handleGetGlance", () => {
    it("forwards the parsed orgFilter as the 4th arg", async () => {
      await handler.handleGetGlance(
        glanceRequest({ tier: "3", excludeOrgRootCategories: "business" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(mockGraphService.getGlanceItems).toHaveBeenCalledWith(
        "user-123",
        3,
        20,
        { exclude: ["business"] },
      );
    });

    it("passes undefined when no org params are present", async () => {
      await handler.handleGetGlance(
        glanceRequest({ tier: "1" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(mockGraphService.getGlanceItems).toHaveBeenCalledWith("user-123", 1, 20, undefined);
    });
  });
});
