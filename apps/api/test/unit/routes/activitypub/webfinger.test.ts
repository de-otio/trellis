/**
 * Unit Tests: ActivityPub WebFinger Routes
 *
 * Tests for WebFinger route handlers for actor discovery.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { webfingerRoutes } from "../../../../src/lib/routes/activitypub/webfinger.js";

// Mock handleWebFinger
const mockHandleWebFinger = vi.fn();
vi.mock("../../../../src/lib/activitypub/webfinger/server", () => ({
  handleWebFinger: (...args: any[]) => mockHandleWebFinger(...args),
}));

describe("ActivityPub WebFinger Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockRequest = new Request(
      "https://example.com/.well-known/webfinger?resource=acct:user@example.com",
      {
        method: "GET",
      },
    );

    mockHandleWebFinger.mockResolvedValue(
      new Response(JSON.stringify({ subject: "acct:user@example.com" }), {
        status: 200,
        headers: { "content-type": "application/jrd+json" },
      }),
    );
  });

  describe("GET /.well-known/webfinger - WebFinger endpoint", () => {
    const route = webfingerRoutes.find(
      (r) => r.method === "GET" && r.path === "/.well-known/webfinger",
    );

    it("should handle WebFinger request successfully", async () => {
      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockHandleWebFinger).toHaveBeenCalledWith(mockRequest, mockEnv);
      expect(response.status).toBe(200);
    });

    it("should handle errors from handleWebFinger", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Resource not found" }),
        { status: 404 },
      );
      mockHandleWebFinger.mockResolvedValue(errorResponse);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(response.status).toBe(404);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(webfingerRoutes).toHaveLength(1);
      expect(webfingerRoutes[0].method).toBe("GET");
    });

    it("should have middleware configured", () => {
      expect(webfingerRoutes[0].middleware).toBeDefined();
    });

    it("should have description", () => {
      expect(webfingerRoutes[0].description).toBeDefined();
      expect(typeof webfingerRoutes[0].description).toBe("string");
    });
  });
});
