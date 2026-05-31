/**
 * Unit Tests: User Routes
 *
 * Tests for user profile management routes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { userRoutes } from "../../../src/lib/routes/user.js";
import type { Session } from "../../../src/lib/session-cookie.js";

// Mock dependencies
const mockGetSession = vi.fn();
const mockSetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
    setSession = mockSetSession;
  },
}));


const mockCreateSecureResponse = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    constructor(env: any) {}
  },
}));

const mockAddCorsHeaders = vi.fn();
vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args),
}));

const mockDetectRegionSync = vi.fn();
const mockIsValidRegion = vi.fn();
vi.mock("../../../src/lib/region-detection", () => ({
  detectRegionSync: (...args: any[]) => mockDetectRegionSync(...args),
  isValidRegion: (...args: any[]) => mockIsValidRegion(...args),
}));

const mockExecuteWithRetry = vi.fn();
vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    executeWithRetry: (...args: any[]) => mockExecuteWithRetry(...args),
  },
}));

const mockGetIPAddress = vi.fn();
vi.mock("../../../src/lib/ip-scrubber", () => ({
  getIPAddress: (...args: any[]) => mockGetIPAddress(...args),
}));

const mockSanitizeError = vi.fn();
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = (...args: any[]) => mockSanitizeError(...args);
  },
}));

describe("User Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;
  let mockSession: Session;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
      FOLLOWERS_KV: {
        delete: vi.fn().mockResolvedValue(undefined),
      } as any,
    } as Env;

    mockSession = {
      userId: "user-123",
      email: "test@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 3600000,
    };

    mockRequest = new Request("https://api.example.com/api/user/profile", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockDetectRegionSync.mockReturnValue("US");
    mockIsValidRegion.mockReturnValue(true);
    mockGetIPAddress.mockReturnValue("192.168.1.1");
    mockSanitizeError.mockImplementation((error: any) => {
      if (error instanceof Error) return error.message;
      return "An error occurred. Please try again later.";
    });

    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });

    mockAddCorsHeaders.mockImplementation((response) => response);
  });

  describe("PATCH /api/user/profile", () => {
    const route = userRoutes.find(
      (r) => r.path === "/api/user/profile" && r.method === "PATCH",
    );

    it("should update user profile with stealth_mode", async () => {
      const request = new Request("https://api.example.com/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stealth_mode: true }),
      });

      mockExecuteWithRetry.mockResolvedValue({
        id: "user-123",
        email: "test@example.com",
        role: "END_USER",
        stealthMode: true,
        createdAt: new Date("2024-01-01"),
      });

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe("user-123");
      expect(body.stealth_mode).toBe(true);
      expect(mockExecuteWithRetry).toHaveBeenCalled();
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe("Unauthorized");
    });

    it("should return 400 when stealth_mode is not a boolean", async () => {
      const request = new Request("https://api.example.com/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stealth_mode: "invalid" }),
      });

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid input: stealth_mode must be a boolean");
    });

    it("should handle stealth_mode undefined (no update)", async () => {
      const request = new Request("https://api.example.com/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      mockExecuteWithRetry.mockResolvedValue({
        id: "user-123",
        email: "test@example.com",
        role: "END_USER",
        stealthMode: false,
        createdAt: new Date("2024-01-01"),
      });

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe("user-123");
    });

    it("should return 404 when user not found", async () => {
      const request = new Request("https://api.example.com/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stealth_mode: true }),
      });

      const prismaError = {
        code: "P2025",
        message: "Record to update not found",
      };
      mockExecuteWithRetry.mockRejectedValue(prismaError);

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe("User not found");
    });

    it("should return 500 on general errors", async () => {
      const request = new Request("https://api.example.com/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stealth_mode: true }),
      });

      mockExecuteWithRetry.mockRejectedValue(new Error("Database error"));

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe("Failed to update profile");
          });

    it("should format response with snake_case for Flutter", async () => {
      const request = new Request("https://api.example.com/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stealth_mode: false }),
      });

      const createdAt = new Date("2024-01-01T00:00:00Z");
      mockExecuteWithRetry.mockResolvedValue({
        id: "user-123",
        email: "test@example.com",
        role: "END_USER",
        stealthMode: false,
        createdAt,
      });

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(body.created_at).toBe(createdAt.toISOString());
      expect(body.stealth_mode).toBe(false);
    });
  });

  describe("POST /api/user/region-preference", () => {
    const route = userRoutes.find(
      (r) => r.path === "/api/user/region-preference" && r.method === "POST",
    );

    it("should update user region preference", async () => {
      const request = new Request(
        "https://api.example.com/api/user/region-preference",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: "EU" }),
        },
      );

      mockExecuteWithRetry.mockResolvedValue({
        id: "user-123",
        email: "test@example.com",
        region: "EU",
        dataRegion: "US",
      });

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.region).toBe("EU");
      expect(body.data_region).toBe("US");
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://api.example.com/api/user/region-preference",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: "EU" }),
        },
      );

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe("Unauthorized");
    });

    it("should return 400 when region is missing", async () => {
      const request = new Request(
        "https://api.example.com/api/user/region-preference",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe(
        "Invalid input: region is required and must be a string",
      );
    });

    it("should return 400 when region is not a string", async () => {
      const request = new Request(
        "https://api.example.com/api/user/region-preference",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: 123 }),
        },
      );

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe(
        "Invalid input: region is required and must be a string",
      );
    });

    it("should return 400 when region is invalid", async () => {
      const request = new Request(
        "https://api.example.com/api/user/region-preference",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: "INVALID" }),
        },
      );

      mockIsValidRegion.mockReturnValue(false);

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid region. Valid regions: US, EU, CN");
    });

    it("should invalidate region cache when KV is available", async () => {
      const request = new Request(
        "https://api.example.com/api/user/region-preference",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: "EU" }),
        },
      );

      const mockKVDelete = vi.fn().mockResolvedValue(undefined);
      mockEnv.FOLLOWERS_KV = {
        delete: mockKVDelete,
      } as any;

      mockExecuteWithRetry.mockResolvedValue({
        id: "user-123",
        email: "test@example.com",
        region: "EU",
        dataRegion: "US",
      });

      const response = await route!.handler(request, mockEnv);

      expect(response.status).toBe(200);
      expect(mockKVDelete).toHaveBeenCalledWith("region:user-123");
      expect(mockKVDelete).toHaveBeenCalledWith("region:validation:user-123");
          });

    it("should handle KV cache invalidation errors gracefully", async () => {
      const request = new Request(
        "https://api.example.com/api/user/region-preference",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: "EU" }),
        },
      );

      const mockKVDelete = vi.fn().mockRejectedValue(new Error("KV error"));
      mockEnv.FOLLOWERS_KV = {
        delete: mockKVDelete,
      } as any;

      mockExecuteWithRetry.mockResolvedValue({
        id: "user-123",
        email: "test@example.com",
        region: "EU",
        dataRegion: "US",
      });

      const response = await route!.handler(request, mockEnv);

      expect(response.status).toBe(200);
          });

    it("should handle database errors", async () => {
      const request = new Request(
        "https://api.example.com/api/user/region-preference",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: "EU" }),
        },
      );

      mockExecuteWithRetry.mockRejectedValue(new Error("Database error"));

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(500);
            expect(mockSanitizeError).toHaveBeenCalled();
    });
  });

  describe("POST /api/user/cross-region-consent", () => {
    const route = userRoutes.find(
      (r) => r.path === "/api/user/cross-region-consent" && r.method === "POST",
    );

    it("should record cross-region consent", async () => {
      const request = new Request(
        "https://api.example.com/api/user/cross-region-consent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dataRegion: "US",
            accessRegion: "EU",
            consented: true,
          }),
        },
      );

      // First call: find user
      // Second call: upsert consent
      mockExecuteWithRetry
        .mockResolvedValueOnce({
          dataRegion: "US",
        })
        .mockResolvedValueOnce({
          consented: true,
          dataRegion: "US",
          accessRegion: "EU",
        });

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.consented).toBe(true);
      expect(body.dataRegion).toBe("US");
      expect(body.accessRegion).toBe("EU");
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://api.example.com/api/user/cross-region-consent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dataRegion: "US",
            accessRegion: "EU",
            consented: true,
          }),
        },
      );

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe("Unauthorized");
    });

    it("should return 400 when dataRegion is invalid", async () => {
      const request = new Request(
        "https://api.example.com/api/user/cross-region-consent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dataRegion: "INVALID",
            accessRegion: "EU",
            consented: true,
          }),
        },
      );

      mockIsValidRegion.mockReturnValue(false);

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid region");
    });

    it("should return 400 when accessRegion is invalid", async () => {
      const request = new Request(
        "https://api.example.com/api/user/cross-region-consent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dataRegion: "US",
            accessRegion: "INVALID",
            consented: true,
          }),
        },
      );

      mockIsValidRegion
        .mockReturnValueOnce(true) // dataRegion
        .mockReturnValueOnce(false); // accessRegion

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid region");
    });

    it("should return 404 when user not found", async () => {
      const request = new Request(
        "https://api.example.com/api/user/cross-region-consent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dataRegion: "US",
            accessRegion: "EU",
            consented: true,
          }),
        },
      );

      mockExecuteWithRetry.mockResolvedValueOnce(null);

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe("User not found");
    });

    it("should return 400 when dataRegion mismatch", async () => {
      const request = new Request(
        "https://api.example.com/api/user/cross-region-consent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dataRegion: "US",
            accessRegion: "EU",
            consented: true,
          }),
        },
      );

      mockExecuteWithRetry.mockResolvedValueOnce({
        dataRegion: "EU", // Different from request
      });

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Data region mismatch");
    });

    it("should record consent withdrawal", async () => {
      const request = new Request(
        "https://api.example.com/api/user/cross-region-consent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dataRegion: "US",
            accessRegion: "EU",
            consented: false,
          }),
        },
      );

      mockExecuteWithRetry
        .mockResolvedValueOnce({
          dataRegion: "US",
        })
        .mockResolvedValueOnce({
          consented: false,
          dataRegion: "US",
          accessRegion: "EU",
        });

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.consented).toBe(false);
    });

    it("should include IP address and user agent in consent record", async () => {
      const request = new Request(
        "https://api.example.com/api/user/cross-region-consent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "TestAgent/1.0",
          },
          body: JSON.stringify({
            dataRegion: "US",
            accessRegion: "EU",
            consented: true,
          }),
        },
      );

      mockGetIPAddress.mockReturnValue("192.168.1.1");
      mockExecuteWithRetry
        .mockResolvedValueOnce({
          dataRegion: "US",
        })
        .mockResolvedValueOnce({
          consented: true,
          dataRegion: "US",
          accessRegion: "EU",
        });

      await route!.handler(request, mockEnv);

      // Verify IP and user agent were captured
      expect(mockGetIPAddress).toHaveBeenCalledWith(request);
    });

    it("should handle database errors", async () => {
      const request = new Request(
        "https://api.example.com/api/user/cross-region-consent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dataRegion: "US",
            accessRegion: "EU",
            consented: true,
          }),
        },
      );

      mockExecuteWithRetry.mockRejectedValue(new Error("Database error"));

      const response = await route!.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(500);
            expect(mockSanitizeError).toHaveBeenCalled();
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(userRoutes).toHaveLength(3);
    });

    it("should have correct paths and methods", () => {
      const paths = userRoutes.map((r) => r.path);
      expect(paths).toContain("/api/user/profile");
      expect(paths).toContain("/api/user/region-preference");
      expect(paths).toContain("/api/user/cross-region-consent");
    });

    it("should have middleware configured", () => {
      userRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
        expect(Array.isArray(route.middleware)).toBe(true);
      });
    });

    it("should have descriptions", () => {
      userRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
