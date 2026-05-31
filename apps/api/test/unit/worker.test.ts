/**
 * Unit Tests: Worker Compatibility Shim
 *
 * Tests for the compatibility shim that re-exports CorsHandler and AuthHandler
 * helpers for route files written against the old entry point.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import {
  addCorsHeaders,
  getAllowedOrigin,
  getCorsHeaders,
  handleAuthRoutes,
} from "../../src/worker.js";

// Hoist all mock variables
const {
  mockGetAllowedOrigin,
  mockAddCorsHeaders,
  mockGetCorsHeaders,
  mockHandleAuthRoutes,
} = vi.hoisted(() => {
  const mockGetAllowedOrigin = vi.fn();
  const mockAddCorsHeaders = vi.fn();
  const mockGetCorsHeaders = vi.fn();
  const mockHandleAuthRoutes = vi.fn();
  return {
    mockGetAllowedOrigin,
    mockAddCorsHeaders,
    mockGetCorsHeaders,
    mockHandleAuthRoutes,
  };
});

// Mock CorsHandler
vi.mock("../../src/lib/cors-handler", () => ({
  CorsHandler: {
    getAllowedOrigin: mockGetAllowedOrigin,
    addCorsHeaders: mockAddCorsHeaders,
    getCorsHeaders: mockGetCorsHeaders,
  },
}));

// Mock AuthHandler
vi.mock("../../src/lib/auth-handler", () => ({
  AuthHandler: {
    handleAuthRoutes: mockHandleAuthRoutes,
  },
}));

describe("Worker Compatibility Shim", () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      ENVIRONMENT: "dev",
    } as Env;

    mockGetAllowedOrigin.mockReturnValue("https://example.com");
    mockAddCorsHeaders.mockResolvedValue(new Response("OK", { status: 200 }));
    mockGetCorsHeaders.mockReturnValue({ "Access-Control-Allow-Origin": "*" });
    mockHandleAuthRoutes.mockResolvedValue(new Response("OK", { status: 200 }));
  });

  describe("Helper functions", () => {
    it("getAllowedOrigin should delegate to CorsHandler", () => {
      const request = new Request("https://api.example.com/api/test", {
        method: "GET",
      });

      const result = getAllowedOrigin(request, mockEnv);

      expect(result).toBe("https://example.com");
      expect(mockGetAllowedOrigin).toHaveBeenCalledWith(request, mockEnv);
    });

    it("addCorsHeaders should delegate to CorsHandler", async () => {
      const request = new Request("https://api.example.com/api/test", {
        method: "GET",
      });
      const response = new Response("OK", { status: 200 });

      const result = await addCorsHeaders(response, request, mockEnv);

      expect(result.status).toBe(200);
      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        response,
        request,
        mockEnv,
        undefined,
      );
    });

    it("addCorsHeaders should pass requestContext when provided", async () => {
      const request = new Request("https://api.example.com/api/test", {
        method: "GET",
      });
      const response = new Response("OK", { status: 200 });
      const requestContext = { region: "US" };

      await addCorsHeaders(response, request, mockEnv, requestContext);

      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        response,
        request,
        mockEnv,
        requestContext,
      );
    });

    it("getCorsHeaders should delegate to CorsHandler", () => {
      const request = new Request("https://api.example.com/api/test", {
        method: "GET",
      });

      const result = getCorsHeaders(request, mockEnv);

      expect(result).toEqual({ "Access-Control-Allow-Origin": "*" });
      expect(mockGetCorsHeaders).toHaveBeenCalledWith(request, mockEnv);
    });

    it("handleAuthRoutes should delegate to AuthHandler", async () => {
      const request = new Request("https://api.example.com/auth/login", {
        method: "POST",
      });
      const url = new URL(request.url);
      const rateLimiter = {} as any;
      const securityHeaders = {} as any;

      await handleAuthRoutes(
        request,
        mockEnv,
        url,
        rateLimiter,
        securityHeaders,
      );

      expect(mockHandleAuthRoutes).toHaveBeenCalledWith(
        request,
        mockEnv,
        url,
        rateLimiter,
        securityHeaders,
        undefined,
      );
    });

    it("handleAuthRoutes should pass requestContext when provided", async () => {
      const request = new Request("https://api.example.com/auth/login", {
        method: "POST",
      });
      const url = new URL(request.url);
      const rateLimiter = {} as any;
      const securityHeaders = {} as any;
      const requestContext = { region: "US" } as any;

      await handleAuthRoutes(
        request,
        mockEnv,
        url,
        rateLimiter,
        securityHeaders,
        requestContext,
      );

      expect(mockHandleAuthRoutes).toHaveBeenCalledWith(
        request,
        mockEnv,
        url,
        rateLimiter,
        securityHeaders,
        requestContext,
      );
    });
  });
});
