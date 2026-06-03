/**
 * Unit tests for China expansion - User Routes
 *
 * Tests region preference API endpoint and cross-region consent endpoint
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { userRoutes } from "../../../src/lib/routes/user.js";

// Mock dependencies
const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class SessionManager {
    getSession(request: any, secret: string, env?: any) {
      return mockGetSession(request, secret, env);
    }
  },
}));
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class SecurityHeaders {
    constructor(env: any) {}
    createSecureResponse(body: string, options: any) {
      return new Response(body, options);
    }
  },
}));
// Hoist mock variables to avoid initialization issues
const {
  mockCreateClient,
  mockExecuteWithRetry,
  mockGetDatabaseForRegion,
  mockSharedInstance,
  mockWithQueryTimeoutAndRetry,
  mockDetectRegionSync,
  mockIsValidRegion,
} = vi.hoisted(() => {
  const mockCreateClient = vi.fn();
  const mockExecuteWithRetry = vi.fn();
  const mockGetDatabaseForRegion = vi.fn();
  const mockSharedInstance = {
    createClient: mockCreateClient,
    executeWithRetry: mockExecuteWithRetry,
    getDatabaseForRegion: mockGetDatabaseForRegion,
  };
  const mockWithQueryTimeoutAndRetry = vi.fn();
  const mockDetectRegionSync = vi.fn(() => "US");
  const mockIsValidRegion = vi.fn((region: string) =>
    ["US", "EU", "CN"].includes(region),
  );
  return {
    mockCreateClient,
    mockExecuteWithRetry,
    mockGetDatabaseForRegion,
    mockSharedInstance,
    mockWithQueryTimeoutAndRetry,
    mockDetectRegionSync,
    mockIsValidRegion,
  };
});

vi.mock("../../../src/lib/database-connection-manager", () => ({
  DatabaseConnectionManager: class DatabaseConnectionManager {
    createClient = mockCreateClient;
    executeWithRetry = mockExecuteWithRetry;
    getDatabaseForRegion = mockGetDatabaseForRegion;
  },
  sharedDatabaseConnectionManager: mockSharedInstance,
}));
vi.mock("../../../src/lib/region-detection", () => ({
  detectRegionSync: mockDetectRegionSync,
  isValidRegion: mockIsValidRegion,
  RegionDetector: class RegionDetector {
    detectRegion = mockDetectRegionSync;
    isValidRegion = mockIsValidRegion;
  },
}));

vi.mock("../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: mockWithQueryTimeoutAndRetry,
  QueryTimeoutPresets: {
    STANDARD: { timeoutMs: 5000 },
    SHORT: { timeoutMs: 2000 },
    USER_FACING: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));
vi.mock("../../../src/lib/ip-scrubber", () => ({
  getIPAddress: vi.fn((request: Request) => {
    return request.headers.get("CF-Connecting-IP") || "127.0.0.1";
  }),
}));
vi.mock("../../../src/lib/validation", () => ({
  Validator: class Validator {
    sanitizeError(error: any) {
      return error.message || "Internal server error";
    }
  },
}));
vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (response: Response) => response,
}));
// The consent handler emits a best-effort audit event via a dynamic import
// of audit-composer; stub it so tests stay hermetic (no saas-foundation / DB).
vi.mock("../../../src/lib/audit-composer", () => ({
  createAuditLogger: () => ({
    log: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe("User Routes - Region Preference", () => {
  let mockEnv: Env;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (dbManager, region, env, callback) => {
        const consentRow = {
          id: "consent-1",
          consented: true,
          dataRegion: "EU",
          accessRegion: "US",
        };
        const tx = {
          consent: {
            findFirst: vi.fn().mockResolvedValue(null),
            update: vi.fn().mockResolvedValue({}),
            create: vi.fn().mockResolvedValue(consentRow),
          },
        };
        const mockDb = {
          user: {
            findUnique: vi.fn().mockResolvedValue({ dataRegion: "EU" }),
          },
          $transaction: vi.fn(async (fn: any) => fn(tx)),
        };
        return await callback(mockDb);
      },
    );
    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
      trellis_dev_session_secret: "test-secret",
      DEFAULT_REGION: "US",
    } as Env;

    mockRequest = {
      headers: new Headers({
        "Content-Type": "application/json",
      }),
      json: vi.fn(),
      url: "https://api.example.com/api/user/region-preference",
    } as unknown as Request;

    vi.clearAllMocks();
    mockGetSession.mockReset();
    mockCreateClient.mockReset();
    mockExecuteWithRetry.mockReset();
    mockWithQueryTimeoutAndRetry.mockReset();
  });

  describe("POST /api/user/region-preference", () => {
    it("should have correct route path", () => {
      const route = userRoutes.find(
        (r) => r.path === "/api/user/region-preference",
      );
      expect(route).toBeDefined();
      expect(route?.method).toBe("POST");
    });

    it("should require authentication", async () => {
      const route = userRoutes.find(
        (r) => r.path === "/api/user/region-preference",
      );
      if (!route) throw new Error("Route not found");

      // Mock session manager to return null (not authenticated)
      mockGetSession.mockResolvedValue(null);

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe("Unauthorized");
    });

    it("should validate region code", async () => {
      const route = userRoutes.find(
        (r) => r.path === "/api/user/region-preference",
      );
      if (!route) throw new Error("Route not found");

      // Mock authenticated session
      mockGetSession.mockResolvedValue({
        userId: "user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      });

      // Mock invalid region
      vi.mocked(mockRequest.json).mockResolvedValue({ region: "INVALID" });

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain("Invalid region");
    });

    it("should accept valid region codes", async () => {
      const route = userRoutes.find(
        (r) => r.path === "/api/user/region-preference",
      );
      if (!route) throw new Error("Route not found");

      // Mock authenticated session
      mockGetSession.mockResolvedValue({
        userId: "user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      });

      // Mock valid region
      vi.mocked(mockRequest.json).mockResolvedValue({ region: "CN" });

      // Mock database update
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              update: vi.fn().mockResolvedValue({
                id: "user-123",
                email: "test@example.com",
                region: "CN",
                dataRegion: "US",
              }),
            },
          };
          return await callback(mockDb);
        },
      );

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.region).toBe("CN");
    });
  });

  describe("POST /api/user/cross-region-consent", () => {
    let consentRequest: Request;

    beforeEach(() => {
      consentRequest = {
        headers: new Headers({
          "Content-Type": "application/json",
          "User-Agent": "test-agent",
          "CF-Connecting-IP": "192.168.1.1",
        }),
        json: vi.fn(),
        url: "https://api.example.com/api/user/cross-region-consent",
      } as unknown as Request;
    });

    it("should have correct route path", () => {
      const route = userRoutes.find(
        (r) => r.path === "/api/user/cross-region-consent",
      );
      expect(route).toBeDefined();
      expect(route?.method).toBe("POST");
    });

    it("should require authentication", async () => {
      const route = userRoutes.find(
        (r) => r.path === "/api/user/cross-region-consent",
      );
      if (!route) throw new Error("Route not found");

      mockGetSession.mockResolvedValue(null);

      const response = await route.handler(consentRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe("Unauthorized");
    });

    it("should validate region codes", async () => {
      const route = userRoutes.find(
        (r) => r.path === "/api/user/cross-region-consent",
      );
      if (!route) throw new Error("Route not found");

      mockGetSession.mockResolvedValue({
        userId: "user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      });

      vi.mocked(consentRequest.json).mockResolvedValue({
        dataRegion: "INVALID",
        accessRegion: "US",
        consented: true,
      });

      const response = await route.handler(consentRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid region");
    });

    it("should validate user exists", async () => {
      const route = userRoutes.find(
        (r) => r.path === "/api/user/cross-region-consent",
      );
      if (!route) throw new Error("Route not found");

      mockGetSession.mockResolvedValue({
        userId: "user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      });

      vi.mocked(consentRequest.json).mockResolvedValue({
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
      });

      mockWithQueryTimeoutAndRetry.mockImplementationOnce(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue(null), // User not found
            },
            crossRegionConsent: {
              upsert: vi.fn(),
            },
          };
          return await callback(mockDb);
        },
      );

      const response = await route.handler(consentRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe("User not found");
    });

    it("should validate dataRegion matches user dataRegion", async () => {
      const route = userRoutes.find(
        (r) => r.path === "/api/user/cross-region-consent",
      );
      if (!route) throw new Error("Route not found");

      mockGetSession.mockResolvedValue({
        userId: "user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      });

      vi.mocked(consentRequest.json).mockResolvedValue({
        dataRegion: "EU", // User's actual dataRegion is US
        accessRegion: "US",
        consented: true,
      });

      mockWithQueryTimeoutAndRetry.mockImplementationOnce(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                id: "user-123",
                dataRegion: "US", // Mismatch!
              }),
            },
            crossRegionConsent: {
              upsert: vi.fn(),
            },
          };
          return await callback(mockDb);
        },
      );

      const response = await route.handler(consentRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Data region mismatch");
    });

    it("should create consent record when user consents", async () => {
      const route = userRoutes.find(
        (r) => r.path === "/api/user/cross-region-consent",
      );
      if (!route) throw new Error("Route not found");

      mockGetSession.mockResolvedValue({
        userId: "user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      });

      vi.mocked(consentRequest.json).mockResolvedValue({
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
      });

      const mockConsent = {
        id: "consent-123",
        userId: "user-123",
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
        consentedAt: new Date(),
        withdrawnAt: null,
        ipAddress: "192.168.1.1",
        userAgent: "test-agent",
      };

      const mockFindFirst = vi.fn().mockResolvedValue(null); // no prior consent
      const mockUpdate = vi.fn();
      const mockCreate = vi.fn().mockResolvedValue(mockConsent);

      // First call: get user
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                id: "user-123",
                dataRegion: "EU",
              }),
            },
          };
          return await callback(mockDb);
        },
      );
      // Second call: append-only consent write inside a $transaction
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(
        async (dbManager, region, env, callback) => {
          const tx = {
            consent: {
              findFirst: mockFindFirst,
              update: mockUpdate,
              create: mockCreate,
            },
          };
          const mockDb = {
            $transaction: vi.fn(async (fn: any) => fn(tx)),
          };
          return await callback(mockDb);
        },
      );

      const response = await route.handler(consentRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.consented).toBe(true);
      expect(body.dataRegion).toBe("EU");
      expect(body.accessRegion).toBe("US");

      // A fresh active CROSS_REGION row is created; no prior row to supersede.
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-123",
          purpose: "CROSS_REGION",
          dataRegion: "EU",
          accessRegion: "US",
          consented: true,
          withdrawnAt: null,
          active: true,
          ipAddress: "192.168.1.1",
          userAgent: "test-agent",
        }),
      });
    });

    it("should update consent record when user withdraws consent", async () => {
      const route = userRoutes.find(
        (r) => r.path === "/api/user/cross-region-consent",
      );
      if (!route) throw new Error("Route not found");

      mockGetSession.mockResolvedValue({
        userId: "user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      });

      vi.mocked(consentRequest.json).mockResolvedValue({
        dataRegion: "EU",
        accessRegion: "US",
        consented: false, // Withdrawing consent
      });

      const mockConsent = {
        id: "consent-123",
        userId: "user-123",
        dataRegion: "EU",
        accessRegion: "US",
        consented: false,
        consentedAt: null,
        withdrawnAt: new Date(),
        ipAddress: "192.168.1.1",
        userAgent: "test-agent",
      };

      // Prior active GRANT row — its consentedAt MUST be preserved across
      // the withdrawal (append-only / GDPR Art.7(3)).
      const priorGrantedAt = new Date("2024-06-01T00:00:00Z");
      const priorRow = {
        id: "consent-prior",
        consented: true,
        consentedAt: priorGrantedAt,
        withdrawnAt: null,
        active: true,
      };
      const mockFindFirst = vi.fn().mockResolvedValue(priorRow);
      const mockUpdate = vi.fn().mockResolvedValue({});
      const mockCreate = vi.fn().mockResolvedValue(mockConsent);

      // First call: get user
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                id: "user-123",
                dataRegion: "EU",
              }),
            },
          };
          return await callback(mockDb);
        },
      );
      // Second call: append-only withdrawal inside a $transaction
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(
        async (dbManager, region, env, callback) => {
          const tx = {
            consent: {
              findFirst: mockFindFirst,
              update: mockUpdate,
              create: mockCreate,
            },
          };
          const mockDb = {
            $transaction: vi.fn(async (fn: any) => fn(tx)),
          };
          return await callback(mockDb);
        },
      );

      const response = await route.handler(consentRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.consented).toBe(false);

      // The prior grant row is SUPERSEDED, not mutated in place.
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: "consent-prior" },
        data: { active: false, supersededAt: expect.any(Date) },
      });
      // The withdrawal row sets withdrawnAt and PRESERVES the original
      // grant's consentedAt (never nulled).
      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          consented: false,
          withdrawnAt: expect.any(Date),
          consentedAt: priorGrantedAt,
          active: true,
        }),
      });
    });

    it("should handle database errors gracefully", async () => {
      const route = userRoutes.find(
        (r) => r.path === "/api/user/cross-region-consent",
      );
      if (!route) throw new Error("Route not found");

      mockGetSession.mockResolvedValue({
        userId: "user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      });

      vi.mocked(consentRequest.json).mockResolvedValue({
        dataRegion: "EU",
        accessRegion: "US",
        consented: true,
      });

      // First call: get user (succeeds). Second call: the consent write
      // transaction rejects, which the handler must surface as a 500.
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                id: "user-123",
                dataRegion: "EU",
              }),
            },
          };
          return await callback(mockDb);
        },
      );
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            $transaction: vi
              .fn()
              .mockRejectedValue(new Error("Database error")),
          };
          return await callback(mockDb);
        },
      );

      const response = await route.handler(consentRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBeDefined();
    });
  });
});
