/**
 * Tests for Fedify Friends Collection
 *
 * Tests friends collection endpoint with Fedify integration.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFriendsCollection } from "../../../../src/lib/activitypub/listeners/friends-collection.js";
import type { Env } from "../../../../src/env.js";

// Mock dependencies
vi.mock("../../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    getConnection: vi.fn(),
  },
}));

vi.mock("../../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: vi.fn(),
  QueryTimeoutPresets: {
    STANDARD: {},
  },
}));

vi.mock("../../../../src/lib/region-detection", () => ({
  detectRegionSync: vi.fn(() => "EU"),
}));

vi.mock("../../../../src/lib/activitypub/friendship-service", () => ({
  FriendshipService: {
    getFriendsActorUris: vi.fn(),
    getFriendsCount: vi.fn(),
  },
}));

describe("Fedify Friends Collection", () => {
  const mockEnv: Partial<Env> = {
    LOG_LEVEL: "INFO",
    ACTIVITYPUB_BASE_URL: "https://example.com",
    DATABASE_URL: "postgresql://test",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getFriendsCollection", () => {
    it("should return 404 for non-existent user", async () => {
      const request = new Request(
        "https://example.com/users/nonexistent/friends",
        {
          method: "GET",
        },
      );

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue(null),
            },
          };
          return callback(mockDb as any);
        },
      );

      const response = await getFriendsCollection(
        request,
        mockEnv as Env,
        "nonexistent",
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("User not found");
    });

    it("should return 404 for user missing actorId", async () => {
      const request = new Request("https://example.com/users/bob/friends", {
        method: "GET",
      });

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                id: "user-123",
                username: "bob",
                actorUri: null,
              }),
            },
          };
          return callback(mockDb as any);
        },
      );

      const response = await getFriendsCollection(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(404);
    });

    it("should return OrderedCollection for user with friends", async () => {
      const request = new Request("https://example.com/users/bob/friends", {
        method: "GET",
      });

      const friendsActorIds = [
        "https://example.com/users/alice",
        "https://example.com/users/charlie",
      ];

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const { FriendshipService } = await import(
        "../../../../src/lib/activitypub/friendship-service.js"
      );

      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          callCount++;
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                id: "user-123",
                username: "bob",
                actorUri: "https://example.com/users/bob",
              }),
            },
          };
          return callback(mockDb as any);
        },
      );

      vi.mocked(FriendshipService.getFriendsActorUris).mockResolvedValue(
        friendsActorIds,
      );
      vi.mocked(FriendshipService.getFriendsCount).mockResolvedValue(2);

      const response = await getFriendsCollection(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.type).toBe("OrderedCollection");
      expect(body.totalItems).toBe(2);
      expect(body.orderedItems).toEqual(friendsActorIds);
      expect(body["@context"]).toBe("https://www.w3.org/ns/activitystreams");
      expect(body.id).toBe("https://example.com/users/bob/friends");
    });

    it("should return empty OrderedCollection for user with no friends", async () => {
      const request = new Request("https://example.com/users/bob/friends", {
        method: "GET",
      });

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const { FriendshipService } = await import(
        "../../../../src/lib/activitypub/friendship-service.js"
      );

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                id: "user-123",
                username: "bob",
                actorUri: "https://example.com/users/bob",
              }),
            },
          };
          return callback(mockDb as any);
        },
      );

      vi.mocked(FriendshipService.getFriendsActorUris).mockResolvedValue([]);
      vi.mocked(FriendshipService.getFriendsCount).mockResolvedValue(0);

      const response = await getFriendsCollection(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.totalItems).toBe(0);
      expect(body.orderedItems).toHaveLength(0);
    });

    it("should handle pagination parameters", async () => {
      const request = new Request(
        "https://example.com/users/bob/friends?page=2&limit=10",
        {
          method: "GET",
        },
      );

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const { FriendshipService } = await import(
        "../../../../src/lib/activitypub/friendship-service.js"
      );

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                id: "user-123",
                username: "bob",
                actorUri: "https://example.com/users/bob",
              }),
            },
          };
          return callback(mockDb as any);
        },
      );

      vi.mocked(FriendshipService.getFriendsActorUris).mockResolvedValue([]);
      vi.mocked(FriendshipService.getFriendsCount).mockResolvedValue(0);

      const response = await getFriendsCollection(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(200);
      expect(FriendshipService.getFriendsActorUris).toHaveBeenCalledWith(
        expect.anything(),
        "https://example.com/users/bob",
        2,
        10,
      );
    });

    it("should enforce maximum limit", async () => {
      const request = new Request(
        "https://example.com/users/bob/friends?limit=200",
        {
          method: "GET",
        },
      );

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const { FriendshipService } = await import(
        "../../../../src/lib/activitypub/friendship-service.js"
      );

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                id: "user-123",
                username: "bob",
                actorUri: "https://example.com/users/bob",
              }),
            },
          };
          return callback(mockDb as any);
        },
      );

      vi.mocked(FriendshipService.getFriendsActorUris).mockResolvedValue([]);
      vi.mocked(FriendshipService.getFriendsCount).mockResolvedValue(0);

      const response = await getFriendsCollection(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(200);
      expect(FriendshipService.getFriendsActorUris).toHaveBeenCalledWith(
        expect.anything(),
        "https://example.com/users/bob",
        1,
        100,
      );
    });

    it("should handle errors gracefully", async () => {
      const request = new Request("https://example.com/users/bob/friends", {
        method: "GET",
      });

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockRejectedValue(
        new Error("Database error"),
      );

      const response = await getFriendsCollection(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Internal server error");
    });
  });
});
