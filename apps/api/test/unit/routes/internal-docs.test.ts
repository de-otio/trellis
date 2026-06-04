/**
 * Unit Tests: Internal Docs Routes
 *
 * Tests for internal documentation route handlers including navigation, dashboard, docs list, and individual docs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { internaldocsRoutes } from "../../../src/lib/routes/internal-docs.js";

// Mock InternalDocsHandler
const mockHandleGetNavigation = vi.fn();
const mockHandleGetDashboardDocs = vi.fn();
const mockHandleGetDocsList = vi.fn();
const mockHandleGetDoc = vi.fn();
vi.mock("../../../src/lib/internal-docs-handler", () => ({
  InternalDocsHandler: class {
    handleGetNavigation = mockHandleGetNavigation;
    handleGetDashboardDocs = mockHandleGetDashboardDocs;
    handleGetDocsList = mockHandleGetDocsList;
    handleGetDoc = mockHandleGetDoc;
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

// Mock addCorsHeaders
const mockAddCorsHeaders = vi.fn();
vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args),
}));

describe("Internal Docs Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockRequest = new Request("https://example.com/api/internal/docs", {
      method: "GET",
    });

    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddCorsHeaders.mockImplementation(async (response) => response);
  });

  describe("GET /api/internal/docs/navigation - Get navigation", () => {
    const route = internaldocsRoutes[0];

    it("should get navigation successfully", async () => {
      const mockResponse = new Response(JSON.stringify({ navigation: [] }), {
        status: 200,
      });
      mockHandleGetNavigation.mockResolvedValue(mockResponse);

      const request = new Request(
        "https://example.com/api/internal/docs/navigation",
        {
          method: "GET",
        },
      );

      const response = await route.handler(request, mockEnv, {
        pathname: "/api/internal/docs/navigation",
      });

      expect(mockHandleGetNavigation).toHaveBeenCalledWith(request, mockEnv);
      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        mockResponse,
        request,
        mockEnv,
      );
      expect(response.status).toBe(200);
    });
  });

  describe("GET /api/internal/docs/dashboard - Get dashboard docs", () => {
    const route = internaldocsRoutes[0];

    it("should get dashboard docs successfully", async () => {
      const mockResponse = new Response(JSON.stringify({ docs: [] }), {
        status: 200,
      });
      mockHandleGetDashboardDocs.mockResolvedValue(mockResponse);

      const request = new Request(
        "https://example.com/api/internal/docs/dashboard",
        {
          method: "GET",
        },
      );

      const response = await route.handler(request, mockEnv, {
        pathname: "/api/internal/docs/dashboard",
      });

      expect(mockHandleGetDashboardDocs).toHaveBeenCalledWith(request, mockEnv);
      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        mockResponse,
        request,
        mockEnv,
      );
      expect(response.status).toBe(200);
    });
  });

  describe("GET /api/internal/docs - Get docs list", () => {
    const route = internaldocsRoutes[0];

    it("should get docs list successfully", async () => {
      const mockResponse = new Response(JSON.stringify({ docs: [] }), {
        status: 200,
      });
      mockHandleGetDocsList.mockResolvedValue(mockResponse);

      const request = new Request("https://example.com/api/internal/docs", {
        method: "GET",
      });

      const response = await route.handler(request, mockEnv, {
        pathname: "/api/internal/docs",
      });

      expect(mockHandleGetDocsList).toHaveBeenCalledWith(request, mockEnv);
      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        mockResponse,
        request,
        mockEnv,
      );
      expect(response.status).toBe(200);
    });
  });

  describe("GET /api/internal/docs/:filename - Get individual doc", () => {
    const route = internaldocsRoutes[0];

    it("should get individual doc successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ content: "doc content" }),
        { status: 200 },
      );
      mockHandleGetDoc.mockResolvedValue(mockResponse);

      const request = new Request(
        "https://example.com/api/internal/docs/some-doc.md",
        {
          method: "GET",
        },
      );

      const response = await route.handler(request, mockEnv, {
        pathname: "/api/internal/docs/some-doc.md",
      });

      expect(mockHandleGetDoc).toHaveBeenCalledWith(
        request,
        mockEnv,
        "some-doc.md",
      );
      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        mockResponse,
        request,
        mockEnv,
      );
      expect(response.status).toBe(200);
    });

    it("should handle nested paths", async () => {
      const mockResponse = new Response(
        JSON.stringify({ content: "doc content" }),
        { status: 200 },
      );
      mockHandleGetDoc.mockResolvedValue(mockResponse);

      const request = new Request(
        "https://example.com/api/internal/docs/folder/subfolder/doc.md",
        {
          method: "GET",
        },
      );

      const response = await route.handler(request, mockEnv, {
        pathname: "/api/internal/docs/folder/subfolder/doc.md",
      });

      expect(mockHandleGetDoc).toHaveBeenCalledWith(
        request,
        mockEnv,
        "folder/subfolder/doc.md",
      );
      expect(response.status).toBe(200);
    });
  });

  describe("404 handling", () => {
    const route = internaldocsRoutes[0];

    it("should return 404 for unknown paths", async () => {
      const request = new Request(
        "https://example.com/api/internal/docs/unknown/path",
        {
          method: "POST",
        },
      );

      const response = await route.handler(request, mockEnv, {
        pathname: "/api/internal/docs/unknown/path",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(response.status).toBe(404);
    });

    it("should return 404 for non-GET methods on doc paths", async () => {
      const request = new Request(
        "https://example.com/api/internal/docs/some-doc.md",
        {
          method: "POST",
        },
      );

      const response = await route.handler(request, mockEnv, {
        pathname: "/api/internal/docs/some-doc.md",
      });

      expect(response.status).toBe(404);
      expect(mockHandleGetDoc).not.toHaveBeenCalled();
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(internaldocsRoutes).toHaveLength(1);
      expect(internaldocsRoutes[0].method).toBe("*");
    });

    it("should have middleware configured", () => {
      expect(internaldocsRoutes[0].middleware).toBeDefined();
    });

    it("should have description", () => {
      expect(internaldocsRoutes[0].description).toBeDefined();
      expect(typeof internaldocsRoutes[0].description).toBe("string");
    });
  });
});
