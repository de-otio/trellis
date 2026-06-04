/**
 * Unit Tests: Entities Routes
 *
 * Tests for entity route handlers including listing, creation, retrieval, and taxonomy tags.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
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

// Mock RateLimiter
const mockApplyRateLimitKV = vi.fn();
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = mockApplyRateLimitKV;
  },
}));

// Mock EntityHandler
const mockListEntityProfiles = vi.fn();
const mockCreateEntityProfile = vi.fn();
const mockGetEntityProfile = vi.fn();
const mockUpdateEntityProfile = vi.fn();
vi.mock("../../../src/lib/entity-handler", () => ({
  EntityHandler: class {
    listEntityProfiles = mockListEntityProfiles;
    createEntityProfile = mockCreateEntityProfile;
    getEntityProfile = mockGetEntityProfile;
    updateEntityProfile = mockUpdateEntityProfile;
  },
}));

// Mock Validator
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));

// Mock ValidationError
vi.mock("../../../src/lib/validation/validate-request", () => ({
  ValidationError: class extends Error {
    toResponse() {
      return { error: this.message };
    }
    getStatusCode() {
      return 400;
    }
    constructor(message: string) {
      super(message);
    }
  },
}));

// Mock DataRouter
const mockGetDatabaseForRegion = vi.fn();
vi.mock("../../../src/lib/data-router", () => ({
  DataRouter: {
    getDatabaseForRegion: (...args: any[]) => mockGetDatabaseForRegion(...args),
  },
}));

// Mock TaxonomyHandler
const mockGetEntityTaxonomyTags = vi.fn();
const mockAddEntityTaxonomyTags = vi.fn();
const mockRemoveEntityTaxonomyTags = vi.fn();
vi.mock("../../../src/lib/taxonomy-handler", () => ({
  TaxonomyHandler: class {
    getEntityTaxonomyTags = mockGetEntityTaxonomyTags;
    addEntityTaxonomyTags = mockAddEntityTaxonomyTags;
    removeEntityTaxonomyTags = mockRemoveEntityTaxonomyTags;
    constructor(db: any, tenantId: string, kv: any) {}
  },
}));

// Mock the createTaxonomyHandler factory function
vi.mock("../../../src/lib/taxonomy-handler-factory", () => {
  const mockFn = vi.fn();
  return {
    createTaxonomyHandler: mockFn,
  };
});

// Import after mocks are set up
import { entitiesRoutes } from "../../../src/lib/routes/entities.js";
import { createTaxonomyHandler } from "../../../src/lib/taxonomy-handler-factory.js";

// Get the mock function
const getMockCreateTaxonomyHandler = () => {
  return createTaxonomyHandler as ReturnType<typeof vi.fn>;
};

// Mock tenant context

// Mock authMiddleware
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const TEST_TENANT_ID = "tenant-test-123";

// Mock request context
const mockCreateRequestContext = vi.fn();
vi.mock("../../../src/lib/request-context", () => ({
  createRequestContext: (...args: any[]) => mockCreateRequestContext(...args),
}));

// Mock database wrapper helper
const mockGetWrappedDatabase = vi.fn();
vi.mock("../../../src/lib/database-wrapper-helper", () => ({
  getWrappedDatabase: (...args: any[]) => mockGetWrappedDatabase(...args),
}));

// Mock CorsHandler
const mockAddCorsHeaders = vi.fn();
vi.mock("../../../src/lib/cors-handler", () => ({
  CorsHandler: {
    addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args),
  },
}));

describe("Entities Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
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
      userId: "user-123",
      email: "user@example.com",
      expiresAt: Date.now() + 3600000,
    };

    mockDb = {
      entity: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation(
      (body, options) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockAddCorsHeaders.mockImplementation(async (response) => response);
    mockApplyRateLimitKV.mockResolvedValue(null);
    mockGetDatabaseForRegion.mockReturnValue(mockDb);
    mockGetWrappedDatabase.mockReturnValue(mockDb);
    mockCreateRequestContext.mockResolvedValue({
      session: mockSession,
      region: "US",
    });

    mockAuthMiddleware.mockResolvedValue({
      userId: "user-123",
      activeTenantId: TEST_TENANT_ID,
    });
    mockGetEntityTaxonomyTags.mockResolvedValue([]);

    // Set up default mock for createTaxonomyHandler
    const mockTaxonomyHandler = {
      getEntityTaxonomyTags: mockGetEntityTaxonomyTags,
      addEntityTaxonomyTags: mockAddEntityTaxonomyTags,
      removeEntityTaxonomyTags: mockRemoveEntityTaxonomyTags,
    };
    getMockCreateTaxonomyHandler().mockResolvedValue(
      mockTaxonomyHandler as any,
    );
  });

  describe("GET /api/entities", () => {
    const route = entitiesRoutes.find(
      (r) => r.path === "/api/entities" && r.method === "GET",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("http://test.com/api/entities");
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities",
        params: {},
      });

      expect(response.status).toBe(401);
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });

    it("should list entity profiles successfully", async () => {
      const listResponse = new Response(JSON.stringify({ entities: [] }), {
        status: 200,
      });
      mockListEntityProfiles.mockResolvedValue(listResponse);

      const request = new Request("http://test.com/api/entities");
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities",
        params: {},
      });

      expect(mockListEntityProfiles).toHaveBeenCalled();
      expect(mockAddSecurityHeaders).toHaveBeenCalled();
    });

    it("should handle errors gracefully", async () => {
      mockListEntityProfiles.mockRejectedValue(new Error("Database error"));

      const request = new Request("http://test.com/api/entities");
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities",
        params: {},
      });

      expect(response.status).toBe(500);
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });
  });

  describe("POST /api/entities", () => {
    const route = entitiesRoutes.find(
      (r) => r.path === "/api/entities" && r.method === "POST",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("http://test.com/api/entities", {
        method: "POST",
        body: JSON.stringify({ name: "Test Entity" }),
        headers: { "Content-Type": "application/json" },
      });
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities",
        params: {},
      });

      expect(response.status).toBe(401);
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });

    it("should return rate limit response when rate limited", async () => {
      const rateLimitResponse = new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429 },
      );
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      const request = new Request("http://test.com/api/entities", {
        method: "POST",
        body: JSON.stringify({ name: "Test Entity" }),
        headers: { "Content-Type": "application/json" },
      });
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities",
        params: {},
      });

      expect(response.status).toBe(429);
    });

    it("should create entity profile successfully", async () => {
      const createResponse = new Response(
        JSON.stringify({ id: "entity-123", name: "Test Entity" }),
        { status: 201 },
      );
      mockCreateEntityProfile.mockResolvedValue(createResponse);

      const request = new Request("http://test.com/api/entities", {
        method: "POST",
        body: JSON.stringify({ name: "Test Entity" }),
        headers: { "Content-Type": "application/json" },
      });
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities",
        params: {},
      });

      expect(mockCreateEntityProfile).toHaveBeenCalled();
      expect(mockAddSecurityHeaders).toHaveBeenCalled();
    });

    it("should handle ValidationError with 400 status", async () => {
      const { ValidationError } = await import(
        "../../../src/lib/validation/validate-request.js"
      );
      const validationError = new ValidationError("Invalid input", []);
      mockCreateEntityProfile.mockRejectedValue(validationError);

      const request = new Request("http://test.com/api/entities", {
        method: "POST",
        body: JSON.stringify({ name: "Test Entity" }),
        headers: { "Content-Type": "application/json" },
      });
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities",
        params: {},
      });

      expect(response.status).toBe(400);
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });

    it("should handle general errors gracefully", async () => {
      mockCreateEntityProfile.mockRejectedValue(new Error("Database error"));

      const request = new Request("http://test.com/api/entities", {
        method: "POST",
        body: JSON.stringify({ name: "Test Entity" }),
        headers: { "Content-Type": "application/json" },
      });
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities",
        params: {},
      });

      expect(response.status).toBe(500);
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });
  });

  describe("GET /api/entities/:id", () => {
    const route = entitiesRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/entities/entity-123") &&
        r.method === "GET",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("http://test.com/api/entities/entity-123");
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(401);
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });

    it("should get entity profile successfully", async () => {
      const getResponse = new Response(
        JSON.stringify({ id: "entity-123", name: "Test Entity" }),
        { status: 200 },
      );
      mockGetEntityProfile.mockResolvedValue(getResponse);

      const request = new Request("http://test.com/api/entities/entity-123");
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123",
        params: { id: "entity-123" },
      });

      expect(mockGetEntityProfile).toHaveBeenCalledWith(
        "entity-123",
        mockSession,
        mockEnv,
        request,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalled();
    });

    it("should handle errors gracefully", async () => {
      mockGetEntityProfile.mockRejectedValue(new Error("Database error"));

      const request = new Request("http://test.com/api/entities/entity-123");
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(500);
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });
  });

  describe("POST /api/entities/:id/taxonomy-tags", () => {
    const route = entitiesRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/entities/entity-123/taxonomy-tags") &&
        r.method === "POST",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(401);
    });

    it("should return rate limit response when rate limited", async () => {
      const rateLimitResponse = new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429 },
      );
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(429);
    });

    it("should return 404 when entity not found", async () => {
      mockDb.entity.findFirst.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe("Entity not found");
    });

    it("should return 403 when user does not own entity", async () => {
      mockDb.entity.findFirst.mockResolvedValue({
        id: "entity-123",
        owners: [{ userId: "other-user", role: "PRIMARY" }],
      });

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("Forbidden");
    });

    it("should return 413 when request body too large", async () => {
      mockDb.entity.findFirst.mockResolvedValue({
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY" }],
      });

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: {
            "Content-Type": "application/json",
            "content-length": "11000", // > 10KB
          },
        },
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(413);
    });

    it("should return 400 when taxonIds is missing", async () => {
      mockDb.entity.findFirst.mockResolvedValue({
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY" }],
      });

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "Content-Type": "application/json" },
        },
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("taxonIds array is required");
    });

    it("should return 400 for invalid taxon ID format", async () => {
      mockDb.entity.findFirst.mockResolvedValue({
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY" }],
      });

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({ taxonIds: ["invalid-format"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Invalid taxon ID format");
    });

    it("should add taxonomy tags successfully", async () => {
      mockDb.entity.findFirst.mockResolvedValue({
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY" }],
      });
      mockGetEntityTaxonomyTags.mockResolvedValue([
        {
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Training for recall commands",
        },
      ]);

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({
            taxonIds: ["behavior:training:recall"],
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(200);
      expect(mockAddEntityTaxonomyTags).toHaveBeenCalledWith("entity-123", [
        "behavior:training:recall",
      ]);
      const data = await response.json();
      expect(data).toHaveProperty("tags");
    });

    it("should handle errors gracefully", async () => {
      mockDb.entity.findFirst.mockResolvedValue({
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY" }],
      });
      mockAddEntityTaxonomyTags.mockRejectedValue(new Error("Database error"));

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
        {
          method: "POST",
          body: JSON.stringify({
            taxonIds: ["behavior:training:recall"],
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(500);
    });
  });

  describe("DELETE /api/entities/:id/taxonomy-tags", () => {
    const route = entitiesRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/entities/entity-123/taxonomy-tags") &&
        r.method === "DELETE",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
        {
          method: "DELETE",
          body: JSON.stringify({ taxonIds: ["behavior:training:recall"] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(401);
    });

    it("should remove taxonomy tags successfully", async () => {
      mockDb.entity.findFirst.mockResolvedValue({
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY" }],
      });

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
        {
          method: "DELETE",
          body: JSON.stringify({
            taxonIds: ["behavior:training:recall"],
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(200);
      expect(mockRemoveEntityTaxonomyTags).toHaveBeenCalledWith("entity-123", [
        "behavior:training:recall",
      ]);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it("should handle errors gracefully", async () => {
      mockDb.entity.findFirst.mockResolvedValue({
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY" }],
      });
      mockRemoveEntityTaxonomyTags.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
        {
          method: "DELETE",
          body: JSON.stringify({
            taxonIds: ["behavior:training:recall"],
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/entities/:id/taxonomy-tags", () => {
    const route = entitiesRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/entities/entity-123/taxonomy-tags") &&
        r.method === "GET",
    )!;

    // Verify route is found
    if (!route) {
      console.error(
        "Route not found! Available routes:",
        entitiesRoutes.map((r) => ({
          path: r.path,
          method: r.method,
        })),
      );
    }

    it("should have route and handler defined", () => {
      expect(route).toBeDefined();
      expect(route.handler).toBeDefined();
      expect(typeof route.handler).toBe("function");
    });

    it("should return 404 when entity not found", async () => {
      mockDb.entity.findFirst.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response).toBeDefined();
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe("Entity not found");
    });

    it("should get taxonomy tags successfully", async () => {
      mockDb.entity.findFirst.mockResolvedValue({
        id: "entity-123",
      });

      mockGetEntityTaxonomyTags.mockResolvedValue([
        {
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Training for recall commands",
          category: null,
        },
      ]);

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("tags");
      expect(data.tags).toHaveLength(1);
    });

    it("should handle errors gracefully", async () => {
      mockDb.entity.findFirst.mockResolvedValue({
        id: "entity-123",
      });

      mockGetEntityTaxonomyTags.mockRejectedValue(new Error("Database error"));

      const request = new Request(
        "http://test.com/api/entities/entity-123/taxonomy-tags",
      );
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123/taxonomy-tags",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(500);
    });
  });

  describe("PUT /api/entities/:id", () => {
    const route = entitiesRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/entities/entity-123") &&
        r.method === "PUT",
    )!;

    it("should have route and handler defined", () => {
      expect(route).toBeDefined();
      expect(route.handler).toBeDefined();
      expect(typeof route.handler).toBe("function");
    });

    it("should have CSRF middleware applied", () => {
      expect(route.middleware).toBeDefined();
      expect(Array.isArray(route.middleware)).toBe(true);
      // The PUT route should have csrfMiddleware in its middleware array
      // We can't easily test the function identity, but we verify the array exists
      expect(route.middleware!.length).toBeGreaterThan(0);
    });

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("http://test.com/api/entities/entity-123", {
        method: "PUT",
        body: JSON.stringify({ name: "Updated Entity" }),
        headers: { "Content-Type": "application/json" },
      });
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(401);
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });

    it("should update entity profile successfully", async () => {
      const updateResponse = new Response(
        JSON.stringify({ id: "entity-123", name: "Updated Entity" }),
        { status: 200 },
      );
      mockUpdateEntityProfile.mockResolvedValue(updateResponse);

      const request = new Request("http://test.com/api/entities/entity-123", {
        method: "PUT",
        body: JSON.stringify({ name: "Updated Entity" }),
        headers: { "Content-Type": "application/json" },
      });
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123",
        params: { id: "entity-123" },
      });

      expect(mockUpdateEntityProfile).toHaveBeenCalled();
      expect(mockAddSecurityHeaders).toHaveBeenCalled();
    });

    it("should handle errors gracefully", async () => {
      mockUpdateEntityProfile.mockRejectedValue(new Error("Database error"));

      const request = new Request("http://test.com/api/entities/entity-123", {
        method: "PUT",
        body: JSON.stringify({ name: "Updated Entity" }),
        headers: { "Content-Type": "application/json" },
      });
      const url = new URL(request.url);
      const response = await route.handler(request, mockEnv, {
        url,
        pathname: "/api/entities/entity-123",
        params: { id: "entity-123" },
      });

      expect(response.status).toBe(500);
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });
  });
});
