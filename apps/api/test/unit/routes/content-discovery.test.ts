/**
 * Unit Tests: Content Discovery Routes
 *
 * Tests for content discovery route handlers including related content, trending topics, and recommendations.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { contentDiscoveryRoutes } from "../../../src/lib/routes/content-discovery.js";
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
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    constructor(env: any) {}
  },
}));

// Mock ContentDiscovery
const mockGetRelatedContent = vi.fn();
const mockGetTrendingTopics = vi.fn();
const mockGetContentRecommendations = vi.fn();
const mockGetCreatorRecommendations = vi.fn();
vi.mock("../../../src/lib/content-discovery", () => ({
  ContentDiscovery: {
    getRelatedContent: (...args: any[]) => mockGetRelatedContent(...args),
    getTrendingTopics: (...args: any[]) => mockGetTrendingTopics(...args),
    getContentRecommendations: (...args: any[]) =>
      mockGetContentRecommendations(...args),
    getCreatorRecommendations: (...args: any[]) =>
      mockGetCreatorRecommendations(...args),
  },
}));

// Mock createRequestContext
const mockCreateRequestContext = vi.fn();
vi.mock("../../../src/lib/request-context", () => ({
  createRequestContext: (...args: any[]) => mockCreateRequestContext(...args),
}));

// Mock authMiddleware
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const TEST_TENANT_ID = "tenant-test-123";

describe("Content Discovery Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockSession = {
      userId: "user-123",
      tenantId: TEST_TENANT_ID,
      expiresAt: new Date(Date.now() + 3600000),
    } as Session;

    mockRequest = new Request(
      "https://example.com/api/posts/post-123/related",
      {
        method: "GET",
      },
    );

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockCreateRequestContext.mockResolvedValue({
      region: "US",
      session: mockSession,
    });
    mockAuthMiddleware.mockResolvedValue({
      userId: "user-123",
      activeTenantId: TEST_TENANT_ID,
    });
  });

  describe("GET /api/posts/:postId/related - Get related content", () => {
    const route = contentDiscoveryRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/posts/:postId/related",
    );

    it("should get related content successfully", async () => {
      const mockRecommendations = [{ id: "post-1" }, { id: "post-2" }];
      mockGetRelatedContent.mockResolvedValue(mockRecommendations);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/related",
      });

      expect(mockGetRelatedContent).toHaveBeenCalledWith(
        "post-123",
        TEST_TENANT_ID,
        "US",
        mockEnv,
        mockRequest,
        {
          limit: 10,
          minMatchingTags: 1,
          includeSameAuthor: false,
        },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.recommendations).toEqual(mockRecommendations);
      expect(body.count).toBe(2);
    });

    it("should parse query parameters correctly", async () => {
      const url = new URL(
        "https://example.com/api/posts/post-123/related?limit=15&minMatchingTags=2&includeSameAuthor=true",
      );
      const request = new Request(url.toString(), { method: "GET" });
      mockGetRelatedContent.mockResolvedValue([]);

      await route!.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/related",
      });

      expect(mockGetRelatedContent).toHaveBeenCalledWith(
        "post-123",
        TEST_TENANT_ID,
        "US",
        mockEnv,
        request,
        {
          limit: 15,
          minMatchingTags: 2,
          includeSameAuthor: true,
        },
      );
    });

    it("should cap limit at 20", async () => {
      const url = new URL(
        "https://example.com/api/posts/post-123/related?limit=100",
      );
      const request = new Request(url.toString(), { method: "GET" });
      mockGetRelatedContent.mockResolvedValue([]);

      await route!.handler(request, mockEnv, {
        pathname: "/api/posts/post-123/related",
      });

      expect(mockGetRelatedContent).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        expect.any(Request),
        expect.objectContaining({ limit: 20 }),
      );
    });

    it("should handle errors", async () => {
      const error = new Error("Database error");
      mockGetRelatedContent.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/posts/post-123/related",
      });

            expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Database error");
    });
  });

  describe("GET /api/taxonomy/trending - Get trending topics", () => {
    const route = contentDiscoveryRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/taxonomy/trending",
    );

    it("should get trending topics successfully", async () => {
      const mockTopics = [{ id: "topic-1" }, { id: "topic-2" }];
      mockGetTrendingTopics.mockResolvedValue(mockTopics);

      const request = new Request("https://example.com/api/taxonomy/trending", {
        method: "GET",
      });

      const response = await route!.handler(request, mockEnv);

      expect(mockGetTrendingTopics).toHaveBeenCalledWith(
        TEST_TENANT_ID,
        "US",
        mockEnv,
        request,
        {
          limit: 20,
          period: "week",
        },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.topics).toEqual(mockTopics);
      expect(body.count).toBe(2);
    });

    it("should parse query parameters correctly", async () => {
      const url = new URL(
        "https://example.com/api/taxonomy/trending?limit=30&period=day",
      );
      const request = new Request(url.toString(), { method: "GET" });
      mockGetTrendingTopics.mockResolvedValue([]);

      await route!.handler(request, mockEnv);

      expect(mockGetTrendingTopics).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        expect.any(Request),
        {
          limit: 30,
          period: "day",
        },
      );
    });

    it("should cap limit at 50", async () => {
      const url = new URL(
        "https://example.com/api/taxonomy/trending?limit=100",
      );
      const request = new Request(url.toString(), { method: "GET" });
      mockGetTrendingTopics.mockResolvedValue([]);

      await route!.handler(request, mockEnv);

      expect(mockGetTrendingTopics).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        expect.any(Request),
        expect.objectContaining({ limit: 50 }),
      );
    });

    it("should handle errors", async () => {
      const error = new Error("Database error");
      mockGetTrendingTopics.mockRejectedValue(error);

      const request = new Request("https://example.com/api/taxonomy/trending", {
        method: "GET",
      });

      const response = await route!.handler(request, mockEnv);

            expect(response.status).toBe(500);
    });
  });

  describe("GET /api/recommendations/content - Get content recommendations", () => {
    const route = contentDiscoveryRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/recommendations/content",
    );

    it("should get content recommendations successfully", async () => {
      const mockRecommendations = [{ id: "post-1" }, { id: "post-2" }];
      mockGetContentRecommendations.mockResolvedValue(mockRecommendations);

      const request = new Request(
        "https://example.com/api/recommendations/content",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(
        request,
        mockEnv.SESSION_SECRET,
      );
      expect(mockGetContentRecommendations).toHaveBeenCalledWith(
        "user-123",
        TEST_TENANT_ID,
        "US",
        mockEnv,
        request,
        {
          limit: 10,
          entityIds: undefined,
        },
      );
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining('"recommendations"'),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/api/recommendations/content",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockGetContentRecommendations).not.toHaveBeenCalled();
    });

    it("should parse entityIds query parameter", async () => {
      const url = new URL(
        "https://example.com/api/recommendations/content?entityIds=entity-1,entity-2",
      );
      const request = new Request(url.toString(), { method: "GET" });
      mockGetContentRecommendations.mockResolvedValue([]);

      await route!.handler(request, mockEnv);

      expect(mockGetContentRecommendations).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        expect.any(Request),
        {
          limit: 10,
          entityIds: ["entity-1", "entity-2"],
        },
      );
    });

    it("should handle errors", async () => {
      const error = new Error("Database error");
      mockGetContentRecommendations.mockRejectedValue(error);

      const request = new Request(
        "https://example.com/api/recommendations/content",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv);

            expect(response.status).toBe(500);
    });
  });

  describe("GET /api/recommendations/creators - Get creator recommendations", () => {
    const route = contentDiscoveryRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/recommendations/creators",
    );

    it("should get creator recommendations successfully", async () => {
      const mockRecommendations = [{ id: "creator-1" }, { id: "creator-2" }];
      mockGetCreatorRecommendations.mockResolvedValue(mockRecommendations);

      const request = new Request(
        "https://example.com/api/recommendations/creators",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(
        request,
        mockEnv.SESSION_SECRET,
      );
      expect(mockGetCreatorRecommendations).toHaveBeenCalledWith(
        "user-123",
        TEST_TENANT_ID,
        "US",
        mockEnv,
        request,
        {
          limit: 10,
          entityIds: undefined,
          minPostCount: 3,
          minMatchingTags: 1,
        },
      );
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/api/recommendations/creators",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockGetCreatorRecommendations).not.toHaveBeenCalled();
    });

    it("should parse query parameters correctly", async () => {
      const url = new URL(
        "https://example.com/api/recommendations/creators?limit=15&entityIds=entity-1&minPostCount=5&minMatchingTags=2",
      );
      const request = new Request(url.toString(), { method: "GET" });
      mockGetCreatorRecommendations.mockResolvedValue([]);

      await route!.handler(request, mockEnv);

      expect(mockGetCreatorRecommendations).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        expect.any(Request),
        {
          limit: 15,
          entityIds: ["entity-1"],
          minPostCount: 5,
          minMatchingTags: 2,
        },
      );
    });

    it("should handle errors", async () => {
      const error = new Error("Database error");
      mockGetCreatorRecommendations.mockRejectedValue(error);

      const request = new Request(
        "https://example.com/api/recommendations/creators",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv);

            expect(response.status).toBe(500);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(contentDiscoveryRoutes).toHaveLength(4);
      expect(contentDiscoveryRoutes.every((r) => r.method === "GET")).toBe(
        true,
      );
    });

    it("should have middleware configured for all routes", () => {
      contentDiscoveryRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      contentDiscoveryRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
