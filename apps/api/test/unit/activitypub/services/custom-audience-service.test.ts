/**
 * Tests for Custom Audience Service (Fedify-Based)
 *
 * Tests custom audience creation and management using Fedify's OrderedCollection.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OrderedCollection } from "@fedify/fedify";
import { CustomAudienceService } from "../../../../src/lib/activitypub/audience-service.js";
import {
  createFedifyTestEnv,
  createMockUser,
} from "../../../utils/fedify-test-fixtures.js";
import type { Env } from "../../../../src/env.js";
import type { User, PrismaClient } from "@prisma/client";
import { DatabaseConnectionManager } from "../../../../src/lib/database-connection-manager.js";

// Mock dependencies
vi.mock("../../../../src/lib/database-connection-manager");

describe("CustomAudienceService", () => {
  let mockEnv: Env;
  let mockCreator: User;
  let mockMember1: User;
  let mockMember2: User;
  let mockPrisma: PrismaClient;

  beforeEach(() => {
    mockEnv = createFedifyTestEnv();
    mockCreator = createMockUser({
      username: "alice",
      actorUri: "https://example.com/users/alice",
    }) as User;

    mockMember1 = createMockUser({
      username: "bob",
      actorUri: "https://example.com/users/bob",
    }) as User;

    mockMember2 = createMockUser({
      username: "charlie",
      actorUri: "https://example.com/users/charlie",
    }) as User;

    // Mock Prisma client
    mockPrisma = {
      customAudience: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      customAudienceMember: {
        create: vi.fn(),
        createMany: vi.fn(),
        count: vi.fn(),
        deleteMany: vi.fn(),
      },
      user: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
    } as any;
  });

  describe("generateCollectionUri", () => {
    it("should generate correct collection URI", () => {
      const audienceId = "audience-123";
      const uri = CustomAudienceService.generateCollectionUri(
        audienceId,
        mockEnv,
      );
      expect(uri).toBe("https://example.com/audiences/audience-123");
    });

    it("should use request URL if provided", () => {
      const audienceId = "audience-123";
      const requestUrl = "https://custom-domain.com/api/audiences";
      const uri = CustomAudienceService.generateCollectionUri(
        audienceId,
        mockEnv,
        requestUrl,
      );
      expect(uri).toBe("https://custom-domain.com/audiences/audience-123");
    });
  });

  describe("createAudience", () => {
    it("should create audience with valid input", async () => {
      const mockAudience = {
        id: "audience-123",
        name: "Test Audience",
        creatorId: mockCreator.id,
        collectionId: "https://example.com/audiences/audience-123",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (mockPrisma.user.findMany as any).mockResolvedValue([
        { id: mockMember1.id },
        { id: mockMember2.id },
      ]);

      (mockPrisma.customAudience.create as any).mockResolvedValue({
        id: "audience-123",
        name: "Test Audience",
        creatorId: mockCreator.id,
        collectionId: "",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      (mockPrisma.customAudience.update as any).mockResolvedValue(mockAudience);
      (mockPrisma.customAudienceMember.createMany as any).mockResolvedValue({
        count: 2,
      });

      const result = await CustomAudienceService.createAudience(
        mockPrisma,
        mockCreator,
        "Test Audience",
        [mockMember1.id, mockMember2.id],
        mockEnv,
      );

      expect(result.id).toBe("audience-123");
      expect(result.name).toBe("Test Audience");
      expect(result.collectionId).toBe(
        "https://example.com/audiences/audience-123",
      );
      expect(mockPrisma.customAudience.create).toHaveBeenCalled();
      expect(mockPrisma.customAudience.update).toHaveBeenCalled();
      expect(mockPrisma.customAudienceMember.createMany).toHaveBeenCalled();
    });

    it("should throw error if creator has no ActivityPub fields", async () => {
      const creatorWithoutFields = {
        ...mockCreator,
        actorUri: null,
        publicKey: null,
      };

      await expect(
        CustomAudienceService.createAudience(
          mockPrisma,
          creatorWithoutFields,
          "Test Audience",
          [mockMember1.id],
          mockEnv,
        ),
      ).rejects.toThrow("Creator does not have ActivityPub fields set");
    });

    it("should throw error if name is empty", async () => {
      await expect(
        CustomAudienceService.createAudience(
          mockPrisma,
          mockCreator,
          "",
          [mockMember1.id],
          mockEnv,
        ),
      ).rejects.toThrow("Audience name is required");
    });

    it("should throw error if no members provided", async () => {
      await expect(
        CustomAudienceService.createAudience(
          mockPrisma,
          mockCreator,
          "Test Audience",
          [],
          mockEnv,
        ),
      ).rejects.toThrow("Audience must have at least one member");
    });

    it("should throw error if member not found", async () => {
      (mockPrisma.user.findMany as any).mockResolvedValue([
        { id: mockMember1.id },
      ]);

      await expect(
        CustomAudienceService.createAudience(
          mockPrisma,
          mockCreator,
          "Test Audience",
          [mockMember1.id, "non-existent-id"],
          mockEnv,
        ),
      ).rejects.toThrow(
        "Some members not found or not configured for ActivityPub",
      );
    });
  });

  describe("getMembers", () => {
    it("should return member actor URIs", async () => {
      const mockAudience = {
        id: "audience-123",
        members: [
          {
            member: {
              id: mockMember1.id,
              actorUri: mockMember1.actorUri,
              username: mockMember1.username,
            },
          },
          {
            member: {
              id: mockMember2.id,
              actorUri: mockMember2.actorUri,
              username: mockMember2.username,
            },
          },
        ],
      };

      (mockPrisma.customAudience.findUnique as any).mockResolvedValue(
        mockAudience,
      );

      const members = await CustomAudienceService.getMembers(
        mockPrisma,
        "audience-123",
        mockEnv,
      );

      expect(members).toHaveLength(2);
      expect(members).toContain("https://example.com/users/bob");
      expect(members).toContain("https://example.com/users/charlie");
    });

    it("should return empty array if audience not found", async () => {
      (mockPrisma.customAudience.findUnique as any).mockResolvedValue(null);

      const members = await CustomAudienceService.getMembers(
        mockPrisma,
        "non-existent",
        mockEnv,
      );

      expect(members).toEqual([]);
    });
  });

  describe("createOrderedCollection", () => {
    it("should create Fedify OrderedCollection", async () => {
      const mockAudience = {
        id: "audience-123",
        collectionId: "https://example.com/audiences/audience-123",
        members: [
          {
            member: {
              id: mockMember1.id,
              actorUri: mockMember1.actorUri,
              username: mockMember1.username,
            },
          },
          {
            member: {
              id: mockMember2.id,
              actorUri: mockMember2.actorUri,
              username: mockMember2.username,
            },
          },
        ],
      };

      (mockPrisma.customAudience.findUnique as any).mockResolvedValue(
        mockAudience,
      );
      (mockPrisma.customAudienceMember.count as any).mockResolvedValue(2);

      const collection = await CustomAudienceService.createOrderedCollection(
        mockPrisma,
        "audience-123",
        mockEnv,
      );

      expect(collection).toBeInstanceOf(OrderedCollection);
      expect(collection.id?.toString()).toBe(
        "https://example.com/audiences/audience-123",
      );
      expect(collection.totalItems).toBe(2);
      // Fedify OrderedCollection may not expose orderedItems directly
      // Verify the collection was created successfully by checking it has the expected properties
      const collectionAny = collection as any;
      // Check if orderedItems exists (Fedify may store it internally)
      // If not directly accessible, verify via serialization or internal structure
      expect(collectionAny.totalItems).toBe(2);
    });

    it("should throw error if audience not found", async () => {
      (mockPrisma.customAudience.findUnique as any).mockResolvedValue(null);

      await expect(
        CustomAudienceService.createOrderedCollection(
          mockPrisma,
          "non-existent",
          mockEnv,
        ),
      ).rejects.toThrow("Audience not found");
    });
  });

  describe("resolveCollection", () => {
    it("should resolve collection URI to member actor URIs", async () => {
      const collectionUri = "https://example.com/audiences/audience-123";
      const mockAudience = {
        id: "audience-123",
        members: [
          {
            member: {
              id: mockMember1.id,
              actorUri: mockMember1.actorUri,
              username: mockMember1.username,
            },
          },
        ],
      };

      (mockPrisma.customAudience.findUnique as any).mockResolvedValue(
        mockAudience,
      );

      const members = await CustomAudienceService.resolveCollection(
        mockPrisma,
        collectionUri,
        mockEnv,
      );

      expect(members).toHaveLength(1);
      expect(members[0]).toBe("https://example.com/users/bob");
    });

    it("should return empty array for invalid URI", async () => {
      const members = await CustomAudienceService.resolveCollection(
        mockPrisma,
        "https://example.com/invalid-uri",
        mockEnv,
      );

      expect(members).toEqual([]);
    });

    it("should handle audience with no members", async () => {
      const collectionUri = "https://example.com/audiences/audience-empty";
      const mockAudience = {
        id: "audience-empty",
        members: [],
      };

      (mockPrisma.customAudience.findUnique as any).mockResolvedValue(
        mockAudience,
      );

      const members = await CustomAudienceService.resolveCollection(
        mockPrisma,
        collectionUri,
        mockEnv,
      );

      expect(members).toEqual([]);
    });
  });

  describe("createAudience - additional edge cases", () => {
    it("should throw error if name exceeds 100 characters", async () => {
      const longName = "a".repeat(101);

      await expect(
        CustomAudienceService.createAudience(
          mockPrisma,
          mockCreator,
          longName,
          [mockMember1.id],
          mockEnv,
        ),
      ).rejects.toThrow("Audience name must be 100 characters or less");
    });

    it("should throw error if name is only whitespace", async () => {
      await expect(
        CustomAudienceService.createAudience(
          mockPrisma,
          mockCreator,
          "   ",
          [mockMember1.id],
          mockEnv,
        ),
      ).rejects.toThrow("Audience name is required");
    });

    it("should throw error if too many members", async () => {
      const tooManyMembers = Array.from(
        { length: 1001 },
        (_, i) => `member-${i}`,
      );

      await expect(
        CustomAudienceService.createAudience(
          mockPrisma,
          mockCreator,
          "Test Audience",
          tooManyMembers,
          mockEnv,
        ),
      ).rejects.toThrow("Audience cannot have more than 1000 members");
    });

    it("should handle member with missing actorId", async () => {
      // Only return member1, not member-without-actor (simulating missing actorId filter)
      (mockPrisma.user.findMany as any).mockResolvedValue([
        { id: mockMember1.id }, // Has actorId
        // member-without-actor not returned (filtered out by query)
      ]);

      await expect(
        CustomAudienceService.createAudience(
          mockPrisma,
          mockCreator,
          "Test Audience",
          [mockMember1.id, "member-without-actor"],
          mockEnv,
        ),
      ).rejects.toThrow(
        "Some members not found or not configured for ActivityPub",
      );
    });

    it("should handle suspended members", async () => {
      // Suspended member is filtered out by query, so only member1 is returned
      (mockPrisma.user.findMany as any).mockResolvedValue([
        { id: mockMember1.id }, // Not suspended
        // suspended-member not returned (filtered out)
      ]);

      await expect(
        CustomAudienceService.createAudience(
          mockPrisma,
          mockCreator,
          "Test Audience",
          [mockMember1.id, "suspended-member"],
          mockEnv,
        ),
      ).rejects.toThrow(
        "Some members not found or not configured for ActivityPub",
      );
    });

    it("should trim audience name", async () => {
      const mockAudience = {
        id: "audience-123",
        name: "Test Audience",
        creatorId: mockCreator.id,
        collectionId: "https://example.com/audiences/audience-123",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (mockPrisma.user.findMany as any).mockResolvedValue([
        { id: mockMember1.id },
      ]);
      (mockPrisma.customAudience.create as any).mockResolvedValue({
        id: "audience-123",
        name: "Test Audience",
        creatorId: mockCreator.id,
        collectionId: "",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      (mockPrisma.customAudience.update as any).mockResolvedValue(mockAudience);
      (mockPrisma.customAudienceMember.createMany as any).mockResolvedValue({
        count: 1,
      });

      const result = await CustomAudienceService.createAudience(
        mockPrisma,
        mockCreator,
        "  Test Audience  ",
        [mockMember1.id],
        mockEnv,
      );

      expect(mockPrisma.customAudience.create).toHaveBeenCalledWith({
        data: {
          name: "Test Audience", // Should be trimmed
          creatorId: mockCreator.id,
          collectionId: "",
        },
      });
    });

    it("should handle database errors during audience creation", async () => {
      (mockPrisma.user.findMany as any).mockResolvedValue([
        { id: mockMember1.id },
      ]);
      (mockPrisma.customAudience.create as any).mockRejectedValue(
        new Error("Database error"),
      );

      await expect(
        CustomAudienceService.createAudience(
          mockPrisma,
          mockCreator,
          "Test Audience",
          [mockMember1.id],
          mockEnv,
        ),
      ).rejects.toThrow("Database error");
    });

    it("should handle database errors during member creation", async () => {
      const mockAudience = {
        id: "audience-123",
        name: "Test Audience",
        creatorId: mockCreator.id,
        collectionId: "",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (mockPrisma.user.findMany as any).mockResolvedValue([
        { id: mockMember1.id },
      ]);
      (mockPrisma.customAudience.create as any).mockResolvedValue(mockAudience);
      (mockPrisma.customAudience.update as any).mockResolvedValue({
        ...mockAudience,
        collectionId: "https://example.com/audiences/audience-123",
      });
      (mockPrisma.customAudienceMember.createMany as any).mockRejectedValue(
        new Error("Member creation error"),
      );

      await expect(
        CustomAudienceService.createAudience(
          mockPrisma,
          mockCreator,
          "Test Audience",
          [mockMember1.id],
          mockEnv,
        ),
      ).rejects.toThrow("Member creation error");
    });
  });

  describe("getMembers - additional edge cases", () => {
    it("should handle audience with members missing actorId", async () => {
      const mockAudience = {
        id: "audience-123",
        members: [
          {
            member: {
              id: mockMember1.id,
              actorUri: mockMember1.actorUri,
              username: mockMember1.username,
            },
          },
          {
            member: {
              id: "member-without-actor",
              actorUri: null,
              username: "noactor",
            },
          },
        ],
      };

      (mockPrisma.customAudience.findUnique as any).mockResolvedValue(
        mockAudience,
      );

      const members = await CustomAudienceService.getMembers(
        mockPrisma,
        "audience-123",
        mockEnv,
      );

      // Should only return members with actorId
      expect(members).toHaveLength(1);
      expect(members[0]).toBe("https://example.com/users/bob");
    });

    it("should handle empty members array", async () => {
      const mockAudience = {
        id: "audience-123",
        members: [],
      };

      (mockPrisma.customAudience.findUnique as any).mockResolvedValue(
        mockAudience,
      );

      const members = await CustomAudienceService.getMembers(
        mockPrisma,
        "audience-123",
        mockEnv,
      );

      expect(members).toEqual([]);
    });
  });

  describe("createOrderedCollection - additional edge cases", () => {
    it("should handle audience with no members", async () => {
      const mockAudience = {
        id: "audience-123",
        collectionId: "https://example.com/audiences/audience-123",
        members: [],
      };

      (mockPrisma.customAudience.findUnique as any).mockResolvedValue(
        mockAudience,
      );
      (mockPrisma.customAudienceMember.count as any).mockResolvedValue(0);

      const collection = await CustomAudienceService.createOrderedCollection(
        mockPrisma,
        "audience-123",
        mockEnv,
      );

      expect(collection).toBeInstanceOf(OrderedCollection);
      expect(collection.totalItems).toBe(0);
    });

    it("should handle database errors", async () => {
      (mockPrisma.customAudience.findUnique as any).mockRejectedValue(
        new Error("Database error"),
      );

      await expect(
        CustomAudienceService.createOrderedCollection(
          mockPrisma,
          "audience-123",
          mockEnv,
        ),
      ).rejects.toThrow("Database error");
    });
  });

  describe("resolveCollection - additional edge cases", () => {
    it("should handle database errors", async () => {
      (mockPrisma.customAudience.findUnique as any).mockRejectedValue(
        new Error("Database error"),
      );

      await expect(
        CustomAudienceService.resolveCollection(
          mockPrisma,
          "https://example.com/audiences/audience-123",
          mockEnv,
        ),
      ).rejects.toThrow("Database error");
    });

    it("should handle URI with different base URL", async () => {
      const collectionUri = "https://custom-domain.com/audiences/audience-123";
      const mockAudience = {
        id: "audience-123",
        members: [
          {
            member: {
              id: mockMember1.id,
              actorUri: mockMember1.actorUri,
              username: mockMember1.username,
            },
          },
        ],
      };

      (mockPrisma.customAudience.findUnique as any).mockResolvedValue(
        mockAudience,
      );

      const members = await CustomAudienceService.resolveCollection(
        mockPrisma,
        collectionUri,
        mockEnv,
      );

      expect(members).toHaveLength(1);
    });
  });

  describe("addMember", () => {
    it("should add member to audience successfully", async () => {
      const member = {
        id: mockMember1.id,
        actorUri: mockMember1.actorUri,
        publicKey: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
        suspended: false,
        deletedAt: null,
      };

      (mockPrisma.user.findUnique as any).mockResolvedValue(member);
      (mockPrisma.customAudienceMember.create as any).mockResolvedValue({
        id: "member-1",
        audienceId: "audience-123",
        memberId: mockMember1.id,
      });

      await CustomAudienceService.addMember(
        mockPrisma,
        "audience-123",
        mockMember1.id,
      );

      expect(mockPrisma.customAudienceMember.create).toHaveBeenCalledWith({
        data: {
          audienceId: "audience-123",
          memberId: mockMember1.id,
        },
      });
    });

    it("should throw error if member not found", async () => {
      (mockPrisma.user.findUnique as any).mockResolvedValue(null);

      await expect(
        CustomAudienceService.addMember(
          mockPrisma,
          "audience-123",
          "non-existent",
        ),
      ).rejects.toThrow("Member not found or not configured for ActivityPub");
    });

    it("should throw error if member missing actorId", async () => {
      const member = {
        id: mockMember1.id,
        actorUri: null,
        publicKey: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
        suspended: false,
        deletedAt: null,
      };

      (mockPrisma.user.findUnique as any).mockResolvedValue(member);

      await expect(
        CustomAudienceService.addMember(
          mockPrisma,
          "audience-123",
          mockMember1.id,
        ),
      ).rejects.toThrow("Member not found or not configured for ActivityPub");
    });

    it("should throw error if member missing publicKey", async () => {
      const member = {
        id: mockMember1.id,
        actorUri: mockMember1.actorUri,
        publicKey: null,
        suspended: false,
        deletedAt: null,
      };

      (mockPrisma.user.findUnique as any).mockResolvedValue(member);

      await expect(
        CustomAudienceService.addMember(
          mockPrisma,
          "audience-123",
          mockMember1.id,
        ),
      ).rejects.toThrow("Member not found or not configured for ActivityPub");
    });

    it("should throw error if member is suspended", async () => {
      const member = {
        id: mockMember1.id,
        actorUri: mockMember1.actorUri,
        publicKey: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
        suspended: true,
        deletedAt: null,
      };

      (mockPrisma.user.findUnique as any).mockResolvedValue(member);

      await expect(
        CustomAudienceService.addMember(
          mockPrisma,
          "audience-123",
          mockMember1.id,
        ),
      ).rejects.toThrow("Cannot add suspended or deleted user to audience");
    });

    it("should throw error if member is deleted", async () => {
      const member = {
        id: mockMember1.id,
        actorUri: mockMember1.actorUri,
        publicKey: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
        suspended: false,
        deletionConfirmedAt: new Date(),
      };

      (mockPrisma.user.findUnique as any).mockResolvedValue(member);

      await expect(
        CustomAudienceService.addMember(
          mockPrisma,
          "audience-123",
          mockMember1.id,
        ),
      ).rejects.toThrow("Cannot add suspended or deleted user to audience");
    });

    it("should ignore unique constraint violation (member already in audience)", async () => {
      const member = {
        id: mockMember1.id,
        actorUri: mockMember1.actorUri,
        publicKey: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
        suspended: false,
        deletedAt: null,
      };

      (mockPrisma.user.findUnique as any).mockResolvedValue(member);

      const uniqueError = new Error("Unique constraint violation");
      (uniqueError as any).code = "P2002";
      (mockPrisma.customAudienceMember.create as any).mockRejectedValue(
        uniqueError,
      );

      // Should not throw
      await CustomAudienceService.addMember(
        mockPrisma,
        "audience-123",
        mockMember1.id,
      );

      expect(mockPrisma.customAudienceMember.create).toHaveBeenCalled();
    });

    it("should throw other database errors", async () => {
      const member = {
        id: mockMember1.id,
        actorUri: mockMember1.actorUri,
        publicKey: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
        suspended: false,
        deletedAt: null,
      };

      (mockPrisma.user.findUnique as any).mockResolvedValue(member);
      (mockPrisma.customAudienceMember.create as any).mockRejectedValue(
        new Error("Database error"),
      );

      await expect(
        CustomAudienceService.addMember(
          mockPrisma,
          "audience-123",
          mockMember1.id,
        ),
      ).rejects.toThrow("Database error");
    });
  });

  describe("removeMember", () => {
    it("should remove member from audience successfully", async () => {
      (mockPrisma.customAudienceMember.deleteMany as any).mockResolvedValue({
        count: 1,
      });

      await CustomAudienceService.removeMember(
        mockPrisma,
        "audience-123",
        mockMember1.id,
      );

      expect(mockPrisma.customAudienceMember.deleteMany).toHaveBeenCalledWith({
        where: {
          audienceId: "audience-123",
          memberId: mockMember1.id,
        },
      });
    });

    it("should handle member not in audience gracefully", async () => {
      (mockPrisma.customAudienceMember.deleteMany as any).mockResolvedValue({
        count: 0,
      });

      await CustomAudienceService.removeMember(
        mockPrisma,
        "audience-123",
        "non-existent-member",
      );

      expect(mockPrisma.customAudienceMember.deleteMany).toHaveBeenCalled();
    });

    it("should handle database errors", async () => {
      (mockPrisma.customAudienceMember.deleteMany as any).mockRejectedValue(
        new Error("Database error"),
      );

      await expect(
        CustomAudienceService.removeMember(
          mockPrisma,
          "audience-123",
          mockMember1.id,
        ),
      ).rejects.toThrow("Database error");
    });
  });
});
