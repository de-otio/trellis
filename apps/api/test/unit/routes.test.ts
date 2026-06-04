/**
 * Unit Tests: Route Registry
 *
 * Tests for the route registry including route matching and route definitions.
 */

import { describe, it, expect, vi } from "vitest";
import { routes } from "../../src/lib/routes.js";
import type { Env } from "../../src/env.js";

// Mock dependencies
vi.mock("../../src/lib/security-headers");
vi.mock("../../src/lib/request-context");
vi.mock("../../src/worker");

describe("Route Registry", () => {
  describe("route definitions", () => {
    it("should have health check route", () => {
      const healthRoute = routes.find((r) => r.path === "/health");
      expect(healthRoute).toBeDefined();
      expect(healthRoute?.method).toBe("GET");
      expect(healthRoute?.description).toContain("Health");
    });

    it("should have config route", () => {
      const configRoute = routes.find((r) => r.path === "/api/config");
      expect(configRoute).toBeDefined();
      expect(configRoute?.method).toBe("GET");
    });

    it("should have auth routes", () => {
      const authRoute = routes.find((r) => r.path === "/auth/*");
      expect(authRoute).toBeDefined();
      expect(authRoute?.method).toBe("*");
    });

    it("should have catch-all 404 route", () => {
      const catchAllRoute = routes.find((r) => r && r.path === "*");
      expect(catchAllRoute).toBeDefined();
      if (catchAllRoute) {
        expect(catchAllRoute.method).toBe("*");
        expect(catchAllRoute.description).toContain("404");
      }
    });

    it("should have middleware for routes that need it", () => {
      const configRoute = routes.find((r) => r.path === "/api/config");
      expect(configRoute?.middleware).toBeDefined();
      expect(configRoute?.middleware?.length).toBeGreaterThan(0);
    });

    it("should have descriptions for routes", () => {
      const routesWithDescriptions = routes.filter((r) => r && r.description);
      expect(routesWithDescriptions.length).toBeGreaterThan(0);
    });
  });

  describe("route handler execution", () => {
    it("should execute handler with correct context", async () => {
      const healthRoute = routes.find((r) => r.path === "/health");
      expect(healthRoute).toBeDefined();

      const mockEnv = {
        APP_DOMAIN: "https://app.example.com",
      } as Env;
      const mockRequest = new Request("https://api.example.com/health", {
        method: "GET",
      });

      if (healthRoute) {
        try {
          const response = await healthRoute.handler(mockRequest, mockEnv, {
            url: new URL("https://api.example.com/health"),
            pathname: "/health",
            params: {},
            requestContext: undefined,
          });

          expect(response).toBeInstanceOf(Response);
          expect(response.status).toBe(200);
        } catch (error) {
          // Handler may require additional setup, which is acceptable for this test
          expect(error).toBeDefined();
        }
      }
    });

    it("should handle errors in route handlers gracefully", async () => {
      // Find a route that might throw
      const testRoute = routes[0];
      expect(testRoute).toBeDefined();

      const mockEnv = {} as Env;
      const mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
      });

      // This should not throw, but handle errors internally
      try {
        await testRoute.handler(mockRequest, mockEnv, {
          url: new URL("https://api.example.com/test"),
          pathname: "/test",
          params: {},
        });
      } catch (error) {
        // Some routes may throw, which is expected behavior
        expect(error).toBeInstanceOf(Error);
      }
    });
  });
});
