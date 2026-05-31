/**
 * Tests for User Actor Dispatcher
 *
 * Tests Fedify Actor Dispatcher for User actors.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { UserActorDispatcher } from "../../../../src/lib/activitypub/dispatchers/user-actor.js";
import {
  createFedifyTestEnv,
  createMockUser,
} from "../../../utils/fedify-test-fixtures.js";
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

// Don't mock crypto - use actual implementation for encryption/decryption
// The decryptPrivateKey will handle both plain and encrypted keys

describe("User Actor Dispatcher", () => {
  const mockEnv = createFedifyTestEnv();
  let dispatcher: UserActorDispatcher;
  let mockDbManager: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock for withQueryTimeoutAndRetry - returns null by default
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

    dispatcher = new UserActorDispatcher(mockEnv);
  });

  describe("getActor", () => {
    it("should return null for invalid actor URI format", async () => {
      const result = await dispatcher.getActor(
        "https://example.com/invalid/path",
      );
      expect(result).toBeNull();
    });

    it("should return null for non-existent user", async () => {
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

      const result = await dispatcher.getActor(
        "https://example.com/users/nonexistent",
      );
      expect(result).toBeNull();
    });

    it("should return null for suspended user", async () => {
      const mockUser = createMockUser({ suspended: true });

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue(mockUser),
            },
          };
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getActor(
        "https://example.com/users/testuser",
      );
      expect(result).toBeNull();
    });

    it("should return null for user without ActivityPub fields", async () => {
      const mockUser = createMockUser({ actorUri: null, publicKey: null });

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue(mockUser),
            },
          };
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getActor(
        "https://example.com/users/testuser",
      );
      expect(result).toBeNull();
    });

    it("should return Actor for valid user", async () => {
      const mockUser = createMockUser();

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue(mockUser),
            },
          };
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getActor(
        "https://example.com/users/testuser",
      );

      expect(result).not.toBeNull();
      expect(result?.id.toString()).toBe("https://example.com/users/testuser");
      expect(result?.type).toBe("Person");
      expect(result?.preferredUsername).toBe("testuser");
      expect(
        (result as any)?.inboxId?.toString() ||
          (result as any)?.inbox?.toString(),
      ).toBe("https://example.com/users/testuser/inbox");
      expect(
        (result as any)?.outboxId?.toString() ||
          (result as any)?.outbox?.toString(),
      ).toBe("https://example.com/users/testuser/outbox");
      expect(
        (result as any)?.followersId?.toString() ||
          (result as any)?.followers?.toString(),
      ).toBe("https://example.com/users/testuser/followers");
      expect(
        (result as any)?.followingId?.toString() ||
          (result as any)?.following?.toString(),
      ).toBe("https://example.com/users/testuser/following");
    });

    it("should include friends collection if available", async () => {
      const mockUser = createMockUser({
        friendsUrl: "https://example.com/users/testuser/friends",
      });

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue(mockUser),
            },
          };
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getActor(
        "https://example.com/users/testuser",
      );

      expect(result).not.toBeNull();
      expect((result as any).friends?.toString()).toBe(
        "https://example.com/users/testuser/friends",
      );
    });

    it("should include publicKey in Actor object", async () => {
      const mockUser = createMockUser();

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue(mockUser),
            },
          };
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getActor(
        "https://example.com/users/testuser",
      );

      expect(result).not.toBeNull();
      expect((result as any).publicKey).toBeDefined();
      expect((result as any).publicKey.id).toBe(
        "https://example.com/users/testuser#main-key",
      );
      expect((result as any).publicKey.owner).toBe(
        "https://example.com/users/testuser",
      );
      expect((result as any).publicKey.publicKeyPem).toBe(mockUser.publicKey);
    });

    it("should handle URL-encoded usernames", async () => {
      const mockUser = createMockUser({ username: "user with spaces" });

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue(mockUser),
            },
          };
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getActor(
        "https://example.com/users/user%20with%20spaces",
      );

      expect(result).not.toBeNull();
      expect(result?.preferredUsername).toBe("user with spaces");
    });
  });

  describe("getKeyPair", () => {
    it("should return null for non-existent actor", async () => {
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

      const result = await dispatcher.getKeyPair(
        "https://example.com/users/nonexistent",
      );
      expect(result).toBeNull();
    });

    it("should return null for user without key pair", async () => {
      const mockUser = createMockUser({ publicKey: null, privateKey: null });

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue(mockUser),
            },
          };
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getKeyPair(
        "https://example.com/users/testuser",
      );
      expect(result).toBeNull();
    });

    it("should return key pair for user with keys", async () => {
      const mockUser = createMockUser();
      // Encrypt the private key to match real-world usage
      const { KeyPairService } = await import(
        "../../../../src/lib/activitypub/crypto.js"
      );
      const encryptedKey = KeyPairService.encryptPrivateKey(
        mockUser.privateKey,
        mockEnv,
      );
      const mockUserWithEncryptedKey = createMockUser({
        privateKey: encryptedKey,
      });

      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          callCount++;
          const mockDb = {
            user: {
              findUnique: vi
                .fn()
                .mockResolvedValue(
                  callCount === 1 ? mockUser : mockUserWithEncryptedKey,
                ),
            },
          };
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getKeyPair(
        "https://example.com/users/testuser",
      );

      expect(result).not.toBeNull();
      expect(result?.publicKey).toBe(mockUser.publicKey);
      expect(result?.privateKey).toBe(mockUser.privateKey); // Should be decrypted
    });

    it("should decrypt encrypted private key", async () => {
      const { KeyPairService } = await import(
        "../../../../src/lib/activitypub/crypto.js"
      );
      const mockUser = createMockUser();
      const encryptedKey = KeyPairService.encryptPrivateKey(
        mockUser.privateKey,
        mockEnv,
      );
      const mockUserWithEncryptedKey = createMockUser({
        privateKey: encryptedKey,
      });

      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue(mockUserWithEncryptedKey),
            },
          };
          return callback(mockDb as any);
        },
      );

      const result = await dispatcher.getKeyPair(
        "https://example.com/users/testuser",
      );

      expect(result).not.toBeNull();
      expect(result?.privateKey).toBe(mockUser.privateKey); // Should be decrypted
    });
  });

  describe("generateActorUri", () => {
    it("should generate correct actor URI", () => {
      const uri = UserActorDispatcher.generateActorUri("testuser", mockEnv);
      expect(uri).toBe("https://example.com/users/testuser");
    });

    it("should URL-encode username in actor URI", () => {
      const uri = UserActorDispatcher.generateActorUri(
        "user with spaces",
        mockEnv,
      );
      expect(uri).toBe("https://example.com/users/user%20with%20spaces");
    });

    it("should handle special characters in username", () => {
      const uri = UserActorDispatcher.generateActorUri(
        "user@example.com",
        mockEnv,
      );
      expect(uri).toBe("https://example.com/users/user%40example.com");
    });
  });
});
