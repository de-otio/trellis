/**
 * Unit Tests: Badge Handler
 *
 * Tests for user badge retrieval and display preference management.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { BadgeHandler } from "../../src/lib/badge-handler.js";

// Mock Prisma client
const mockPrisma = {
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));


// Mock user-badge
vi.mock("../../src/lib/user-badge", () => ({
  getUserBadges: vi.fn(),
}));

// Mock validate-request
const mockValidateRequest = vi.fn();
vi.mock("../../src/lib/validate-request", () => ({
  validateRequest: mockValidateRequest,
}));

// Mock schemas
vi.mock("../../src/lib/schemas", () => ({
  badgeSchema: {},
}));

describe("BadgeHandler", () => {
  let handler: BadgeHandler;
  let mockEnv: Env;
  let mockSession: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    handler = new BadgeHandler();

    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
    } as Env;

    mockSession = {
      userId: "user123",
      email: "user@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 3600000,
      sessionType: "user",
      lastActivityAt: Date.now(),
    };

    const { getUserBadges } = await import("../../src/lib/user-badge.js");
    vi.mocked(getUserBadges).mockReturnValue([]);
  });

  describe("handleGetUserBadges", () => {
    it("should return badges for user", async () => {
      const mockUser = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: false,
        identityVerifiedAt: null,
        showIdentityVerifiedBadge: false,
        identityVerificationMethod: null,
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      const { getUserBadges } = await import("../../src/lib/user-badge.js");
      vi.mocked(getUserBadges).mockReturnValue([
        { type: "verified", display: true },
      ]);

      const request = new Request(
        "https://api.example.com/api/users/user123/badges",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetUserBadges(
        request,
        mockEnv,
        "user123",
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.badges).toBeDefined();
      expect(body.count).toBe(1);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user123" },
        select: expect.objectContaining({
          emailVerified: true,
          showVerifiedBadge: true,
        }),
      });
    });

    it("should return 404 if user not found", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const request = new Request(
        "https://api.example.com/api/users/user123/badges",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetUserBadges(
        request,
        mockEnv,
        "user123",
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("User not found");
    });

    it("should return empty badges array when user has no badges", async () => {
      const mockUser = {
        emailVerified: false,
        emailVerifiedAt: null,
        showVerifiedBadge: false,
        identityVerified: false,
        identityVerifiedAt: null,
        showIdentityVerifiedBadge: false,
        identityVerificationMethod: null,
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      const { getUserBadges } = await import("../../src/lib/user-badge.js");
      vi.mocked(getUserBadges).mockReturnValue([]);

      const request = new Request(
        "https://api.example.com/api/users/user123/badges",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetUserBadges(
        request,
        mockEnv,
        "user123",
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.badges).toEqual([]);
      expect(body.count).toBe(0);
    });

    it("should return 500 on database error", async () => {
      mockPrisma.user.findUnique.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const request = new Request(
        "https://api.example.com/api/users/user123/badges",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetUserBadges(
        request,
        mockEnv,
        "user123",
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Internal server error");
    });

    it("should call getUserBadges with correct user data", async () => {
      const mockUser = {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        showVerifiedBadge: true,
        identityVerified: true,
        identityVerifiedAt: new Date(),
        showIdentityVerifiedBadge: true,
        identityVerificationMethod: "government_id",
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      const { getUserBadges } = await import("../../src/lib/user-badge.js");
      vi.mocked(getUserBadges).mockReturnValue([
        { type: "verified", display: true },
        { type: "identity_verified", display: true },
      ]);

      const request = new Request(
        "https://api.example.com/api/users/user123/badges",
        {
          method: "GET",
        },
      );

      await handler.handleGetUserBadges(request, mockEnv, "user123");

      expect(getUserBadges).toHaveBeenCalledWith(mockUser);
    });
  });

  describe("handleUpdateBadgeDisplay", () => {
    it("should update badge display preference", async () => {
      mockGetSession.mockResolvedValue(mockSession);
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { showVerifiedBadge: true },
      });
      mockPrisma.user.update.mockResolvedValue({
        id: "user123",
        showVerifiedBadge: true,
      });

      const request = new Request(
        "https://api.example.com/api/users/user123/badges/display",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ showVerifiedBadge: true }),
        },
      );

      const response = await handler.handleUpdateBadgeDisplay(
        request,
        mockEnv,
        "user123",
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "user123" },
        data: { showVerifiedBadge: true },
      });
    });

    it("should return 401 if not authenticated", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://api.example.com/api/users/user123/badges/display",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ showVerifiedBadge: true }),
        },
      );

      const response = await handler.handleUpdateBadgeDisplay(
        request,
        mockEnv,
        "user123",
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("should return 403 if user tries to update another user badge", async () => {
      mockGetSession.mockResolvedValue(mockSession);

      const request = new Request(
        "https://api.example.com/api/users/other-user/badges/display",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ showVerifiedBadge: true }),
        },
      );

      const response = await handler.handleUpdateBadgeDisplay(
        request,
        mockEnv,
        "other-user",
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Forbidden");
    });

    it("should return validation error if request invalid", async () => {
      mockGetSession.mockResolvedValue(mockSession);
      mockValidateRequest.mockResolvedValue({
        success: false,
        error: new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      });

      const request = new Request(
        "https://api.example.com/api/users/user123/badges/display",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ showVerifiedBadge: "invalid" }),
        },
      );

      const response = await handler.handleUpdateBadgeDisplay(
        request,
        mockEnv,
        "user123",
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid request body");
    });

    it("should update showVerifiedBadge to false", async () => {
      mockGetSession.mockResolvedValue(mockSession);
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { showVerifiedBadge: false },
      });
      mockPrisma.user.update.mockResolvedValue({
        id: "user123",
        showVerifiedBadge: false,
      });

      const request = new Request(
        "https://api.example.com/api/users/user123/badges/display",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ showVerifiedBadge: false }),
        },
      );

      const response = await handler.handleUpdateBadgeDisplay(
        request,
        mockEnv,
        "user123",
      );

      expect(response.status).toBe(200);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "user123" },
        data: { showVerifiedBadge: false },
      });
    });

    it("should return 500 on database error", async () => {
      mockGetSession.mockResolvedValue(mockSession);
      mockValidateRequest.mockResolvedValue({
        success: true,
        data: { showVerifiedBadge: true },
      });
      mockPrisma.user.update.mockRejectedValue(
        new Error("Database update failed"),
      );

      const request = new Request(
        "https://api.example.com/api/users/user123/badges/display",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ showVerifiedBadge: true }),
        },
      );

      const response = await handler.handleUpdateBadgeDisplay(
        request,
        mockEnv,
        "user123",
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Internal server error");
    });
  });
});
