/**
 * Unit Tests: Products Routes
 *
 * Tests for product taxonomy route handlers including adding, removing, and getting taxonomy tags.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { productTaxonomyRoutes } from "../../../src/lib/routes/products.js";
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

// Mock Validator
const mockValidateTaxonIds = vi.fn();
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    validateTaxonIds = mockValidateTaxonIds;
    sanitizeError = mockSanitizeError;
  },
}));

// Mock TaxonomyHandler
const mockAddProductTaxonomyTags = vi.fn();
const mockRemoveProductTaxonomyTags = vi.fn();
const mockGetProductTaxonomyTags = vi.fn();
vi.mock("../../../src/lib/taxonomy-handler", () => ({
  TaxonomyHandler: class {
    addProductTaxonomyTags = mockAddProductTaxonomyTags;
    removeProductTaxonomyTags = mockRemoveProductTaxonomyTags;
    getProductTaxonomyTags = mockGetProductTaxonomyTags;
    constructor(db: any, tenantId: string, kv: any) {}
  },
}));

// Mock authMiddleware
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const TEST_TENANT_ID = "tenant-test-123";

// Mock createRequestContext
const mockCreateRequestContext = vi.fn();
vi.mock("../../../src/lib/request-context", () => ({
  createRequestContext: (...args: any[]) => mockCreateRequestContext(...args),
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

// Hoist mock variables to avoid initialization issues
const { mockAddCorsHeaders } = vi.hoisted(() => {
  const mockAddCorsHeaders = vi.fn();
  return { mockAddCorsHeaders };
});

vi.mock("../../../src/lib/cors-handler", () => ({
  CorsHandler: class {
    static addCorsHeaders = mockAddCorsHeaders;
  },
}));

describe("Products Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequest: Request;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
      TAXONOMY_CACHE_KV: {} as any,
    } as any;

    mockSession = {
      userId: "user-123",
      tenantId: "tenant-123",
      expiresAt: new Date(Date.now() + 3600000),
    } as Session;

    mockDb = { query: vi.fn() };

    mockRequest = new Request(
      "https://example.com/products/product-123/taxonomy-tags",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ taxonIds: ["taxon-1", "taxon-2"] }),
      },
    );

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockApplyRateLimitKV.mockResolvedValue(null);
    mockValidateTaxonIds.mockReturnValue(["taxon-1", "taxon-2"]);

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
    mockAddCorsHeaders.mockImplementation(async (response) => response);
  });

  describe("POST /products/:productId/taxonomy-tags - Add taxonomy tags", () => {
    const route = productTaxonomyRoutes.find(
      (r) => r.method === "POST" && r.path.toString().includes("products"),
    );

    it("should add taxonomy tags successfully", async () => {
      const mockTags = [
        {
          id: "tag-1",
          taxonId: "taxon-1",
          displayName: "Tag 1",
          description: "Description 1",
          category: {
            code: "cat-1",
            displayName: "Category 1",
            dimension: {
              code: "dim-1",
              displayName: "Dimension 1",
            },
          },
        },
      ];
      mockGetProductTaxonomyTags.mockResolvedValue(mockTags);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/products/product-123/taxonomy-tags",
      });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockApplyRateLimitKV).toHaveBeenCalled();
      expect(mockAddProductTaxonomyTags).toHaveBeenCalledWith("product-123", [
        "taxon-1",
        "taxon-2",
      ]);
      expect(mockGetProductTaxonomyTags).toHaveBeenCalledWith("product-123");
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining('"tags"'),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/products/product-123/taxonomy-tags",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(mockAddProductTaxonomyTags).not.toHaveBeenCalled();
    });

    it("should handle rate limiting", async () => {
      const rateLimitResponse = new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429 },
      );
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/products/product-123/taxonomy-tags",
      });

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(rateLimitResponse);
      expect(mockAddProductTaxonomyTags).not.toHaveBeenCalled();
    });

    it("should handle errors from TaxonomyHandler", async () => {
      const error = new Error("Product not found");
      mockAddProductTaxonomyTags.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/products/product-123/taxonomy-tags",
      });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining('"error"'),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });

    it("should return 500 for non-404 errors", async () => {
      const error = new Error("Database error");
      mockAddProductTaxonomyTags.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        pathname: "/products/product-123/taxonomy-tags",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining('"error"'),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    });
  });

  describe("DELETE /products/:productId/taxonomy-tags - Remove taxonomy tags", () => {
    const route = productTaxonomyRoutes.find(
      (r) => r.method === "DELETE" && r.path.toString().includes("products"),
    );

    it("should remove taxonomy tags successfully", async () => {
      const deleteRequest = new Request(
        "https://example.com/products/product-123/taxonomy-tags",
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ taxonIds: ["taxon-1"] }),
        },
      );

      const response = await route!.handler(deleteRequest, mockEnv, {
        pathname: "/products/product-123/taxonomy-tags",
      });

      expect(mockGetSession).toHaveBeenCalledWith(deleteRequest, "test-secret", mockEnv);
      expect(mockRemoveProductTaxonomyTags).toHaveBeenCalledWith(
        "product-123",
        ["taxon-1", "taxon-2"],
      );
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ success: true }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const deleteRequest = new Request(
        "https://example.com/products/product-123/taxonomy-tags",
        {
          method: "DELETE",
        },
      );

      await route!.handler(deleteRequest, mockEnv, {
        pathname: "/products/product-123/taxonomy-tags",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockRemoveProductTaxonomyTags).not.toHaveBeenCalled();
    });

    it("should handle errors from TaxonomyHandler", async () => {
      const error = new Error("Product not found");
      mockRemoveProductTaxonomyTags.mockRejectedValue(error);

      const deleteRequest = new Request(
        "https://example.com/products/product-123/taxonomy-tags",
        {
          method: "DELETE",
          body: JSON.stringify({ taxonIds: ["taxon-1"] }),
        },
      );

      await route!.handler(deleteRequest, mockEnv, {
        pathname: "/products/product-123/taxonomy-tags",
      });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining('"error"'),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    });
  });

  describe("GET /products/:productId/taxonomy-tags - Get taxonomy tags", () => {
    const route = productTaxonomyRoutes.find(
      (r) => r.method === "GET" && r.path.toString().includes("products"),
    );

    it("should get taxonomy tags successfully", async () => {
      const mockTags = [
        {
          id: "tag-1",
          taxonId: "taxon-1",
          displayName: "Tag 1",
          description: "Description 1",
          category: null,
        },
      ];
      mockGetProductTaxonomyTags.mockResolvedValue(mockTags);

      const getRequest = new Request(
        "https://example.com/products/product-123/taxonomy-tags",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(getRequest, mockEnv, {
        pathname: "/products/product-123/taxonomy-tags",
      });

      expect(mockGetProductTaxonomyTags).toHaveBeenCalledWith("product-123");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.tags).toBeDefined();
      expect(body.count).toBe(1);
    });

    it("should handle errors from TaxonomyHandler", async () => {
      const error = new Error("Database error");
      mockGetProductTaxonomyTags.mockRejectedValue(error);

      const getRequest = new Request(
        "https://example.com/products/product-123/taxonomy-tags",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(getRequest, mockEnv, {
        pathname: "/products/product-123/taxonomy-tags",
      });

            expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it("should handle tags with category and dimension", async () => {
      const mockTags = [
        {
          id: "tag-1",
          taxonId: "taxon-1",
          displayName: "Tag 1",
          description: "Description 1",
          category: {
            code: "cat-1",
            displayName: "Category 1",
            dimension: {
              code: "dim-1",
              displayName: "Dimension 1",
            },
          },
        },
      ];
      mockGetProductTaxonomyTags.mockResolvedValue(mockTags);

      const getRequest = new Request(
        "https://example.com/products/product-123/taxonomy-tags",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(getRequest, mockEnv, {
        pathname: "/products/product-123/taxonomy-tags",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.tags[0].category).toBeDefined();
      expect(body.tags[0].category.dimension).toBeDefined();
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(productTaxonomyRoutes).toHaveLength(3);
      expect(productTaxonomyRoutes.some((r) => r.method === "POST")).toBe(true);
      expect(productTaxonomyRoutes.some((r) => r.method === "DELETE")).toBe(
        true,
      );
      expect(productTaxonomyRoutes.some((r) => r.method === "GET")).toBe(true);
    });

    it("should have middleware configured for all routes", () => {
      productTaxonomyRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      productTaxonomyRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
