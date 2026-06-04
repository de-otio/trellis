/**
 * Tests for Dog Profile Actor Dispatcher
 *
 * Tests Fedify Actor Dispatcher for dog profiles.
 */

import type { Entity } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { EntityActorDispatcher } from "../../../../src/lib/activitypub/dispatchers/entity-actor.js";
import { createFedifyTestEnv } from "../../../../test/utils/fedify-test-fixtures.js";

// Mock dependencies
vi.mock("../../../../src/lib/database-connection-manager");
vi.mock("../../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: vi.fn(),
  QueryTimeoutPresets: {
    STANDARD: {},
  },
}));
vi.mock("../../../../src/lib/region-detection", () => ({
  detectRegionSync: vi.fn(() => "EU"),
}));
vi.mock("../../../../src/lib/activitypub/crypto", () => ({
  KeyPairService: {
    decryptPrivateKey: vi.fn((key: string) => key.replace("encrypted:", "")),
  },
}));
vi.mock("../../../../src/lib/activitypub/entity-profile-service", () => ({
  EntityProfileService: {
    generateActorUri: vi.fn((entityId: string, entityType: string, env: Env) => {
      const baseUrl = env.ACTIVITYPUB_BASE_URL || "https://example.com";
      return `${baseUrl}/entities/${entityType}/${entityId}`;
    }),
  },
}));

