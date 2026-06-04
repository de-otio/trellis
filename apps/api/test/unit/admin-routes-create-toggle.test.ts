import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "@cloudflare/workers-types";

// Mock dependencies
const mockGetSession = vi.fn();
vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

const mockCreatePrisma = vi.fn();
const mockPrismaClient = {
  user: {
    findUnique: vi.fn(),
  },
  featureToggle: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
};
vi.mock("../../src/db", () => ({
  createPrisma: mockCreatePrisma,
  DatabaseClient: {
    createForRegion: vi.fn(),
    clearPoolCache: vi.fn(),
    getPoolStatus: vi.fn().mockReturnValue([]),
  },
}));

const mockSetToggle = vi.fn();
const mockGetToggle = vi.fn();
vi.mock("../../src/lib/feature-toggle-service", () => ({
  FeatureToggleService: class {
    setToggle = mockSetToggle;
    getToggle = mockGetToggle;
    constructor(db: any) {}
  },
}));

const mockRateLimitAdminFeatureToggleAPI = vi.fn();
vi.mock("../../src/lib/middleware/feature-toggle-rate-limit", () => ({
  rateLimitAdminFeatureToggleAPI: mockRateLimitAdminFeatureToggleAPI,
  createRateLimitErrorResponse: vi.fn(),
}));

const mockValidateBody = vi.fn();
const mockValidationError = class ValidationError extends Error {};
vi.mock("../../src/lib/validation/validate-request", () => ({
  validateBody: mockValidateBody,
  ValidationError: mockValidationError,
}));

const mockCreateSecureResponse = vi.fn();
vi.mock("../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    constructor(env: any) {}
  },
}));

const mockAddCorsHeaders = vi.fn();
vi.mock("../../worker", () => ({
  addCorsHeaders: mockAddCorsHeaders,
}));

