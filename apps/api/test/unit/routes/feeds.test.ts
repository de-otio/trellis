/**
 * Unit Tests: Feeds Routes
 *
 * Tests for feed route handlers including dog feed, home feed, and ATProto feed endpoints.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { feedsRoutes } from "../../../src/lib/routes/feeds.js";
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

// Mock FeedHandler
const mockGetEntityFeed = vi.fn();
const mockGetHomeFeed = vi.fn();
vi.mock("../../../src/lib/feed-handler", () => ({
  FeedHandler: class {
    getEntityFeed = mockGetEntityFeed;
    getHomeFeed = mockGetHomeFeed;
  },
}));

// Mock Validator
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));

// Mock validateQueryParams
const mockValidateQueryParams = vi.fn();
vi.mock("../../../src/lib/validate-request", () => ({
  validateQueryParams: (...args: any[]) => mockValidateQueryParams(...args),
}));

// Mock paginationSchema and feedQuerySchema
vi.mock("../../../src/lib/schemas", () => ({
  paginationSchema: {
    parse: vi.fn(),
  },
  feedQuerySchema: {
    parse: vi.fn(),
  },
}));


// Mock addCorsHeaders
const mockAddCorsHeaders = vi.fn();
vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args),
}));

// Mock authMiddleware
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const TEST_TENANT_ID = "tenant-test-123";

describe("Feeds Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockSession = {
      userId: "user-123",
      tenantId: "tenant-123",
      expiresAt: new Date(Date.now() + 3600000),
    } as Session;

    mockRequestContext = {
      tenantId: "tenant-123",
      userId: "user-123",
      region: "us-east-1",
    } as TrellisRequestContext;

    mockRequest = new Request("https://example.com/api/feeds/dog/dog-123", {
      method: "GET",
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockAuthMiddleware.mockResolvedValue({
      userId: "user-123",
      activeTenantId: TEST_TENANT_ID,
    });
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockAddCorsHeaders.mockImplementation(async (response) => response);
  });

  describe("GET /api/feeds/dog/* - Get dog feed", () => {
    const route = feedsRoutes.find(
      (r) => r.method === "GET" && r.path.toString().includes("dog"),
    );

    it("should get dog feed successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ posts: [], cursor: null }),
        { status: 200 },
      );
      mockGetEntityFeed.mockResolvedValue(mockResponse);
      mockValidateQueryParams.mockReturnValue({
        success: true,
        data: { limit: 20, cursor: null },
      });

      const url = new URL("https://example.com/api/feeds/dog/dog-123?limit=20");
      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/feeds/dog/dog-123",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        mockRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockValidateQueryParams).toHaveBeenCalled();
      expect(mockGetEntityFeed).toHaveBeenCalledWith(
        mockSession,
        "dog-123",
        mockEnv,
        { limit: 20, cursor: null },
        mockRequestContext,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should decode URL-encoded dog reference", async () => {
      const mockResponse = new Response(JSON.stringify({}), { status: 200 });
      mockGetEntityFeed.mockResolvedValue(mockResponse);
      mockValidateQueryParams.mockReturnValue({
        success: true,
        data: { limit: 20, cursor: null },
      });

      const encodedDogRef = encodeURIComponent("dog@example.com");
      const url = new URL(`https://example.com/api/feeds/dog/${encodedDogRef}`);
      await route!.handler(mockRequest, mockEnv, {
        pathname: `/api/feeds/dog/${encodedDogRef}`,
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetEntityFeed).toHaveBeenCalledWith(
        expect.anything(),
        "dog@example.com",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const url = new URL("https://example.com/api/feeds/dog/dog-123");
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/feeds/dog/dog-123",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockGetEntityFeed).not.toHaveBeenCalled();
    });

    it("should return 500 when request context is missing", async () => {
      const url = new URL("https://example.com/api/feeds/dog/dog-123");
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/feeds/dog/dog-123",
        url,
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockGetEntityFeed).not.toHaveBeenCalled();
    });

    it("should handle query validation errors", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Invalid query parameters" }),
        { status: 400 },
      );
      mockValidateQueryParams.mockReturnValue({
        success: false,
        error: errorResponse,
      });

      const url = new URL(
        "https://example.com/api/feeds/dog/dog-123?limit=invalid",
      );
      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/feeds/dog/dog-123",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(errorResponse);
      expect(mockGetEntityFeed).not.toHaveBeenCalled();
    });

    it("should handle errors from FeedHandler", async () => {
      const error = new Error("Database error");
      mockGetEntityFeed.mockRejectedValue(error);
      mockValidateQueryParams.mockReturnValue({
        success: true,
        data: { limit: 20, cursor: null },
      });

      const url = new URL("https://example.com/api/feeds/dog/dog-123");
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/feeds/dog/dog-123",
        url,
        requestContext: mockRequestContext,
      });

            expect(mockSanitizeError).toHaveBeenCalledWith(error);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Database error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("GET /api/feeds/home - Get home feed", () => {
    const route = feedsRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/feeds/home",
    );

    it("should get home feed successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ posts: [], cursor: null }),
        { status: 200 },
      );
      mockGetHomeFeed.mockResolvedValue(mockResponse);
      mockValidateQueryParams.mockReturnValue({
        success: true,
        data: {
          limit: 20,
          cursor: null,
          entityRef: null,
          entityRefs: null,
          taxonomyTags: null,
          personalized: false,
          personalizationEntityIds: null,
        },
      });

      const url = new URL("https://example.com/api/feeds/home?limit=20");
      const response = await route!.handler(mockRequest, mockEnv, {
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        mockRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockValidateQueryParams).toHaveBeenCalled();
      expect(mockGetHomeFeed).toHaveBeenCalledWith(
        mockSession,
        mockRequest,
        mockEnv,
        {
          limit: 20,
          cursor: null,
          entityRef: null,
          entityRefs: null,
          taxonomyTags: null,
          personalized: false,
          personalizationEntityIds: null,
        },
        mockRequestContext,
        TEST_TENANT_ID,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const url = new URL("https://example.com/api/feeds/home");
      const response = await route!.handler(mockRequest, mockEnv, {
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(mockGetHomeFeed).not.toHaveBeenCalled();
    });

    it("should return 500 when request context is missing", async () => {
      const url = new URL("https://example.com/api/feeds/home");
      const response = await route!.handler(mockRequest, mockEnv, {
        url,
        requestContext: null,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Request context not available" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(mockGetHomeFeed).not.toHaveBeenCalled();
    });

    it("should handle query validation errors", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Invalid query parameters" }),
        { status: 400 },
      );
      mockValidateQueryParams.mockReturnValue({
        success: false,
        error: errorResponse,
      });

      const url = new URL("https://example.com/api/feeds/home?limit=invalid");
      const response = await route!.handler(mockRequest, mockEnv, {
        url,
        requestContext: mockRequestContext,
      });

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(errorResponse);
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(mockGetHomeFeed).not.toHaveBeenCalled();
    });

    it("should handle errors from FeedHandler", async () => {
      const error = new Error("Database error");
      error.stack = "Error stack trace";
      mockGetHomeFeed.mockRejectedValue(error);
      mockValidateQueryParams.mockReturnValue({
        success: true,
        data: {
          limit: 20,
          cursor: null,
          entityRef: null,
          entityRefs: null,
          taxonomyTags: null,
          personalized: false,
          personalizationEntityIds: null,
        },
      });

      const url = new URL("https://example.com/api/feeds/home");
      const response = await route!.handler(mockRequest, mockEnv, {
        url,
        requestContext: mockRequestContext,
      });

                  expect(mockSanitizeError).toHaveBeenCalledWith(error);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({
          error: "Database error",
          message: "Database error",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });
  });

  describe("GET /xrpc/app.bsky.feed.getFeedSkeleton - ATProto feed endpoint", () => {
    const route = feedsRoutes.find(
      (r) => r.method === "GET" && r.path.toString().includes("xrpc"),
    );

    it("should return 501 not implemented", async () => {
      mockValidateQueryParams.mockReturnValue({
        success: true,
        data: { limit: 20, cursor: null },
      });

      const url = new URL(
        "https://example.com/xrpc/app.bsky.feed.getFeedSkeleton?limit=20",
      );
      const response = await route!.handler(mockRequest, mockEnv, {
        url,
      });

      expect(mockValidateQueryParams).toHaveBeenCalled();
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ feed: [], cursor: null, error: "Not implemented" }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
      expect(response.status).toBe(501);
    });

    it("should handle query validation errors", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Invalid query parameters" }),
        { status: 400 },
      );
      mockValidateQueryParams.mockReturnValue({
        success: false,
        error: errorResponse,
      });

      const url = new URL(
        "https://example.com/xrpc/app.bsky.feed.getFeedSkeleton?limit=invalid",
      );
      const response = await route!.handler(mockRequest, mockEnv, {
        url,
      });

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(errorResponse);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(feedsRoutes).toHaveLength(3);
      expect(feedsRoutes.every((r) => r.method === "GET")).toBe(true);
    });

    it("should have middleware configured for all routes", () => {
      feedsRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      feedsRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
