/**
 * Unit Tests: Map Routes
 *
 * Tests for map-related routes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { mapRoutes } from "../../../src/lib/routes/map.js";

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    constructor(env: any) {}
  },
}));

describe("Map Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
    } as Env;

    mockRequest = new Request("https://api.example.com/api/map/nearby", {
      method: "GET",
    });

    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
  });

  describe("GET /api/map/nearby", () => {
    const route = mapRoutes.find(
      (r) => r.path === "/api/map/nearby" && r.method === "GET",
    );

    it("should return 501 Not Implemented", async () => {
      const response = await route!.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(501);
      expect(body.error).toBe("Not implemented - Milestone E");
      expect(body.posts).toEqual([]);
    });

    it("should have correct route configuration", () => {
      expect(route).toBeDefined();
      expect(route!.path).toBe("/api/map/nearby");
      expect(route!.method).toBe("GET");
      expect(route!.description).toBe("Get nearby posts on map");
    });

    it("should have middleware configured", () => {
      expect(route!.middleware).toBeDefined();
      expect(Array.isArray(route!.middleware)).toBe(true);
    });
  });

  describe("Route registry", () => {
    it("should export routes array", () => {
      expect(mapRoutes).toBeDefined();
      expect(Array.isArray(mapRoutes)).toBe(true);
      expect(mapRoutes.length).toBe(1);
    });
  });
});
