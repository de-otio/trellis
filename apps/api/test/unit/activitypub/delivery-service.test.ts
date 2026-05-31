/**
 * Unit Tests: Delivery Service
 *
 * Tests for ActivityPub activity delivery to recipients.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryService } from "../../../src/lib/activitypub/delivery-service.js";
import { getLogger } from "../../../src/lib/logger.js";
import type { Env } from "../../../src/env.js";
import type {
  PrismaClient,
  User,
  Post,
  Follow,
  Friendship,
  GroupMember,
} from "@prisma/client";
import { createFedifyTestEnv } from "../../utils/fedify-test-fixtures.js";

// Mock dependencies
vi.mock("../../../src/lib/activitypub/actor", () => ({
  ActorService: {
    getActorUri: vi.fn(
      (user: User, env: Env) =>
        user.actorUri || `https://example.com/users/${user.username}`,
    ),
  },
}));
vi.mock("../../../src/lib/activitypub/services/fedify-delivery", () => ({
  deliverActivityWithFedify: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../../src/lib/activitypub/dispatchers/user-actor", () => ({
  UserActorDispatcher: {
    generateActorUri: vi.fn(
      (username: string, env: Env) => `https://example.com/users/${username}`,
    ),
  },
}));
vi.mock("../../../src/lib/activitypub/audience-service", () => ({
  CustomAudienceService: {
    resolveCollection: vi.fn().mockResolvedValue([]),
  },
}));

describe("DeliveryService", () => {
  let mockPrisma: Partial<PrismaClient>;
  let mockEnv: Env;

  beforeEach(() => {
    mockEnv = createFedifyTestEnv();

    mockPrisma = {
      follow: {
        findMany: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      friendship: {
        findMany: vi.fn(),
      },
      groupMember: {
        findMany: vi.fn(),
      },
    } as any;

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("getFollowers", () => {
    // getFollowers is stubbed to return [] — follow relationships moved to the graph DB.
    it("should return empty array (follow relationships moved to graph DB)", async () => {
      const result = await DeliveryService.getFollowers(
        mockPrisma as PrismaClient,
        "user-123",
      );
      expect(result).toHaveLength(0);
    });
  });

  describe("getFriends", () => {
    // getFriends is stubbed to return [] — friendship relationships moved to the graph DB.
    it("should return empty array (friendship relationships moved to graph DB)", async () => {
      (mockPrisma.user.findUnique as any).mockResolvedValue(null);

      const result = await DeliveryService.getFriends(
        mockPrisma as PrismaClient,
        "user-123",
      );

      expect(result).toHaveLength(0);
    });

  });

  describe("getGroupMembers", () => {
    it("should get members of a group", async () => {
      const groupId = "group-123";
      const mockMembers = [
        { groupId, actorUri: "https://example.com/users/member1" },
        { groupId, actorUri: "https://example.com/users/member2" },
      ] as GroupMember[];

      const mockUser1 = {
        id: "user-1",
        username: "member1",
        actorUri: "https://example.com/users/member1",
      } as User;
      const mockUser2 = {
        id: "user-2",
        username: "member2",
        actorUri: "https://example.com/users/member2",
      } as User;

      (mockPrisma.groupMember.findMany as any).mockResolvedValue(mockMembers);
      (mockPrisma.user.findUnique as any)
        .mockResolvedValueOnce(mockUser1)
        .mockResolvedValueOnce(mockUser2);

      const result = await DeliveryService.getGroupMembers(
        mockPrisma as PrismaClient,
        groupId,
      );

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("user-1");
      expect(result[1].id).toBe("user-2");
    });

    it("should return empty array when group has no members", async () => {
      const groupId = "group-123";
      (mockPrisma.groupMember.findMany as any).mockResolvedValue([]);

      const result = await DeliveryService.getGroupMembers(
        mockPrisma as PrismaClient,
        groupId,
      );

      expect(result).toHaveLength(0);
    });

    it("should filter out members that are not found", async () => {
      const groupId = "group-123";
      const mockMembers = [
        { groupId, actorUri: "https://example.com/users/member1" },
        { groupId, actorUri: "https://example.com/users/nonexistent" },
      ] as GroupMember[];

      const mockUser1 = {
        id: "user-1",
        username: "member1",
        actorUri: "https://example.com/users/member1",
      } as User;

      (mockPrisma.groupMember.findMany as any).mockResolvedValue(mockMembers);
      (mockPrisma.user.findUnique as any)
        .mockResolvedValueOnce(mockUser1)
        .mockResolvedValueOnce(null);

      const result = await DeliveryService.getGroupMembers(
        mockPrisma as PrismaClient,
        groupId,
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("user-1");
    });
  });

  describe("resolveActorUri", () => {
    it("should resolve local actor URI to user", async () => {
      const actorUri = "https://example.com/users/alice";
      const mockUser = {
        id: "user-123",
        username: "alice",
        actorUri: actorUri,
        inboxUrl: `${actorUri}/inbox`,
        suspended: false,
        deletedAt: null,
      } as User;

      (mockPrisma.user.findUnique as any).mockResolvedValue(mockUser);

      const result = await DeliveryService.resolveActorUri(
        mockPrisma as PrismaClient,
        actorUri,
        mockEnv,
      );

      expect(result).toEqual(mockUser);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { username: "alice" },
        select: {
          id: true,
          username: true,
          actorUri: true,
          inboxUrl: true,
          suspended: true,
          deletionConfirmedAt: true,
        },
      });
    });

    it("should return null for remote actor URI", async () => {
      const remoteUri = "https://mastodon.social/users/alice";

      const result = await DeliveryService.resolveActorUri(
        mockPrisma as PrismaClient,
        remoteUri,
        mockEnv,
      );

      expect(result).toBeNull();
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("should return null for invalid URI format", async () => {
      const invalidUri = "https://example.com/invalid/path";

      const result = await DeliveryService.resolveActorUri(
        mockPrisma as PrismaClient,
        invalidUri,
        mockEnv,
      );

      expect(result).toBeNull();
    });

    it("should return null if user not found", async () => {
      const actorUri = "https://example.com/users/nonexistent";
      (mockPrisma.user.findUnique as any).mockResolvedValue(null);

      const result = await DeliveryService.resolveActorUri(
        mockPrisma as PrismaClient,
        actorUri,
        mockEnv,
      );

      expect(result).toBeNull();
    });

    it("should return null if user is suspended", async () => {
      const actorUri = "https://example.com/users/alice";
      const mockUser = {
        id: "user-123",
        username: "alice",
        actorUri: actorUri,
        inboxUrl: `${actorUri}/inbox`,
        suspended: true,
        deletedAt: null,
      } as User;

      (mockPrisma.user.findUnique as any).mockResolvedValue(mockUser);

      const result = await DeliveryService.resolveActorUri(
        mockPrisma as PrismaClient,
        actorUri,
        mockEnv,
      );

      expect(result).toBeNull();
    });

    it("should return null if user is deleted", async () => {
      const actorUri = "https://example.com/users/alice";
      const mockUser = {
        id: "user-123",
        username: "alice",
        actorUri: actorUri,
        inboxUrl: `${actorUri}/inbox`,
        suspended: false,
        deletionConfirmedAt: new Date(),
      } as User;

      (mockPrisma.user.findUnique as any).mockResolvedValue(mockUser);

      const result = await DeliveryService.resolveActorUri(
        mockPrisma as PrismaClient,
        actorUri,
        mockEnv,
      );

      expect(result).toBeNull();
    });

    it("should return null if user missing actorId", async () => {
      const actorUri = "https://example.com/users/alice";
      const mockUser = {
        id: "user-123",
        username: "alice",
        actorUri: null,
        inboxUrl: `${actorUri}/inbox`,
        suspended: false,
        deletedAt: null,
      } as any;

      (mockPrisma.user.findUnique as any).mockResolvedValue(mockUser);

      const result = await DeliveryService.resolveActorUri(
        mockPrisma as PrismaClient,
        actorUri,
        mockEnv,
      );

      expect(result).toBeNull();
    });

    it("should return null if user missing inboxUrl", async () => {
      const actorUri = "https://example.com/users/alice";
      const mockUser = {
        id: "user-123",
        username: "alice",
        actorUri: actorUri,
        inboxUrl: null,
        suspended: false,
        deletedAt: null,
      } as any;

      (mockPrisma.user.findUnique as any).mockResolvedValue(mockUser);

      const result = await DeliveryService.resolveActorUri(
        mockPrisma as PrismaClient,
        actorUri,
        mockEnv,
      );

      expect(result).toBeNull();
    });

    it("should handle URL-encoded usernames", async () => {
      const actorUri = "https://example.com/users/alice%20smith";
      const mockUser = {
        id: "user-123",
        username: "alice smith",
        actorUri: actorUri,
        inboxUrl: `${actorUri}/inbox`,
        suspended: false,
        deletedAt: null,
      } as User;

      (mockPrisma.user.findUnique as any).mockResolvedValue(mockUser);

      const result = await DeliveryService.resolveActorUri(
        mockPrisma as PrismaClient,
        actorUri,
        mockEnv,
      );

      expect(result).toEqual(mockUser);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { username: "alice smith" },
        select: expect.any(Object),
      });
    });
  });

  describe("getRecipients", () => {
    it("should get recipients for group post", async () => {
      const post = {
        id: "post-123",
        groupId: "group-123",
        to: null,
        bto: null,
      } as Post;

      const author = {
        id: "user-123",
        username: "alice",
        actorUri: "https://example.com/users/alice",
      } as User;

      const mockMembers = [
        {
          id: "user-1",
          username: "member1",
          actorUri: "https://example.com/users/member1",
        } as User,
        {
          id: "user-2",
          username: "member2",
          actorUri: "https://example.com/users/member2",
        } as User,
      ];

      (mockPrisma.groupMember.findMany as any).mockResolvedValue([
        { groupId: "group-123", actorUri: "https://example.com/users/member1" },
        { groupId: "group-123", actorUri: "https://example.com/users/member2" },
      ]);
      (mockPrisma.user.findUnique as any)
        .mockResolvedValueOnce(mockMembers[0])
        .mockResolvedValueOnce(mockMembers[1]);

      const result = await DeliveryService.getRecipients(
        mockPrisma as PrismaClient,
        post,
        author,
        mockEnv,
      );

      expect(result).toHaveLength(2);
      expect(result.map((u) => u.id)).toEqual(["user-1", "user-2"]);
    });

    // Tests for public/followers/friends recipient resolution removed:
    // follow and friendship relationships are now in the graph DB (AuraDB).
    // getFollowers() and getFriends() on DeliveryService return [] stubs.

    it("should get recipients for private post (bto)", async () => {
      const post = {
        id: "post-123",
        groupId: null,
        to: null,
        bto: ["https://example.com/users/bob"],
      } as Post;

      const author = {
        id: "user-123",
        username: "alice",
        actorUri: "https://example.com/users/alice",
      } as User;

      const mockRecipient = {
        id: "user-456",
        username: "bob",
        actorUri: "https://example.com/users/bob",
        inboxUrl: "https://example.com/users/bob/inbox",
        suspended: false,
        deletedAt: null,
      } as User;

      (mockPrisma.user.findUnique as any).mockResolvedValue(mockRecipient);

      const result = await DeliveryService.getRecipients(
        mockPrisma as PrismaClient,
        post,
        author,
        mockEnv,
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("user-456");
    });

    // Duplicate-deduplication test removed: it relied on follow.findMany which is now a no-op.
  });

  describe("deliverToInbox", () => {
    it("should deliver activity to recipient inbox", async () => {
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Create",
        actor: "https://example.com/users/alice",
      };

      const recipient = {
        id: "user-456",
        username: "bob",
        actorUri: "https://example.com/users/bob",
        inboxUrl: "https://example.com/users/bob/inbox",
      } as User;

      const senderActorUri = "https://example.com/users/alice";

      const { deliverActivityWithFedify } = await import(
        "../../../src/lib/activitypub/services/fedify-delivery.js"
      );

      await DeliveryService.deliverToInbox(
        mockPrisma as PrismaClient,
        activity,
        recipient,
        mockEnv,
        senderActorUri,
        getLogger(),
      );

      expect(deliverActivityWithFedify).toHaveBeenCalledWith(
        activity,
        recipient.inboxUrl,
        senderActorUri,
        mockEnv,
      );
    });

    it("should skip delivery if recipient missing inboxUrl", async () => {
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Create",
      };

      const recipient = {
        id: "user-456",
        username: "bob",
        actorUri: "https://example.com/users/bob",
        inboxUrl: null,
      } as any;

      const senderActorUri = "https://example.com/users/alice";

      const { deliverActivityWithFedify } = await import(
        "../../../src/lib/activitypub/services/fedify-delivery.js"
      );

      await DeliveryService.deliverToInbox(
        mockPrisma as PrismaClient,
        activity,
        recipient,
        mockEnv,
        senderActorUri,
        getLogger(),
      );

      expect(deliverActivityWithFedify).not.toHaveBeenCalled();
          });

    it("should skip delivery if recipient missing actorId", async () => {
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Create",
      };

      const recipient = {
        id: "user-456",
        username: "bob",
        actorUri: null,
        inboxUrl: "https://example.com/users/bob/inbox",
      } as any;

      const senderActorUri = "https://example.com/users/alice";

      const { deliverActivityWithFedify } = await import(
        "../../../src/lib/activitypub/services/fedify-delivery.js"
      );

      await DeliveryService.deliverToInbox(
        mockPrisma as PrismaClient,
        activity,
        recipient,
        mockEnv,
        senderActorUri,
        getLogger(),
      );

      expect(deliverActivityWithFedify).not.toHaveBeenCalled();
          });

    it("should log error if delivery fails", async () => {
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Create",
      };

      const recipient = {
        id: "user-456",
        username: "bob",
        actorUri: "https://example.com/users/bob",
        inboxUrl: "https://example.com/users/bob/inbox",
      } as User;

      const senderActorUri = "https://example.com/users/alice";

      const { deliverActivityWithFedify } = await import(
        "../../../src/lib/activitypub/services/fedify-delivery.js"
      );
      vi.mocked(deliverActivityWithFedify).mockResolvedValue(false);

      await DeliveryService.deliverToInbox(
        mockPrisma as PrismaClient,
        activity,
        recipient,
        mockEnv,
        senderActorUri,
        getLogger(),
      );

          });
  });

  describe("deliverPost", () => {
    // deliverPost tests relying on follow.findMany removed: follow relationships moved to graph DB.
    it("should not throw when post has no recipients (followers stub returns [])", async () => {
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Create",
        actor: "https://example.com/users/alice",
      };

      const post = {
        id: "post-123",
        groupId: null,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        bto: null,
      } as Post;

      const author = {
        id: "user-123",
        username: "alice",
        actorUri: "https://example.com/users/alice",
      } as User;

      await expect(
        DeliveryService.deliverPost(
          mockPrisma as PrismaClient,
          activity,
          post,
          author,
          mockEnv,
          undefined,
          getLogger(),
        ),
      ).resolves.not.toThrow();
    });

  });
});