describe("Entity Actor Dispatcher", () => {
  let mockEnv: Env;
  let mockEntity: Entity & { owner?: { actorUri: string | null } | null };

  beforeEach(() => {
    mockEnv = createFedifyTestEnv();

    mockEntity = {
      id: "dog-123",
      name: "Buddy",
      entityType: "dog",
      metadata: { bio: "A friendly dog" },
      actorUri: "https://example.com/entities/dog/dog-123",
      inboxUrl: "https://example.com/entities/dog/dog-123/inbox",
      outboxUrl: "https://example.com/entities/dog/dog-123/outbox",
      followersUrl: "https://example.com/entities/dog/dog-123/followers",
      publicKey:
        "-----BEGIN PUBLIC KEY-----\nMOCK_KEY\n-----END PUBLIC KEY-----",
      privateKey:
        "encrypted:-----BEGIN PRIVATE KEY-----\nMOCK_KEY\n-----END PRIVATE KEY-----",
      ownerId: "user-123",
      followPrivacy: "PUBLIC",
      owner: {
        actorUri: "https://example.com/users/alice",
      },
    } as any;

    vi.clearAllMocks();
  });

  describe("getActor", () => {
    it("should return null for invalid actor URI format", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);
      const result = await dispatcher.getActor(
        "https://example.com/users/invalid",
      );

      expect(result).toBeNull();
    });

    it("should return null for URI with empty dog ID", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);
      const result = await dispatcher.getActor("https://example.com/entities/dog/");

      expect(result).toBeNull();
    });

    it("should return null for non-existent dog profile", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(null);

      const result = await dispatcher.getActor(
        "https://example.com/entities/dog/nonexistent",
      );

      expect(result).toBeNull();
    });

    it("should return null if entity missing actorId", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const entityWithoutActorId = {
        ...mockEntity,
        actorUri: null,
      };
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(
        entityWithoutActorId,
      );

      const result = await dispatcher.getActor(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).toBeNull();
    });

    it("should return null if entity missing publicKey", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const entityWithoutKey = {
        ...mockEntity,
        publicKey: null,
      };
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(entityWithoutKey);

      const result = await dispatcher.getActor(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).toBeNull();
    });

    it("should return actor for valid dog profile", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(mockEntity);

      const result = await dispatcher.getActor(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).not.toBeNull();
      expect(result?.id).toBeInstanceOf(URL);
      expect(result?.id.toString()).toBe("https://example.com/entities/dog/dog-123");
      expect(result?.type).toBe("Person");
      expect(result?.preferredUsername).toBe("dog-123");
      expect(result?.name).toBe("Buddy");
      expect(result?.summary).toBe("A friendly dog");
    });

    it("should handle URL-encoded dog IDs", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const encodedEntity = {
        ...mockEntity,
        id: "dog with spaces",
        actorUri: "https://example.com/entities/dog/dog%20with%20spaces",
      };
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(encodedEntity);

      const result = await dispatcher.getActor(
        "https://example.com/entities/dog/dog%20with%20spaces",
      );

      expect(result).not.toBeNull();
      expect(result?.preferredUsername).toBe("dog with spaces");
    });

    it("should include owner in attributedTo if available", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(mockEntity);

      const result = await dispatcher.getActor(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result?.attributedTo).toBeInstanceOf(URL);
      expect(result?.attributedTo?.toString()).toBe(
        "https://example.com/users/alice",
      );
    });

    it("should handle missing owner gracefully", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const entityWithoutOwner = {
        ...mockEntity,
        owner: null,
      };
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(entityWithoutOwner);

      const result = await dispatcher.getActor(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).not.toBeNull();
      expect(result?.attributedTo).toBeUndefined();
    });

    it("should handle entity without name", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const entityWithoutName = {
        ...mockEntity,
        name: null,
      };
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(entityWithoutName);

      const result = await dispatcher.getActor(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).not.toBeNull();
      expect(result?.name).toBeUndefined();
    });

    it("should handle entity without bio", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const entityWithoutBio = {
        ...mockEntity,
        metadata: {},
      };
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(entityWithoutBio);

      const result = await dispatcher.getActor(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).not.toBeNull();
      expect(result?.summary).toBeUndefined();
    });

    it("should handle database errors gracefully", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockRejectedValue(
        new Error("Database error"),
      );

      const result = await dispatcher.getActor(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).toBeNull();
    });

    it("should handle invalid URL format", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      await expect(dispatcher.getActor("not-a-valid-url")).rejects.toThrow();
    });

    it("should use default URLs if entity URLs missing", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const entityWithMinimalUrls = {
        ...mockEntity,
        inboxUrl: null,
        outboxUrl: null,
        followersUrl: null,
      };
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(
        entityWithMinimalUrls,
      );

      const result = await dispatcher.getActor(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).not.toBeNull();
      expect(
        (result as any)?.inboxId?.toString() ||
          (result as any)?.inbox?.toString(),
      ).toBe("https://example.com/entities/dog/dog-123/inbox");
      expect(
        (result as any)?.outboxId?.toString() ||
          (result as any)?.outbox?.toString(),
      ).toBe("https://example.com/entities/dog/dog-123/outbox");
      expect(
        (result as any)?.followersId?.toString() ||
          (result as any)?.followers?.toString(),
      ).toBe("https://example.com/entities/dog/dog-123/followers");
    });
  });

  describe("getKeyPair", () => {
    it("should return null for non-existent actor", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      vi.spyOn(dispatcher, "getActor").mockResolvedValue(null);

      const result = await dispatcher.getKeyPair(
        "https://example.com/entities/dog/nonexistent",
      );

      expect(result).toBeNull();
    });

    it("should return null for invalid URI format", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const mockActor = {
        id: new URL("https://example.com/entities/dog/dog-123"),
        type: "Person",
      } as any;
      vi.spyOn(dispatcher, "getActor").mockResolvedValue(mockActor);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(null);

      const result = await dispatcher.getKeyPair("https://example.com/invalid");

      expect(result).toBeNull();
    });

    it("should return null if entity not found", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const mockActor = {
        id: new URL("https://example.com/entities/dog/dog-123"),
        type: "Person",
      } as any;
      vi.spyOn(dispatcher, "getActor").mockResolvedValue(mockActor);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(null);

      const result = await dispatcher.getKeyPair(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).toBeNull();
    });

    it("should return null if publicKey missing", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const mockActor = {
        id: new URL("https://example.com/entities/dog/dog-123"),
        type: "Person",
      } as any;
      vi.spyOn(dispatcher, "getActor").mockResolvedValue(mockActor);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const entityWithoutKey = {
        ...mockEntity,
        publicKey: null,
      };
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(entityWithoutKey);

      const result = await dispatcher.getKeyPair(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).toBeNull();
    });

    it("should return null if privateKey missing", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const mockActor = {
        id: new URL("https://example.com/entities/dog/dog-123"),
        type: "Person",
      } as any;
      vi.spyOn(dispatcher, "getActor").mockResolvedValue(mockActor);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      const entityWithoutPrivateKey = {
        ...mockEntity,
        privateKey: null,
      };
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(
        entityWithoutPrivateKey,
      );

      const result = await dispatcher.getKeyPair(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).toBeNull();
    });

    it("should return key pair for valid entity", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const mockActor = {
        id: new URL("https://example.com/entities/dog/dog-123"),
        type: "Person",
      } as any;
      vi.spyOn(dispatcher, "getActor").mockResolvedValue(mockActor);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue({
        publicKey: mockEntity.publicKey,
        privateKey: mockEntity.privateKey,
      });

      const result = await dispatcher.getKeyPair(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).not.toBeNull();
      expect(result?.publicKey).toBe(mockEntity.publicKey);
      expect(result?.privateKey).toBe(
        "-----BEGIN PRIVATE KEY-----\nMOCK_KEY\n-----END PRIVATE KEY-----",
      );
    });

    it("should decrypt private key", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const mockActor = {
        id: new URL("https://example.com/entities/dog/dog-123"),
        type: "Person",
      } as any;
      vi.spyOn(dispatcher, "getActor").mockResolvedValue(mockActor);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue({
        publicKey: mockEntity.publicKey,
        privateKey: "encrypted:test-private-key",
      });

      const { KeyPairService } = await import(
        "../../../../src/lib/activitypub/crypto.js"
      );

      const result = await dispatcher.getKeyPair(
        "https://example.com/entities/dog/dog-123",
      );

      expect(KeyPairService.decryptPrivateKey).toHaveBeenCalledWith(
        "encrypted:test-private-key",
        mockEnv,
      );
      expect(result?.privateKey).toBe("test-private-key");
    });

    it("should handle database errors gracefully", async () => {
      const dispatcher = new EntityActorDispatcher(mockEnv);

      const mockActor = {
        id: new URL("https://example.com/entities/dog/dog-123"),
        type: "Person",
      } as any;
      vi.spyOn(dispatcher, "getActor").mockResolvedValue(mockActor);

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockRejectedValue(
        new Error("Database error"),
      );

      const result = await dispatcher.getKeyPair(
        "https://example.com/entities/dog/dog-123",
      );

      expect(result).toBeNull();
    });
  });

  describe("generateActorUri", () => {
    it("should generate correct actor URI with entityType", () => {
      const uri = EntityActorDispatcher.generateActorUri("test-123", mockEnv, "dog");
      expect(uri).toBe("https://example.com/entities/dog/test-123");
    });

    it("should default to 'entity' when no entityType given", () => {
      const uri = EntityActorDispatcher.generateActorUri("test-123", mockEnv);
      expect(uri).toBe("https://example.com/entities/entity/test-123");
    });

    it("should use custom base URL from env", () => {
      const customEnv = createFedifyTestEnv({
        ACTIVITYPUB_BASE_URL: "https://custom.com",
      });
      const uri = EntityActorDispatcher.generateActorUri("test-123", customEnv, "plant");
      expect(uri).toBe("https://custom.com/entities/plant/test-123");
    });
  });
});
