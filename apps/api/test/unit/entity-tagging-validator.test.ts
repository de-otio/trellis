/**
 * Unit Tests: Entity Tagging Validator
 *
 * Tests for entity tagging permission validation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateEntityTagging,
  cacheEntityOwner,
  getCachedEntityOwner,
} from "../../src/lib/entity-tagging-validator.js";
import { FriendsHandler } from "../../src/lib/friends-handler.js";
import {
  InvalidEntitiesError,
  EntityTaggingPermissionError,
} from "../../src/lib/entity-tagging-errors.js";
import type { Session } from "../../src/lib/session-cookie.js";
import type { PrismaClient } from "@prisma/client/edge";

describe("validateEntityTagging", () => {
  let mockDb: any;
  let mockFriendsHandler: FriendsHandler;
  let mockSession: Session;
  let mockEnv: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      entity: {
        findMany: vi.fn(),
      },
    };

    mockFriendsHandler = {
      getFriends: vi.fn(),
    } as any;

    mockSession = {
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    };

    mockEnv = {
      FRIENDS_KV: {} as any,
      CACHE_KV: {} as any,
    };
  });

  it("should allow tagging when no entities provided", async () => {
    await expect(
      validateEntityTagging(
        "user-123",
        [],
        mockDb as any,
        mockFriendsHandler,
        mockEnv,
        mockSession,
      ),
    ).resolves.not.toThrow();
  });

  it("should allow tagging own entities", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "user-123", role: "PRIMARY" }] },
    ]);
    mockFriendsHandler.getFriends = vi.fn().mockResolvedValue([]);

    await expect(
      validateEntityTagging(
        "user-123",
        ["entity-1"],
        mockDb as any,
        mockFriendsHandler,
        mockEnv,
        mockSession,
      ),
    ).resolves.not.toThrow();
  });

  it("should allow tagging friends entities", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "friend-456", role: "PRIMARY" }] },
    ]);
    mockFriendsHandler.getFriends = vi
      .fn()
      .mockResolvedValue([{ id: "friend-456", email: "friend@example.com" }]);

    await expect(
      validateEntityTagging(
        "user-123",
        ["entity-1"],
        mockDb as any,
        mockFriendsHandler,
        mockEnv,
        mockSession,
      ),
    ).resolves.not.toThrow();
  });

  it("should allow tagging mix of own and friends entities", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "user-123", role: "PRIMARY" }] },
      { id: "entity-2", owners: [{ userId: "friend-456", role: "PRIMARY" }] },
    ]);
    mockFriendsHandler.getFriends = vi
      .fn()
      .mockResolvedValue([{ id: "friend-456", email: "friend@example.com" }]);

    await expect(
      validateEntityTagging(
        "user-123",
        ["entity-1", "entity-2"],
        mockDb as any,
        mockFriendsHandler,
        mockEnv,
        mockSession,
      ),
    ).resolves.not.toThrow();
  });

  it("should reject tagging non-existent entities", async () => {
    mockDb.entity.findMany.mockResolvedValue([]);

    await expect(
      validateEntityTagging(
        "user-123",
        ["entity-1"],
        mockDb as any,
        mockFriendsHandler,
        mockEnv,
        mockSession,
      ),
    ).rejects.toThrow(InvalidEntitiesError);
  });

  it("should reject tagging entities owned by non-friends", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "stranger-789", role: "PRIMARY" }] },
    ]);
    mockFriendsHandler.getFriends = vi.fn().mockResolvedValue([]);

    await expect(
      validateEntityTagging(
        "user-123",
        ["entity-1"],
        mockDb as any,
        mockFriendsHandler,
        mockEnv,
        mockSession,
      ),
    ).rejects.toThrow(EntityTaggingPermissionError);
  });

  it("should handle duplicate entity IDs", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "user-123", role: "PRIMARY" }] },
    ]);
    mockFriendsHandler.getFriends = vi.fn().mockResolvedValue([]);

    await expect(
      validateEntityTagging(
        "user-123",
        ["entity-1", "entity-1", "ENTITY-1"], // Duplicates and case variations
        mockDb as any,
        mockFriendsHandler,
        mockEnv,
        mockSession,
      ),
    ).resolves.not.toThrow();

    // Should be called with unique IDs
    expect(mockDb.entity.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["entity-1"] } },
      select: { id: true, owners: { select: { userId: true, role: true }, where: { status: 'ACTIVE' } } },
    });
  });

  it("should trim and lowercase entity IDs", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "user-123", role: "PRIMARY" }] },
      { id: "entity-2", owners: [{ userId: "user-123", role: "PRIMARY" }] },
    ]);
    mockFriendsHandler.getFriends = vi.fn().mockResolvedValue([]);

    await expect(
      validateEntityTagging(
        "user-123",
        ["  ENTITY-1  ", "entity-2"],
        mockDb as any,
        mockFriendsHandler,
        mockEnv,
        mockSession,
      ),
    ).resolves.not.toThrow();

    expect(mockDb.entity.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["entity-1", "entity-2"] } },
      select: { id: true, owners: { select: { userId: true, role: true }, where: { status: 'ACTIVE' } } },
    });
  });

  it("should filter out empty entity IDs", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "user-123", role: "PRIMARY" }] },
      { id: "entity-2", owners: [{ userId: "user-123", role: "PRIMARY" }] },
    ]);
    mockFriendsHandler.getFriends = vi.fn().mockResolvedValue([]);

    await expect(
      validateEntityTagging(
        "user-123",
        ["entity-1", "", "   ", "entity-2"],
        mockDb as any,
        mockFriendsHandler,
        mockEnv,
        mockSession,
      ),
    ).resolves.not.toThrow();

    expect(mockDb.entity.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["entity-1", "entity-2"] } },
      select: { id: true, owners: { select: { userId: true, role: true }, where: { status: 'ACTIVE' } } },
    });
  });
});

describe("cacheEntityOwner", () => {
  it("should cache entity owner when CACHE_KV is available", async () => {
    const mockPut = vi.fn().mockResolvedValue(undefined);
    const env = {
      CACHE_KV: {
        put: mockPut,
      } as any,
    };

    await cacheEntityOwner("entity-1", "owner-123", env, 300);

    expect(mockPut).toHaveBeenCalledWith("entity-owner:entity-1", "owner-123", {
      expirationTtl: 300,
    });
  });

  it("should not cache when CACHE_KV is not available", async () => {
    const env = {};

    await expect(
      cacheEntityOwner("entity-1", "owner-123", env, 300),
    ).resolves.not.toThrow();
  });
});

describe("getCachedEntityOwner", () => {
  it("should get cached entity owner when CACHE_KV is available", async () => {
    const mockGet = vi.fn().mockResolvedValue("owner-123");
    const env = {
      CACHE_KV: {
        get: mockGet,
      } as any,
    };

    const result = await getCachedEntityOwner("entity-1", env);

    expect(result).toBe("owner-123");
    expect(mockGet).toHaveBeenCalledWith("entity-owner:entity-1");
  });

  it("should return null when CACHE_KV is not available", async () => {
    const env = {};

    const result = await getCachedEntityOwner("entity-1", env);

    expect(result).toBeNull();
  });

  it("should return null when cache miss", async () => {
    const mockGet = vi.fn().mockResolvedValue(null);
    const env = {
      CACHE_KV: {
        get: mockGet,
      } as any,
    };

    const result = await getCachedEntityOwner("entity-1", env);

    expect(result).toBeNull();
  });
});
