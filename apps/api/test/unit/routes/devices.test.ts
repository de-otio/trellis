/**
 * Unit Tests: Push Device Routes (T8)
 *
 * POST /api/devices/register and DELETE /api/devices/:id — auth, validation,
 * owner-scoping, rate-limit config, and error paths per the frozen contract
 * (lib/doc/push-device-contract.md §2).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { devicesRoutes } from "../../../src/lib/routes/devices.js";
import type { MiddlewareContext } from "../../../src/lib/middleware.js";

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
    constructor(_env: any) {}
  },
}));

// Mock Validator
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = mockSanitizeError;
  },
}));

// Mock PushDeviceHandler
const mockRegisterDevice = vi.fn();
const mockDeleteDevice = vi.fn();
vi.mock("../../../src/lib/push/push-device-handler", () => ({
  PushDeviceHandler: class {
    registerDevice = mockRegisterDevice;
    deleteDevice = mockDeleteDevice;
  },
}));

// Mock authMiddleware
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

// Mock the token-bucket limiter so the route's rateLimitMiddleware can be
// exercised deterministically (429 path).
const mockCheckRateLimitKVStrict = vi.fn();
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    checkRateLimitKVStrict = mockCheckRateLimitKVStrict;
  },
  buildRateLimitResponse: (maxRequests: number, retryAfter: number) =>
    new Response(
      JSON.stringify({ error: "Rate limit exceeded", retryAfter }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "Retry-After": String(retryAfter),
        },
      },
    ),
}));

const registerRoute = devicesRoutes[0];
const deleteRoute = devicesRoutes[1];

function registerRequest(body: unknown): Request {
  return new Request("https://example.com/api/devices/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Push Device Routes", () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
    } as any;

    mockGetSession.mockResolvedValue({
      userId: "user-123",
      expiresAt: new Date(Date.now() + 3600000),
    });
    mockAuthMiddleware.mockResolvedValue({
      userId: "user-123",
      activeTenantId: "tenant-123",
    });
    mockCreateSecureResponse.mockImplementation(
      (body, options) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockRegisterDevice.mockResolvedValue({
      id: "dev-1",
      platform: "apns",
      createdAt: "2026-07-05T12:00:00.000Z",
      lastSeenAt: "2026-07-05T12:00:00.000Z",
    });
    mockDeleteDevice.mockResolvedValue(true);
  });

  describe("POST /api/devices/register", () => {
    it("registers a device and returns 201 with the device DTO (never the token)", async () => {
      const response = await registerRoute.handler(
        registerRequest({ token: "raw-apns-token", platform: "apns" }),
        mockEnv,
        { pathname: "/api/devices/register" } as any,
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toEqual({
        device: {
          id: "dev-1",
          platform: "apns",
          createdAt: "2026-07-05T12:00:00.000Z",
          lastSeenAt: "2026-07-05T12:00:00.000Z",
        },
      });
      // Server-resolved identity: the session userId, never a client claim.
      expect(mockRegisterDevice).toHaveBeenCalledWith(
        "user-123",
        "raw-apns-token",
        "apns",
        mockEnv,
      );
      expect(JSON.stringify(body)).not.toContain("raw-apns-token");
    });

    it("returns 400 on an unknown platform", async () => {
      const response = await registerRoute.handler(
        registerRequest({ token: "t", platform: "windows-phone" }),
        mockEnv,
        { pathname: "/api/devices/register" } as any,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Validation failed");
      expect(mockRegisterDevice).not.toHaveBeenCalled();
    });

    it("returns 400 on a missing/empty/oversized token", async () => {
      for (const bad of [
        { platform: "apns" },
        { token: "", platform: "apns" },
        { token: "x".repeat(4097), platform: "apns" },
      ]) {
        const response = await registerRoute.handler(
          registerRequest(bad),
          mockEnv,
          { pathname: "/api/devices/register" } as any,
        );
        expect(response.status).toBe(400);
      }
      expect(mockRegisterDevice).not.toHaveBeenCalled();
    });

    it("returns 401 without a session", async () => {
      mockGetSession.mockResolvedValue(null);
      const response = await registerRoute.handler(
        registerRequest({ token: "t", platform: "fcm" }),
        mockEnv,
        { pathname: "/api/devices/register" } as any,
      );
      expect(response.status).toBe(401);
      expect(mockRegisterDevice).not.toHaveBeenCalled();
    });

    it("returns 401 when authMiddleware yields no active tenant", async () => {
      mockAuthMiddleware.mockResolvedValue(null);
      const response = await registerRoute.handler(
        registerRequest({ token: "t", platform: "fcm" }),
        mockEnv,
        { pathname: "/api/devices/register" } as any,
      );
      expect(response.status).toBe(401);
      expect(mockRegisterDevice).not.toHaveBeenCalled();
    });

    it("returns 500 (sanitized) on a handler failure", async () => {
      mockRegisterDevice.mockRejectedValue(new Error("DB error"));
      const response = await registerRoute.handler(
        registerRequest({ token: "t", platform: "fcm" }),
        mockEnv,
        { pathname: "/api/devices/register" } as any,
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("DB error");
    });

    it("is rate-limited: the route middleware returns 429 when the limiter denies", async () => {
      mockCheckRateLimitKVStrict.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 60000,
        retryAfter: 60,
      });

      // middleware = [cors, csrf, rateLimit] — exercise the limiter directly.
      const rateLimit = registerRoute.middleware![2];
      const next = vi.fn(async () => new Response("should not run"));
      const context = {
        request: registerRequest({ token: "t", platform: "apns" }),
        env: mockEnv,
        url: new URL("https://example.com/api/devices/register"),
        pathname: "/api/devices/register",
        method: "POST",
      } as MiddlewareContext;

      const response = await rateLimit(context, next);

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/devices/:id", () => {
    const deleteRequest = new Request("https://example.com/api/devices/dev-1", {
      method: "DELETE",
    });

    it("deletes an owned device and returns 200", async () => {
      const response = await deleteRoute.handler(deleteRequest, mockEnv, {
        pathname: "/api/devices/dev-1",
      } as any);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      // Owner-scoped: session userId in the predicate.
      expect(mockDeleteDevice).toHaveBeenCalledWith("user-123", "dev-1", mockEnv);
    });

    it("returns 404 for a device owned by another user (no existence oracle)", async () => {
      mockDeleteDevice.mockResolvedValue(false);
      const response = await deleteRoute.handler(deleteRequest, mockEnv, {
        pathname: "/api/devices/dev-1",
      } as any);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Device not found" });
    });

    it("returns 401 without a session", async () => {
      mockGetSession.mockResolvedValue(null);
      const response = await deleteRoute.handler(deleteRequest, mockEnv, {
        pathname: "/api/devices/dev-1",
      } as any);
      expect(response.status).toBe(401);
      expect(mockDeleteDevice).not.toHaveBeenCalled();
    });

    it("returns 401 when authMiddleware yields no active tenant", async () => {
      mockAuthMiddleware.mockResolvedValue(null);
      const response = await deleteRoute.handler(deleteRequest, mockEnv, {
        pathname: "/api/devices/dev-1",
      } as any);
      expect(response.status).toBe(401);
      expect(mockDeleteDevice).not.toHaveBeenCalled();
    });

    it("returns 500 (sanitized) on a handler failure", async () => {
      mockDeleteDevice.mockRejectedValue(new Error("DB error"));
      const response = await deleteRoute.handler(deleteRequest, mockEnv, {
        pathname: "/api/devices/dev-1",
      } as any);
      expect(response.status).toBe(500);
    });
  });

  it("declares CORS + CSRF + rate-limit middleware on both routes", () => {
    expect(registerRoute.middleware).toHaveLength(3);
    expect(deleteRoute.middleware).toHaveLength(3);
    expect(registerRoute.method).toBe("POST");
    expect(deleteRoute.method).toBe("DELETE");
  });
});