describe("POST /api/admin/super-admin/feature-toggles", () => {
  let mockRequest: Request;
  let mockEnv: any;
  let mockSession: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSession = {
      userId: "user-123",
      email: "admin@example.com",
      expiresAt: Date.now() + 3600000,
    };

    // Reset mock Prisma client methods
    mockPrismaClient.user.findUnique = vi.fn();
    mockPrismaClient.featureToggle.findUnique = vi.fn();
    mockPrismaClient.featureToggle.create = vi.fn();
    mockPrismaClient.featureToggle.update = vi.fn();

    mockGetSession.mockResolvedValue(mockSession);
    mockCreatePrisma.mockReturnValue(mockPrismaClient);
    mockRateLimitAdminFeatureToggleAPI.mockResolvedValue({
      allowed: true,
      headers: {},
    });
    mockGetToggle.mockResolvedValue(null); // Toggle doesn't exist
    mockSetToggle.mockResolvedValue({
      key: "test_toggle",
      enabled: false,
      lastChanged: new Date(),
      changedBy: "admin@example.com",
    });
    // Mock user lookup to return super admin
    mockPrismaClient.user.findUnique.mockResolvedValue({
      id: "user-123",
      role: "SUPER_ADMIN",
      email: "admin@example.com",
    });
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddCorsHeaders.mockImplementation((response) => response);

    mockEnv = {
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
      trellis_dev_session_secret: "test-secret",
    };

    mockRequest = new Request(
      "https://api.example.com/api/admin/super-admin/feature-toggles",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          key: "test_toggle",
          enabled: false,
          description: "Test toggle description",
        }),
      },
    );
  });

  it("should create a new feature toggle successfully", async () => {
    const { adminRoutes } = await import("../../src/lib/routes/admin.js");
    const route = adminRoutes.find(
      (r) => r.path === "/api/admin/super-admin/*",
    );

    expect(route).toBeDefined();

    mockValidateBody.mockReturnValue({
      key: "test_toggle",
      enabled: false,
      description: "Test toggle description",
    });

    const handler = route!.handler;
    const response = await handler(mockRequest, mockEnv, {
      pathname: "/api/admin/super-admin/feature-toggles",
    });

    expect(response.status).toBe(201);
    expect(mockGetToggle).toHaveBeenCalledWith("test_toggle");
    expect(mockSetToggle).toHaveBeenCalledWith(
      "test_toggle",
      false,
      "admin@example.com",
      "Test toggle description",
      // setToggle now takes an audit context (userId/region/env) as a 5th arg.
      expect.objectContaining({ userId: "user-123", region: "EU" }),
    );
  });

  it("should return 409 if toggle already exists", async () => {
    mockGetToggle.mockResolvedValue({
      key: "test_toggle",
      enabled: true,
    });

    const { adminRoutes } = await import("../../src/lib/routes/admin.js");
    const route = adminRoutes.find(
      (r) => r.path === "/api/admin/super-admin/*",
    );
    const handler = route!.handler;

    mockValidateBody.mockReturnValue({
      key: "test_toggle",
      enabled: false,
    });

    const response = await handler(mockRequest, mockEnv, {
      pathname: "/api/admin/super-admin/feature-toggles",
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("Feature toggle already exists");
    expect(mockSetToggle).not.toHaveBeenCalled();
  });

  it("should return 400 on validation error", async () => {
    const validationError = new mockValidationError("Invalid key format");
    mockValidateBody.mockImplementation(() => {
      throw validationError;
    });

    const { adminRoutes } = await import("../../src/lib/routes/admin.js");
    const route = adminRoutes.find(
      (r) => r.path === "/api/admin/super-admin/*",
    );
    const handler = route!.handler;

    const response = await handler(mockRequest, mockEnv, {
      pathname: "/api/admin/super-admin/feature-toggles",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Invalid key format");
  });

  it("should return 429 on rate limit exceeded", async () => {
    mockRateLimitAdminFeatureToggleAPI.mockResolvedValue({
      allowed: false,
      resetAt: Date.now() + 60000,
      headers: { "Retry-After": "60" },
    });

    const { adminRoutes } = await import("../../src/lib/routes/admin.js");
    const route = adminRoutes.find(
      (r) => r.path === "/api/admin/super-admin/*",
    );
    const handler = route!.handler;

    mockValidateBody.mockReturnValue({
      key: "test_toggle",
      enabled: false,
    });

    const response = await handler(mockRequest, mockEnv, {
      pathname: "/api/admin/super-admin/feature-toggles",
    });

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("should return 401 if not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);

    const { adminRoutes } = await import("../../src/lib/routes/admin.js");
    const route = adminRoutes.find(
      (r) => r.path === "/api/admin/super-admin/*",
    );
    const handler = route!.handler;

    const response = await handler(mockRequest, mockEnv, {
      pathname: "/api/admin/super-admin/feature-toggles",
    });

    expect(response.status).toBe(401);
  });

  it("should return 403 if not super admin", async () => {
    // Mock user lookup to return non-super-admin
    const mockUser = { role: "ADMIN" };
    const mockDb = {
      user: {
        findUnique: vi.fn().mockResolvedValue(mockUser),
      },
    };
    mockCreatePrisma.mockReturnValue(mockDb);

    const { adminRoutes } = await import("../../src/lib/routes/admin.js");
    const route = adminRoutes.find(
      (r) => r.path === "/api/admin/super-admin/*",
    );
    const handler = route!.handler;

    const response = await handler(mockRequest, mockEnv, {
      pathname: "/api/admin/super-admin/feature-toggles",
    });

    expect(response.status).toBe(403);
  });

  it("should handle database errors gracefully", async () => {
    mockSetToggle.mockRejectedValue(new Error("Database connection failed"));

    const { adminRoutes } = await import("../../src/lib/routes/admin.js");
    const route = adminRoutes.find(
      (r) => r.path === "/api/admin/super-admin/*",
    );
    const handler = route!.handler;

    mockValidateBody.mockReturnValue({
      key: "test_toggle",
      enabled: false,
    });

    const response = await handler(mockRequest, mockEnv, {
      pathname: "/api/admin/super-admin/feature-toggles",
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to create feature toggle");
  });
});
