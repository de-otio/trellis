/**
 * Unit Tests: Dashboard Routes
 *
 * Tests for dashboard route handlers including metrics, user management, and moderation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { dashboardRoutes } from "../../../src/lib/routes/dashboard.js";
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

// Hoist mock variables to avoid initialization issues
const { mockAddCorsHeaders } = vi.hoisted(() => {
  const mockAddCorsHeaders = vi.fn();
  return { mockAddCorsHeaders };
});

vi.mock("../../../src/worker", () => ({
  addCorsHeaders: mockAddCorsHeaders,
}));

// Hoist mock variables to avoid initialization issues
const {
  mockWithQueryTimeoutAndRetry,
  mockDetectRegionSync,
  mockCreatePrisma,
  mockSharedDatabaseConnectionManager,
} = vi.hoisted(() => {
  const mockWithQueryTimeoutAndRetry = vi.fn();
  const mockDetectRegionSync = vi.fn();
  const mockCreatePrisma = vi.fn();
  const mockSharedDatabaseConnectionManager = {
    getConnection: vi.fn(),
  };
  return {
    mockWithQueryTimeoutAndRetry,
    mockDetectRegionSync,
    mockCreatePrisma,
    mockSharedDatabaseConnectionManager,
  };
});

// Mock database connection manager
vi.mock("../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    STANDARD: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock region detection
vi.mock("../../../src/lib/region-detection", () => ({
  detectRegionSync: (...args: any[]) => mockDetectRegionSync(...args),
}));

// Mock database connection manager
vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: mockSharedDatabaseConnectionManager,
}));

// Mock createPrisma
vi.mock("../../../src/db", () => ({
  createPrisma: (...args: any[]) => mockCreatePrisma(...args),
}));


describe("Dashboard Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret",
      DEFAULT_REGION: "US",
    } as Env;

    mockSession = {
      userId: "user-123",
      email: "admin@example.com",
      expiresAt: Date.now() + 3600000,
    };

    mockDb = {
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
      },
      roleMetadata: {
        findMany: vi.fn(),
      },
    };

    mockGetSession.mockResolvedValue(mockSession);
    mockDetectRegionSync.mockReturnValue("US");
    mockCreatePrisma.mockReturnValue(mockDb);
    mockCreateSecureResponse.mockImplementation(
      (body, options) => new Response(body, options),
    );
    mockAddCorsHeaders.mockImplementation((response) => response);

    // Default: mockWithQueryTimeoutAndRetry executes the query function with mockDb
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (
        manager: any,
        region: string,
        env: any,
        queryFn: (db: any) => Promise<any>,
      ) => {
        return await queryFn(mockDb);
      },
    );
  });

  describe("GET /api/dashboard/metrics/users", () => {
    const route = dashboardRoutes.find(
      (r) => r.path === "/api/dashboard/metrics/users",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/dashboard/metrics/users",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Unauthorized");
    });

    it("should return 403 when user is not INTERNAL or SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request(
        "http://test.com/api/dashboard/metrics/users",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("Forbidden: Internal access required");
    });

    it("should return user metrics for INTERNAL user", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/metrics/users",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("metric");
      expect(data).toHaveProperty("value");
      expect(data).toHaveProperty("change");
      expect(data).toHaveProperty("changeType");
      expect(data).toHaveProperty("trend");
    });

    it("should return user metrics for SUPER_ADMIN user", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "SUPER_ADMIN" });

      const request = new Request(
        "http://test.com/api/dashboard/metrics/users",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("metric");
    });

    it("should handle dau metric", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/metrics/users?metric=dau",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metric).toBe("dau");
    });

    it("should handle wau metric", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/metrics/users?metric=wau",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metric).toBe("wau");
    });

    it("should handle mau metric", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/metrics/users?metric=mau",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metric).toBe("mau");
    });

    it("should handle timeRange parameter", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/metrics/users?timeRange=7d",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.trend).toHaveLength(7);
    });

    it("should handle 1y timeRange", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/metrics/users?timeRange=1y",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.trend).toHaveLength(365);
    });

    it("should handle database errors", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/dashboard/metrics/users",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe("Failed to get user metrics");
    });
  });

  describe("GET /api/dashboard/system/health", () => {
    const route = dashboardRoutes.find(
      (r) => r.path === "/api/dashboard/system/health",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/dashboard/system/health",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not INTERNAL or SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request(
        "http://test.com/api/dashboard/system/health",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(403);
    });

    it("should return system health for INTERNAL user", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });
      mockDb.user.count.mockResolvedValue(100);

      const request = new Request(
        "http://test.com/api/dashboard/system/health",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("overall");
      expect(data).toHaveProperty("services");
      expect(data.services).toHaveLength(2);
    });

    it("should detect unhealthy database", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          return await queryFn(mockDb);
        },
      );
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(async () => {
        throw new Error("Database connection failed");
      });

      const request = new Request(
        "http://test.com/api/dashboard/system/health",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.overall).toBe("degraded");
      expect(data.services[1].status).toBe("unhealthy");
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/dashboard/system/health",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/dashboard/metrics/performance", () => {
    const route = dashboardRoutes.find(
      (r) => r.path === "/api/dashboard/metrics/performance",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/dashboard/metrics/performance",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not INTERNAL or SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request(
        "http://test.com/api/dashboard/metrics/performance",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(403);
    });

    it("should return performance metrics for INTERNAL user", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/metrics/performance",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("avgResponseTime");
      expect(data).toHaveProperty("p95Latency");
      expect(data).toHaveProperty("p99Latency");
      expect(data).toHaveProperty("errorRate");
      expect(data).toHaveProperty("requestVolume");
      expect(data).toHaveProperty("trends");
    });

    it("should handle timeRange parameter", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/metrics/performance?timeRange=7d",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/dashboard/metrics/performance",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/dashboard/users", () => {
    const route = dashboardRoutes.find(
      (r) => r.path === "/api/dashboard/users" && r.method === "GET",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("http://test.com/api/dashboard/users");
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not INTERNAL or SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request("http://test.com/api/dashboard/users");
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(403);
    });

    it("should list users successfully", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });
      mockDb.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          email: "user1@example.com",
          role: "END_USER",
          suspended: false,
          createdAt: new Date("2024-01-01"),
        },
      ]);
      mockDb.user.count.mockResolvedValue(1);

      const request = new Request("http://test.com/api/dashboard/users");
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("users");
      expect(data).toHaveProperty("total");
      expect(data.users).toHaveLength(1);
    });

    it("should filter users by search query", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });
      mockDb.user.findMany.mockResolvedValue([]);
      mockDb.user.count.mockResolvedValue(0);

      const request = new Request(
        "http://test.com/api/dashboard/users?search=test@example.com",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      expect(mockDb.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.any(Array),
          }),
        }),
      );
    });

    it("should filter users by role", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });
      mockDb.user.findMany.mockResolvedValue([]);
      mockDb.user.count.mockResolvedValue(0);

      const request = new Request(
        "http://test.com/api/dashboard/users?role=END_USER",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      expect(mockDb.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: "END_USER",
          }),
        }),
      );
    });

    it("should filter users by status", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });
      mockDb.user.findMany.mockResolvedValue([]);
      mockDb.user.count.mockResolvedValue(0);

      const request = new Request(
        "http://test.com/api/dashboard/users?status=suspended",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      expect(mockDb.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            suspended: true,
          }),
        }),
      );
    });

    it("should handle pagination", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });
      mockDb.user.findMany.mockResolvedValue([]);
      mockDb.user.count.mockResolvedValue(0);

      const request = new Request(
        "http://test.com/api/dashboard/users?limit=10&offset=20",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      expect(mockDb.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 20,
        }),
      );
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request("http://test.com/api/dashboard/users");
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/dashboard/users/:id", () => {
    const route = dashboardRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/dashboard/users/user-123") &&
        r.method === "GET",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not INTERNAL or SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(403);
    });

    it("should return 400 for invalid user ID", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request("http://test.com/api/dashboard/users/");
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/",
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Invalid user ID");
    });

    it("should return user details successfully", async () => {
      mockDb.user.findUnique
        .mockResolvedValueOnce({ role: "INTERNAL" })
        .mockResolvedValueOnce({
          id: "user-123",
          email: "user@example.com",
          role: "END_USER",
          suspended: false,
          createdAt: new Date("2024-01-01"),
        });

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe("user-123");
      expect(data).toHaveProperty("stats");
    });

    it("should return 404 when user not found", async () => {
      mockDb.user.findUnique
        .mockResolvedValueOnce({ role: "INTERNAL" })
        .mockResolvedValueOnce(null);

      const request = new Request(
        "http://test.com/api/dashboard/users/nonexistent",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/nonexistent",
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe("User not found");
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(500);
    });
  });

  describe("PATCH /api/dashboard/users/:id", () => {
    const route = dashboardRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/dashboard/users/user-123") &&
        r.method === "PATCH",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
        {
          method: "PATCH",
          body: JSON.stringify({ role: "INTERNAL" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not INTERNAL or SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
        {
          method: "PATCH",
          body: JSON.stringify({ role: "INTERNAL" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(403);
    });

    it("should return 400 for invalid user ID", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request("http://test.com/api/dashboard/users/", {
        method: "PATCH",
        body: JSON.stringify({ role: "INTERNAL" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/",
      });

      expect(response.status).toBe(400);
    });

    it("should update user role successfully", async () => {
      mockDb.user.findUnique
        .mockResolvedValueOnce({ role: "INTERNAL" })
        .mockResolvedValueOnce({
          id: "user-123",
          email: "user@example.com",
          role: "INTERNAL",
          suspended: false,
          createdAt: new Date("2024-01-01"),
        });
      mockDb.user.update.mockResolvedValue({
        id: "user-123",
        email: "user@example.com",
        role: "INTERNAL",
        suspended: false,
        createdAt: new Date("2024-01-01"),
      });

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
        {
          method: "PATCH",
          body: JSON.stringify({ role: "INTERNAL" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.role).toBe("INTERNAL");
    });

    it("should update user status to suspended", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });
      mockDb.user.update.mockResolvedValue({
        id: "user-123",
        email: "user@example.com",
        role: "END_USER",
        suspended: true,
        createdAt: new Date("2024-01-01"),
      });

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
        {
          method: "PATCH",
          body: JSON.stringify({ status: "suspended" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(200);
      expect(mockDb.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            suspended: true,
          }),
        }),
      );
    });

    it("should return 400 for invalid role", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
        {
          method: "PATCH",
          body: JSON.stringify({ role: "INVALID_ROLE" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Invalid role");
    });

    it("should return 400 when no fields to update", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
        {
          method: "PATCH",
          body: JSON.stringify({}),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("No valid fields to update");
    });

    it("should return 404 when user not found", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });
      mockDb.user.update.mockRejectedValue({
        code: "P2025",
        message: "Record to update not found",
      });

      const request = new Request(
        "http://test.com/api/dashboard/users/nonexistent",
        {
          method: "PATCH",
          body: JSON.stringify({ role: "INTERNAL" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/nonexistent",
      });

      expect(response.status).toBe(404);
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
        {
          method: "PATCH",
          body: JSON.stringify({ role: "INTERNAL" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(500);
    });
  });

  describe("DELETE /api/dashboard/users/:id", () => {
    const route = dashboardRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/dashboard/users/user-123") &&
        r.method === "DELETE",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
        { method: "DELETE" },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not INTERNAL or SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
        { method: "DELETE" },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(403);
    });

    it("should return 400 when trying to delete own account", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/users/user-123",
        { method: "DELETE" },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/user-123",
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Cannot delete your own account");
    });

    it("should delete user successfully", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });
      mockDb.user.update.mockResolvedValue({});

      const request = new Request(
        "http://test.com/api/dashboard/users/other-user",
        { method: "DELETE" },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/other-user",
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(mockDb.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deletionRequestedAt: expect.any(Date),
            deletionScheduledAt: expect.any(Date),
          }),
        }),
      );
    });

    it("should return 404 when user not found", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });
      mockDb.user.update.mockRejectedValue({
        code: "P2025",
        message: "Record to update not found",
      });

      const request = new Request(
        "http://test.com/api/dashboard/users/nonexistent",
        { method: "DELETE" },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/nonexistent",
      });

      expect(response.status).toBe(404);
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/dashboard/users/other-user",
        { method: "DELETE" },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/users/other-user",
      });

      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/dashboard/moderation/posts", () => {
    const route = dashboardRoutes.find(
      (r) => r.path === "/api/dashboard/moderation/posts",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not INTERNAL or SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(403);
    });

    it("should return moderation posts list", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("posts");
      expect(data).toHaveProperty("total");
    });

    it("should handle query parameters", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts?status=pending&limit=10&offset=0",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(500);
    });
  });

  describe("POST /api/dashboard/moderation/posts/:id/action", () => {
    const route = dashboardRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/dashboard/moderation/posts/post-123/action") &&
        r.method === "POST",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts/post-123/action",
        {
          method: "POST",
          body: JSON.stringify({ action: "approve" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/moderation/posts/post-123/action",
      });

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not INTERNAL or SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts/post-123/action",
        {
          method: "POST",
          body: JSON.stringify({ action: "approve" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/moderation/posts/post-123/action",
      });

      expect(response.status).toBe(403);
    });

    it("should return 400 for invalid post ID", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts//action",
        {
          method: "POST",
          body: JSON.stringify({ action: "approve" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/moderation/posts//action",
      });

      expect(response.status).toBe(400);
    });

    it("should return 400 for invalid action", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts/post-123/action",
        {
          method: "POST",
          body: JSON.stringify({ action: "invalid" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/moderation/posts/post-123/action",
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("Invalid action");
    });

    it("should approve post successfully", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts/post-123/action",
        {
          method: "POST",
          body: JSON.stringify({ action: "approve" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/moderation/posts/post-123/action",
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.message).toContain("approved");
    });

    it("should reject post successfully", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts/post-123/action",
        {
          method: "POST",
          body: JSON.stringify({ action: "reject" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/moderation/posts/post-123/action",
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toMatch(/reject/i);
    });

    it("should delete post successfully", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts/post-123/action",
        {
          method: "POST",
          body: JSON.stringify({ action: "delete" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/moderation/posts/post-123/action",
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toContain("deleted");
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/dashboard/moderation/posts/post-123/action",
        {
          method: "POST",
          body: JSON.stringify({ action: "approve" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/dashboard/moderation/posts/post-123/action",
      });

      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/dashboard/b2b/usage/requests", () => {
    const route = dashboardRoutes.find(
      (r) => r.path === "/api/dashboard/b2b/usage/requests",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/dashboard/b2b/usage/requests",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not PARTNER", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request(
        "http://test.com/api/dashboard/b2b/usage/requests",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("Forbidden: Partner access required");
    });

    it("should return usage data for B2B_PARTNER", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        role: "B2B_PARTNER",
        partnerId: "partner-123",
      });

      const request = new Request(
        "http://test.com/api/dashboard/b2b/usage/requests",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("total");
      expect(data).toHaveProperty("timeRange");
      expect(data).toHaveProperty("trend");
      expect(data).toHaveProperty("breakdown");
    });

    it("should return usage data for PARTNER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        role: "PARTNER_ADMIN",
        partnerId: "partner-123",
      });

      const request = new Request(
        "http://test.com/api/dashboard/b2b/usage/requests",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
    });

    it("should handle timeRange parameter", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        role: "B2B_PARTNER",
        partnerId: "partner-123",
      });

      const request = new Request(
        "http://test.com/api/dashboard/b2b/usage/requests?timeRange=7d",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/dashboard/b2b/usage/requests",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/dashboard/b2b/usage/rate-limits", () => {
    const route = dashboardRoutes.find(
      (r) => r.path === "/api/dashboard/b2b/usage/rate-limits",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/dashboard/b2b/usage/rate-limits",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not PARTNER", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request(
        "http://test.com/api/dashboard/b2b/usage/rate-limits",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(403);
    });

    it("should return rate limit data for PARTNER", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "B2B_PARTNER" });

      const request = new Request(
        "http://test.com/api/dashboard/b2b/usage/rate-limits",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("limit");
      expect(data).toHaveProperty("used");
      expect(data).toHaveProperty("remaining");
      expect(data).toHaveProperty("resetAt");
      expect(data).toHaveProperty("window");
      expect(data).toHaveProperty("history");
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/dashboard/b2b/usage/rate-limits",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/dashboard/b2b/performance", () => {
    const route = dashboardRoutes.find(
      (r) => r.path === "/api/dashboard/b2b/performance",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/dashboard/b2b/performance",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not PARTNER", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request(
        "http://test.com/api/dashboard/b2b/performance",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(403);
    });

    it("should return performance data for PARTNER", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "B2B_PARTNER" });

      const request = new Request(
        "http://test.com/api/dashboard/b2b/performance",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("avgResponseTime");
      expect(data).toHaveProperty("p95Latency");
      expect(data).toHaveProperty("p99Latency");
      expect(data).toHaveProperty("errorRate");
      expect(data).toHaveProperty("successRate");
      expect(data).toHaveProperty("trends");
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/dashboard/b2b/performance",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/admin/roles", () => {
    const route = dashboardRoutes.find((r) => r.path === "/api/admin/roles")!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("http://test.com/api/admin/roles");
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request("http://test.com/api/admin/roles");
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("Forbidden: Super-admin access required");
    });

    it("should return roles list for SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "SUPER_ADMIN" });
      mockDb.roleMetadata.findMany.mockResolvedValue([
        {
          role: "END_USER",
          displayName: "End User",
          description: "Regular user",
          permissions: [],
          isActive: true,
        },
      ]);

      const request = new Request("http://test.com/api/admin/roles");
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("roles");
      expect(data.roles).toHaveLength(1);
      expect(data.roles[0]).toHaveProperty("id");
      expect(data.roles[0]).toHaveProperty("name");
      expect(data.roles[0]).toHaveProperty("description");
      expect(data.roles[0]).toHaveProperty("permissions");
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request("http://test.com/api/admin/roles");
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(500);
    });
  });

  describe("PATCH /api/admin/users/:id/role", () => {
    const route = dashboardRoutes.find(
      (r) =>
        r.path instanceof RegExp &&
        r.path.test("/api/admin/users/user-123/role") &&
        r.method === "PATCH",
    )!;

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/admin/users/user-123/role",
        {
          method: "PATCH",
          body: JSON.stringify({ role: "INTERNAL" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/admin/users/user-123/role",
      });

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/admin/users/user-123/role",
        {
          method: "PATCH",
          body: JSON.stringify({ role: "INTERNAL" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/admin/users/user-123/role",
      });

      expect(response.status).toBe(403);
    });

    it("should return 400 for invalid user ID", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "SUPER_ADMIN" });

      const request = new Request("http://test.com/api/admin/users//role", {
        method: "PATCH",
        body: JSON.stringify({ role: "INTERNAL" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/admin/users//role",
      });

      expect(response.status).toBe(400);
    });

    it("should return 400 when role is missing", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "SUPER_ADMIN" });

      const request = new Request(
        "http://test.com/api/admin/users/user-123/role",
        {
          method: "PATCH",
          body: JSON.stringify({}),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/admin/users/user-123/role",
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Role is required");
    });

    it("should return 400 for invalid role", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "SUPER_ADMIN" });

      const request = new Request(
        "http://test.com/api/admin/users/user-123/role",
        {
          method: "PATCH",
          body: JSON.stringify({ role: "INVALID_ROLE" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/admin/users/user-123/role",
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Invalid role");
    });

    it("should update user role successfully", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "SUPER_ADMIN" });
      mockDb.user.update.mockResolvedValue({
        id: "user-123",
        email: "user@example.com",
        role: "INTERNAL",
        createdAt: new Date("2024-01-01"),
      });

      const request = new Request(
        "http://test.com/api/admin/users/user-123/role",
        {
          method: "PATCH",
          body: JSON.stringify({ role: "INTERNAL" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/admin/users/user-123/role",
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.role).toBe("INTERNAL");
    });

    it("should return 404 when user not found", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "SUPER_ADMIN" });
      mockDb.user.update.mockRejectedValue({
        code: "P2025",
        message: "Record to update not found",
      });

      const request = new Request(
        "http://test.com/api/admin/users/nonexistent/role",
        {
          method: "PATCH",
          body: JSON.stringify({ role: "INTERNAL" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/admin/users/nonexistent/role",
      });

      expect(response.status).toBe(404);
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/admin/users/user-123/role",
        {
          method: "PATCH",
          body: JSON.stringify({ role: "INTERNAL" }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: "/api/admin/users/user-123/role",
      });

      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/dashboard/scaling-health", () => {
    const route = dashboardRoutes.find(
      (r) => r.path === "/api/dashboard/scaling-health",
    )!;

    it("should exist as a route", () => {
      expect(route).toBeDefined();
      expect(route.method).toBe("GET");
    });

    it("should return 401 when no session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "http://test.com/api/dashboard/scaling-health",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(401);
    });

    it("should return 403 when user is not SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "INTERNAL" });

      const request = new Request(
        "http://test.com/api/dashboard/scaling-health",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(403);
    });

    it("should return 403 for END_USER", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });

      const request = new Request(
        "http://test.com/api/dashboard/scaling-health",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(403);
    });

    it("should return 200 with scaling health for SUPER_ADMIN", async () => {
      mockDb.user.findUnique.mockResolvedValue({ role: "SUPER_ADMIN" });
      mockDb.user.count.mockResolvedValue(150);

      const request = new Request(
        "http://test.com/api/dashboard/scaling-health",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("currentPhase");
      expect(data).toHaveProperty("overallStatus");
      expect(data).toHaveProperty("indicators");
      expect(data).toHaveProperty("phases");
      expect(data).toHaveProperty("recommendations");
      expect(data).toHaveProperty("infrastructure");
      expect(data).toHaveProperty("timestamp");
    });

    it("should handle errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request(
        "http://test.com/api/dashboard/scaling-health",
      );
      const response = await route.handler(request, mockEnv);

      expect(response.status).toBe(500);
    });
  });
});
