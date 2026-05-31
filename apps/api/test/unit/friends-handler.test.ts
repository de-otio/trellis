/**
 * Unit Tests: Friends Handler
 *
 * Tests for friend connections, connection codes, and friendship management.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { withQueryTimeoutAndRetry } from "../../src/lib/db-query-helper.js";
import { FriendsHandler, type Env } from "../../src/lib/friends-handler.js";
import type { Session } from "../../src/lib/session-cookie.js";

// Mock database connection manager
const mockExecuteWithRetry = vi.fn();
vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    executeWithRetry: mockExecuteWithRetry,
  },
}));

// Mock db-query-helper
vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: vi.fn(),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 5000 },
  },
}));

// Mock region detection
vi.mock("../../src/lib/region-detection", () => ({
  detectRegionSync: vi.fn(() => "US"),
}));

describe("FriendsHandler", () => {
  let handler: FriendsHandler;
  let mockEnv: Env;
  let mockSession: Session;
  let mockFriendsKV: any;
  let mockConnectionCodesKV: any;

  beforeEach(() => {
    vi.clearAllMocks();

    handler = new FriendsHandler();

    mockSession = {
      userId: "user123",
      email: "user@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 3600000,
      sessionType: "user",
      lastActivityAt: Date.now(),
    };

    mockFriendsKV = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    mockConnectionCodesKV = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    mockEnv = {
      FRIENDS_KV: mockFriendsKV,
      CONNECTION_CODES_KV: mockConnectionCodesKV,
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    };
  });

  describe("generateConnectionCode", () => {
    it("should generate a connection code successfully", async () => {
      const code = await handler.generateConnectionCode(mockSession, mockEnv);

      expect(code).toBeDefined();
      expect(code.code).toHaveLength(32);
      expect(code.expiresAt).toBeDefined();
      expect(mockConnectionCodesKV.put).toHaveBeenCalledWith(
        expect.stringContaining("connection-code:"),
        expect.stringContaining(mockSession.userId),
        expect.objectContaining({
          expirationTtl: 300,
        }),
      );
    });

    it("should use FRIENDS_KV if CONNECTION_CODES_KV not available", async () => {
      delete mockEnv.CONNECTION_CODES_KV;

      const code = await handler.generateConnectionCode(mockSession, mockEnv);

      expect(code).toBeDefined();
      expect(mockFriendsKV.put).toHaveBeenCalled();
    });

    it("should work without KV (graceful degradation)", async () => {
      delete mockEnv.CONNECTION_CODES_KV;
      delete mockEnv.FRIENDS_KV;

      const code = await handler.generateConnectionCode(mockSession, mockEnv);

      expect(code).toBeDefined();
      expect(code.code).toHaveLength(32);
    });

    it("should generate code with 5 minute expiration", async () => {
      const code = await handler.generateConnectionCode(mockSession, mockEnv);
      const expiresAt = new Date(code.expiresAt);
      const now = new Date();
      const diffMinutes = (expiresAt.getTime() - now.getTime()) / (1000 * 60);

      expect(diffMinutes).toBeGreaterThan(4.9);
      expect(diffMinutes).toBeLessThan(5.1);
    });
  });

  describe("useConnectionCode", () => {
    const validCodeData = {
      userId: "other-user",
      email: "other@example.com",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      used: false,
    };

    it("should use connection code successfully", async () => {
      mockConnectionCodesKV.get.mockResolvedValue(
        JSON.stringify(validCodeData),
      );
      mockFriendsKV.get.mockResolvedValue(null); // No existing friends list

      const result = await handler.useConnectionCode(
        mockSession,
        "TESTCODE123",
        mockEnv,
      );

      expect(result.success).toBe(true);
      expect(result.friendshipId).toBeDefined();
      expect(mockConnectionCodesKV.put).toHaveBeenCalledWith(
        "connection-code:TESTCODE123",
        expect.stringContaining('"used":true'),
        expect.any(Object),
      );
      expect(mockFriendsKV.put).toHaveBeenCalledTimes(4); // 2 friendships + 2 friends lists
    });

    it("should throw error if code not found", async () => {
      mockConnectionCodesKV.get.mockResolvedValue(null);

      await expect(
        handler.useConnectionCode(mockSession, "INVALID", mockEnv),
      ).rejects.toThrow("Invalid or expired connection code");
    });

    it("should throw error if code expired", async () => {
      const expiredCodeData = {
        ...validCodeData,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
      mockConnectionCodesKV.get.mockResolvedValue(
        JSON.stringify(expiredCodeData),
      );

      await expect(
        handler.useConnectionCode(mockSession, "EXPIRED", mockEnv),
      ).rejects.toThrow("Connection code has expired");

      expect(mockConnectionCodesKV.delete).toHaveBeenCalledWith(
        "connection-code:EXPIRED",
      );
    });

    it("should throw error if code already used", async () => {
      const usedCodeData = {
        ...validCodeData,
        used: true,
      };
      mockConnectionCodesKV.get.mockResolvedValue(JSON.stringify(usedCodeData));

      await expect(
        handler.useConnectionCode(mockSession, "USED", mockEnv),
      ).rejects.toThrow("Connection code has already been used");
    });

    it("should throw error if user tries to connect to themselves", async () => {
      const selfCodeData = {
        ...validCodeData,
        userId: mockSession.userId,
      };
      mockConnectionCodesKV.get.mockResolvedValue(JSON.stringify(selfCodeData));

      await expect(
        handler.useConnectionCode(mockSession, "SELF", mockEnv),
      ).rejects.toThrow("Cannot connect to yourself");
    });

    it("should throw error if KV not configured", async () => {
      delete mockEnv.CONNECTION_CODES_KV;
      delete mockEnv.FRIENDS_KV;

      await expect(
        handler.useConnectionCode(mockSession, "TEST", mockEnv),
      ).rejects.toThrow("Connection codes storage not available");
    });

    it("should create bidirectional friendships", async () => {
      mockConnectionCodesKV.get.mockResolvedValue(
        JSON.stringify(validCodeData),
      );
      mockFriendsKV.get.mockResolvedValue(null);

      await handler.useConnectionCode(mockSession, "TESTCODE", mockEnv);

      const putCalls = mockFriendsKV.put.mock.calls;
      const friendshipCalls = putCalls.filter((call) =>
        call[0].startsWith("friendship:"),
      );

      expect(friendshipCalls.length).toBe(2);
      expect(friendshipCalls[0][0]).toBe(
        `friendship:${mockSession.userId}:${validCodeData.userId}`,
      );
      expect(friendshipCalls[1][0]).toBe(
        `friendship:${validCodeData.userId}:${mockSession.userId}`,
      );
    });

    it("should add friends to both users friends lists", async () => {
      mockConnectionCodesKV.get.mockResolvedValue(
        JSON.stringify(validCodeData),
      );
      mockFriendsKV.get.mockResolvedValue(null);

      await handler.useConnectionCode(mockSession, "TESTCODE", mockEnv);

      const friendsListCalls = mockFriendsKV.put.mock.calls.filter((call) =>
        call[0].startsWith("friends-list:"),
      );

      expect(friendsListCalls.length).toBe(2);
      expect(friendsListCalls[0][0]).toBe(`friends-list:${mockSession.userId}`);
      expect(friendsListCalls[1][0]).toBe(
        `friends-list:${validCodeData.userId}`,
      );
    });

    it("should throw error if MAX_FRIENDS limit reached", async () => {
      const fullFriendsList = Array.from(
        { length: 500 },
        (_, i) => `friend${i}`,
      );
      mockConnectionCodesKV.get.mockResolvedValue(
        JSON.stringify(validCodeData),
      );
      mockFriendsKV.get.mockResolvedValueOnce(JSON.stringify(fullFriendsList));

      await expect(
        handler.useConnectionCode(mockSession, "TESTCODE", mockEnv),
      ).rejects.toThrow("Maximum number of friends (500) reached");
    });
  });

  describe("getFriends", () => {
    it("should return empty list when no friends", async () => {
      mockFriendsKV.get.mockResolvedValue(null);

      const friends = await handler.getFriends(
        mockSession,
        "ACCEPTED",
        mockEnv,
      );

      expect(friends).toEqual([]);
    });

    it("should return friends list", async () => {
      const friendsList = ["friend1", "friend2"];
      const friendship1 = {
        id: "friendship1",
        requesterId: mockSession.userId,
        requesterEmail: mockSession.email,
        addresseeId: "friend1",
        addresseeEmail: "friend1@example.com",
        status: "ACCEPTED",
        acceptedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      const friendship2 = {
        id: "friendship2",
        requesterId: mockSession.userId,
        requesterEmail: mockSession.email,
        addresseeId: "friend2",
        addresseeEmail: "friend2@example.com",
        status: "ACCEPTED",
        acceptedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };

      mockFriendsKV.get
        .mockResolvedValueOnce(JSON.stringify(friendsList))
        .mockResolvedValueOnce(JSON.stringify(friendship1))
        .mockResolvedValueOnce(JSON.stringify(friendship2));

      const friends = await handler.getFriends(
        mockSession,
        "ACCEPTED",
        mockEnv,
      );

      expect(friends).toHaveLength(2);
      expect(friends[0].id).toBe("friend1");
      expect(friends[1].id).toBe("friend2");
    });

    it("should filter by status", async () => {
      const friendsList = ["friend1", "friend2"];
      const acceptedFriendship = {
        id: "friendship1",
        requesterId: mockSession.userId,
        addresseeId: "friend1",
        addresseeEmail: "friend1@example.com",
        status: "ACCEPTED",
        acceptedAt: new Date().toISOString(),
      };
      const pendingFriendship = {
        id: "friendship2",
        requesterId: mockSession.userId,
        addresseeId: "friend2",
        addresseeEmail: "friend2@example.com",
        status: "PENDING",
      };

      mockFriendsKV.get
        .mockResolvedValueOnce(JSON.stringify(friendsList))
        .mockResolvedValueOnce(JSON.stringify(acceptedFriendship))
        .mockResolvedValueOnce(JSON.stringify(pendingFriendship));

      const acceptedFriends = await handler.getFriends(
        mockSession,
        "ACCEPTED",
        mockEnv,
      );

      expect(acceptedFriends).toHaveLength(1);
      expect(acceptedFriends[0].status).toBe("ACCEPTED");
    });

    it("should limit to MAX_FRIENDS", async () => {
      const largeFriendsList = Array.from(
        { length: 600 },
        (_, i) => `friend${i}`,
      );
      mockFriendsKV.get.mockResolvedValueOnce(JSON.stringify(largeFriendsList));

      // Mock friendship data for first 500
      for (let i = 0; i < 500; i++) {
        mockFriendsKV.get.mockResolvedValueOnce(
          JSON.stringify({
            id: `friendship${i}`,
            requesterId: mockSession.userId,
            addresseeId: `friend${i}`,
            addresseeEmail: `friend${i}@example.com`,
            status: "ACCEPTED",
            acceptedAt: new Date().toISOString(),
          }),
        );
      }

      const friends = await handler.getFriends(
        mockSession,
        "ACCEPTED",
        mockEnv,
      );

      expect(friends.length).toBeLessThanOrEqual(500);
    });

    it("should return empty list if FRIENDS_KV not configured", async () => {
      delete mockEnv.FRIENDS_KV;

      const friends = await handler.getFriends(
        mockSession,
        "ACCEPTED",
        mockEnv,
      );

      expect(friends).toEqual([]);
    });
  });

  describe("handleGetFriends", () => {
    it("should return friends list", async () => {
      mockFriendsKV.get.mockResolvedValue(null);

      const request = new Request("https://api.example.com/api/friends", {
        method: "GET",
      });

      const response = await handler.handleGetFriends(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.friends).toBeDefined();
    });

    it("should filter by status query parameter", async () => {
      mockFriendsKV.get.mockResolvedValue(null);

      const request = new Request(
        "https://api.example.com/api/friends?status=PENDING",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetFriends(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
    });

    it("should return 500 on error", async () => {
      mockFriendsKV.get.mockRejectedValue(new Error("KV error"));

      const request = new Request("https://api.example.com/api/friends", {
        method: "GET",
      });

      const response = await handler.handleGetFriends(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to get friends list");
    });
  });

  describe("handleGenerateConnectionCode", () => {
    it("should return connection code", async () => {
      const request = new Request(
        "https://api.example.com/api/friends/connection-code",
        {
          method: "POST",
        },
      );

      const response = await handler.handleGenerateConnectionCode(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.code).toBeDefined();
      expect(body.expiresAt).toBeDefined();
    });

    it("should return 500 on error", async () => {
      mockConnectionCodesKV.put.mockRejectedValue(new Error("KV error"));

      const request = new Request(
        "https://api.example.com/api/friends/connection-code",
        {
          method: "POST",
        },
      );

      const response = await handler.handleGenerateConnectionCode(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });

  describe("handleConnect", () => {
    it("should connect using connection code", async () => {
      const validCodeData = {
        userId: "other-user",
        email: "other@example.com",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        used: false,
      };

      mockConnectionCodesKV.get.mockResolvedValue(
        JSON.stringify(validCodeData),
      );
      mockFriendsKV.get.mockResolvedValue(null);

      const request = new Request(
        "https://api.example.com/api/friends/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "TESTCODE" }),
        },
      );

      const response = await handler.handleConnect(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.friendshipId).toBeDefined();
    });

    it("should return 400 if code missing", async () => {
      const request = new Request(
        "https://api.example.com/api/friends/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await handler.handleConnect(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Connection code is required");
    });

    it("should return 400 if code is not string", async () => {
      const request = new Request(
        "https://api.example.com/api/friends/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: 123 }),
        },
      );

      const response = await handler.handleConnect(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(400);
    });

    it("should return 403 if MAX_FRIENDS limit reached", async () => {
      const fullFriendsList = Array.from(
        { length: 500 },
        (_, i) => `friend${i}`,
      );
      const validCodeData = {
        userId: "other-user",
        email: "other@example.com",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        used: false,
      };

      mockConnectionCodesKV.get.mockResolvedValue(
        JSON.stringify(validCodeData),
      );
      mockFriendsKV.get.mockResolvedValue(JSON.stringify(fullFriendsList));

      const request = new Request(
        "https://api.example.com/api/friends/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "TESTCODE" }),
        },
      );

      const response = await handler.handleConnect(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain("Maximum number of friends");
    });

    it("should return 400 for invalid code", async () => {
      mockConnectionCodesKV.get.mockResolvedValue(null);

      const request = new Request(
        "https://api.example.com/api/friends/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "INVALID" }),
        },
      );

      const response = await handler.handleConnect(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Invalid or expired");
    });
  });

  describe("handleConnectFromInvitation", () => {
    it("should create friendship from invitation", async () => {
      const mockInviter = { email: "inviter@example.com" };
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(mockInviter);
      mockFriendsKV.get.mockResolvedValue(null);

      const request = new Request(
        "https://api.example.com/api/friends/connect-from-invitation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inviterId: "inviter123" }),
        },
      );

      const response = await handler.handleConnectFromInvitation(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.friendshipId).toBeDefined();
    });

    it("should return 400 if inviterId missing", async () => {
      const request = new Request(
        "https://api.example.com/api/friends/connect-from-invitation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await handler.handleConnectFromInvitation(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Inviter ID is required");
    });

    it("should return 400 if user tries to connect to themselves", async () => {
      const request = new Request(
        "https://api.example.com/api/friends/connect-from-invitation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inviterId: mockSession.userId }),
        },
      );

      const response = await handler.handleConnectFromInvitation(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Cannot connect to yourself");
    });

    it("should return 500 if database not configured", async () => {
      delete mockEnv.DATABASE_URL;

      const request = new Request(
        "https://api.example.com/api/friends/connect-from-invitation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inviterId: "inviter123" }),
        },
      );

      const response = await handler.handleConnectFromInvitation(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Database not configured");
    });

    it("should return 404 if inviter not found", async () => {
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(null);

      const request = new Request(
        "https://api.example.com/api/friends/connect-from-invitation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inviterId: "nonexistent" }),
        },
      );

      const response = await handler.handleConnectFromInvitation(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("Inviter not found");
    });

    it("should return 403 if MAX_FRIENDS limit reached", async () => {
      const fullFriendsList = Array.from(
        { length: 500 },
        (_, i) => `friend${i}`,
      );
      const mockInviter = { email: "inviter@example.com" };
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(mockInviter);
      mockFriendsKV.get.mockResolvedValue(JSON.stringify(fullFriendsList));

      const request = new Request(
        "https://api.example.com/api/friends/connect-from-invitation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inviterId: "inviter123" }),
        },
      );

      const response = await handler.handleConnectFromInvitation(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain("Maximum number of friends");
    });

    it("should create bidirectional friendships", async () => {
      const mockInviter = { email: "inviter@example.com" };
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(mockInviter);
      mockFriendsKV.get.mockResolvedValue(null);

      const request = new Request(
        "https://api.example.com/api/friends/connect-from-invitation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inviterId: "inviter123" }),
        },
      );

      await handler.handleConnectFromInvitation(request, mockSession, mockEnv);

      const friendshipCalls = mockFriendsKV.put.mock.calls.filter((call) =>
        call[0].startsWith("friendship:"),
      );

      expect(friendshipCalls.length).toBe(2);
    });
  });
});
