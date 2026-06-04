/**
 * Unit Tests: Entity Profile Service
 *
 * Tests for ActivityPub entity actor functionality.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntityProfileService } from "../../../src/lib/activitypub/entity-profile-service.js";
import type { PrismaClient, Entity } from "@prisma/client";
import type { Env } from "../../../src/env.js";

// Mock extensions registry
vi.mock("../../../src/extensions", () => ({
  getExtension: vi.fn(() => undefined),
}));

// Mock KeyPairService
vi.mock("../../../src/lib/activitypub/crypto", () => ({
  KeyPairService: {
    generateKeyPair: vi.fn(() => ({
      publicKey: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
      privateKey:
        "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
    })),
    encryptPrivateKey: vi.fn((key: string) => `encrypted:${key}`),
  },
}));

describe("EntityProfileService", () => {
  let mockPrisma: Partial<PrismaClient>;
  let mockEnv: Env;
  let mockEntity: Entity;

  beforeEach(() => {
    mockPrisma = {
      entity: {
        update: vi.fn(),
      },
      follow: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
    } as any;

    mockEnv = {
      ACTIVITYPUB_BASE_URL: "https://example.com",
    } as Env;

    mockEntity = {
      id: "entity-1",
      name: "Mochi",
      entityType: "dog",
      ownerId: "user-1",
      metadata: {
        breed: "Shiba Inu",
        bio: "Ball enthusiast",
        birthdate: "2021-05-10",
      },
      actorUri: "https://example.com/entities/dog/entity-1",
      inboxUrl: "https://example.com/entities/dog/entity-1/inbox",
      outboxUrl: "https://example.com/entities/dog/entity-1/outbox",
      followersUrl: "https://example.com/entities/dog/entity-1/followers",
      publicKey: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
      privateKey: "encrypted:private-key",
      followPrivacy: "PUBLIC",
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    } as Entity;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("generateActorUri", () => {
    it("should generate actor URI for dog profile", () => {
      const result = EntityProfileService.generateActorUri("entity-1", "dog", mockEnv);

      expect(result).toBe("https://example.com/entities/dog/entity-1");
    });
  });

  describe("getActorUri", () => {
    it("should return existing actorId if present", () => {
      const result = EntityProfileService.getActorUri(mockEntity, mockEnv);

      expect(result).toBe("https://example.com/entities/dog/entity-1");
    });

    it("should generate actor URI if missing", () => {
      const entityWithoutActorId = {
        ...mockEntity,
        actorUri: null,
      } as Entity;

      const result = EntityProfileService.getActorUri(
        entityWithoutActorId,
        mockEnv,
      );

      expect(result).toBe("https://example.com/entities/dog/entity-1");
    });
  });

  describe("generateCollectionUrls", () => {
    it("should generate collection URLs for dog profile", () => {
      const actorUri = "https://example.com/entities/dog/entity-1";
      const result = EntityProfileService.generateCollectionUrls(actorUri);

      expect(result).toEqual({
        inbox: "https://example.com/entities/dog/entity-1/inbox",
        outbox: "https://example.com/entities/dog/entity-1/outbox",
        followers: "https://example.com/entities/dog/entity-1/followers",
      });
    });
  });

  // Actor serialization is handled by EntityActorDispatcher.entityToActor()
  // and Fedify's respondWithObject() — single serialization path via Fedify

  describe("initializeActorFields", () => {
    it("should initialize ActivityPub fields for entity", async () => {
      const entityWithoutFields = {
        ...mockEntity,
        actorUri: null,
        inboxUrl: null,
        outboxUrl: null,
        followersUrl: null,
        publicKey: null,
        privateKey: null,
      } as Entity;

      const updatedEntity = {
        ...entityWithoutFields,
        actorUri: "https://example.com/entities/dog/entity-1",
        inboxUrl: "https://example.com/entities/dog/entity-1/inbox",
        outboxUrl: "https://example.com/entities/dog/entity-1/outbox",
        followersUrl: "https://example.com/entities/dog/entity-1/followers",
        publicKey: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
        privateKey: "encrypted:private-key",
      };

      (mockPrisma.entity.update as any).mockResolvedValue(updatedEntity);

      const result = await EntityProfileService.initializeActorFields(
        mockPrisma as PrismaClient,
        entityWithoutFields,
        mockEnv,
      );

      expect(mockPrisma.entity.update).toHaveBeenCalledWith({
        where: { id: entityWithoutFields.id },
        data: {
          actorUri: "https://example.com/entities/dog/entity-1",
          inboxUrl: "https://example.com/entities/dog/entity-1/inbox",
          outboxUrl: "https://example.com/entities/dog/entity-1/outbox",
          followersUrl: "https://example.com/entities/dog/entity-1/followers",
          publicKey: expect.any(String),
          privateKey: expect.stringContaining("encrypted:"),
        },
      });

      expect(result).toEqual(updatedEntity);
    });
  });

  // getFollowers and getFollowersCount tests removed:
  // Follow relationships are now stored in the graph DB (AuraDB), not Postgres.
  // EntityProfileService.getFollowers() returns [] and getFollowersCount() returns 0.
});
