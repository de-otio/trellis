/**
 * Unit Tests: Entity Tagging Validator
 *
 * Tests for entity tagging permission validation. Friendship is resolved
 * from the `relationships` graph edge table (lib/friend-ids.ts) — the
 * legacy KV-backed FriendsHandler was removed in the pre-launch schema
 * end-state pass.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateEntityTagging } from "../../src/lib/entity-tagging-validator.js";
import {
  InvalidEntitiesError,
  EntityTaggingPermissionError,
} from "../../src/lib/entity-tagging-errors.js";

/** Build a friend-edge row as `relationship.findMany` would return it. */
const friendEdge = (targetId: string) => ({ targetId });

describe("validateEntityTagging", () => {
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      entity: {
        findMany: vi.fn(),
      },
      relationship: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
  });

  it("should allow tagging when no entities provided", async () => {
    await expect(
      validateEntityTagging("user-123", [], mockDb as any),
    ).resolves.not.toThrow();
    // No queries at all for the empty case
    expect(mockDb.entity.findMany).not.toHaveBeenCalled();
    expect(mockDb.relationship.findMany).not.toHaveBeenCalled();
  });

  it("should allow tagging own entities", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "user-123", role: "PRIMARY" }] },
    ]);

    await expect(
      validateEntityTagging("user-123", ["entity-1"], mockDb as any),
    ).resolves.not.toThrow();
  });

  it("should allow tagging friends entities", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "friend-456", role: "PRIMARY" }] },
    ]);
    mockDb.relationship.findMany.mockResolvedValue([friendEdge("friend-456")]);

    await expect(
      validateEntityTagging("user-123", ["entity-1"], mockDb as any),
    ).resolves.not.toThrow();

    // Friend set must come from the caller's outgoing user-edges, tier ≤ 1
    expect(mockDb.relationship.findMany).toHaveBeenCalledWith({
      where: { userId: "user-123", targetType: "user", tier: { lte: 1 } },
      select: { targetId: true },
    });
  });

  it("should allow tagging mix of own and friends entities", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "user-123", role: "PRIMARY" }] },
      { id: "entity-2", owners: [{ userId: "friend-456", role: "PRIMARY" }] },
    ]);
    mockDb.relationship.findMany.mockResolvedValue([friendEdge("friend-456")]);

    await expect(
      validateEntityTagging(
        "user-123",
        ["entity-1", "entity-2"],
        mockDb as any,
      ),
    ).resolves.not.toThrow();
  });

  it("should reject tagging non-existent entities", async () => {
    mockDb.entity.findMany.mockResolvedValue([]);

    await expect(
      validateEntityTagging("user-123", ["entity-1"], mockDb as any),
    ).rejects.toThrow(InvalidEntitiesError);
  });

  it("should reject tagging entities owned by non-friends", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "stranger-789", role: "PRIMARY" }] },
    ]);
    mockDb.relationship.findMany.mockResolvedValue([]);

    await expect(
      validateEntityTagging("user-123", ["entity-1"], mockDb as any),
    ).rejects.toThrow(EntityTaggingPermissionError);
  });

  it("should reject when the owner edge is only tier 2+ (not a friend)", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "suggested-999", role: "PRIMARY" }] },
    ]);
    // tier-filtered query returns nothing for a tier-2 (suggestion/discovery) edge
    mockDb.relationship.findMany.mockResolvedValue([]);

    await expect(
      validateEntityTagging("user-123", ["entity-1"], mockDb as any),
    ).rejects.toThrow(EntityTaggingPermissionError);
  });

  it("should handle duplicate entity IDs", async () => {
    mockDb.entity.findMany.mockResolvedValue([
      { id: "entity-1", owners: [{ userId: "user-123", role: "PRIMARY" }] },
    ]);

    await expect(
      validateEntityTagging(
        "user-123",
        ["entity-1", "entity-1", "ENTITY-1"], // Duplicates and case variations
        mockDb as any,
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

    await expect(
      validateEntityTagging(
        "user-123",
        ["  ENTITY-1  ", "entity-2"],
        mockDb as any,
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

    await expect(
      validateEntityTagging(
        "user-123",
        ["entity-1", "", "   ", "entity-2"],
        mockDb as any,
      ),
    ).resolves.not.toThrow();

    expect(mockDb.entity.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["entity-1", "entity-2"] } },
      select: { id: true, owners: { select: { userId: true, role: true }, where: { status: 'ACTIVE' } } },
    });
  });
});
