/**
 * Unit Tests: Deletion Routes
 *
 * Tests for account deletion route handlers including request, confirm, cancel, and status.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { deletionRoutes } from "../../../src/lib/routes/deletion.js";
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

// Mock RateLimiter
const mockApplyRateLimitKV = vi.fn();
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = mockApplyRateLimitKV;
  },
}));

// Mock Validator
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));

// Mock UserDeletionHandlerEnhanced
const mockRequestDeletion = vi.fn();
const mockConfirmDeletion = vi.fn();
const mockCancelDeletion = vi.fn();
vi.mock("../../../src/lib/user-deletion-handler-enhanced", () => ({
  UserDeletionHandlerEnhanced: class {
    requestDeletion = mockRequestDeletion;
    confirmDeletion = mockConfirmDeletion;
    cancelDeletion = mockCancelDeletion;
  },
}));

// Mock createPrisma for status endpoint
const mockUserFindUnique = vi.fn();
vi.mock("../../../src/db", () => ({
  createPrisma: vi.fn(() => ({
    user: { findUnique: mockUserFindUnique },
  })),
}));

// Mock validateRequest
const mockValidateRequest = vi.fn();
vi.mock("../../../src/lib/validate-request", () => ({
  validateRequest: (...args: any[]) => mockValidateRequest(...args),
}));

// Mock deleteAccountConfirmationSchema
vi.mock("../../../src/lib/schemas", () => ({
  deleteAccountConfirmationSchema: {
    parse: vi.fn(),
  },
}));


describe("Deletion Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequest: Request;

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

    mockRequest = new Request("https://example.com/api/user/delete-account", {
      method: "DELETE",
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockApplyRateLimitKV.mockResolvedValue(null);
  });

  describe("DELETE /api/user/delete-account - Request account deletion", () => {
    const route = deletionRoutes.find(
      (r) => r.method === "DELETE" && r.path === "/api/user/delete-account",
    );

    it("should request account deletion successfully", async () => {
      mockRequestDeletion.mockResolvedValue({
        success: true,
        jobId: "job-123",
      });

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockApplyRateLimitKV).toHaveBeenCalledWith(
        mockEnv,
        mockRequest,
        "/api/user/delete-account",
        3,
        3600,
        undefined,
        undefined,
        "user-123",
      );
      expect(mockRequestDeletion).toHaveBeenCalledWith(mockSession, mockEnv);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ success: true, jobId: "job-123" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      await route!.handler(mockRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockRequestDeletion).not.toHaveBeenCalled();
    });

    it("should handle rate limiting", async () => {
      const rateLimitResponse = new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429 },
      );
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(rateLimitResponse);
      expect(mockRequestDeletion).not.toHaveBeenCalled();
    });

    it("should handle errors from UserDeletionHandlerEnhanced", async () => {
      const error = new Error("Failed to create deletion job");
      mockRequestDeletion.mockRejectedValue(error);

      await route!.handler(mockRequest, mockEnv);

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Failed to create deletion job" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });

    it("should return 400 when deletion request fails", async () => {
      mockRequestDeletion.mockResolvedValue({
        success: false,
        message: "Invalid request",
      });

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ success: false, message: "Invalid request" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("POST /api/user/delete-account/confirm - Confirm account deletion", () => {
    const route = deletionRoutes.find(
      (r) =>
        r.method === "POST" && r.path === "/api/user/delete-account/confirm",
    );

    it("should confirm account deletion successfully", async () => {
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { confirmationCode: "CODE123" },
      });
      mockConfirmDeletion.mockResolvedValue({ success: true });

      const postRequest = new Request(
        "https://example.com/api/user/delete-account/confirm",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ confirmationCode: "CODE123" }),
        },
      );

      const response = await route!.handler(postRequest, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(postRequest, "test-secret", mockEnv);
      expect(mockValidateRequest).toHaveBeenCalled();
      expect(mockConfirmDeletion).toHaveBeenCalledWith(
        "user-123",
        "CODE123",
        mockEnv,
      );
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ success: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const postRequest = new Request(
        "https://example.com/api/user/delete-account/confirm",
        {
          method: "POST",
        },
      );

      await route!.handler(postRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockConfirmDeletion).not.toHaveBeenCalled();
    });

    it("should handle validation errors", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Invalid confirmation code" }),
        { status: 400 },
      );
      mockValidateRequest.mockResolvedValue({
        success: false,
        error: errorResponse,
      });

      const postRequest = new Request(
        "https://example.com/api/user/delete-account/confirm",
        {
          method: "POST",
        },
      );

      const response = await route!.handler(postRequest, mockEnv);

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(errorResponse);
      expect(mockConfirmDeletion).not.toHaveBeenCalled();
    });

    it("should handle errors from UserDeletionHandlerEnhanced", async () => {
      const error = new Error("Invalid confirmation code");
      mockConfirmDeletion.mockRejectedValue(error);
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { confirmationCode: "CODE123" },
      });

      const postRequest = new Request(
        "https://example.com/api/user/delete-account/confirm",
        {
          method: "POST",
        },
      );

      await route!.handler(postRequest, mockEnv);

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Invalid confirmation code" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("POST /api/user/delete-account/cancel - Cancel account deletion", () => {
    const route = deletionRoutes.find(
      (r) =>
        r.method === "POST" && r.path === "/api/user/delete-account/cancel",
    );

    it("should cancel account deletion successfully", async () => {
      mockCancelDeletion.mockResolvedValue({ success: true });

      const postRequest = new Request(
        "https://example.com/api/user/delete-account/cancel",
        {
          method: "POST",
        },
      );

      const response = await route!.handler(postRequest, mockEnv);

      expect(mockGetSession).toHaveBeenCalledWith(postRequest, "test-secret", mockEnv);
      expect(mockCancelDeletion).toHaveBeenCalledWith(mockSession, mockEnv);
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ success: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const postRequest = new Request(
        "https://example.com/api/user/delete-account/cancel",
        {
          method: "POST",
        },
      );

      await route!.handler(postRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockCancelDeletion).not.toHaveBeenCalled();
    });

    it("should return 400 when there is no deletion request to cancel", async () => {
      // The handler throws this exact message when nothing is pending. It is a
      // client-state condition, so it must map to 400 — not 500. (Regression:
      // the old "not found" substring check missed "...request found to cancel".)
      const error = new Error("No deletion request found to cancel");
      mockCancelDeletion.mockRejectedValue(error);

      const postRequest = new Request(
        "https://example.com/api/user/delete-account/cancel",
        {
          method: "POST",
        },
      );

      const response = await route!.handler(postRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "No deletion request found to cancel" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
      expect(response.status).toBe(400);
    });

    it("should return 400 when the grace period has expired", async () => {
      const error = new Error(
        "Grace period has expired. Deletion cannot be cancelled.",
      );
      mockCancelDeletion.mockRejectedValue(error);

      const postRequest = new Request(
        "https://example.com/api/user/delete-account/cancel",
        { method: "POST" },
      );

      const response = await route!.handler(postRequest, mockEnv);

      expect(response.status).toBe(400);
    });

    it("should return 500 on an unexpected handler error", async () => {
      const error = new Error("Database connection failed");
      mockCancelDeletion.mockRejectedValue(error);

      const postRequest = new Request(
        "https://example.com/api/user/delete-account/cancel",
        { method: "POST" },
      );

      const response = await route!.handler(postRequest, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Database connection failed" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/user/delete-account/status - Get deletion status", () => {
    const route = deletionRoutes.find(
      (r) => r.method === "GET" && r.path.toString().includes("status"),
    );

    it("should return confirmed status from User model", async () => {
      const requestedAt = new Date();
      const scheduledAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const confirmedAt = new Date();

      mockUserFindUnique.mockResolvedValue({
        deletionRequestedAt: requestedAt,
        deletionScheduledAt: scheduledAt,
        deletionConfirmedAt: confirmedAt,
        suspended: true,
      });

      const getRequest = new Request(
        "https://example.com/api/user/delete-account/status",
        { method: "GET" },
      );

      await route!.handler(getRequest, mockEnv, {
        pathname: "/api/user/delete-account/status",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({
          status: "confirmed",
          requestedAt: requestedAt.toISOString(),
          scheduledAt: scheduledAt.toISOString(),
          confirmedAt: confirmedAt.toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    it("should return 'none' when no deletion requested", async () => {
      mockUserFindUnique.mockResolvedValue({
        deletionRequestedAt: null,
        deletionScheduledAt: null,
        deletionConfirmedAt: null,
        suspended: false,
      });

      const getRequest = new Request(
        "https://example.com/api/user/delete-account/status",
        { method: "GET" },
      );

      await route!.handler(getRequest, mockEnv, {
        pathname: "/api/user/delete-account/status",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ status: "none", message: "No deletion request found" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const getRequest = new Request(
        "https://example.com/api/user/delete-account/status",
        { method: "GET" },
      );

      await route!.handler(getRequest, mockEnv, {
        pathname: "/api/user/delete-account/status",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(deletionRoutes).toHaveLength(4);
      expect(deletionRoutes.some((r) => r.method === "DELETE")).toBe(true);
      expect(deletionRoutes.filter((r) => r.method === "POST")).toHaveLength(2);
      expect(deletionRoutes.some((r) => r.method === "GET")).toBe(true);
    });

    it("should have middleware configured for all routes", () => {
      deletionRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      deletionRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
