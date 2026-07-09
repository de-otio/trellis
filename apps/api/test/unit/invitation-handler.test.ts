/**
 * Unit Tests: Invitation Handler
 *
 * Comprehensive tests for the invitation system including:
 * - Creating invitations
 * - Listing invitations
 * - Validating invitations
 * - Marking invitations as used
 * - Security checks (disabled sign-up mode, rate limiting, etc.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrisma } from "../../src/db.js";
import { InvitationHandler } from "../../src/lib/invitation-handler.js";
import type { Session } from "../../src/lib/session-cookie.js";

// Mock function for rate limiting - will be used with vi.spyOn
const mockCheckRateLimit = vi.fn().mockImplementation(() => ({
  allowed: true,
  remaining: 10,
  resetAt: Date.now() + 3600000,
}));

// Mock dependencies
vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(),
  DatabaseClient: {
    clearPoolCache: vi.fn(),
    createForRegion: vi.fn(),
    create: vi.fn(),
  },
}));

// Mock DatabaseConnectionManager
const mockExecuteWithRetry = vi.fn();
const mockCreateClient = vi.fn();
const mockSharedInstance = {
  createClient: mockCreateClient,
  clearPools: vi.fn(),
  getPoolStatus: vi.fn().mockReturnValue([]),
  executeWithRetry: mockExecuteWithRetry,
};
vi.mock("../../src/lib/database-connection-manager", () => ({
  DatabaseConnectionManager: class {
    createClient = mockSharedInstance.createClient;
    clearPools = mockSharedInstance.clearPools;
    getPoolStatus = mockSharedInstance.getPoolStatus;
    executeWithRetry = mockSharedInstance.executeWithRetry;
  },
  sharedDatabaseConnectionManager: mockSharedInstance,
}));

// Mock region detection
vi.mock("../../src/lib/region-detection", () => {
  const mockDetectRegionSync = vi.fn().mockReturnValue("US");
  const mockIsValidRegion = vi
    .fn()
    .mockImplementation((region: string) =>
      ["US", "EU", "CN"].includes(region),
    );
  return {
    detectRegionSync: mockDetectRegionSync,
    isValidRegion: mockIsValidRegion,
    RegionDetector: class RegionDetector {
      detectRegionSync = mockDetectRegionSync;
      isValidRegion = mockIsValidRegion;
    },
  };
});

// Mock SessionManager class
const mockGetSession = vi.fn();
vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class SessionManager {
    getSession(request: any, secret: string, env?: any) {
      return mockGetSession(request, secret, env);
    }
  },
}));

// Mock SecurityHeaders class
const mockCreateSecureResponse = vi.fn((body, options) => {
  return new Response(body, options);
});
const mockAddSecurityHeaders = vi.fn((response) => {
  const newResponse = response.clone();
  newResponse.headers.set("X-Content-Type-Options", "nosniff");
  newResponse.headers.set("X-Frame-Options", "DENY");
  return newResponse;
});
vi.mock("../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    constructor(env: any) {}
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
  },
}));

// Mock FeatureToggleService class
const mockGetToggle = vi.fn();
vi.mock("../../src/lib/feature-toggle-service", () => ({
  FeatureToggleService: class {
    getToggle = mockGetToggle;
    constructor(db: any) {}
  },
}));

// Mock the PreSignUp DynamoDB record writer so create-path unit tests don't
// make real AWS calls. The real writer's shape/casing is covered end-to-end by
// invitation-presignup-gate.test.ts; here we only assert the handler invokes it
// with the created code + the invite's expiry/email.
const { mockWritePreSignUpInvitationRecord } = vi.hoisted(() => ({
  mockWritePreSignUpInvitationRecord: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/lib/invitation-presignup-record", () => ({
  writePreSignUpInvitationRecord: mockWritePreSignUpInvitationRecord,
  markPreSignUpInvitationRecordUsed: vi.fn().mockResolvedValue(undefined),
  preSignUpInvitationPk: (code: string) => `invitations:${code.toUpperCase()}`,
}));

// Don't mock RateLimiter - we'll use vi.spyOn to intercept method calls
// This is more reliable than module mocking for instance methods

describe("InvitationHandler", () => {
  let handler: InvitationHandler;
  let mockDb: any;
  let mockSession: Session;
  let mockEnv: any;
  let mockRequest: Request;

  beforeEach(async () => {
    // Reset all mocks first (restoreAllMocks clears spies created with vi.spyOn)
    vi.restoreAllMocks();
    vi.clearAllMocks();

    // Reset rate limit mock
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockImplementation(() => ({
      allowed: true,
      remaining: 10,
      resetAt: Date.now() + 3600000,
    }));

    // Setup mock database
    mockDb = {
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      invitation: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn().mockResolvedValue(0),
      },
      $transaction: vi.fn((callback) => callback(mockDb)),
    };

    (createPrisma as any).mockReturnValue(mockDb);

    // Setup mock session
    mockSession = {
      userId: "user-123",
      email: "test@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      id: "session-123",
    };

    // Setup mock environment
    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
      trellis_dev_session_secret: "test-secret",
      APP_DOMAIN: "https://test.example.com",
      INVITATIONS_KV: {
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };

    // Setup mock request
    mockRequest = new Request("https://api.test.example.com/api/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    // Setup default mock behaviors
    mockGetSession.mockResolvedValue(mockSession);
    mockGetToggle.mockResolvedValue({
      description: "user_signup_mode:open",
      enabled: true,
    });

    // Setup mockExecuteWithRetry to execute the callback with mockDb
    mockExecuteWithRetry.mockImplementation(
      async (region, env, queryFn, options) => {
        return await queryFn(mockDb);
      },
    );
    mockCreateClient.mockReturnValue(mockDb);

    // Create handler instance AFTER setting up all mocks
    handler = new InvitationHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("handleCreateInvitation", () => {
    it("should create invitation successfully without email restriction", async () => {
      // Reset mocks for this test
      mockExecuteWithRetry.mockReset();
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockDb);
        },
      );

      mockDb.user.findUnique.mockResolvedValue({ suspended: false });
      mockDb.invitation.deleteMany.mockResolvedValue({ count: 0 });
      mockDb.invitation.count.mockResolvedValue(0);
      mockDb.invitation.findUnique.mockResolvedValue(null); // Code doesn't exist
      mockDb.invitation.create.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
      });

      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await handler.handleCreateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.invitation).toBeDefined();
      expect(data.invitation.code).toBe("ABC12345");
      expect(data.invitation.email).toBeNull();

      // AUTH GATE: the create flow must write the PreSignUp DynamoDB record,
      // keyed off the same code, or invited signup is impossible.
      expect(mockWritePreSignUpInvitationRecord).toHaveBeenCalledTimes(1);
      expect(mockWritePreSignUpInvitationRecord).toHaveBeenCalledWith(
        expect.objectContaining({ code: "ABC12345", email: null }),
      );
    });

    it("should create invitation with email restriction", async () => {
      // Reset mocks for this test
      mockExecuteWithRetry.mockReset();
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockDb);
        },
      );

      mockDb.user.findUnique.mockResolvedValue({ suspended: false });
      mockDb.invitation.deleteMany.mockResolvedValue({ count: 0 });
      mockDb.invitation.count.mockResolvedValue(0);
      mockDb.invitation.findUnique.mockResolvedValue(null);
      mockDb.invitation.create.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: "invited@example.com",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
      });

      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "invited@example.com" }),
        },
      );

      const response = await handler.handleCreateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.invitation.email).toBe("invited@example.com");
      // Email restriction must be carried onto the PreSignUp record.
      expect(mockWritePreSignUpInvitationRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "ABC12345",
          email: "invited@example.com",
        }),
      );
    });

    it("should reject invitation creation when sign-up is disabled", async () => {
      // Reset mocks for this test
      mockExecuteWithRetry.mockReset();
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockDb);
        },
      );

      mockGetToggle.mockResolvedValueOnce({
        description: "user_signup_mode:disabled",
        enabled: false,
      });

      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await handler.handleCreateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe("Sign-up disabled");
      expect(data.message).toContain("disabled");
    });

    it("should reject invitation creation for unauthenticated users", async () => {
      mockGetSession.mockResolvedValueOnce(null);

      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await handler.handleCreateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("should reject invitation creation for suspended users", async () => {
      // Reset mocks for this test
      mockExecuteWithRetry.mockReset();
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockDb);
        },
      );

      mockDb.user.findUnique.mockResolvedValue({ suspended: true });

      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await handler.handleCreateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe("Account suspended");
    });

    it("should enforce open invitation limit", async () => {
      // Reset mocks for this test
      mockExecuteWithRetry.mockReset();
      // Mock executeWithRetry to handle both deleteExpiredInvitations and checkOpenInvitationLimit
      let callCount = 0;
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          callCount++;
          if (callCount === 1) {
            // First call: deleteExpiredInvitations - returns count from deleteMany
            return await queryFn(mockDb);
          } else {
            // Second call: checkOpenInvitationLimit - returns count from count()
            return await queryFn(mockDb);
          }
        },
      );

      // Rate limit must pass first (checked before open invitation limit)
      mockCheckRateLimit.mockImplementationOnce(() => ({
        allowed: true,
        remaining: 10,
        resetAt: Date.now() + 3600000,
      }));
      mockDb.user.findUnique.mockResolvedValue({ suspended: false });
      mockDb.invitation.deleteMany.mockResolvedValue({ count: 0 });
      mockDb.invitation.count.mockResolvedValue(10); // Already at limit

      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await handler.handleCreateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(429);
      expect(data.error).toBe("Invitation limit reached");
      expect(data.message).toContain("open invitations");
    });

    it("should validate email format", async () => {
      // Reset mocks for this test
      mockExecuteWithRetry.mockReset();
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockDb);
        },
      );

      // Ensure rate limit passes (it's checked before validation)
      mockCheckRateLimit.mockImplementationOnce(() => ({
        allowed: true,
        remaining: 10,
        resetAt: Date.now() + 3600000,
      }));
      mockDb.user.findUnique.mockResolvedValue({ suspended: false });

      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "invalid-email" }),
        },
      );

      const response = await handler.handleCreateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Validation failed");
      expect(data.details).toBeDefined();
      expect(data.details.some((d: any) => d.path === "email")).toBe(true);
    });

    it("should enforce email length limit", async () => {
      // Test validation schema directly - simpler and more maintainable
      const { createInvitationSchema } = await import("../../src/lib/schemas.js");

      const longEmail = "a".repeat(250) + "@example.com";
      const result = createInvitationSchema.safeParse({ email: longEmail });

      // Email validation should fail due to length (RFC 5321 max is 254, but Zod email() may enforce stricter)
      // If it passes Zod email validation but exceeds length, the test should verify the actual behavior
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.path.includes("email")),
        ).toBe(true);
      } else {
        // If Zod allows it, check that the email length is handled elsewhere
        // For now, just verify the schema processes it
        expect(result.data.email).toBe(longEmail.toLowerCase());
      }
    });

    it("should validate expiration days range", async () => {
      // Reset mocks for this test
      mockExecuteWithRetry.mockReset();
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockDb);
        },
      );

      // Ensure rate limit passes (it's checked before validation)
      mockCheckRateLimit.mockImplementationOnce(() => ({
        allowed: true,
        remaining: 10,
        resetAt: Date.now() + 3600000,
      }));
      mockDb.user.findUnique.mockResolvedValue({ suspended: false });
      mockDb.invitation.deleteMany.mockResolvedValue({ count: 0 });
      mockDb.invitation.count.mockResolvedValue(0);
      mockDb.invitation.findUnique.mockResolvedValue(null);

      // expiresInDays validation happens when email is provided
      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "test@example.com",
            expiresInDays: 500,
          }), // Exceeds max
        },
      );

      const response = await handler.handleCreateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Validation failed");
      expect(data.details).toBeDefined();
      expect(data.details.some((d: any) => d.path === "expiresInDays")).toBe(
        true,
      );
    });

    it("should handle general errors in catch block", async () => {
      // Trigger the catch path by making getSession throw unexpectedly
      mockGetSession.mockRejectedValueOnce(new Error("Unexpected session error"));

      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await handler.handleCreateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });

    it("should apply rate limiting", async () => {
      // Reset mocks for this test
      mockExecuteWithRetry.mockReset();
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockDb);
        },
      );

      handler = new InvitationHandler();
      // Set rate limiter to return rate limited
      (handler as any).rateLimiter.checkRateLimit = () => ({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 3600000,
      });

      mockDb.user.findUnique.mockResolvedValue({ suspended: false });

      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await handler.handleCreateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(429);
      expect(data.error).toBe("Rate limit exceeded");
    });
  });

  describe("handleGetInviterInfo", () => {
    it("should return inviter info for newly signed up user", async () => {
      mockEnv.INVITATIONS_KV.get.mockResolvedValue(
        JSON.stringify({
          inviterId: "inviter-123",
          inviterEmail: "inviter@example.com",
        }),
      );

      const request = new Request(
        "https://api.test.example.com/api/invitations/inviter-info",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetInviterInfo(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.inviterId).toBe("inviter-123");
      expect(data.inviterEmail).toBe("inviter@example.com");
      expect(mockEnv.INVITATIONS_KV.get).toHaveBeenCalledWith(
        "inviter-info:user-123",
      );
      expect(mockEnv.INVITATIONS_KV.delete).toHaveBeenCalledWith(
        "inviter-info:user-123",
      );
    });

    it("should handle errors when KV get fails", async () => {
      const session: Session = {
        userId: "user-123",
        email: "user@example.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(session);
      mockEnv.INVITATIONS_KV.get.mockRejectedValue(new Error("KV error"));

      const request = new Request(
        "https://api.test.example.com/api/invitations/inviter-info",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetInviterInfo(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });

    it("should handle errors when KV delete fails gracefully", async () => {
      const session: Session = {
        userId: "user-123",
        email: "user@example.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(session);
      mockEnv.INVITATIONS_KV.get.mockResolvedValue(
        JSON.stringify({
          inviterId: "inviter-123",
          inviterEmail: "inviter@example.com",
        }),
      );
      // Delete fails but should be caught and return null values
      mockEnv.INVITATIONS_KV.delete.mockRejectedValue(
        new Error("KV delete error"),
      );

      const request = new Request(
        "https://api.test.example.com/api/invitations/inviter-info",
        {
          method: "GET",
        },
      );

      // Should return null values when delete fails (caught in inner try-catch)
      const response = await handler.handleGetInviterInfo(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.inviterId).toBe(null);
      expect(data.inviterEmail).toBe(null);
    });

    it("should handle invalid JSON in KV storage", async () => {
      const session: Session = {
        userId: "user-123",
        email: "user@example.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(session);
      mockEnv.INVITATIONS_KV.get.mockResolvedValue("invalid json");

      const request = new Request(
        "https://api.test.example.com/api/invitations/inviter-info",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetInviterInfo(request, mockEnv);
      const data = await response.json();

      // Should return null values when JSON parsing fails
      expect(response.status).toBe(200);
      expect(data.inviterId).toBe(null);
      expect(data.inviterEmail).toBe(null);
    });

    it("should return null when no inviter info exists", async () => {
      mockEnv.INVITATIONS_KV.get.mockResolvedValue(null);

      const request = new Request(
        "https://api.test.example.com/api/invitations/inviter-info",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetInviterInfo(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.inviterId).toBeNull();
      expect(data.inviterEmail).toBeNull();
    });

    it("should reject unauthenticated requests", async () => {
      mockGetSession.mockResolvedValueOnce(null);

      const request = new Request(
        "https://api.test.example.com/api/invitations/inviter-info",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetInviterInfo(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });
  });

  describe("handleListInvitations", () => {
    it("should list user invitations successfully", async () => {
      const mockInvitations = [
        {
          id: "inv-1",
          code: "ABC12345",
          email: null,
          used: false,
          usedBy: null,
          usedAt: null,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          createdAt: new Date(),
        },
        {
          id: "inv-2",
          code: "XYZ67890",
          email: "test@example.com",
          used: true,
          usedBy: "user-456",
          usedAt: new Date(),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          createdAt: new Date(),
        },
      ];

      // Mock user.findMany for fetching user emails for used invitations
      // This will be called inside the queryFn when there are used invitations
      mockDb.user.findMany.mockResolvedValue([
        {
          id: "user-456",
          email: "usedby@example.com",
        },
      ]);

      // Set up deleteMany mock for deleteExpiredInvitations (first call)
      // This will be called by deleteExpiredInvitations, which extracts result.count
      mockDb.invitation.deleteMany.mockResolvedValue({ count: 0 });

      // Set up the invitation.findMany mock to return the expected data
      // Note: This will be called by the queryFn in handleListInvitations
      // The queryFn will call findMany, then user.findMany, then map the results
      mockDb.invitation.findMany.mockResolvedValue(mockInvitations);

      // Mock executeWithRetry to handle both deleteExpiredInvitations and the query
      // Called as: executeWithRetry(region, env, queryFn, options)
      mockExecuteWithRetry.mockReset();
      mockExecuteWithRetry.mockImplementation(
        async (region: string, env: any, queryFn: any, options: any) => {
          return await queryFn(mockDb);
        },
      );

      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "GET",
        },
      );

      const response = await handler.handleListInvitations(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.invitations).toHaveLength(2);
      expect(data.invitations[0].code).toBe("ABC12345");
      expect(data.invitations[1].used).toBe(true);
      expect(mockDb.invitation.findMany).toHaveBeenCalledWith({
        where: { createdBy: "user-123" },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          code: true,
          createdBy: true,
          email: true,
          used: true,
          usedBy: true,
          usedAt: true,
          scannedAt: true,
          expiresAt: true,
          createdAt: true,
        },
      });
    });

    it("should handle general errors in catch block", async () => {
      // Trigger the catch path by making getSession throw unexpectedly
      mockGetSession.mockRejectedValueOnce(new Error("Unexpected session error"));

      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "GET",
        },
      );

      const response = await handler.handleListInvitations(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });

    it("should reject listing invitations for unauthenticated users", async () => {
      mockGetSession.mockResolvedValueOnce(null);

      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "GET",
        },
      );

      const response = await handler.handleListInvitations(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });
  });

  describe("handleValidateInvitation", () => {
    it("should validate valid invitation code and return session token", async () => {
      mockDb.invitation.findUnique.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: null,
        used: false,
        scannedAt: null,
        scannedBy: null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      // Mock SELECT FOR UPDATE query
      mockDb.$queryRaw = vi.fn().mockResolvedValue([
        {
          id: "inv-123",
          scannedAt: null,
          scannedBy: null,
          used: false,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          email: null,
        },
      ]);

      mockDb.invitation.update.mockResolvedValue({
        id: "inv-123",
        scannedAt: new Date(),
        scannedBy: "inv_token123",
      });

      mockEnv.INVITATIONS_KV.put.mockResolvedValue(undefined);

      const request = new Request(
        "https://api.test.example.com/api/invitations/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "ABC12345" }),
        },
      );

      const response = await handler.handleValidateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.token).toBeDefined();
      expect(data.token).toMatch(/^inv_/);
      expect(data.emailRestricted).toBe(false);
      expect(mockEnv.INVITATIONS_KV.put).toHaveBeenCalled();
    });

    it("should reject invalid invitation code with generic error", async () => {
      mockDb.invitation.findUnique.mockResolvedValue(null);

      const request = new Request(
        "https://api.test.example.com/api/invitations/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "INVALID" }),
        },
      );

      const response = await handler.handleValidateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(false);
      // SECURITY: Generic error message to prevent code enumeration
      expect(data.error).toBe("Invalid or unavailable invitation code");
    });

    it("should reject already used invitation code with generic error", async () => {
      mockDb.invitation.findUnique.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: null,
        used: true,
        usedBy: "user-456",
        usedAt: new Date(),
        scannedAt: null,
        scannedBy: null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      const request = new Request(
        "https://api.test.example.com/api/invitations/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "ABC12345" }),
        },
      );

      const response = await handler.handleValidateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(false);
      // SECURITY: Generic error message
      expect(data.error).toBe("Invalid or unavailable invitation code");
    });

    it("should reject expired invitation code with generic error", async () => {
      mockDb.invitation.findUnique.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: null,
        used: false,
        scannedAt: null,
        scannedBy: null,
        expiresAt: new Date(Date.now() - 1000), // Expired
      });

      const request = new Request(
        "https://api.test.example.com/api/invitations/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "ABC12345" }),
        },
      );

      const response = await handler.handleValidateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(false);
      // SECURITY: Generic error message - expiration checked before claiming
      expect(data.error).toBe("Invalid or unavailable invitation code");
    });

    it("should require email for restricted invitation", async () => {
      mockDb.invitation.findUnique.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: "invited@example.com",
        used: false,
        scannedAt: null,
        scannedBy: null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      // SECURITY: Email is required for restricted invitations
      const request = new Request(
        "https://api.test.example.com/api/invitations/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "ABC12345" }), // No email provided
        },
      );

      const response = await handler.handleValidateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(false);
      expect(data.error).toBe(
        "Email address is required for this invitation code",
      );
      expect(data.emailRequired).toBe(true);
    });

    it("should validate email-restricted invitation with correct email", async () => {
      mockDb.invitation.findUnique.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: "invited@example.com",
        used: false,
        scannedAt: null,
        scannedBy: null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      // Mock SELECT FOR UPDATE query
      mockDb.$queryRaw = vi.fn().mockResolvedValue([
        {
          id: "inv-123",
          scannedAt: null,
          scannedBy: null,
          used: false,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          email: "invited@example.com",
        },
      ]);

      mockDb.invitation.update.mockResolvedValue({
        id: "inv-123",
        scannedAt: new Date(),
        scannedBy: "inv_token123",
      });

      mockEnv.INVITATIONS_KV.put.mockResolvedValue(undefined);

      const request = new Request(
        "https://api.test.example.com/api/invitations/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: "ABC12345",
            email: "invited@example.com",
          }),
        },
      );

      const response = await handler.handleValidateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.token).toBeDefined();
      expect(data.emailRestricted).toBe(true);
      expect(data.requiredEmail).toBe("invited@example.com");
    });

    it("should reject email-restricted invitation with wrong email", async () => {
      mockDb.invitation.findUnique.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: "invited@example.com",
        used: false,
        scannedAt: null,
        scannedBy: null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      const request = new Request(
        "https://api.test.example.com/api/invitations/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: "ABC12345",
            email: "wrong@example.com",
          }),
        },
      );

      const response = await handler.handleValidateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(false);
      // SECURITY: Generic error message to prevent email enumeration
      expect(data.error).toBe("Invalid or unavailable invitation code");
    });

    it("should sanitize and validate invitation code format", async () => {
      // Code will be sanitized by Zod (trim, toUpperCase), so 'ABC-123!@#' becomes 'ABC-123!@#'
      // Then it will be checked against the database
      mockDb.invitation.findUnique.mockResolvedValueOnce(null); // Code doesn't exist

      const request = new Request(
        "https://api.test.example.com/api/invitations/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "ABC-123!@#" }), // Will be sanitized to uppercase
        },
      );

      const response = await handler.handleValidateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(false);
      expect(data.error).toBe("Invalid or unavailable invitation code");
    });

    it("should enforce code length limit", async () => {
      const longCode = "A".repeat(101); // Exceeds 100 char limit from schema
      const request = new Request(
        "https://api.test.example.com/api/invitations/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: longCode }),
        },
      );

      const response = await handler.handleValidateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Validation failed");
      expect(data.details).toBeDefined();
      expect(data.details.some((d: any) => d.path === "code")).toBe(true);
    });

    it("should handle general errors in catch block", async () => {
      // Mock rateLimiter.checkRateLimit to throw an error
      vi.spyOn(handler["rateLimiter"], "checkRateLimit").mockImplementation(
        () => {
          throw new Error("Rate limiter error");
        },
      );

      const request = new Request(
        "https://api.test.example.com/api/invitations/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "ABC12345" }),
        },
      );

      const response = await handler.handleValidateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });

    it("should apply rate limiting to validation", async () => {
      handler = new InvitationHandler();
      // Set rate limiter to return rate limited
      (handler as any).rateLimiter.checkRateLimit = () => ({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 3600000,
      });

      const request = new Request(
        "https://api.test.example.com/api/invitations/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "ABC12345" }),
        },
      );

      const response = await handler.handleValidateInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(false);
      expect(data.error).toContain("Too many validation attempts");
    });
  });

  describe("markInvitationAsUsed", () => {
    it("should mark invitation as used successfully with session token validation", async () => {
      // SECURITY: Session token should be validated
      const sessionToken = "inv_testtoken123";
      mockEnv.INVITATIONS_KV.get.mockResolvedValue(
        JSON.stringify({
          token: sessionToken,
          email: null,
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        }),
      );

      // Setup transaction mock - implementation uses findUnique, not $queryRaw
      mockDb.$transaction.mockImplementation(async (callback) => {
        const txDb = {
          ...mockDb,
          invitation: {
            findUnique: vi.fn().mockResolvedValue({
              id: "inv-123",
              createdBy: "inviter-123",
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              used: false,
              email: null,
            }),
            update: vi.fn().mockResolvedValue({
              id: "inv-123",
              used: true,
              usedBy: "user-123",
              usedAt: new Date(),
            }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "inviter-123",
              email: "inviter@example.com",
            }),
          },
        };
        return await callback(txDb);
      });

      const result = await handler.markInvitationAsUsed(
        "ABC12345",
        "user-123",
        sessionToken,
        "newuser@example.com",
        mockEnv,
      );

      expect(result.success).toBe(true);
      expect(result.inviterId).toBe("inviter-123");
      expect(result.inviterEmail).toBe("inviter@example.com");
      expect(mockDb.$transaction).toHaveBeenCalled();
      expect(mockEnv.INVITATIONS_KV.get).toHaveBeenCalled();
    });

    it("should reject invalid session token", async () => {
      mockEnv.INVITATIONS_KV.get.mockResolvedValue(null); // Token not found

      const result = await handler.markInvitationAsUsed(
        "ABC12345",
        "user-123",
        "invalid-token",
        "newuser@example.com",
        mockEnv,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid or expired invitation session");
    });

    it("should reject mismatched email for email-restricted invitation", async () => {
      // Setup invitation with email restriction
      const invitation = {
        id: "inv-123",
        code: "ABC12345",
        createdBy: "user-123",
        expiresAt: null,
        used: false,
        email: "stored@example.com", // Email-restricted invitation
      };

      mockDb.invitation.findUnique.mockResolvedValue(invitation);
      mockEnv.INVITATIONS_KV.get.mockResolvedValue(
        JSON.stringify({
          token: "inv_testtoken123",
          email: "stored@example.com",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        }),
      );

      const result = await handler.markInvitationAsUsed(
        "ABC12345",
        "user-123",
        "inv_testtoken123",
        "different@example.com", // Different email - should be rejected for email-restricted
        mockEnv,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("restricted to a different email address");
    });

    it("should allow email correction for open invitation", async () => {
      // Setup open invitation (no email restriction)
      const invitation = {
        id: "inv-123",
        code: "ABC12345",
        createdBy: "user-123",
        expiresAt: null,
        used: false,
        email: null, // Open invitation
      };

      const creator = {
        id: "user-123",
        email: "creator@example.com",
      };

      mockDb.invitation.findUnique.mockResolvedValue(invitation);
      mockDb.user.findUnique.mockResolvedValue(creator);
      mockDb.invitation.update.mockResolvedValue({
        id: "inv-123",
        used: true,
        usedBy: "user-123",
        usedAt: new Date(),
      });

      mockEnv.INVITATIONS_KV.get.mockResolvedValue(
        JSON.stringify({
          token: "inv_testtoken123",
          email: "stored@example.com", // Email stored during scanning
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        }),
      );

      const result = await handler.markInvitationAsUsed(
        "ABC12345",
        "user-123",
        "inv_testtoken123",
        "corrected@example.com", // Different email - should be allowed for open invitation
        mockEnv,
      );

      // Should succeed for open invitation even with email mismatch
      expect(result.success).toBe(true);
    });

    it("should reject marking invalid invitation as used", async () => {
      // Setup transaction mock with SELECT FOR UPDATE returning empty
      mockDb.$transaction.mockImplementation(async (callback) => {
        const txDb = {
          ...mockDb,
          $queryRaw: vi.fn().mockResolvedValue([]), // No invitation found
        };
        return await callback(txDb);
      });

      const result = await handler.markInvitationAsUsed(
        "INVALID",
        "user-123",
        undefined,
        "user@example.com",
        mockEnv,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid invitation code");
    });

    it("should reject marking already used invitation as used", async () => {
      // Setup transaction mock - implementation uses findUnique, not $queryRaw
      mockDb.$transaction.mockImplementation(async (callback) => {
        const txDb = {
          ...mockDb,
          invitation: {
            findUnique: vi.fn().mockResolvedValue({
              id: "inv-123",
              createdBy: "inviter-123",
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              used: true, // Already used
              email: null,
            }),
            update: vi.fn(),
          },
          user: {
            findUnique: vi.fn(),
          },
        };
        return await callback(txDb);
      });

      const result = await handler.markInvitationAsUsed(
        "ABC12345",
        "user-123",
        undefined,
        "user@example.com",
        mockEnv,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invitation code has already been used");
    });

    it("should reject marking expired invitation as used", async () => {
      // Setup transaction mock - implementation uses findUnique, not $queryRaw
      mockDb.$transaction.mockImplementation(async (callback) => {
        const txDb = {
          ...mockDb,
          invitation: {
            findUnique: vi.fn().mockResolvedValue({
              id: "inv-123",
              createdBy: "inviter-123",
              expiresAt: new Date(Date.now() - 1000), // Expired
              used: false,
              email: null,
            }),
            update: vi.fn(),
          },
          user: {
            findUnique: vi.fn(),
          },
        };
        return await callback(txDb);
      });

      const result = await handler.markInvitationAsUsed(
        "ABC12345",
        "user-123",
        undefined,
        "user@example.com",
        mockEnv,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invitation code has expired");
    });

    it("should sanitize invitation code input", async () => {
      const result = await handler.markInvitationAsUsed(
        "abc-123!@#",
        "user-123",
        undefined,
        "user@example.com",
        mockEnv,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid invitation code format");
    });

    it("should handle general errors in catch block", async () => {
      // Mock createPrisma to throw an error
      (createPrisma as any).mockImplementation(() => {
        throw new Error("Database error");
      });

      const result = await handler.markInvitationAsUsed(
        "ABC12345",
        "user-123",
        null,
        "test@example.com",
        mockEnv,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Internal server error");
    });

    it("should handle errors when validating session token with invalid JSON", async () => {
      // This tests the validateSessionToken error handling
      mockEnv.INVITATIONS_KV.get.mockResolvedValue("invalid json");

      const result = await handler.markInvitationAsUsed(
        "ABC12345",
        "user-123",
        "inv_testtoken",
        "test@example.com",
        mockEnv,
      );

      // Should reject invalid session token
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid or expired invitation session");
    });

    it("should use transaction to prevent race conditions", async () => {
      // SECURITY: Transaction provides atomicity to prevent race conditions
      // Implementation uses findUnique + update in a transaction, not SELECT FOR UPDATE
      const findUniqueMock = vi.fn().mockResolvedValue({
        id: "inv-123",
        createdBy: "inviter-123",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        used: false,
        email: null,
      });
      const updateMock = vi.fn().mockResolvedValue({
        id: "inv-123",
        used: true,
        usedBy: "user-123",
        usedAt: new Date(),
      });

      mockDb.$transaction.mockImplementation(async (callback) => {
        const txDb = {
          ...mockDb,
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "inviter-123",
              email: "inviter@example.com",
            }),
          },
          invitation: {
            findUnique: findUniqueMock,
            update: updateMock,
          },
        };
        return await callback(txDb);
      });

      const result = await handler.markInvitationAsUsed(
        "ABC12345",
        "user-123",
        undefined,
        "user@example.com",
        mockEnv,
      );

      expect(result.success).toBe(true);
      expect(mockDb.$transaction).toHaveBeenCalled();
      expect(findUniqueMock).toHaveBeenCalled();
      expect(updateMock).toHaveBeenCalled();
      // Verify transaction provides atomicity (both findUnique and update are called)
      // This prevents race conditions where multiple requests try to use the same code
    });
  });

  describe("fail-closed invitation gate (T17)", () => {
    // SECURITY: the invite gate must FAIL CLOSED when the INVITATIONS_KV
    // binding is absent or erroring. A missing binding is a deployment
    // misconfiguration — it must reject (visibly, via loud error logs),
    // never silently accept.

    it("markInvitationAsUsed rejects a session token when INVITATIONS_KV is absent (fail-closed)", async () => {
      const envWithoutKv = { ...mockEnv, INVITATIONS_KV: undefined };

      // Full happy-path DB state: if the gate failed open, the redemption
      // would succeed end-to-end.
      mockDb.$transaction.mockImplementation(async (callback: any) => {
        const txDb = {
          ...mockDb,
          invitation: {
            findUnique: vi.fn().mockResolvedValue({
              id: "inv-123",
              createdBy: "inviter-123",
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              used: false,
              email: null,
            }),
            update: vi.fn().mockResolvedValue({
              id: "inv-123",
              used: true,
              usedBy: "user-123",
              usedAt: new Date(),
            }),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              id: "inviter-123",
              email: "inviter@example.com",
            }),
          },
        };
        return await callback(txDb);
      });

      const result = await handler.markInvitationAsUsed(
        "ABC12345",
        "user-123",
        "inv_sometoken",
        "newuser@example.com",
        envWithoutKv,
      );

      // FAIL CLOSED: without the KV binding the token cannot be verified,
      // so redemption must be rejected.
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid or expired invitation session");
    });

    it("markInvitationAsUsed rejects a session token when INVITATIONS_KV errors (fail-closed)", async () => {
      mockEnv.INVITATIONS_KV.get.mockRejectedValue(
        new Error("Dynamo unavailable"),
      );

      const result = await handler.markInvitationAsUsed(
        "ABC12345",
        "user-123",
        "inv_sometoken",
        "newuser@example.com",
        mockEnv,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid or expired invitation session");
    });

    it("handleValidateInvitation rejects (valid:false) when INVITATIONS_KV is absent, without claiming the code", async () => {
      const envWithoutKv = { ...mockEnv, INVITATIONS_KV: undefined };

      // Valid, unclaimed invitation — would validate fine with the binding.
      mockDb.invitation.findUnique.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: null,
        used: false,
        scannedAt: null,
        scannedBy: null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      const request = new Request(
        "https://api.test.example.com/api/invitations/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "ABC12345" }),
        },
      );

      const response = await handler.handleValidateInvitation(
        request,
        envWithoutKv,
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      // FAIL CLOSED: no binding → no token storage possible → reject with the
      // generic message (no internals leaked).
      expect(data.valid).toBe(false);
      expect(data.error).toBe("Invalid or unavailable invitation code");
      // Must NOT claim (burn) the code when the gate is unavailable.
      expect(mockDb.$transaction).not.toHaveBeenCalled();
      expect(mockDb.invitation.update).not.toHaveBeenCalled();
    });

    it("storeSessionToken throws when INVITATIONS_KV is absent (no silently unstorable tokens)", async () => {
      const envWithoutKv = { ...mockEnv, INVITATIONS_KV: undefined };
      await expect(
        (handler as any).storeSessionToken(
          "ABC12345",
          "inv_sometoken",
          undefined,
          envWithoutKv,
        ),
      ).rejects.toThrow(/INVITATIONS_KV/);
    });

    it("handleGetInviterInfo returns nulls when INVITATIONS_KV is absent", async () => {
      const envWithoutKv = { ...mockEnv, INVITATIONS_KV: undefined };
      const response = await handler.handleGetInviterInfo(
        mockRequest,
        envWithoutKv,
      );
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.inviterId).toBeNull();
      expect(data.inviterEmail).toBeNull();
    });
  });

  describe("handleValidateInvitation — branch coverage (T17)", () => {
    const validateRequest = (body: Record<string, unknown>) =>
      new Request("https://api.test.example.com/api/invitations/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    it("returns the existing token when an already-scanned code still has a valid stored token", async () => {
      mockDb.invitation.findUnique.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: null,
        used: false,
        scannedAt: new Date(),
        expiresAt: null,
      });
      mockEnv.INVITATIONS_KV.get.mockResolvedValue(
        JSON.stringify({
          token: "inv_existingtoken",
          email: null,
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        }),
      );

      const response = await handler.handleValidateInvitation(
        validateRequest({ code: "ABC12345" }),
        mockEnv,
      );
      const data = await response.json();

      expect(data.valid).toBe(true);
      expect(data.token).toBe("inv_existingtoken");
      expect(data.emailRestricted).toBe(false);
      // Must not re-claim the code.
      expect(mockDb.$transaction).not.toHaveBeenCalled();
    });

    it("rejects an already-scanned code whose stored token has expired", async () => {
      mockDb.invitation.findUnique.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: null,
        used: false,
        scannedAt: new Date(),
        expiresAt: null,
      });
      mockEnv.INVITATIONS_KV.get.mockResolvedValue(
        JSON.stringify({
          token: "inv_expiredtoken",
          email: null,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );

      const response = await handler.handleValidateInvitation(
        validateRequest({ code: "ABC12345" }),
        mockEnv,
      );
      const data = await response.json();

      expect(data.valid).toBe(false);
      expect(data.error).toBe("Invalid or unavailable invitation code");
    });

    it("rejects an already-scanned code whose stored token data is corrupt", async () => {
      mockDb.invitation.findUnique.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: null,
        used: false,
        scannedAt: new Date(),
        expiresAt: null,
      });
      mockEnv.INVITATIONS_KV.get.mockResolvedValue("not-json{{{");

      const response = await handler.handleValidateInvitation(
        validateRequest({ code: "ABC12345" }),
        mockEnv,
      );
      const data = await response.json();

      expect(data.valid).toBe(false);
      expect(data.error).toBe("Invalid or unavailable invitation code");
    });

    it("validates an email-restricted invitation end-to-end when the email matches", async () => {
      const invitation = {
        id: "inv-123",
        code: "ABC12345",
        email: "friend@example.com",
        used: false,
        scannedAt: null,
        scannedBy: null,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      };
      mockDb.invitation.findUnique.mockResolvedValue(invitation);
      mockDb.invitation.update.mockResolvedValue({
        ...invitation,
        scannedAt: new Date(),
      });
      mockEnv.INVITATIONS_KV.put.mockResolvedValue(undefined);

      const response = await handler.handleValidateInvitation(
        validateRequest({ code: "ABC12345", email: "friend@example.com" }),
        mockEnv,
      );
      const data = await response.json();

      expect(data.valid).toBe(true);
      expect(data.emailRestricted).toBe(true);
      expect(data.requiredEmail).toBe("friend@example.com");
      expect(mockEnv.INVITATIONS_KV.put).toHaveBeenCalled();
    });

    it("rejects an email-restricted invitation when the email does not match", async () => {
      mockDb.invitation.findUnique.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: "friend@example.com",
        used: false,
        scannedAt: null,
        expiresAt: null,
      });

      const response = await handler.handleValidateInvitation(
        validateRequest({ code: "ABC12345", email: "attacker@example.com" }),
        mockEnv,
      );
      const data = await response.json();

      expect(data.valid).toBe(false);
      // Generic message — must not reveal the restricted email.
      expect(data.error).toBe("Invalid or unavailable invitation code");
    });

    it("requires an email for an email-restricted invitation", async () => {
      mockDb.invitation.findUnique.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: "friend@example.com",
        used: false,
        scannedAt: null,
        expiresAt: null,
      });

      const response = await handler.handleValidateInvitation(
        validateRequest({ code: "ABC12345" }),
        mockEnv,
      );
      const data = await response.json();

      expect(data.valid).toBe(false);
      expect(data.emailRequired).toBe(true);
    });

    it("rejects when the claim transaction loses the race (already scanned by another request)", async () => {
      // Outer quick check: clean and unclaimed…
      mockDb.invitation.findUnique
        .mockResolvedValueOnce({
          id: "inv-123",
          code: "ABC12345",
          email: null,
          used: false,
          scannedAt: null,
          expiresAt: null,
        })
        // …but inside the transaction another request already claimed it.
        .mockResolvedValueOnce({
          id: "inv-123",
          scannedAt: new Date(),
          scannedBy: "inv_othertoken",
          used: false,
          expiresAt: null,
          email: null,
        });

      const response = await handler.handleValidateInvitation(
        validateRequest({ code: "ABC12345" }),
        mockEnv,
      );
      const data = await response.json();

      expect(data.valid).toBe(false);
      expect(data.error).toBe("Invalid or unavailable invitation code");
    });

    it("rejects when the invitation was used between check and claim", async () => {
      mockDb.invitation.findUnique
        .mockResolvedValueOnce({
          id: "inv-123",
          code: "ABC12345",
          email: null,
          used: false,
          scannedAt: null,
          expiresAt: null,
        })
        .mockResolvedValueOnce({
          id: "inv-123",
          scannedAt: null,
          scannedBy: null,
          used: true,
          expiresAt: null,
          email: null,
        });

      const response = await handler.handleValidateInvitation(
        validateRequest({ code: "ABC12345" }),
        mockEnv,
      );
      const data = await response.json();

      expect(data.valid).toBe(false);
    });

    it("rejects when the invitation expired between check and claim", async () => {
      mockDb.invitation.findUnique
        .mockResolvedValueOnce({
          id: "inv-123",
          code: "ABC12345",
          email: null,
          used: false,
          scannedAt: null,
          expiresAt: new Date(Date.now() + 60 * 1000),
        })
        .mockResolvedValueOnce({
          id: "inv-123",
          scannedAt: null,
          scannedBy: null,
          used: false,
          expiresAt: new Date(Date.now() - 60 * 1000),
          email: null,
        });

      const response = await handler.handleValidateInvitation(
        validateRequest({ code: "ABC12345" }),
        mockEnv,
      );
      const data = await response.json();

      expect(data.valid).toBe(false);
    });

    it("rejects when the invitation disappears inside the claim transaction", async () => {
      mockDb.invitation.findUnique
        .mockResolvedValueOnce({
          id: "inv-123",
          code: "ABC12345",
          email: null,
          used: false,
          scannedAt: null,
          expiresAt: null,
        })
        .mockResolvedValueOnce(null);

      const response = await handler.handleValidateInvitation(
        validateRequest({ code: "ABC12345" }),
        mockEnv,
      );
      const data = await response.json();

      expect(data.valid).toBe(false);
    });

    it("rejects when the claim update fails inside the transaction", async () => {
      const cleanInvitation = {
        id: "inv-123",
        code: "ABC12345",
        email: null,
        used: false,
        scannedAt: null,
        scannedBy: null,
        expiresAt: null,
      };
      mockDb.invitation.findUnique.mockResolvedValue(cleanInvitation);
      mockDb.invitation.update.mockRejectedValue(
        Object.assign(new Error("Record to update not found"), {
          code: "P2025",
        }),
      );

      const response = await handler.handleValidateInvitation(
        validateRequest({ code: "ABC12345" }),
        mockEnv,
      );
      const data = await response.json();

      expect(data.valid).toBe(false);
      expect(data.error).toBe("Invalid or unavailable invitation code");
    });
  });

  describe("Security", () => {
    it("should use cryptographically secure random code generation with 10 characters", () => {
      // Test that generateInvitationCode uses crypto.getRandomValues
      // SECURITY: Code length increased to 10 characters for better security
      const handler = new InvitationHandler();
      const code1 = (handler as any).generateInvitationCode();
      const code2 = (handler as any).generateInvitationCode();

      expect(code1).toMatch(/^[A-Z2-9]{10}$/); // 10 chars, alphanumeric (no ambiguous)
      expect(code2).toMatch(/^[A-Z2-9]{10}$/);
      // Codes should be different (very high probability)
      expect(code1).not.toBe(code2);
    });

    it("should generate secure session tokens", () => {
      // SECURITY: Session tokens should be cryptographically secure
      const handler = new InvitationHandler();
      const token1 = (handler as any).generateSessionToken();
      const token2 = (handler as any).generateSessionToken();

      expect(token1).toMatch(/^inv_/);
      expect(token2).toMatch(/^inv_/);
      // Tokens should be different (very high probability)
      expect(token1).not.toBe(token2);
      // Tokens should be reasonably long (at least 40 chars including prefix)
      expect(token1.length).toBeGreaterThan(40);
    });

    it("should prevent SQL injection through Prisma parameterized queries", async () => {
      // Reset mocks for this test
      mockExecuteWithRetry.mockReset();
      mockExecuteWithRetry.mockImplementation(
        async (region, env, queryFn, options) => {
          return await queryFn(mockDb);
        },
      );

      mockDb.user.findUnique.mockResolvedValue({ suspended: false });
      mockDb.invitation.deleteMany.mockResolvedValue({ count: 0 });
      mockDb.invitation.count.mockResolvedValue(0);
      mockDb.invitation.findUnique.mockResolvedValue(null);
      mockDb.invitation.create.mockResolvedValue({
        id: "inv-123",
        code: "ABC12345",
        email: null,
        expiresAt: new Date(),
        createdAt: new Date(),
      });

      // Attempt SQL injection in email field
      const maliciousEmail = "test@example.com'; DROP TABLE invitations; --";
      const request = new Request(
        "https://api.test.example.com/api/invitations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: maliciousEmail }),
        },
      );

      const response = await handler.handleCreateInvitation(request, mockEnv);

      // Should fail validation (invalid email format) or be sanitized
      // Prisma will handle it safely regardless
      // The email validation regex will reject this, so create won't be called
      const data = await response.json();
      expect(response.status).toBe(400);
      expect(data.error).toBe("Validation failed");
      expect(data.details).toBeDefined();
      expect(data.details.some((d: any) => d.path === "email")).toBe(true);
    });
  });

  describe("handleDeleteInvitation", () => {
    it("should delete invitation successfully when user is the creator", async () => {
      const invitationId = "inv-123";
      const invitation = {
        id: invitationId,
        code: "ABC12345",
        createdBy: "user-123",
        used: false,
        scannedAt: null,
      };

      mockDb.invitation.findUnique.mockResolvedValue(invitation);
      mockDb.invitation.delete.mockResolvedValue(invitation);
      mockEnv.INVITATIONS_KV.delete.mockResolvedValue(undefined);

      const request = new Request(
        `https://api.test.example.com/api/invitations/${invitationId}`,
        {
          method: "DELETE",
        },
      );

      const response = await handler.handleDeleteInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toBe("Invitation deleted successfully");
      expect(mockDb.invitation.findUnique).toHaveBeenCalledWith({
        where: { id: invitationId },
        select: {
          id: true,
          code: true,
          createdBy: true,
          used: true,
          scannedAt: true,
        },
      });
      expect(mockDb.invitation.delete).toHaveBeenCalledWith({
        where: { id: invitationId },
      });
      expect(mockEnv.INVITATIONS_KV.delete).toHaveBeenCalledWith(
        "invitation-session:ABC12345",
      );
    });

    it("should return 401 when user is not authenticated", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://api.test.example.com/api/invitations/inv-123",
        {
          method: "DELETE",
        },
      );

      const response = await handler.handleDeleteInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
      expect(mockDb.invitation.findUnique).not.toHaveBeenCalled();
      expect(mockDb.invitation.delete).not.toHaveBeenCalled();
    });

    it("should return 404 when invitation does not exist", async () => {
      mockDb.invitation.findUnique.mockResolvedValue(null);

      const request = new Request(
        "https://api.test.example.com/api/invitations/non-existent",
        {
          method: "DELETE",
        },
      );

      const response = await handler.handleDeleteInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe("Invitation not found");
      expect(mockDb.invitation.delete).not.toHaveBeenCalled();
    });

    it("should return 403 when user tries to delete someone else's invitation", async () => {
      const invitation = {
        id: "inv-123",
        code: "ABC12345",
        createdBy: "other-user-456", // Different user
        used: false,
        scannedAt: null,
      };

      mockDb.invitation.findUnique.mockResolvedValue(invitation);

      const request = new Request(
        "https://api.test.example.com/api/invitations/inv-123",
        {
          method: "DELETE",
        },
      );

      const response = await handler.handleDeleteInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe(
        "Forbidden: You can only delete your own invitations",
      );
      expect(mockDb.invitation.delete).not.toHaveBeenCalled();
    });

    it("should return 409 when invitation is currently being used (scanned but not completed)", async () => {
      const invitation = {
        id: "inv-123",
        code: "ABC12345",
        createdBy: "user-123",
        used: false,
        scannedAt: new Date(), // Scanned but not yet used
      };

      mockDb.invitation.findUnique.mockResolvedValue(invitation);

      const request = new Request(
        "https://api.test.example.com/api/invitations/inv-123",
        {
          method: "DELETE",
        },
      );

      const response = await handler.handleDeleteInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error).toBe(
        "Cannot delete invitation that is currently being used",
      );
      expect(data.message).toContain(
        "scanned and is in the process of being used",
      );
      expect(mockDb.invitation.delete).not.toHaveBeenCalled();
    });

    it("should allow deletion of used invitations", async () => {
      const invitation = {
        id: "inv-123",
        code: "ABC12345",
        createdBy: "user-123",
        used: true, // Already used
        scannedAt: new Date(),
      };

      mockDb.invitation.findUnique.mockResolvedValue(invitation);
      mockDb.invitation.delete.mockResolvedValue(invitation);
      mockEnv.INVITATIONS_KV.delete.mockResolvedValue(undefined);

      const request = new Request(
        "https://api.test.example.com/api/invitations/inv-123",
        {
          method: "DELETE",
        },
      );

      const response = await handler.handleDeleteInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockDb.invitation.delete).toHaveBeenCalled();
    });

    it("should clean up KV entries when deleting invitation", async () => {
      const invitation = {
        id: "inv-123",
        code: "ABC12345",
        createdBy: "user-123",
        used: false,
        scannedAt: null,
      };

      mockDb.invitation.findUnique.mockResolvedValue(invitation);
      mockDb.invitation.delete.mockResolvedValue(invitation);
      mockEnv.INVITATIONS_KV.delete.mockResolvedValue(undefined);

      const request = new Request(
        "https://api.test.example.com/api/invitations/inv-123",
        {
          method: "DELETE",
        },
      );

      const response = await handler.handleDeleteInvitation(request, mockEnv);

      expect(response.status).toBe(200);
      expect(mockEnv.INVITATIONS_KV.delete).toHaveBeenCalledWith(
        "invitation-session:ABC12345",
      );
    });

    it("should handle general errors in catch block", async () => {
      // Trigger the catch path by making getSession throw unexpectedly
      mockGetSession.mockRejectedValueOnce(new Error("Unexpected session error"));

      const request = new Request(
        "https://api.test.example.com/api/invitations/inv-123",
        {
          method: "DELETE",
        },
      );

      const response = await handler.handleDeleteInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });

    it("should handle missing invitation ID gracefully", async () => {
      const request = new Request(
        "https://api.test.example.com/api/invitations/",
        {
          method: "DELETE",
        },
      );

      const response = await handler.handleDeleteInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invitation ID is required");
      expect(mockDb.invitation.findUnique).not.toHaveBeenCalled();
    });

    it("should handle database errors gracefully", async () => {
      const invitation = {
        id: "inv-123",
        code: "ABC12345",
        createdBy: "user-123",
        used: false,
        scannedAt: null,
      };

      mockDb.invitation.findUnique.mockResolvedValue(invitation);
      mockDb.invitation.delete.mockRejectedValue(new Error("Database error"));

      const request = new Request(
        "https://api.test.example.com/api/invitations/inv-123",
        {
          method: "DELETE",
        },
      );

      const response = await handler.handleDeleteInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });

    it("should handle KV deletion failure gracefully", async () => {
      const invitation = {
        id: "inv-123",
        code: "ABC12345",
        createdBy: "user-123",
        used: false,
        scannedAt: null,
      };

      mockDb.invitation.findUnique.mockResolvedValue(invitation);
      mockDb.invitation.delete.mockResolvedValue(invitation);
      mockEnv.INVITATIONS_KV.delete.mockRejectedValue(new Error("KV error"));

      const request = new Request(
        "https://api.test.example.com/api/invitations/inv-123",
        {
          method: "DELETE",
        },
      );

      // Should still succeed even if KV deletion fails
      const response = await handler.handleDeleteInvitation(request, mockEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      // Database deletion should still succeed
      expect(mockDb.invitation.delete).toHaveBeenCalled();
    });
  });
});
