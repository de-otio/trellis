/**
 * Unit Tests: ActivityPub Messages Routes
 *
 * Tests for ActivityPub direct message route handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { messageRoutes } from "../../../../src/lib/routes/activitypub/messages.js";

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
vi.mock("../../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    constructor(env: any) {}
  },
}));

// Mock addCorsHeaders
const mockAddCorsHeaders = vi.fn();
vi.mock("../../../../src/worker", () => ({
  addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args),
}));


// Mock withQueryTimeoutAndRetry
const mockWithQueryTimeoutAndRetry = vi.fn();
vi.mock("../../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    STANDARD: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock detectRegionSync
const mockDetectRegionSync = vi.fn();
vi.mock("../../../../src/lib/region-detection", () => ({
  detectRegionSync: (...args: any[]) => mockDetectRegionSync(...args),
}));

// Mock DmServiceFedify
const mockCreateDirectMessage = vi.fn();
vi.mock("../../../../src/lib/activitypub/services/dm-service-fedify", () => ({
  DmServiceFedify: {
    createDirectMessage: (...args: any[]) => mockCreateDirectMessage(...args),
  },
}));

describe("ActivityPub Messages Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;
  let mockSession: any;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockSession = {
      userId: "user-123",
      email: "sender@example.com",
    };

    mockDb = {
      user: {
        findUnique: vi.fn(),
      },
    };

    mockRequest = new Request("https://example.com/api/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipientId: "recipient-123",
        text: "Hello, this is a test message",
      }),
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddCorsHeaders.mockImplementation(async (response) => response);
    mockDetectRegionSync.mockReturnValue("US");
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (db, region, env, fn) => {
        return await fn(mockDb);
      },
    );
  });

  describe("POST /api/messages - Send direct message", () => {
    const route = messageRoutes.find(
      (r) => r.method === "POST" && r.path === "/api/messages",
    );

    it("should send message successfully", async () => {
      const mockSender = {
        id: "user-123",
        username: "sender",
        actorUri: "https://example.com/users/sender",
        publicKey: "public-key",
      };
      const mockRecipient = {
        id: "recipient-123",
        username: "recipient",
        actorUri: "https://example.com/users/recipient",
        publicKey: "public-key",
        dmAccess: "EVERYONE",
      };
      mockDb.user.findUnique
        .mockResolvedValueOnce(mockSender)
        .mockResolvedValueOnce(mockRecipient);
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (db, region, env, fn) => {
          return await fn(mockDb);
        },
      );
      mockCreateDirectMessage.mockResolvedValue({
        id: "message-123",
        recipientId: "recipient-123",
        text: "Hello, this is a test message",
        read: false,
        createdAt: new Date(),
      });

      const response = await route!.handler(mockRequest, mockEnv, {
        url: new URL(mockRequest.url),
      });

      expect(mockGetSession).toHaveBeenCalled();
      expect(mockDb.user.findUnique).toHaveBeenCalledTimes(2);
      expect(mockCreateDirectMessage).toHaveBeenCalled();
      expect(response.status).toBe(201);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv, {
        url: new URL(mockRequest.url),
      });

      expect(response.status).toBe(401);
      expect(mockCreateDirectMessage).not.toHaveBeenCalled();
    });

    it("should return 400 when recipientId is missing", async () => {
      const invalidRequest = new Request("https://example.com/api/messages", {
        method: "POST",
        body: JSON.stringify({ text: "Hello" }),
      });

      const response = await route!.handler(invalidRequest, mockEnv, {
        url: new URL(invalidRequest.url),
      });

      expect(response.status).toBe(400);
      expect(mockCreateDirectMessage).not.toHaveBeenCalled();
    });

    it("should return 400 when text is missing", async () => {
      const invalidRequest = new Request("https://example.com/api/messages", {
        method: "POST",
        body: JSON.stringify({ recipientId: "recipient-123" }),
      });

      const response = await route!.handler(invalidRequest, mockEnv, {
        url: new URL(invalidRequest.url),
      });

      expect(response.status).toBe(400);
    });

    it("should return 400 when text is too long", async () => {
      const longText = "a".repeat(5001);
      const invalidRequest = new Request("https://example.com/api/messages", {
        method: "POST",
        body: JSON.stringify({
          recipientId: "recipient-123",
          text: longText,
        }),
      });

      const response = await route!.handler(invalidRequest, mockEnv, {
        url: new URL(invalidRequest.url),
      });

      expect(response.status).toBe(400);
    });

    it("should handle errors", async () => {
      const mockSender = {
        id: "user-123",
        username: "sender",
        actorUri: "https://example.com/users/sender",
        publicKey: "public-key",
      };
      mockDb.user.findUnique
        .mockResolvedValueOnce(mockSender)
        .mockResolvedValueOnce({
          id: "recipient-123",
          username: "recipient",
          actorUri: "https://example.com/users/recipient",
          publicKey: "public-key",
          suspended: false,
          deletionConfirmedAt: null,
          dmAccess: "EVERYONE", // Allow DMs so we reach the error path
        });
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (db, region, env, fn) => {
          return await fn(mockDb);
        },
      );
      const error = new Error("Failed to send message");
      mockCreateDirectMessage.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        url: new URL(mockRequest.url),
      });

      // Logger error should be called
      expect(response.status).toBe(500);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(messageRoutes.length).toBeGreaterThan(0);
    });

    it("should have middleware configured", () => {
      messageRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions", () => {
      messageRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
