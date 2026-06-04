/**
 * Unit Tests: Taxonomy Analytics Routes
 *
 * Tests for taxonomy analytics route handlers including metrics, pruning candidates, and free-form tags.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { taxonomyAnalyticsRoutes } from "../../../src/lib/routes/taxonomy-analytics.js";
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

// Mock TaxonomyMetrics
const mockGetTaxonMetrics = vi.fn();
const mockCheckPruningCandidates = vi.fn();
const mockGetPopularFreeFormTags = vi.fn();
vi.mock("../../../src/lib/taxonomy-metrics", () => ({
  TaxonomyMetrics: class {
    getTaxonMetrics = mockGetTaxonMetrics;
    checkPruningCandidates = mockCheckPruningCandidates;
    getPopularFreeFormTags = mockGetPopularFreeFormTags;
    constructor(db: any) {}
  },
}));

// Mock getWrappedDatabase
const mockGetWrappedDatabase = vi.fn();
vi.mock("../../../src/lib/database-wrapper-helper", () => ({
  getWrappedDatabase: (...args: any[]) => mockGetWrappedDatabase(...args),
}));

// Mock detectRegionSync
const mockDetectRegionSync = vi.fn();
vi.mock("../../../src/lib/region-detection", () => ({
  detectRegionSync: (...args: any[]) => mockDetectRegionSync(...args),
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

describe("Taxonomy Analytics Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequest: Request;
  let mockDb: any;

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

    mockDb = { query: vi.fn() };

    mockRequest = new Request("https://example.com/api/taxonomy/metrics", {
      method: "GET",
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });

    mockAuthMiddleware.mockResolvedValue({
      userId: "user-123",
      activeTenantId: TEST_TENANT_ID,
    });
    mockCreateRequestContext.mockResolvedValue({
      region: "us-east-1",
      session: mockSession,
    });
    mockGetWrappedDatabase.mockReturnValue(mockDb);
    mockDetectRegionSync.mockReturnValue("us-east-1");
  });

  describe("GET /api/taxonomy/metrics - Get taxonomy usage metrics", () => {
    const route = taxonomyAnalyticsRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/taxonomy/metrics",
    );

    it("should get taxonomy metrics successfully", async () => {
      const mockMetrics = [
        { taxonId: "taxon-1", usageCount: 10 },
        { taxonId: "taxon-2", usageCount: 5 },
      ];
      mockGetTaxonMetrics.mockResolvedValue(mockMetrics);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockGetTaxonMetrics).toHaveBeenCalledWith(TEST_TENANT_ID, {
        dimension: undefined,
        minUsageCount: 0,
        includeUnused: true,
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.metrics).toEqual(mockMetrics);
      expect(body.count).toBe(2);
    });

    it("should parse query parameters correctly", async () => {
      const url = new URL(
        "https://example.com/api/taxonomy/metrics?dimension=dim-1&minUsageCount=5&includeUnused=false",
      );
      const request = new Request(url.toString(), { method: "GET" });
      mockGetTaxonMetrics.mockResolvedValue([]);

      await route!.handler(request, mockEnv);

      expect(mockGetTaxonMetrics).toHaveBeenCalledWith(TEST_TENANT_ID, {
        dimension: "dim-1",
        minUsageCount: 5,
        includeUnused: false,
      });
    });

    it("should handle errors", async () => {
      const error = new Error("Database error");
      mockGetTaxonMetrics.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv);

            expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Database error");
    });
  });

  describe("GET /api/taxonomy/pruning-candidates - Get pruning candidates", () => {
    const route = taxonomyAnalyticsRoutes.find(
      (r) =>
        r.method === "GET" && r.path === "/api/taxonomy/pruning-candidates",
    );

    it("should get pruning candidates successfully", async () => {
      const mockCandidates = [
        { taxonId: "taxon-1", usageCount: 0 },
        { taxonId: "taxon-2", usageCount: 1 },
      ];
      mockCheckPruningCandidates.mockResolvedValue(mockCandidates);

      const request = new Request(
        "https://example.com/api/taxonomy/pruning-candidates",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(
        request,
        "test-secret",
        mockEnv,
      );
      expect(mockCheckPruningCandidates).toHaveBeenCalledWith(TEST_TENANT_ID);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining('"candidates"'),
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
        "https://example.com/api/taxonomy/pruning-candidates",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockCheckPruningCandidates).not.toHaveBeenCalled();
    });

    it("should handle errors", async () => {
      const error = new Error("Database error");
      mockCheckPruningCandidates.mockRejectedValue(error);

      const request = new Request(
        "https://example.com/api/taxonomy/pruning-candidates",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv);

            expect(response.status).toBe(500);
    });
  });

  describe("GET /api/taxonomy/free-form-tags - Get popular free-form tags", () => {
    const route = taxonomyAnalyticsRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/taxonomy/free-form-tags",
    );

    it("should get popular free-form tags successfully", async () => {
      const mockTags = [
        { tag: "tag-1", count: 10 },
        { tag: "tag-2", count: 5 },
      ];
      mockGetPopularFreeFormTags.mockResolvedValue(mockTags);

      const request = new Request(
        "https://example.com/api/taxonomy/free-form-tags",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv);

      expect(mockGetPopularFreeFormTags).toHaveBeenCalledWith(
        TEST_TENANT_ID,
        100,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.tags).toEqual(mockTags);
      expect(body.count).toBe(2);
    });

    it("should parse limit query parameter", async () => {
      const url = new URL(
        "https://example.com/api/taxonomy/free-form-tags?limit=50",
      );
      const request = new Request(url.toString(), { method: "GET" });
      mockGetPopularFreeFormTags.mockResolvedValue([]);

      await route!.handler(request, mockEnv);

      expect(mockGetPopularFreeFormTags).toHaveBeenCalledWith(TEST_TENANT_ID, 50);
    });

    it("should cap limit at 500", async () => {
      const url = new URL(
        "https://example.com/api/taxonomy/free-form-tags?limit=1000",
      );
      const request = new Request(url.toString(), { method: "GET" });
      mockGetPopularFreeFormTags.mockResolvedValue([]);

      await route!.handler(request, mockEnv);

      expect(mockGetPopularFreeFormTags).toHaveBeenCalledWith(
        TEST_TENANT_ID,
        500,
      );
    });

    it("should handle errors", async () => {
      const error = new Error("Database error");
      mockGetPopularFreeFormTags.mockRejectedValue(error);

      const request = new Request(
        "https://example.com/api/taxonomy/free-form-tags",
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
      expect(taxonomyAnalyticsRoutes).toHaveLength(3);
      expect(taxonomyAnalyticsRoutes.every((r) => r.method === "GET")).toBe(
        true,
      );
    });

    it("should have middleware configured for all routes", () => {
      taxonomyAnalyticsRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      taxonomyAnalyticsRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
