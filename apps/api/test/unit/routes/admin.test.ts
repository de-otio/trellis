/**
 * Unit Tests: Admin Routes
 *
 * Tests for admin route handlers including test user management, super-admin endpoints,
 * feature toggles, domain management, and reports.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { adminRoutes } from "../../../src/lib/routes/admin.js";
import type { Session } from "../../../src/lib/session-cookie.js";

// Mock SessionManager
const mockGetSession = vi.fn();
const mockSetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
    setSession = mockSetSession;
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

// Hoist mock variables to avoid initialization issues
const { mockAddCorsHeaders } = vi.hoisted(() => {
  const mockAddCorsHeaders = vi.fn();
  return { mockAddCorsHeaders };
});

vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args),
}));

// Mock DataRouter
const mockCreateUser = vi.fn();
const mockGetDatabaseForRegion = vi.fn();
vi.mock("../../../src/lib/data-router", () => ({
  DataRouter: {
    createUser: (...args: any[]) => mockCreateUser(...args),
    getDatabaseForRegion: (...args: any[]) => mockGetDatabaseForRegion(...args),
  },
}));

// Mock createPrisma
const mockCreatePrisma = vi.fn();
vi.mock("../../../src/db", () => ({
  createPrisma: (...args: any[]) => mockCreatePrisma(...args),
}));

// Mock detectRegionSync
const mockDetectRegionSync = vi.fn();
vi.mock("../../../src/lib/region-detection", () => ({
  detectRegionSync: (...args: any[]) => mockDetectRegionSync(...args),
}));

// Hoist mock variables to avoid initialization issues
const { mockSharedDatabaseConnectionManager, mockExecuteWithRetry } =
  vi.hoisted(() => {
    const mockExecuteWithRetry = vi.fn();
    const mockSharedDatabaseConnectionManager = {
      getConnection: vi.fn(),
      executeWithRetry: mockExecuteWithRetry,
    };
    return { mockSharedDatabaseConnectionManager, mockExecuteWithRetry };
  });

vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: mockSharedDatabaseConnectionManager,
}));

// Mock withQueryTimeoutAndRetry
const mockWithQueryTimeoutAndRetry = vi.fn();
vi.mock("../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 1000, retryTimeoutMs: 1000 },
    STANDARD: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock FeatureToggleService
const mockGetAllToggles = vi.fn();
const mockGetToggle = vi.fn();
const mockSetToggle = vi.fn();
vi.mock("../../../src/lib/feature-toggle-service", () => ({
  FeatureToggleService: class {
    getAllToggles = mockGetAllToggles;
    getToggle = mockGetToggle;
    setToggle = mockSetToggle;
    constructor(db: any) {}
  },
}));

// Mock getAppVersion
const mockGetAppVersion = vi.fn();
vi.mock("../../../src/lib/version", () => ({
  getAppVersion: (...args: any[]) => mockGetAppVersion(...args),
}));


// Mock rateLimitAdminFeatureToggleAPI and rateLimitFeatureToggleAPI
const mockRateLimitAdminFeatureToggleAPI = vi.fn();
const mockRateLimitFeatureToggleAPI = vi.fn();
vi.mock("../../../src/lib/middleware/feature-toggle-rate-limit", () => ({
  rateLimitAdminFeatureToggleAPI: (...args: any[]) =>
    mockRateLimitAdminFeatureToggleAPI(...args),
  rateLimitFeatureToggleAPI: (...args: any[]) =>
    mockRateLimitFeatureToggleAPI(...args),
  createRateLimitErrorResponse: vi.fn(),
}));

// Mock validateBody, validatePathParam, validateQuery
const mockValidateBody = vi.fn();
const mockValidatePathParam = vi.fn();
const mockValidateQuery = vi.fn();
vi.mock("../../../src/lib/validation/validate-request", () => ({
  validateBody: (...args: any[]) => mockValidateBody(...args),
  validatePathParam: (...args: any[]) => mockValidatePathParam(...args),
  validateQuery: (...args: any[]) => mockValidateQuery(...args),
  ValidationError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ValidationError";
    }
    toResponse() {
      return { error: this.message };
    }
    getStatusCode() {
      return 400;
    }
  },
}));

// Mock DomainReputationService
const { mockBlockDomain, mockUnblockDomain, mockUpdateReputation } = vi.hoisted(
  () => {
    const mockBlockDomain = vi.fn();
    const mockUnblockDomain = vi.fn();
    const mockUpdateReputation = vi.fn();
    return { mockBlockDomain, mockUnblockDomain, mockUpdateReputation };
  },
);

vi.mock("../../../src/lib/domain-reputation-service", () => ({
  DomainReputationService: class {
    blockDomain = mockBlockDomain;
    unblockDomain = mockUnblockDomain;
    updateReputation = mockUpdateReputation;
    constructor(env: any) {}
  },
}));

describe("Admin Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequest: Request;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
      CI: "false",
    } as any;

    mockSession = {
      userId: "user-123",
      tenantId: "tenant-123",
      expiresAt: new Date(Date.now() + 3600000),
    } as Session;

    mockDb = {
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      postComment: {
        findMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      post: {
        findMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      entity: {
        findMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      entityOwnership: {
        deleteMany: vi.fn(),
      },
      directMessage: {
        deleteMany: vi.fn(),
      },
      customAudience: {
        deleteMany: vi.fn(),
      },
      customAudienceMember: {
        deleteMany: vi.fn(),
      },
      securityEvent: {
        deleteMany: vi.fn(),
      },
      consent: {
        deleteMany: vi.fn(),
      },
      invitation: {
        deleteMany: vi.fn(),
      },
      commentSentiment: {
        deleteMany: vi.fn(),
      },
      postSentiment: {
        deleteMany: vi.fn(),
      },
      postCommentMedia: {
        deleteMany: vi.fn(),
      },
      postSubject: {
        deleteMany: vi.fn(),
      },
      postTaxonomyTag: {
        deleteMany: vi.fn(),
      },
      postMedia: {
        deleteMany: vi.fn(),
      },
      entityTaxonomyTag: {
        deleteMany: vi.fn(),
      },
    };

    mockRequest = new Request("https://example.com/api/admin/test/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "test@test.example.com" }),
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockSetSession.mockImplementation(async (response) => response);
    mockAddCorsHeaders.mockImplementation(async (response) => response);
    mockDetectRegionSync.mockReturnValue("US");
    mockCreatePrisma.mockReturnValue(mockDb);
    mockRateLimitFeatureToggleAPI.mockResolvedValue({
      allowed: true,
      headers: {},
    });
    mockValidatePathParam.mockImplementation((schema, value) => value);
    mockValidateQuery.mockImplementation((schema, params) => ({
      success: true,
      data: params,
    }));
    mockGetDatabaseForRegion.mockReturnValue(mockDb);
    mockBlockDomain.mockResolvedValue(undefined);
    mockUnblockDomain.mockResolvedValue(undefined);
    mockUpdateReputation.mockResolvedValue(undefined);
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (db, region, env, fn) => {
        return await fn(mockDb);
      },
    );
    mockRateLimitAdminFeatureToggleAPI.mockResolvedValue({ allowed: true });
  });

  describe("POST /api/admin/test/users - Create test user", () => {
    const route = adminRoutes.find(
      (r) => r.method === "POST" && r.path === "/api/admin/test/users",
    );

    it("should create test user successfully in dev environment", async () => {
      const mockUser = {
        id: "user-123",
        email: "test@test.example.com",
        role: "END_USER",
        region: "US",
        dataRegion: "US",
      };
      mockCreateUser.mockResolvedValue(mockUser);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockCreateUser).toHaveBeenCalled();
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining('"success":true'),
        {
          status: 201,
          headers: { "content-type": "application/json" },
        },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(response.status).toBe(201);
    });

    it("should return 403 in production environment", async () => {
      const prodEnv = { ...mockEnv, STAGE: "prod" };

      const response = await route!.handler(mockRequest, prodEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Forbidden"),
        { status: 403, headers: { "content-type": "application/json" } },
      );
      expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it("should check SUPER_ADMIN role for non-test users", async () => {
      const nonTestRequest = new Request(
        "https://example.com/api/admin/test/users",
        {
          method: "POST",
          body: JSON.stringify({ email: "real@example.com" }),
        },
      );
      const mockUser = { role: "SUPER_ADMIN" };
      mockDb.user.findUnique.mockResolvedValue(mockUser);
      mockCreateUser.mockResolvedValue({
        id: "user-123",
        email: "real@example.com",
      });

      await route!.handler(nonTestRequest, mockEnv);

      expect(mockDb.user.findUnique).toHaveBeenCalled();
    });

    it("should handle errors", async () => {
      const error = new Error("Database error");
      mockCreateUser.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv);

            expect(response.status).toBe(500);
    });
  });

  describe("DELETE /api/admin/test/users/:userId - Delete test user", () => {
    const route = adminRoutes.find(
      (r) => r.method === "DELETE" && r.path.toString().includes("test/users"),
    );

    it("should delete test user successfully", async () => {
      // Set CI mode to allow unauthenticated access
      const ciEnv = { ...mockEnv, CI: "true" };
      mockDb.postComment.findMany.mockResolvedValue([]);
      mockDb.post.findMany.mockResolvedValue([]);
      mockDb.entity.findMany.mockResolvedValue([]);
      mockDb.user.delete.mockResolvedValue({ id: "user-123" });
      // deleteUserData needs deleteMany to return { count: N }
      for (const model of [mockDb.commentSentiment, mockDb.postSentiment, mockDb.postComment, mockDb.post, mockDb.entity, mockDb.entityOwnership, mockDb.postSubject, mockDb.directMessage, mockDb.customAudienceMember, mockDb.customAudience, mockDb.securityEvent, mockDb.consent, mockDb.invitation]) {
        model.deleteMany.mockResolvedValue({ count: 0 });
      }
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (db, region, env, fn) => {
          return await fn(mockDb);
        },
      );

      const deleteRequest = new Request(
        "https://example.com/api/admin/test/users/user-123",
        {
          method: "DELETE",
        },
      );

      const response = await route!.handler(deleteRequest, ciEnv, {
        pathname: "/api/admin/test/users/user-123",
      });

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining('"success":true'),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
      expect(response.status).toBe(200);
    });

    it("should return 403 in production environment", async () => {
      const prodEnv = { ...mockEnv, STAGE: "prod" };
      const deleteRequest = new Request(
        "https://example.com/api/admin/test/users/user-123",
        {
          method: "DELETE",
        },
      );

      const response = await route!.handler(deleteRequest, prodEnv, {
        pathname: "/api/admin/test/users/user-123",
      });

      expect(response.status).toBe(403);
      expect(mockDb.user.delete).not.toHaveBeenCalled();
    });

    it("should handle user not found gracefully", async () => {
      // Set CI mode to allow unauthenticated access
      const ciEnv = { ...mockEnv, CI: "true" };
      const error = new Error("Record to delete does not exist");
      mockDb.postComment.findMany.mockResolvedValue([]);
      mockDb.post.findMany.mockResolvedValue([]);
      mockDb.entity.findMany.mockResolvedValue([]);
      mockDb.user.delete.mockRejectedValue(error);
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (db, region, env, fn) => {
          return await fn(mockDb);
        },
      );

      const deleteRequest = new Request(
        "https://example.com/api/admin/test/users/user-123",
        {
          method: "DELETE",
        },
      );

      const response = await route!.handler(deleteRequest, ciEnv, {
        pathname: "/api/admin/test/users/user-123",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toContain("already deleted");
    });
  });

  describe("GET /api/admin/super-admin/check - Check super admin status", () => {
    const route = adminRoutes.find(
      (r) => r.method === "*" && r.path === "/api/admin/super-admin/*",
    );

    it("should return true for SUPER_ADMIN user", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        role: "SUPER_ADMIN",
        email: "admin@example.com",
      });

      const request = new Request(
        "https://example.com/api/admin/super-admin/check",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/check",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.isSuperAdmin).toBe(true);
    });

    it("should return false for non-SUPER_ADMIN user", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        role: "END_USER",
        email: "user@example.com",
      });

      const request = new Request(
        "https://example.com/api/admin/super-admin/check",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/check",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.isSuperAdmin).toBe(false);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/api/admin/super-admin/check",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/check",
      });

      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/super-admin/feature-toggles - Get all feature toggles", () => {
    const route = adminRoutes.find(
      (r) => r.method === "*" && r.path === "/api/admin/super-admin/*",
    );

    it("should get all feature toggles successfully", async () => {
      const mockToggles = [
        {
          key: "feature1",
          enabled: true,
          lastChanged: new Date(),
          changedBy: "admin@example.com",
          description: "Test feature",
        },
      ];
      mockGetAllToggles.mockResolvedValue(mockToggles);
      mockDb.user.findUnique.mockResolvedValue({
        role: "SUPER_ADMIN",
        email: "admin@example.com",
      });

      const request = new Request(
        "https://example.com/api/admin/super-admin/feature-toggles",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/feature-toggles",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.toggles).toBeDefined();
      expect(body.toggles.length).toBe(1);
    });

    it("should return empty array on database error (graceful degradation)", async () => {
      const error = new Error("Database timeout");
      mockWithQueryTimeoutAndRetry.mockRejectedValue(error);
      mockDb.user.findUnique.mockResolvedValue({
        role: "SUPER_ADMIN",
        email: "admin@example.com",
      });

      const request = new Request(
        "https://example.com/api/admin/super-admin/feature-toggles",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/feature-toggles",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.toggles).toEqual([]);
    });

    it("should return 403 for non-SUPER_ADMIN user", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        role: "END_USER",
        email: "user@example.com",
      });

      const request = new Request(
        "https://example.com/api/admin/super-admin/feature-toggles",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/feature-toggles",
      });

      expect(response.status).toBe(403);
    });
  });

  describe("POST /api/admin/super-admin/feature-toggles - Create feature toggle", () => {
    const route = adminRoutes.find(
      (r) => r.method === "*" && r.path === "/api/admin/super-admin/*",
    );

    it("should create feature toggle successfully", async () => {
      const mockToggle = {
        key: "new-feature",
        enabled: true,
        lastChanged: new Date(),
        changedBy: "admin@example.com",
      };
      mockGetToggle.mockResolvedValue(null); // Toggle doesn't exist
      mockSetToggle.mockResolvedValue(mockToggle);
      mockValidateBody.mockReturnValue({
        key: "new-feature",
        enabled: true,
        description: "New feature",
      });
      mockDb.user.findUnique.mockResolvedValue({
        role: "SUPER_ADMIN",
        email: "admin@example.com",
      });

      const request = new Request(
        "https://example.com/api/admin/super-admin/feature-toggles",
        {
          method: "POST",
          body: JSON.stringify({
            key: "new-feature",
            enabled: true,
            description: "New feature",
          }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/feature-toggles",
      });

      expect(mockSetToggle).toHaveBeenCalled();
      expect(response.status).toBe(201);
    });

    it("should return 409 when toggle already exists", async () => {
      mockGetToggle.mockResolvedValue({
        key: "existing-feature",
        enabled: true,
      });
      mockValidateBody.mockReturnValue({
        key: "existing-feature",
        enabled: true,
      });
      mockDb.user.findUnique.mockResolvedValue({
        role: "SUPER_ADMIN",
        email: "admin@example.com",
      });

      const request = new Request(
        "https://example.com/api/admin/super-admin/feature-toggles",
        {
          method: "POST",
          body: JSON.stringify({ key: "existing-feature", enabled: true }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/feature-toggles",
      });

      expect(response.status).toBe(409);
      expect(mockSetToggle).not.toHaveBeenCalled();
    });

    it("should handle rate limiting", async () => {
      mockRateLimitAdminFeatureToggleAPI.mockResolvedValue({
        allowed: false,
        resetAt: Date.now() + 60000,
        headers: {},
      });
      mockDb.user.findUnique.mockResolvedValue({
        role: "SUPER_ADMIN",
        email: "admin@example.com",
      });

      const request = new Request(
        "https://example.com/api/admin/super-admin/feature-toggles",
        {
          method: "POST",
          body: JSON.stringify({ key: "new-feature", enabled: true }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/feature-toggles",
      });

      expect(response.status).toBe(429);
    });
  });

  describe("GET /api/admin/super-admin/settings - Get settings", () => {
    const route = adminRoutes.find(
      (r) => r.method === "*" && r.path === "/api/admin/super-admin/*",
    );

    it("should get settings successfully", async () => {
      mockGetToggle.mockResolvedValue({
        enabled: true,
        lastChanged: new Date(),
        changedBy: "admin@example.com",
      });
      mockDb.user.count.mockResolvedValue(5);
      mockGetAppVersion.mockReturnValue("1.0.0");
      mockDb.user.findUnique.mockResolvedValue({
        role: "SUPER_ADMIN",
        email: "admin@example.com",
      });

      const request = new Request(
        "https://example.com/api/admin/super-admin/settings",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/settings",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.featureToggles).toBeDefined();
      expect(body.signupSettings).toBeDefined();
      expect(body.systemInfo).toBeDefined();
    });
  });

  describe("GET /api/feature-toggles/:key - Public feature toggle API", () => {
    it("should return feature toggle status", async () => {
      mockGetToggle.mockResolvedValue({
        key: "test_toggle",
        enabled: true,
        lastChanged: new Date(),
        changedBy: "admin-123",
      });
      mockRateLimitFeatureToggleAPI.mockResolvedValue({
        allowed: true,
        headers: {},
      });

      const route = adminRoutes.find(
        (r) =>
          r.path instanceof RegExp &&
          r.path.test("/api/feature-toggles/test_toggle"),
      );
      expect(route).toBeDefined();

      const request = new Request(
        "https://api.example.com/api/feature-toggles/test_toggle",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/feature-toggles/test_toggle",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.enabled).toBe(true);
      expect(body.key).toBe("test_toggle");
    });

    it("should return false for non-existent toggle", async () => {
      mockGetToggle.mockResolvedValue(null);

      const mockRateLimitFeatureToggleAPI = vi.fn().mockResolvedValue({
        allowed: true,
        headers: {},
      });

      const route = adminRoutes.find(
        (r) =>
          r.path instanceof RegExp &&
          r.path.test("/api/feature-toggles/nonexistent"),
      );
      expect(route).toBeDefined();

      const request = new Request(
        "https://api.example.com/api/feature-toggles/nonexistent",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/feature-toggles/nonexistent",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.enabled).toBe(false);
      expect(body.key).toBe("nonexistent");
    });

    it("should handle rate limiting", async () => {
      mockRateLimitFeatureToggleAPI.mockResolvedValue({
        allowed: false,
        resetAt: Date.now() + 60000,
        headers: { "Retry-After": "60" },
      });

      const route = adminRoutes.find(
        (r) =>
          r.path instanceof RegExp &&
          r.path.test("/api/feature-toggles/test_toggle"),
      );

      const request = new Request(
        "https://api.example.com/api/feature-toggles/test_toggle",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/feature-toggles/test_toggle",
      });

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    });

    it("should handle validation errors", async () => {
      const { ValidationError } = await import(
        "../../../src/lib/validation/validate-request.js"
      );
      mockValidatePathParam.mockImplementation(() => {
        throw new ValidationError("Invalid toggle key");
      });
      mockRateLimitFeatureToggleAPI.mockResolvedValue({
        allowed: true,
        headers: {},
      });

      const route = adminRoutes.find(
        (r) =>
          r.path instanceof RegExp &&
          r.path.test("/api/feature-toggles/invalid-key!"),
      );

      const request = new Request(
        "https://api.example.com/api/feature-toggles/invalid-key!",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/feature-toggles/invalid-key!",
      });

      // Should handle validation error
      expect(response.status).toBe(400);
    });
  });

  describe("GET /api/roles/metadata", () => {
    it("should return role metadata", async () => {
      const mockRoleMetadata = [
        { role: "END_USER", description: "End user", isActive: true },
        { role: "INTERNAL", description: "Internal user", isActive: true },
      ];

      const roleMetadataDb = {
        roleMetadata: {
          findMany: vi.fn().mockResolvedValue(mockRoleMetadata),
        },
      };
      mockCreatePrisma.mockReturnValue(roleMetadataDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/roles/metadata" && r.method === "GET",
      );
      expect(route).toBeDefined();

      const request = new Request(
        "https://api.example.com/api/roles/metadata",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.roles).toEqual(mockRoleMetadata);
    });

    it("should handle database errors", async () => {
      const roleMetadataDb = {
        roleMetadata: {
          findMany: vi.fn().mockRejectedValue(new Error("Database error")),
        },
      };
      mockCreatePrisma.mockReturnValue(roleMetadataDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/roles/metadata" && r.method === "GET",
      );

      const request = new Request(
        "https://api.example.com/api/roles/metadata",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(request, mockEnv);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to fetch role metadata");
    });
  });

  describe("GET /api/admin/domains", () => {
    it("should return domains for SUPER_ADMIN", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const mockDomains = [
        {
          id: "domain-1",
          domain: "example.com",
          reputation: 50,
          status: "active",
          lastChecked: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const domainsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
        domainReputation: {
          findMany: vi.fn().mockResolvedValue(mockDomains),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(domainsDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains" && r.method === "GET",
      );
      expect(route).toBeDefined();

      const request = new Request("https://api.example.com/api/admin/domains", {
        method: "GET",
      });

      const response = await route!.handler(request, mockEnv, {
        url: new URL(request.url),
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.domains).toBeDefined();
    });

    it("should return 401 for unauthenticated requests", async () => {
      mockGetSession.mockResolvedValue(null);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains" && r.method === "GET",
      );

      const request = new Request("https://api.example.com/api/admin/domains", {
        method: "GET",
      });

      const response = await route!.handler(request, mockEnv, {
        url: new URL(request.url),
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("should return 403 for non-admin users", async () => {
      const mockSession: Session = {
        userId: "user-123",
        email: "user@example.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const domainsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "END_USER" }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(domainsDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains" && r.method === "GET",
      );

      const request = new Request("https://api.example.com/api/admin/domains", {
        method: "GET",
      });

      const response = await route!.handler(request, mockEnv, {
        url: new URL(request.url),
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Forbidden: Admin access required");
    });

    it("should handle database errors", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const domainsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
        domainReputation: {
          findMany: vi.fn().mockRejectedValue(new Error("Database error")),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(domainsDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains" && r.method === "GET",
      );

      const request = new Request("https://api.example.com/api/admin/domains", {
        method: "GET",
      });

      const response = await route!.handler(request, mockEnv, {
        url: new URL(request.url),
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to fetch domains");
    });
  });

  describe("POST /api/admin/domains/:domain/block", () => {
    it("should block domain for SUPER_ADMIN", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const domainsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(domainsDb);

      const route = adminRoutes.find(
        (r) =>
          r.path instanceof RegExp &&
          r.path.test("/api/admin/domains/malicious.com/block") &&
          r.method === "POST",
      );
      expect(route).toBeDefined();

      const request = new Request(
        "https://api.example.com/api/admin/domains/malicious.com/block",
        { method: "POST" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/domains/malicious.com/block",
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(200);
    });

    it("should return 401 for unauthenticated requests", async () => {
      mockGetSession.mockResolvedValue(null);

      const route = adminRoutes.find(
        (r) =>
          r.path instanceof RegExp &&
          r.path.test("/api/admin/domains/malicious.com/block") &&
          r.method === "POST",
      );

      const request = new Request(
        "https://api.example.com/api/admin/domains/malicious.com/block",
        { method: "POST" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/domains/malicious.com/block",
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(401);
    });
  });

  describe("POST /api/admin/domains/:domain/unblock", () => {
    it("should unblock domain for SUPER_ADMIN", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const domainsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(domainsDb);

      const route = adminRoutes.find(
        (r) =>
          r.path instanceof RegExp &&
          r.path.test("/api/admin/domains/example.com/unblock") &&
          r.method === "POST",
      );
      expect(route).toBeDefined();

      const request = new Request(
        "https://api.example.com/api/admin/domains/example.com/unblock",
        { method: "POST" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/domains/example.com/unblock",
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(200);
    });

    it("should return 400 for invalid URL format", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const domainsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(domainsDb);

      const route = adminRoutes.find(
        (r) =>
          r.path instanceof RegExp &&
          r.path.test("/api/admin/domains/malicious.com/block") &&
          r.method === "POST",
      );

      const request = new Request(
        "https://api.example.com/api/admin/domains//block",
        { method: "POST" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/domains//block",
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid URL format");
    });

    it("should handle errors when blocking domain fails", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const domainsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(domainsDb);
      mockBlockDomain.mockRejectedValue(new Error("Block failed"));

      const route = adminRoutes.find(
        (r) =>
          r.path instanceof RegExp &&
          r.path.test("/api/admin/domains/malicious.com/block") &&
          r.method === "POST",
      );

      const request = new Request(
        "https://api.example.com/api/admin/domains/malicious.com/block",
        { method: "POST" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/domains/malicious.com/block",
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to block domain");
    });
  });

  describe("GET /api/admin/reports", () => {
    it("should return reports for SUPER_ADMIN", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const mockReports = [
        {
          id: "report-1",
          userId: "user-123",
          user: { id: "user-123", email: "user@example.com" },
          linkUrl: "https://malicious.com",
          domain: "malicious.com",
          reason: "phishing",
          status: "pending",
          createdAt: new Date(),
        },
      ];

      const reportsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
        linkReport: {
          findMany: vi.fn().mockResolvedValue(mockReports),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(reportsDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/reports" && r.method === "GET",
      );
      expect(route).toBeDefined();

      const request = new Request("https://api.example.com/api/admin/reports", {
        method: "GET",
      });

      const response = await route!.handler(request, mockEnv, {
        url: new URL(request.url),
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.reports).toBeDefined();
    });

    it("should handle database errors", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const reportsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
        linkReport: {
          findMany: vi.fn().mockRejectedValue(new Error("Database error")),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(reportsDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/reports" && r.method === "GET",
      );

      const request = new Request("https://api.example.com/api/admin/reports", {
        method: "GET",
      });

      const response = await route!.handler(request, mockEnv, {
        url: new URL(request.url),
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to fetch reports");
    });
  });

  describe("POST /api/admin/reports/:reportId/review", () => {
    it("should review report for SUPER_ADMIN", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const reportsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
        linkReport: {
          findUnique: vi.fn().mockResolvedValue({
            id: "report-1",
            status: "pending",
            domain: "malicious.com",
          }),
          update: vi.fn().mockResolvedValue({
            id: "report-1",
            status: "approved",
          }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(reportsDb);
      mockUpdateReputation.mockResolvedValue(undefined);

      const route = adminRoutes.find(
        (r) =>
          r.path instanceof RegExp &&
          r.path.test("/api/admin/reports/report-1/review") &&
          r.method === "POST",
      );
      expect(route).toBeDefined();

      const request = new Request(
        "https://api.example.com/api/admin/reports/report-1/review",
        {
          method: "POST",
          body: JSON.stringify({ action: "approve", notes: "Looks good" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/reports/report-1/review",
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(200);
    });

    it("should return 400 for invalid URL format", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const reportsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(reportsDb);

      const route = adminRoutes.find(
        (r) =>
          r.path instanceof RegExp &&
          r.path.test("/api/admin/reports/report-1/review") &&
          r.method === "POST",
      );

      const request = new Request(
        "https://api.example.com/api/admin/reports//review",
        {
          method: "POST",
          body: JSON.stringify({ action: "approve" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/reports//review",
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid URL format");
    });
  });

  describe("POST /api/admin/domains/bulk", () => {
    it("should perform bulk block operation for SUPER_ADMIN", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const bulkDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(bulkDb);
      mockBlockDomain.mockResolvedValue(undefined);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains/bulk" && r.method === "POST",
      );
      expect(route).toBeDefined();

      const request = new Request(
        "https://api.example.com/api/admin/domains/bulk",
        {
          method: "POST",
          body: JSON.stringify({
            action: "block",
            domains: ["malicious.com", "spam.com"],
          }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.action).toBe("block");
      expect(body.total).toBe(2);
      expect(body.successful).toBe(2);
    });

    it("should perform bulk unblock operation", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const bulkDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(bulkDb);
      mockUnblockDomain.mockResolvedValue(undefined);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains/bulk" && r.method === "POST",
      );

      const request = new Request(
        "https://api.example.com/api/admin/domains/bulk",
        {
          method: "POST",
          body: JSON.stringify({
            action: "unblock",
            domains: ["example.com"],
          }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.action).toBe("unblock");
    });

    it("should return 400 for invalid action", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const bulkDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(bulkDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains/bulk" && r.method === "POST",
      );

      const request = new Request(
        "https://api.example.com/api/admin/domains/bulk",
        {
          method: "POST",
          body: JSON.stringify({
            action: "invalid",
            domains: ["example.com"],
          }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Invalid action");
    });

    it("should return 400 for empty domains array", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const bulkDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(bulkDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains/bulk" && r.method === "POST",
      );

      const request = new Request(
        "https://api.example.com/api/admin/domains/bulk",
        {
          method: "POST",
          body: JSON.stringify({
            action: "block",
            domains: [],
          }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("non-empty array");
    });

    it("should return 400 for domains exceeding limit", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const bulkDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(bulkDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains/bulk" && r.method === "POST",
      );

      const domains = Array.from({ length: 101 }, (_, i) => `domain${i}.com`);
      const request = new Request(
        "https://api.example.com/api/admin/domains/bulk",
        {
          method: "POST",
          body: JSON.stringify({
            action: "block",
            domains,
          }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Maximum 100 domains");
    });

    it("should handle partial failures in bulk operation", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const bulkDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(bulkDb);
      mockBlockDomain
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Block failed"));

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains/bulk" && r.method === "POST",
      );

      const request = new Request(
        "https://api.example.com/api/admin/domains/bulk",
        {
          method: "POST",
          body: JSON.stringify({
            action: "block",
            domains: ["success.com", "fail.com"],
          }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.successful).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.results).toHaveLength(2);
    });

    it("should return 401 for unauthenticated requests", async () => {
      mockGetSession.mockResolvedValue(null);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains/bulk" && r.method === "POST",
      );

      const request = new Request(
        "https://api.example.com/api/admin/domains/bulk",
        {
          method: "POST",
          body: JSON.stringify({ action: "block", domains: ["example.com"] }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/domains - Additional edge cases", () => {
    it("should handle pagination with cursor", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const mockDomains = Array.from({ length: 51 }, (_, i) => ({
        id: `domain-${i}`,
        domain: `example${i}.com`,
        reputation: 50,
        status: "active",
        lastChecked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const domainsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
        domainReputation: {
          findMany: vi.fn().mockResolvedValue(mockDomains),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(domainsDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains" && r.method === "GET",
      );

      const request = new Request(
        "https://api.example.com/api/admin/domains?cursor=domain-0&limit=50",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(request.url),
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.hasMore).toBe(true);
      expect(body.nextCursor).toBeDefined();
    });

    it("should filter by status", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const domainsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
        domainReputation: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(domainsDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains" && r.method === "GET",
      );

      const request = new Request(
        "https://api.example.com/api/admin/domains?status=blocked",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(request.url),
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(200);
      expect(domainsDb.domainReputation.findMany).toHaveBeenCalled();
    });

    it("should filter by domain name", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const domainsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
        domainReputation: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(domainsDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains" && r.method === "GET",
      );

      const request = new Request(
        "https://api.example.com/api/admin/domains?domain=example",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(request.url),
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(200);
      expect(domainsDb.domainReputation.findMany).toHaveBeenCalled();
    });

    it("should handle invalid sortBy gracefully", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const domainsDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: "SUPER_ADMIN" }),
        },
        domainReputation: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(domainsDb);

      const route = adminRoutes.find(
        (r) => r.path === "/api/admin/domains" && r.method === "GET",
      );

      const request = new Request(
        "https://api.example.com/api/admin/domains?sortBy=invalid&sortOrder=asc",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(request.url),
        requestContext: { region: "US" },
      });

      expect(response.status).toBe(200);
      // Should default to createdAt desc
      expect(domainsDb.domainReputation.findMany).toHaveBeenCalled();
    });
  });

  describe("POST /api/admin/test/users - Additional edge cases", () => {
    it("should handle missing userId in pathname for delete", async () => {
      // The pathname '/api/admin/test/users/' doesn't match the regex pattern
      // The regex requires at least one character after the last slash
      const route = adminRoutes.find(
        (r) =>
          r.path === "/api/admin/test/users/:userId" && r.method === "DELETE",
      );

      // Ensure we're in dev environment and CI mode to skip auth
      const devEnv = { ...mockEnv, ENVIRONMENT: "dev", CI: "true" };

      const request = new Request(
        "https://api.example.com/api/admin/test/users/",
        { method: "DELETE" },
      );

      const response = await route!.handler(request, devEnv, {
        pathname: "/api/admin/test/users/",
      });

      // The regex doesn't match, so it returns 400
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid user ID");
    });

    it("should handle foreign key constraint errors gracefully", async () => {
      // Ensure we're in dev environment and CI mode to skip auth
      const devEnv = { ...mockEnv, ENVIRONMENT: "dev", CI: "true" };

      const error = new Error("Foreign key constraint violated");
      mockWithQueryTimeoutAndRetry.mockRejectedValue(error);

      // Mock the verification query to return false (user doesn't exist)
      const verifyDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(verifyDb);

      const route = adminRoutes.find(
        (r) =>
          r.path === "/api/admin/test/users/:userId" && r.method === "DELETE",
      );

      const request = new Request(
        "https://api.example.com/api/admin/test/users/user-123",
        { method: "DELETE" },
      );

      const response = await route!.handler(request, devEnv, {
        pathname: "/api/admin/test/users/user-123",
      });

      // Should handle gracefully - either 200 (if user already deleted) or 500
      expect([200, 500]).toContain(response.status);
    });
  });

  describe("PUT /api/admin/super-admin/feature-toggles/:key", () => {
    it("should update feature toggle for SUPER_ADMIN", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const toggleDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            role: "SUPER_ADMIN",
            email: "admin@example.com",
          }),
        },
      };
      mockCreatePrisma.mockReturnValue(toggleDb);
      mockRateLimitAdminFeatureToggleAPI.mockResolvedValue({
        allowed: true,
        headers: {},
      });
      mockValidatePathParam.mockImplementation((schema, value) => value);
      mockValidateBody.mockResolvedValue({
        success: true,
        data: { enabled: true },
      });
      mockSetToggle.mockResolvedValue({
        key: "test_toggle",
        enabled: true,
        lastChanged: new Date(),
        changedBy: "admin@example.com",
      });
      mockSharedDatabaseConnectionManager.executeWithRetry.mockResolvedValue({
        key: "test_toggle",
        enabled: true,
        lastChanged: new Date(),
        changedBy: "admin@example.com",
      });

      const route = adminRoutes.find(
        (r) =>
          r.path === "/api/admin/super-admin/*" &&
          r.method === "*" &&
          typeof r.handler === "function",
      );

      const request = new Request(
        "https://api.example.com/api/admin/super-admin/feature-toggles/test_toggle",
        {
          method: "PUT",
          body: JSON.stringify({ enabled: true }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/feature-toggles/test_toggle",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.toggle.enabled).toBe(true);
    });

    it("should return 400 for invalid path parameter", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const toggleDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            role: "SUPER_ADMIN",
            email: "admin@example.com",
          }),
        },
      };
      mockCreatePrisma.mockReturnValue(toggleDb);
      mockRateLimitAdminFeatureToggleAPI.mockResolvedValue({
        allowed: true,
        headers: {},
      });
      const { ValidationError } = await import(
        "../../../src/lib/validation/validate-request.js"
      );
      mockValidatePathParam.mockImplementation(() => {
        throw new ValidationError("Invalid toggle key");
      });

      const route = adminRoutes.find(
        (r) =>
          r.path === "/api/admin/super-admin/*" &&
          r.method === "*" &&
          typeof r.handler === "function",
      );

      const request = new Request(
        "https://api.example.com/api/admin/super-admin/feature-toggles/invalid!",
        {
          method: "PUT",
          body: JSON.stringify({ enabled: true }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/feature-toggles/invalid!",
      });

      expect(response.status).toBe(400);
    });

    it("should return 400 for invalid JSON body", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const toggleDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            role: "SUPER_ADMIN",
            email: "admin@example.com",
          }),
        },
      };
      mockCreatePrisma.mockReturnValue(toggleDb);
      mockRateLimitAdminFeatureToggleAPI.mockResolvedValue({
        allowed: true,
        headers: {},
      });
      mockValidatePathParam.mockImplementation((schema, value) => value);

      const route = adminRoutes.find(
        (r) =>
          r.path === "/api/admin/super-admin/*" &&
          r.method === "*" &&
          typeof r.handler === "function",
      );

      const request = new Request(
        "https://api.example.com/api/admin/super-admin/feature-toggles/test_toggle",
        {
          method: "PUT",
          body: "invalid json",
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/feature-toggles/test_toggle",
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid JSON in request body");
    });

    it("should return 500 for missing user email", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const toggleDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            role: "SUPER_ADMIN",
            email: null,
          }),
        },
      };
      mockCreatePrisma.mockReturnValue(toggleDb);
      mockRateLimitAdminFeatureToggleAPI.mockResolvedValue({
        allowed: true,
        headers: {},
      });
      mockValidatePathParam.mockImplementation((schema, value) => value);

      const route = adminRoutes.find(
        (r) =>
          r.path === "/api/admin/super-admin/*" &&
          r.method === "*" &&
          typeof r.handler === "function",
      );

      const request = new Request(
        "https://api.example.com/api/admin/super-admin/feature-toggles/test_toggle",
        {
          method: "PUT",
          body: JSON.stringify({ enabled: true }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/feature-toggles/test_toggle",
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("User email not found or invalid");
    });

    it("should handle database timeout errors", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const toggleDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            role: "SUPER_ADMIN",
            email: "admin@example.com",
          }),
        },
      };
      mockCreatePrisma.mockReturnValue(toggleDb);
      mockRateLimitAdminFeatureToggleAPI.mockResolvedValue({
        allowed: true,
        headers: {},
      });
      mockValidatePathParam.mockImplementation((schema, value) => value);
      mockValidateBody.mockResolvedValue({
        success: true,
        data: { enabled: true },
      });
      mockSharedDatabaseConnectionManager.executeWithRetry.mockRejectedValue(
        new Error("Database query timeout"),
      );

      const route = adminRoutes.find(
        (r) =>
          r.path === "/api/admin/super-admin/*" &&
          r.method === "*" &&
          typeof r.handler === "function",
      );

      const request = new Request(
        "https://api.example.com/api/admin/super-admin/feature-toggles/test_toggle",
        {
          method: "PUT",
          body: JSON.stringify({ enabled: true }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/feature-toggles/test_toggle",
      });

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toContain("timed out");
    });
  });

  describe("PUT /api/admin/super-admin/signup-settings", () => {
    it("should update signup settings for SUPER_ADMIN", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const signupDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            role: "SUPER_ADMIN",
            email: "admin@example.com",
          }),
        },
      };
      mockCreatePrisma.mockReturnValue(signupDb);
      mockSetToggle.mockResolvedValue({
        key: "user_signup_mode",
        enabled: true,
        lastChanged: new Date(),
        changedBy: "admin@example.com",
      });

      const route = adminRoutes.find(
        (r) =>
          r.path === "/api/admin/super-admin/*" &&
          r.method === "*" &&
          typeof r.handler === "function",
      );

      const request = new Request(
        "https://api.example.com/api/admin/super-admin/signup-settings",
        {
          method: "PUT",
          body: JSON.stringify({ mode: "invitation_only" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/signup-settings",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.signupSettings.mode).toBe("invitation_only");
    });

    it("should return 400 for invalid mode", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const signupDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            role: "SUPER_ADMIN",
            email: "admin@example.com",
          }),
        },
      };
      mockCreatePrisma.mockReturnValue(signupDb);

      const route = adminRoutes.find(
        (r) =>
          r.path === "/api/admin/super-admin/*" &&
          r.method === "*" &&
          typeof r.handler === "function",
      );

      const request = new Request(
        "https://api.example.com/api/admin/super-admin/signup-settings",
        {
          method: "PUT",
          body: JSON.stringify({ mode: "invalid_mode" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/signup-settings",
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Invalid request");
    });

    it("should handle database errors", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const signupDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            role: "SUPER_ADMIN",
            email: "admin@example.com",
          }),
        },
      };
      mockCreatePrisma.mockReturnValue(signupDb);
      mockSetToggle.mockRejectedValue(new Error("Database error"));

      const route = adminRoutes.find(
        (r) =>
          r.path === "/api/admin/super-admin/*" &&
          r.method === "*" &&
          typeof r.handler === "function",
      );

      const request = new Request(
        "https://api.example.com/api/admin/super-admin/signup-settings",
        {
          method: "PUT",
          body: JSON.stringify({ mode: "open" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/signup-settings",
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to update sign-up settings");
    });
  });

  describe("Super-admin wildcard route - Error handling", () => {
    it("should handle invalid session secret", async () => {
      // env.SESSION_SECRET is undefined → admin route returns 500
      const envWithoutSecret = { ...mockEnv, SESSION_SECRET: undefined } as any;

      const route = adminRoutes.find(
        (r) =>
          r.path === "/api/admin/super-admin/*" &&
          r.method === "*" &&
          typeof r.handler === "function",
      );

      const request = new Request(
        "https://api.example.com/api/admin/super-admin/check",
        { method: "GET" },
      );

      const response = await route!.handler(request, envWithoutSecret, {
        pathname: "/api/admin/super-admin/check",
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Server configuration error");
    });

    it("should return 404 for unknown super-admin routes", async () => {
      const mockSession: Session = {
        userId: "admin-123",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(mockSession);

      const unknownDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            role: "SUPER_ADMIN",
            email: "admin@example.com",
          }),
        },
      };
      mockCreatePrisma.mockReturnValue(unknownDb);

      const route = adminRoutes.find(
        (r) =>
          r.path === "/api/admin/super-admin/*" &&
          r.method === "*" &&
          typeof r.handler === "function",
      );

      const request = new Request(
        "https://api.example.com/api/admin/super-admin/unknown-route",
        { method: "GET" },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/admin/super-admin/unknown-route",
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("Not found");
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(adminRoutes.length).toBeGreaterThan(0);
    });

    it("should have middleware configured for routes", () => {
      adminRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      adminRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
