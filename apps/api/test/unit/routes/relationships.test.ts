/**
 * Unit Tests: Relationships Routes
 *
 * Tests for relationship CRUD routes including create, remove, update score,
 * get single, list, and graph visualization endpoints.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { relationshipRoutes } from "../../../src/lib/routes/relationships.js";
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

// Mock RelationshipHandler
const mockHandleCreateRelationship = vi.fn();
const mockHandleRemoveRelationship = vi.fn();
const mockHandleUpdateScore = vi.fn();
const mockHandleGetRelationship = vi.fn();
const mockHandleGetRelationships = vi.fn();
const mockHandleGetGraph = vi.fn();
vi.mock("../../../src/lib/relationship-handler", () => ({
  RelationshipHandler: class {
    handleCreateRelationship = mockHandleCreateRelationship;
    handleRemoveRelationship = mockHandleRemoveRelationship;
    handleUpdateScore = mockHandleUpdateScore;
    handleGetRelationship = mockHandleGetRelationship;
    handleGetRelationships = mockHandleGetRelationships;
    handleGetGraph = mockHandleGetGraph;
  },
}));


describe("Relationship Routes", () => {
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

    mockRequest = new Request("https://example.com/api/relationships", {
      method: "POST",
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
  });

  describe("POST /api/relationships - Create relationship", () => {
    const route = relationshipRoutes.find(
      (r) => r.method === "POST" && r.path === "/api/relationships",
    );

    it("should create relationship successfully", async () => {
      const mockResponse = new Response(JSON.stringify({ id: "rel-123" }), {
        status: 201,
      });
      mockHandleCreateRelationship.mockResolvedValue(mockResponse);

      const url = new URL("https://example.com/api/relationships");
      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/relationships",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        mockRequest,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleCreateRelationship).toHaveBeenCalledWith(
        mockRequest,
        mockSession,
        mockEnv,
        mockRequestContext,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockResponse);
      expect(response.status).toBe(201);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const url = new URL("https://example.com/api/relationships");
      await route!.handler(mockRequest, mockEnv, {
        pathname: "/api/relationships",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleCreateRelationship).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/relationships - Remove relationship", () => {
    const route = relationshipRoutes.find(
      (r) => r.method === "DELETE" && r.path === "/api/relationships",
    );

    it("should remove relationship successfully", async () => {
      const mockResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
      mockHandleRemoveRelationship.mockResolvedValue(mockResponse);

      const request = new Request("https://example.com/api/relationships", {
        method: "DELETE",
      });
      const url = new URL("https://example.com/api/relationships");
      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/relationships",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        request,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleRemoveRelationship).toHaveBeenCalledWith(
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

      const request = new Request("https://example.com/api/relationships", {
        method: "DELETE",
      });
      const url = new URL("https://example.com/api/relationships");
      await route!.handler(request, mockEnv, {
        pathname: "/api/relationships",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleRemoveRelationship).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /api/relationships/score - Update relationship score", () => {
    const route = relationshipRoutes.find(
      (r) =>
        r.method === "PATCH" && r.path === "/api/relationships/score",
    );

    it("should update relationship score successfully", async () => {
      const mockResponse = new Response(JSON.stringify({ score: 85 }), {
        status: 200,
      });
      mockHandleUpdateScore.mockResolvedValue(mockResponse);

      const request = new Request("https://example.com/api/relationships/score", {
        method: "PATCH",
      });
      const url = new URL("https://example.com/api/relationships/score");
      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/relationships/score",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        request,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleUpdateScore).toHaveBeenCalledWith(
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

      const request = new Request("https://example.com/api/relationships/score", {
        method: "PATCH",
      });
      const url = new URL("https://example.com/api/relationships/score");
      await route!.handler(request, mockEnv, {
        pathname: "/api/relationships/score",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleUpdateScore).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/relationships/single - Get single relationship", () => {
    const route = relationshipRoutes.find(
      (r) =>
        r.method === "GET" && r.path === "/api/relationships/single",
    );

    it("should get single relationship successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ id: "rel-123", score: 75 }),
        { status: 200 },
      );
      mockHandleGetRelationship.mockResolvedValue(mockResponse);

      const request = new Request(
        "https://example.com/api/relationships/single?targetId=user-456",
        { method: "GET" },
      );
      const url = new URL(
        "https://example.com/api/relationships/single?targetId=user-456",
      );
      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/relationships/single",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        request,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleGetRelationship).toHaveBeenCalledWith(
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
        "https://example.com/api/relationships/single",
        { method: "GET" },
      );
      const url = new URL("https://example.com/api/relationships/single");
      await route!.handler(request, mockEnv, {
        pathname: "/api/relationships/single",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetRelationship).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/relationships - List relationships", () => {
    const route = relationshipRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/relationships",
    );

    it("should list relationships successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({
          relationships: [
            { id: "rel-123", score: 75 },
            { id: "rel-456", score: 60 },
          ],
        }),
        { status: 200 },
      );
      mockHandleGetRelationships.mockResolvedValue(mockResponse);

      const request = new Request(
        "https://example.com/api/relationships?limit=10",
        { method: "GET" },
      );
      const url = new URL("https://example.com/api/relationships?limit=10");
      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/relationships",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        request,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleGetRelationships).toHaveBeenCalledWith(
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

      const request = new Request("https://example.com/api/relationships", {
        method: "GET",
      });
      const url = new URL("https://example.com/api/relationships");
      await route!.handler(request, mockEnv, {
        pathname: "/api/relationships",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetRelationships).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/relationships/graph - Get relationship graph", () => {
    const route = relationshipRoutes.find(
      (r) =>
        r.method === "GET" && r.path === "/api/relationships/graph",
    );

    it("should get relationship graph successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ nodes: [], edges: [] }),
        { status: 200 },
      );
      mockHandleGetGraph.mockResolvedValue(mockResponse);

      const request = new Request(
        "https://example.com/api/relationships/graph",
        { method: "GET" },
      );
      const url = new URL("https://example.com/api/relationships/graph");
      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/relationships/graph",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(
        request,
        "test-secret",
        mockEnv,
      );
      expect(mockHandleGetGraph).toHaveBeenCalledWith(
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
        "https://example.com/api/relationships/graph",
        { method: "GET" },
      );
      const url = new URL("https://example.com/api/relationships/graph");
      await route!.handler(request, mockEnv, {
        pathname: "/api/relationships/graph",
        url,
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetGraph).not.toHaveBeenCalled();
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(relationshipRoutes).toHaveLength(6);
    });

    it("should have correct methods for each route", () => {
      const methods = relationshipRoutes.map((r) => r.method);
      expect(methods).toContain("POST");
      expect(methods).toContain("DELETE");
      expect(methods).toContain("PATCH");
      expect(methods.filter((m) => m === "GET")).toHaveLength(3);
    });

    it("should have middleware configured for all routes", () => {
      relationshipRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      relationshipRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
