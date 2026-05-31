/**
 * Tests for Group Actor Dispatcher
 *
 * Tests Fedify Actor Dispatcher for groups.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { GroupActorDispatcher } from "../../../../src/lib/activitypub/dispatchers/group-actor.js";
import type { Env } from "../../../../src/env.js";
import { DatabaseConnectionManager } from "../../../../src/lib/database-connection-manager.js";
import { withQueryTimeoutAndRetry } from "../../../../src/lib/db-query-helper.js";

// Mock dependencies
vi.mock("../../../../src/lib/database-connection-manager", () => {
  class MockDatabaseConnectionManager {
    constructor(env: any) {}
    withClient = vi.fn();
  }
  return {
    DatabaseConnectionManager: MockDatabaseConnectionManager,
  };
});
vi.mock("../../../../src/lib/db-query-helper");
vi.mock("../../../../src/lib/region-detection", () => ({
  detectRegionSync: vi.fn(() => "EU"),
}));
vi.mock("../../../../src/lib/activitypub/crypto", () => ({
  KeyPairService: {
    decryptPrivateKey: vi.fn((key, env) => key), // Return as-is for testing
  },
}));

describe("Group Actor Dispatcher", () => {
  const mockEnv: Partial<Env> = {
    LOG_LEVEL: "INFO",
    ACTIVITYPUB_BASE_URL: "https://example.com",
    DATABASE_URL: "postgresql://test",
  };

  let dispatcher: GroupActorDispatcher;
  let mockDbManager: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock for withQueryTimeoutAndRetry - returns null by default
    vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
      async (dbManager, region, env, callback) => {
        const mockDb = {
          group: {
            findUnique: vi.fn().mockResolvedValue(null),
          },
        };
        return callback(mockDb as any);
      },
    );

    dispatcher = new GroupActorDispatcher(mockEnv as Env);
  });

  describe("getActor", () => {
    it("should return null for invalid actor URI format", async () => {
      const result = await dispatcher.getActor(
        "https://example.com/users/invalid",
      );
      expect(result).toBeNull();
    });

    it("should return null for non-existent group", async () => {
      const mockDb = {
        group: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getActor(
        "https://example.com/groups/nonexistent",
      );
      expect(result).toBeNull();
    });

    it("should return null for group without ActivityPub fields", async () => {
      const mockGroup = {
        id: "group-123",
        name: "Test Group",
        actorUri: null,
        publicKey: null,
      };

      const mockDb = {
        group: {
          findUnique: vi.fn().mockResolvedValue(mockGroup),
        },
      };

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getActor(
        "https://example.com/groups/group-123",
      );
      expect(result).toBeNull();
    });

    it("should return Actor for valid group", async () => {
      const mockGroup = {
        id: "group-123",
        name: "Test Group",
        description: "A test group",
        actorUri: "https://example.com/groups/group-123",
        inboxUrl: "https://example.com/groups/group-123/inbox",
        outboxUrl: "https://example.com/groups/group-123/outbox",
        followersUrl: "https://example.com/groups/group-123/followers",
        publicKey:
          "-----BEGIN PUBLIC KEY-----\nMOCK_KEY\n-----END PUBLIC KEY-----",
        privateKey:
          "-----BEGIN PRIVATE KEY-----\nMOCK_KEY\n-----END PRIVATE KEY-----",
        privacy: "PUBLIC",
      };

      const mockDb = {
        group: {
          findUnique: vi.fn().mockResolvedValue(mockGroup),
        },
      };

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getActor(
        "https://example.com/groups/group-123",
      );

      expect(result).not.toBeNull();
      expect(result?.id.toString()).toBe(
        "https://example.com/groups/group-123",
      );
      expect(result?.type).toBe("Group");
      expect(result?.preferredUsername).toBe("group-123");
      expect(result?.name).toBe("Test Group");
      expect(result?.summary).toBe("A test group");
      expect(
        (result as any)?.inboxId?.toString() ||
          (result as any)?.inbox?.toString(),
      ).toBe("https://example.com/groups/group-123/inbox");
      expect(
        (result as any)?.outboxId?.toString() ||
          (result as any)?.outbox?.toString(),
      ).toBe("https://example.com/groups/group-123/outbox");
      expect(
        (result as any)?.followersId?.toString() ||
          (result as any)?.followers?.toString(),
      ).toBe("https://example.com/groups/group-123/followers");
    });

    it("should handle URL encoding in group ID", async () => {
      const encodedGroupId = encodeURIComponent("group with spaces");
      const mockGroup = {
        id: "group with spaces",
        name: "Test Group",
        actorUri: `https://example.com/groups/${encodedGroupId}`,
        publicKey:
          "-----BEGIN PUBLIC KEY-----\nMOCK_KEY\n-----END PUBLIC KEY-----",
        inboxUrl: `https://example.com/groups/${encodedGroupId}/inbox`,
        outboxUrl: `https://example.com/groups/${encodedGroupId}/outbox`,
        followersUrl: `https://example.com/groups/${encodedGroupId}/followers`,
        privateKey:
          "-----BEGIN PRIVATE KEY-----\nMOCK_KEY\n-----END PRIVATE KEY-----",
        privacy: "PUBLIC",
      };

      const mockDb = {
        group: {
          findUnique: vi.fn().mockResolvedValue(mockGroup),
        },
      };

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getActor(
        `https://example.com/groups/${encodedGroupId}`,
      );
      expect(result).not.toBeNull();
    });

    it("should handle errors gracefully", async () => {
      vi.mocked(withQueryTimeoutAndRetry).mockRejectedValue(
        new Error("Database error"),
      );

      const result = await dispatcher.getActor(
        "https://example.com/groups/group-123",
      );
      expect(result).toBeNull();
    });
  });

  describe("getKeyPair", () => {
    it("should return null for non-existent actor", async () => {
      vi.spyOn(dispatcher, "getActor").mockResolvedValue(null);

      const result = await dispatcher.getKeyPair(
        "https://example.com/groups/nonexistent",
      );
      expect(result).toBeNull();
    });

    it("should return null for invalid URI format", async () => {
      const result = await dispatcher.getKeyPair("https://example.com/invalid");
      expect(result).toBeNull();
    });

    it("should return key pair for valid group", async () => {
      const mockGroup = {
        id: "group-123",
        publicKey:
          "-----BEGIN PUBLIC KEY-----\nMOCK_PUBLIC\n-----END PUBLIC KEY-----",
        privateKey:
          "-----BEGIN PRIVATE KEY-----\nMOCK_PRIVATE\n-----END PRIVATE KEY-----",
      };

      const mockDb = {
        group: {
          findUnique: vi.fn().mockResolvedValue(mockGroup),
        },
      };

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      vi.spyOn(dispatcher, "getActor").mockResolvedValue({
        id: new URL("https://example.com/groups/group-123"),
        type: "Group",
        preferredUsername: "group-123",
      } as any);

      const result = await dispatcher.getKeyPair(
        "https://example.com/groups/group-123",
      );

      expect(result).not.toBeNull();
      expect(result?.publicKey).toBe(mockGroup.publicKey);
      expect(result?.privateKey).toBe(mockGroup.privateKey);
    });

    it("should return null when group missing keys", async () => {
      const mockGroup = {
        id: "group-123",
        publicKey: null,
        privateKey: null,
      };

      const mockDb = {
        group: {
          findUnique: vi.fn().mockResolvedValue(mockGroup),
        },
      };

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      vi.spyOn(dispatcher, "getActor").mockResolvedValue({
        id: new URL("https://example.com/groups/group-123"),
        type: "Group",
      } as any);

      const result = await dispatcher.getKeyPair(
        "https://example.com/groups/group-123",
      );
      expect(result).toBeNull();
    });

    it("should handle errors gracefully", async () => {
      vi.spyOn(dispatcher, "getActor").mockRejectedValue(new Error("Error"));

      const result = await dispatcher.getKeyPair(
        "https://example.com/groups/group-123",
      );
      expect(result).toBeNull();
    });
  });

  describe("generateActorUri", () => {
    it("should generate correct actor URI", () => {
      const groupId = "test-group-123";
      const uri = GroupActorDispatcher.generateActorUri(
        groupId,
        mockEnv as Env,
      );

      expect(uri).toContain("groups");
      expect(uri).toContain(groupId);
    });

    it("should handle special characters in group ID", () => {
      const groupId = "group with spaces & special chars";
      const uri = GroupActorDispatcher.generateActorUri(
        groupId,
        mockEnv as Env,
      );

      expect(uri).toContain("groups");
    });
  });
});
