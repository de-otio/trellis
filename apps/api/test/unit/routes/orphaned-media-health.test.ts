/**
 * Unit Tests: Orphaned Media Health Routes
 *
 * Tests for orphaned media health check and backlog size endpoints.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { orphanedMediaHealthRoutes } from "../../../src/lib/routes/orphaned-media-health.js";

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

// Mock OrphanedMediaMonitor
const mockCheckHealth = vi.fn();
const mockGetBacklogSize = vi.fn();
vi.mock("../../../src/lib/scheduled/orphaned-media-monitor", () => ({
  OrphanedMediaMonitor: class {
    checkHealth = mockCheckHealth;
    getBacklogSize = mockGetBacklogSize;
    constructor(env: any) {}
  },
}));

describe("Orphaned Media Health Routes", () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
    } as any;

    mockCreateSecureResponse.mockImplementation(
      (body, options) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((response) => response);
  });

  describe("GET /api/admin/orphaned-media/health - Health status", () => {
    const route = orphanedMediaHealthRoutes.find(
      (r) =>
        r.path === "/api/admin/orphaned-media/health" && r.method === "GET",
    );

    it("should return healthy status with 200", async () => {
      const healthData = {
        healthy: true,
        lastRun: "2026-03-21T00:00:00.000Z",
        hoursSinceLastRun: 2,
        backlogEstimate: 5,
        errorRate: 0,
        issues: [],
      };
      mockCheckHealth.mockResolvedValue(healthData);

      const request = new Request(
        "https://example.com/api/admin/orphaned-media/health",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/orphaned-media/health",
      });

      expect(mockCheckHealth).toHaveBeenCalledWith(mockEnv);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.healthy).toBe(true);
    });

    it("should return unhealthy status with 503", async () => {
      const healthData = {
        healthy: false,
        lastRun: null,
        hoursSinceLastRun: null,
        backlogEstimate: 1000,
        errorRate: 0.5,
        issues: ["No recent cleanup run"],
      };
      mockCheckHealth.mockResolvedValue(healthData);

      const request = new Request(
        "https://example.com/api/admin/orphaned-media/health",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/orphaned-media/health",
      });

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.healthy).toBe(false);
      expect(body.issues).toContain("No recent cleanup run");
    });

    it("should return 500 on monitor error", async () => {
      mockCheckHealth.mockRejectedValue(new Error("Monitor failed"));

      const request = new Request(
        "https://example.com/api/admin/orphaned-media/health",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/orphaned-media/health",
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.healthy).toBe(false);
      expect(body.error).toBe("Health check failed");
          });

    it("should include Cache-Control header for healthy response", async () => {
      mockCheckHealth.mockResolvedValue({ healthy: true });

      const request = new Request(
        "https://example.com/api/admin/orphaned-media/health",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/orphaned-media/health",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: 200,
          headers: expect.objectContaining({
            "Cache-Control": "no-cache, no-store, must-revalidate",
          }),
        }),
      );
    });
  });

  describe("GET /api/admin/orphaned-media/backlog - Backlog size", () => {
    const route = orphanedMediaHealthRoutes.find(
      (r) =>
        r.path === "/api/admin/orphaned-media/backlog" && r.method === "GET",
    );

    it("should return backlog size successfully", async () => {
      const backlogData = {
        orphanedCount: 10,
        softDeletedCount: 5,
      };
      mockGetBacklogSize.mockResolvedValue(backlogData);

      const request = new Request(
        "https://example.com/api/admin/orphaned-media/backlog",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/orphaned-media/backlog",
      });

      expect(mockGetBacklogSize).toHaveBeenCalledWith(mockEnv);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.orphanedCount).toBe(10);
      expect(body.softDeletedCount).toBe(5);
      expect(body.timestamp).toBeDefined();
    });

    it("should return 500 on backlog check error", async () => {
      mockGetBacklogSize.mockRejectedValue(new Error("Database error"));

      const request = new Request(
        "https://example.com/api/admin/orphaned-media/backlog",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/orphaned-media/backlog",
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Backlog check failed");
          });

    it("should include Cache-Control header", async () => {
      mockGetBacklogSize.mockResolvedValue({
        orphanedCount: 0,
        softDeletedCount: 0,
      });

      const request = new Request(
        "https://example.com/api/admin/orphaned-media/backlog",
        { method: "GET" },
      );

      await route!.handler(request, mockEnv, {
        pathname: "/api/admin/orphaned-media/backlog",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Cache-Control": "no-cache, no-store, must-revalidate",
          }),
        }),
      );
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(orphanedMediaHealthRoutes).toHaveLength(2);
      expect(
        orphanedMediaHealthRoutes.every((r) => r.method === "GET"),
      ).toBe(true);
    });

    it("should have middleware configured for all routes", () => {
      orphanedMediaHealthRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have empty middleware (admin routes)", () => {
      orphanedMediaHealthRoutes.forEach((route) => {
        expect(route.middleware).toEqual([]);
      });
    });

    it("should have descriptions for all routes", () => {
      orphanedMediaHealthRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
