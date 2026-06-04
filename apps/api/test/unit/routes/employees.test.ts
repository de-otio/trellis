/**
 * Unit Tests: Employees Routes
 *
 * Tests for employee route handlers including getting employee lists.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { employeesRoutes } from "../../../src/lib/routes/employees.js";
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

// Mock Validator
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));

// Mock createPrisma
const mockCreatePrisma = vi.fn();
vi.mock("../../../src/db", () => ({
  createPrisma: (...args: any[]) => mockCreatePrisma(...args),
}));

// Mock authMiddleware (used for B2B_PARTNER/PARTNER_ADMIN paths)
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
  requireActiveTenant: vi.fn().mockReturnValue(null),
}));


describe("Employees Routes", () => {
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
      tenantId: "tenant-123",
      expiresAt: new Date(Date.now() + 3600000),
    } as Session;

    mockRequest = new Request("https://example.com/api/employees", {
      method: "GET",
    });

    mockDb = {
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      tenantMember: {
        findMany: vi.fn(),
      },
    };

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockCreatePrisma.mockReturnValue(mockDb);
    // Default: no JWT / no active tenant
    mockAuthMiddleware.mockResolvedValue(null);
  });

  describe("GET /api/employees - Get employees list", () => {
    const route = employeesRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/employees",
    );

    it("should get employees for INTERNAL role successfully", async () => {
      const mockUser = {
        id: "user-123",
        role: "INTERNAL",
      };
      const mockEmployees = [
        {
          id: "emp-1",
          email: "emp1@test.example.com",
          handle: "emp1",
          actorUri: "https://example.com/users/emp1",
        },
        { id: "emp-2", email: "emp2@test.example.com", handle: null, actorUri: null },
      ];

      mockDb.user.findUnique.mockResolvedValue(mockUser);
      mockDb.user.findMany.mockResolvedValue(mockEmployees);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockDb.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user-123" },
        select: { role: true },
      });
      expect(mockDb.user.findMany).toHaveBeenCalledWith({
        where: { role: "INTERNAL" },
        select: { id: true, email: true, handle: true, actorUri: true },
        orderBy: { email: "asc" },
      });
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining('"friends"'),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
      expect(response.status).toBe(200);
    });

    it("should return 401 for B2B_PARTNER without active tenant context (no JWT)", async () => {
      // B2B_PARTNER without a JWT → no activeTenantId → 401 (auth missing)
      const mockUser = {
        id: "user-123",
        role: "B2B_PARTNER",
      };

      mockDb.user.findUnique.mockResolvedValue(mockUser);

      // Request has no Authorization header → authMiddleware returns null
      const response = await route!.handler(mockRequest, mockEnv);
      expect(response.status).toBe(401);
    });

    it("should return 401 for PARTNER_ADMIN without active tenant context (no JWT)", async () => {
      const mockUser = {
        id: "user-123",
        role: "PARTNER_ADMIN",
      };

      mockDb.user.findUnique.mockResolvedValue(mockUser);

      const response = await route!.handler(mockRequest, mockEnv);
      expect(response.status).toBe(401);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    });

    it("should return 404 when user is not found", async () => {
      mockDb.user.findUnique.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "User not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
      expect(mockDb.user.findMany).not.toHaveBeenCalled();
    });

    it("should return 403 for unauthorized roles", async () => {
      const mockUser = {
        id: "user-123",
        role: "USER",
        partnerId: null,
      };

      mockDb.user.findUnique.mockResolvedValue(mockUser);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Forbidden"),
        { status: 403, headers: { "content-type": "application/json" } },
      );
      expect(mockDb.user.findMany).not.toHaveBeenCalled();
    });

    it("should return 401 for B2B_PARTNER without active tenant (no JWT)", async () => {
      const mockUser = {
        id: "user-123",
        role: "B2B_PARTNER",
      };

      mockDb.user.findUnique.mockResolvedValue(mockUser);
      // No Authorization header → authMiddleware returns null → no activeTenantId
      mockAuthMiddleware.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });

    it("should format employees correctly", async () => {
      const mockUser = {
        id: "user-123",
        role: "INTERNAL",
        partnerId: null,
      };
      const mockEmployees = [
        {
          id: "emp-1",
          email: "emp1@example.com",
          handle: "emp1",
          actorUri: "https://example.com/users/emp1",
        },
        { id: "emp-2", email: "emp2@example.com", handle: null, actorUri: null },
      ];

      mockDb.user.findUnique.mockResolvedValue(mockUser);
      mockDb.user.findMany.mockResolvedValue(mockEmployees);

      const response = await route!.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(body.friends).toHaveLength(2);
      expect(body.friends[0]).toEqual({
        id: "emp-1",
        email: "emp1@example.com",
        actorUri: "https://example.com/users/emp1",
        handle: "emp1",
        status: "ACCEPTED",
      });
      expect(body.friends[1]).toEqual({
        id: "emp-2",
        email: "emp2@example.com",
        actorUri: undefined,
        handle: undefined,
        status: "ACCEPTED",
      });
    });

    it("should handle database errors", async () => {
      const error = new Error("Database error");
      mockDb.user.findUnique.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv);

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining('"error"'),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(employeesRoutes).toHaveLength(1);
      expect(employeesRoutes[0].method).toBe("GET");
    });

    it("should have middleware configured", () => {
      expect(employeesRoutes[0].middleware).toBeDefined();
    });

    it("should have description", () => {
      expect(employeesRoutes[0].description).toBeDefined();
      expect(typeof employeesRoutes[0].description).toBe("string");
    });
  });
});
