/**
 * Unit Tests: Discovery Routes
 *
 * Tests for entity discovery routes including graph traversal, nearby discovery,
 * and recommendation endpoints.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { discoveryRoutes } from "../../../src/lib/routes/discovery.js";
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

// Mock DiscoveryHandler
const mockHandleDiscoverByGraph = vi.fn();
const mockHandleDiscoverNearby = vi.fn();
const mockHandleGetRecommendations = vi.fn();
vi.mock("../../../src/lib/discovery-handler", () => ({
  DiscoveryHandler: class {
    handleDiscoverByGraph = mockHandleDiscoverByGraph;
    handleDiscoverNearby = mockHandleDiscoverNearby;
    handleGetRecommendations = mockHandleGetRecommendations;
  },
}));


describe("Discovery Routes", () => {
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

    mockRequest = new Request("https://example.com/api/discovery/graph", {
      method: "GET",
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
  });

  describe("GET /api/discovery/graph - Discover by graph traversal", () => {
    const route = discoveryRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/discovery/graph",
    );

    it("should discover entities via graph successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ entities: [{ id: "entity-123" }] }),
        { status: 200 },
      );
      mockHandleDiscoverByGraph.mockResolvedValue(mockResponse);

      const url = new URL("https://example.com/api/discovery/graph?depth=2");
      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/discovery/graph",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        mockRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleDiscoverByGraph).toHaveBeenCalledWith(
        mockRequest,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const url = new URL("https://example.com/api/discovery/graph");
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/discovery/graph",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleDiscoverByGraph).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/discovery/nearby - Discover nearby entities", () => {
    const route = discoveryRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/discovery/nearby",
    );

    it("should discover nearby entities successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({
          entities: [
            { id: "entity-123", distance: 0.5 },
            { id: "entity-456", distance: 1.2 },
          ],
        }),
        { status: 200 },
      );
      mockHandleDiscoverNearby.mockResolvedValue(mockResponse);

      const request = new Request(
        "https://example.com/api/discovery/nearby?latitude=40.7128&longitude=-74.0060&radius=10",
        { method: "GET" },
      );
      const url = new URL(
        "https://example.com/api/discovery/nearby?latitude=40.7128&longitude=-74.0060&radius=10",
      );
      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/discovery/nearby",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        request,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleDiscoverNearby).toHaveBeenCalledWith(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("https://example.com/api/discovery/nearby", {
        method: "GET",
      });
      const url = new URL("https://example.com/api/discovery/nearby");
      await route!.handler(request, mockEnv, {
        pathname: "/api/discovery/nearby",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleDiscoverNearby).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/discovery/recommendations - Get recommendations", () => {
    const route = discoveryRoutes.find(
      (r) =>
        r.method === "GET" && r.path === "/api/discovery/recommendations",
    );

    it("should get recommendations successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({
          recommendations: [
            { id: "entity-123", score: 95 },
            { id: "entity-456", score: 87 },
          ],
        }),
        { status: 200 },
      );
      mockHandleGetRecommendations.mockResolvedValue(mockResponse);

      const request = new Request(
        "https://example.com/api/discovery/recommendations?limit=20",
        { method: "GET" },
      );
      const url = new URL(
        "https://example.com/api/discovery/recommendations?limit=20",
      );
      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/discovery/recommendations",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        request,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleGetRecommendations).toHaveBeenCalledWith(
        request,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/api/discovery/recommendations",
        { method: "GET" },
      );
      const url = new URL("https://example.com/api/discovery/recommendations");
      await route!.handler(request, mockEnv, {
        pathname: "/api/discovery/recommendations",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetRecommendations).not.toHaveBeenCalled();
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(discoveryRoutes).toHaveLength(3);
    });

    it("should have correct method for all routes", () => {
      discoveryRoutes.forEach((route) => {
        expect(route.method).toBe("GET");
      });
    });

    it("should have middleware configured for all routes", () => {
      discoveryRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      discoveryRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
