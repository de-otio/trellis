/**
 * Unit Tests: Taxonomy Routes
 *
 * Tests for taxonomy API endpoints.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { taxonomyRoutes } from "../../src/lib/routes/taxonomy.js";
import { createMockRequest } from "../utils/test-helpers.js";
import { createMockEnv } from "../utils/mock-env.js";

// Mock dependencies - must be declared before vi.mock() calls
const mockGetWrappedDatabase = vi.fn();

const mockCreateRequestContext = vi.fn();

// Create mock handler instance that will be returned by TaxonomyHandler constructor
// We'll use a function to get the current instance
const getMockHandlerInstance = () => mockHandlerInstance;
let mockHandlerInstance: any = {
  getDimensions: vi.fn(),
  getDimensionByCode: vi.fn(),
  searchTaxons: vi.fn(),
  getTaxonByTaxonId: vi.fn(),
};

// Mock sanitize-html for search route
vi.mock("sanitize-html", () => ({
  default: vi.fn((text: string) => text),
}));

// Mock rate limiter
const mockRateLimiter = {
  applyRateLimitKV: vi.fn().mockResolvedValue(null),
};
vi.mock("../../src/lib/rate-limit", () => ({
  RateLimiter: class MockRateLimiter {
    constructor() {
      return mockRateLimiter;
    }
  },
}));

// Mock search metrics
const mockMetrics = {
  trackSearch: vi.fn().mockResolvedValue(undefined),
};
vi.mock("../../src/lib/taxonomy-search-metrics", () => ({
  TaxonomySearchMetrics: class MockTaxonomySearchMetrics {
    constructor() {
      return mockMetrics;
    }
  },
}));

const mockAuthMiddleware = vi.fn();
vi.mock("../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const TEST_TENANT_ID = "tenant-test-123";

vi.mock("../../src/lib/request-context", () => ({
  createRequestContext: (...args: any[]) => mockCreateRequestContext(...args),
}));

vi.mock("../../src/lib/database-wrapper-helper", () => ({
  getWrappedDatabase: vi.fn((...args: any[]) => {
    // Route handlers call getWrappedDatabase(env, request) but function expects (region, env, request)
    // Access mockDb from global scope
    const db = (globalThis as any).__mockDb__;
    return (
      db || {
        taxonomyDimension: { findMany: vi.fn(), findUnique: vi.fn() },
        taxonomyTaxon: { findMany: vi.fn(), findFirst: vi.fn() },
        $queryRawUnsafe: vi.fn(),
      }
    );
  }),
}));

vi.mock("../../src/lib/taxonomy-handler", () => {
  // Use a factory function that returns the mock instance
  const MockTaxonomyHandler = function (this: any) {
    const instance = (globalThis as any).__mockHandlerInstance__;
    if (instance) {
      // Return the mock instance directly
      return instance;
    }
    return this;
  } as any;

  // Make it work with 'new'
  MockTaxonomyHandler.prototype = {};

  return {
    TaxonomyHandler: MockTaxonomyHandler,
  };
});

describe("Taxonomy Routes", () => {
  let mockEnv: any;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = createMockEnv();
    mockDb = {
      taxonomyDimension: { findMany: vi.fn(), findUnique: vi.fn() },
      taxonomyTaxon: { findMany: vi.fn(), findFirst: vi.fn() },
      $queryRawUnsafe: vi.fn(),
    };

    mockGetWrappedDatabase.mockReturnValue(mockDb);

    // Store mockDb in global scope so mock can access it
    (globalThis as any).__mockDb__ = mockDb;

    // Create fresh mock handler instance for each test
    mockHandlerInstance = {
      getDimensions: vi.fn(),
      getDimensionByCode: vi.fn(),
      searchTaxons: vi.fn(),
      getTaxonByTaxonId: vi.fn(),
    };

    // Store in global scope so mock can access it
    (globalThis as any).__mockHandlerInstance__ = mockHandlerInstance;

    // Mock tenant context - these are called by getTenantId inside the route handler
    mockCreateRequestContext.mockResolvedValue({
      region: "US",
      session: null,
      config: {} as any,
    });

    mockAuthMiddleware.mockResolvedValue({
      userId: "user-123",
      activeTenantId: TEST_TENANT_ID,
    });

    // Reset rate limiter and metrics mocks
    mockRateLimiter.applyRateLimitKV.mockResolvedValue(null);
    mockMetrics.trackSearch.mockResolvedValue(undefined);
    mockEnv.SEARCH_METRICS_KV = {};
  });

  describe("GET /api/taxonomy/dimensions", () => {
    it("should return all dimensions", async () => {
      const mockDimensions = [
        {
          id: "dim-1",
          code: "behavior",
          displayName: "Behavior",
          order: 1,
        },
      ];

      mockHandlerInstance.getDimensions.mockResolvedValue(mockDimensions);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/dimensions",
      );
      expect(route).toBeDefined();

      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/dimensions",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv, {} as any);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.dimensions).toEqual(mockDimensions);
    });

    it("should include categories when requested", async () => {
      mockHandlerInstance.getDimensions.mockResolvedValue([]);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/dimensions",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/dimensions?includeCategories=true",
        { method: "GET" },
      );

      await route!.handler(request, mockEnv, {} as any);

      expect(mockHandlerInstance.getDimensions).toHaveBeenCalledWith({
        includeCategories: true,
        includeTaxons: false,
      });
    });

    it("should handle errors gracefully", async () => {
      mockHandlerInstance.getDimensions.mockRejectedValue(
        new Error("Database error"),
      );

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/dimensions",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/dimensions",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv, {} as any);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });

  describe("GET /api/taxonomy/dimensions/:dimensionCode", () => {
    it("should return dimension by code", async () => {
      const mockDimension = {
        id: "dim-1",
        code: "behavior",
        displayName: "Behavior",
        categories: [],
      };

      mockHandlerInstance.getDimensionByCode.mockResolvedValue(mockDimension);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/dimensions/:dimensionCode",
      );
      expect(route).toBeDefined();

      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/dimensions/behavior",
        { method: "GET" },
      );

      // Route handler expects params in nested structure
      const response = await route!.handler(request, mockEnv, {
        params: { dimensionCode: "behavior" },
      } as any);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.dimension).toEqual(mockDimension);
      expect(mockHandlerInstance.getDimensionByCode).toHaveBeenCalledWith(
        "behavior",
        {
          includeCategories: false,
          includeTaxons: false,
        },
      );
    });

    it("should return 404 when dimension not found", async () => {
      mockHandlerInstance.getDimensionByCode.mockResolvedValue(null);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/dimensions/:dimensionCode",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/dimensions/nonexistent",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        params: { dimensionCode: "nonexistent" },
      } as any);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("Dimension not found");
    });

    it("should return 400 when dimensionCode missing", async () => {
      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/dimensions/:dimensionCode",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/dimensions/",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {} as any);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Dimension code required");
    });
  });

  describe("GET /api/taxonomy/taxons/search", () => {
    beforeEach(() => {
      mockEnv.SEARCH_METRICS_KV = {};
      mockRateLimiter.applyRateLimitKV.mockResolvedValue(null);
      mockMetrics.trackSearch.mockResolvedValue(undefined);
    });

    it("should search taxons by query", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
        },
      ];

      mockHandlerInstance.searchTaxons.mockResolvedValue(mockTaxons);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/taxons/search",
      );
      expect(route).toBeDefined();

      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/taxons/search?q=recall",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {} as any);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.taxons).toHaveLength(1);
      expect(body.taxons[0]).toMatchObject({
        id: "taxon-1",
        taxonId: "behavior:training:recall",
        displayName: "Recall Training",
      });
      expect(body.query).toBe("recall");
      expect(body.count).toBe(1);
    });

    it("should filter by dimension when provided", async () => {
      mockHandlerInstance.searchTaxons.mockResolvedValue([]);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/taxons/search",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/taxons/search?q=recall&dimension=behavior",
        { method: "GET" },
      );

      await route!.handler(request, mockEnv, {} as any);

      expect(mockHandlerInstance.searchTaxons).toHaveBeenCalledWith(
        "recall",
        expect.objectContaining({
          dimension: "behavior",
        }),
      );
    });

    it("should respect limit parameter", async () => {
      mockHandlerInstance.searchTaxons.mockResolvedValue([]);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/taxons/search",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/taxons/search?q=recall&limit=10",
        { method: "GET" },
      );

      await route!.handler(request, mockEnv, {} as any);

      expect(mockHandlerInstance.searchTaxons).toHaveBeenCalledWith(
        "recall",
        expect.objectContaining({
          limit: 10,
        }),
      );
    });

    it("should cap limit at 50", async () => {
      mockHandlerInstance.searchTaxons.mockResolvedValue([]);
      // Reset mock to track calls
      mockHandlerInstance.searchTaxons.mockClear();

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/taxons/search",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/taxons/search?q=recall&limit=100",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {} as any);

      // Should succeed (limit capped by Zod)
      expect(response.status).toBe(200);

      // Zod validation caps limit at 50, and query is sanitized
      expect(mockHandlerInstance.searchTaxons).toHaveBeenCalled();
      const callArgs = mockHandlerInstance.searchTaxons.mock.calls[0];
      expect(callArgs[0]).toBe("recall"); // sanitized query (mocked to return same value)
      expect(callArgs[1]).toMatchObject({
        limit: 50, // Should be capped at 50 by Zod schema
      });
    });

    it("should return 400 when query missing", async () => {
      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/taxons/search",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/taxons/search",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {} as any);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid query parameters");
      expect(body.details).toBeDefined();
      expect(body.details.some((d: any) => d.path === "q")).toBe(true);
    });
  });

  describe("GET /api/taxonomy/taxons/:taxonId", () => {
    it("should return taxon by taxonId", async () => {
      const mockTaxon = {
        id: "taxon-1",
        taxonId: "behavior:training:recall",
        displayName: "Recall Training",
      };

      mockHandlerInstance.getTaxonByTaxonId.mockResolvedValue(mockTaxon);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/taxons/:taxonId",
      );
      expect(route).toBeDefined();

      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/taxons/behavior:training:recall",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        params: { taxonId: "behavior:training:recall" },
      } as any);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.taxon).toEqual(mockTaxon);
    });

    it("should return 404 when taxon not found", async () => {
      mockHandlerInstance.getTaxonByTaxonId.mockResolvedValue(null);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/taxons/:taxonId",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/taxons/nonexistent:taxon:id",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        params: { taxonId: "nonexistent:taxon:id" },
      } as any);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("Taxon not found");
    });

    it("should return 400 when taxonId missing", async () => {
      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/taxons/:taxonId",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/taxons/",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv, {} as any);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Taxon ID required");
    });

    it("should handle errors gracefully", async () => {
      mockHandlerInstance.getTaxonByTaxonId.mockRejectedValue(
        new Error("Database error"),
      );

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/taxons/:taxonId",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/taxons/behavior:training:recall",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        params: { taxonId: "behavior:training:recall" },
      } as any);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });

  describe("GET /api/taxonomy/dimensions with includeTaxons", () => {
    it("should include taxons when requested", async () => {
      mockHandlerInstance.getDimensions.mockResolvedValue([]);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/dimensions",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/dimensions?includeCategories=true&includeTaxons=true",
        { method: "GET" },
      );

      await route!.handler(request, mockEnv, {} as any);

      expect(mockHandlerInstance.getDimensions).toHaveBeenCalledWith({
        includeCategories: true,
        includeTaxons: true,
      });
    });
  });

  describe("GET /api/taxonomy/dimensions/:dimensionCode with include options", () => {
    it("should include categories and taxons when requested", async () => {
      const mockDimension = {
        id: "dim-1",
        code: "behavior",
        displayName: "Behavior",
        categories: [],
      };

      mockHandlerInstance.getDimensionByCode.mockResolvedValue(mockDimension);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/dimensions/:dimensionCode",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/dimensions/behavior?includeCategories=true&includeTaxons=true",
        { method: "GET" },
      );

      await route!.handler(request, mockEnv, {
        params: { dimensionCode: "behavior" },
      } as any);

      expect(mockHandlerInstance.getDimensionByCode).toHaveBeenCalledWith(
        "behavior",
        {
          includeCategories: true,
          includeTaxons: true,
        },
      );
    });

    it("should handle errors gracefully", async () => {
      mockHandlerInstance.getDimensionByCode.mockRejectedValue(
        new Error("Database error"),
      );

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/dimensions/:dimensionCode",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/dimensions/behavior",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        params: { dimensionCode: "behavior" },
      } as any);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });

  describe("GET /api/taxonomy/taxons/search edge cases", () => {
    beforeEach(() => {
      mockEnv.SEARCH_METRICS_KV = {};
      mockRateLimiter.applyRateLimitKV.mockResolvedValue(null);
      mockMetrics.trackSearch.mockResolvedValue(undefined);
    });

    it("should handle category filter", async () => {
      mockHandlerInstance.searchTaxons.mockResolvedValue([]);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/taxons/search",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/taxons/search?q=recall&category=training",
        { method: "GET" },
      );

      await route!.handler(request, mockEnv, {} as any);

      expect(mockHandlerInstance.searchTaxons).toHaveBeenCalledWith(
        "recall",
        expect.objectContaining({
          category: "training",
        }),
      );
    });

    it("should handle both dimension and category filters", async () => {
      mockHandlerInstance.searchTaxons.mockResolvedValue([]);

      const route = taxonomyRoutes.find(
        (r) => r.path === "/api/taxonomy/taxons/search",
      );
      const request = createMockRequest(
        "https://api.example.com/api/taxonomy/taxons/search?q=recall&dimension=behavior&category=training",
        { method: "GET" },
      );

      await route!.handler(request, mockEnv, {} as any);

      expect(mockHandlerInstance.searchTaxons).toHaveBeenCalledWith(
        "recall",
        expect.objectContaining({
          dimension: "behavior",
          category: "training",
        }),
      );
    });
  });
});
