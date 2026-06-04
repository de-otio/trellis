/**
 * Unit Tests: Activity Service
 *
 * Tests for ActivityPub activity storage and retrieval.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityService } from "../../../src/lib/activitypub/activity-service.js";
import type { PrismaClient, Activity } from "@prisma/client";

describe("ActivityService", () => {
  let mockPrisma: Partial<PrismaClient>;

  beforeEach(() => {
    mockPrisma = {
      activity: {
        create: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
      },
    } as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("storeInboxActivity", () => {
    it("should store activity in inbox with all fields", async () => {
      const mockActivity: Activity = {
        id: "activity-1",
        actorUri: "https://example.com/users/alice",
        type: "Create",
        objectId: "https://example.com/posts/123",
        targetId: null,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: null,
        bto: null,
        bcc: null,
        published: new Date("2024-01-01T00:00:00Z"),
        receivedAt: new Date("2024-01-01T00:00:01Z"),
        inboxActorUri: "https://example.com/users/bob",
        outboxActorUri: null,
      };

      (mockPrisma.activity.create as any).mockResolvedValue(mockActivity);

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/posts/123",
          type: "Note",
        },
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: "2024-01-01T00:00:00Z",
      };

      const result = await ActivityService.storeInboxActivity(
        mockPrisma as PrismaClient,
        "https://example.com/users/bob",
        activity,
      );

      expect(mockPrisma.activity.create).toHaveBeenCalledWith({
        data: {
          actorUri: "https://example.com/users/alice",
          type: "Create",
          objectId: "https://example.com/posts/123",
          targetId: undefined,
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: undefined,
          bto: undefined,
          bcc: undefined,
          published: expect.any(Date),
          inboxActorUri: "https://example.com/users/bob",
          receivedAt: expect.any(Date),
        },
      });

      expect(result).toEqual(mockActivity);
    });

    it("should handle activity with string actor and object", async () => {
      const mockActivity: Activity = {
        id: "activity-2",
        actorUri: "https://example.com/users/alice",
        type: "Follow",
        objectId: "https://example.com/users/bob",
        targetId: null,
        to: null,
        cc: null,
        bto: null,
        bcc: null,
        published: new Date(),
        receivedAt: new Date(),
        inboxActorUri: "https://example.com/users/bob",
        outboxActorUri: null,
      };

      (mockPrisma.activity.create as any).mockResolvedValue(mockActivity);

      const activity = {
        type: "Follow",
        actor: "https://example.com/users/alice",
        object: "https://example.com/users/bob",
      };

      await ActivityService.storeInboxActivity(
        mockPrisma as PrismaClient,
        "https://example.com/users/bob",
        activity,
      );

      expect(mockPrisma.activity.create).toHaveBeenCalledWith({
        data: {
          actorUri: "https://example.com/users/alice",
          type: "Follow",
          objectId: "https://example.com/users/bob",
          targetId: undefined,
          to: undefined,
          cc: undefined,
          bto: undefined,
          bcc: undefined,
          published: expect.any(Date),
          inboxActorUri: "https://example.com/users/bob",
          receivedAt: expect.any(Date),
        },
      });
    });

    it("should handle array audience fields", async () => {
      const mockActivity: Activity = {
        id: "activity-3",
        actorUri: "https://example.com/users/alice",
        type: "Create",
        objectId: null,
        targetId: null,
        to: [
          "https://www.w3.org/ns/activitystreams#Public",
          "https://example.com/users/bob",
        ],
        cc: ["https://example.com/users/charlie"],
        bto: ["https://example.com/users/dave"],
        bcc: ["https://example.com/users/eve"],
        published: new Date(),
        receivedAt: new Date(),
        inboxActorUri: "https://example.com/users/bob",
        outboxActorUri: null,
      };

      (mockPrisma.activity.create as any).mockResolvedValue(mockActivity);

      const activity = {
        type: "Create",
        actor: "https://example.com/users/alice",
        to: [
          "https://www.w3.org/ns/activitystreams#Public",
          "https://example.com/users/bob",
        ],
        cc: ["https://example.com/users/charlie"],
        bto: ["https://example.com/users/dave"],
        bcc: ["https://example.com/users/eve"],
      };

      await ActivityService.storeInboxActivity(
        mockPrisma as PrismaClient,
        "https://example.com/users/bob",
        activity,
      );

      expect(mockPrisma.activity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          to: [
            "https://www.w3.org/ns/activitystreams#Public",
            "https://example.com/users/bob",
          ],
          cc: ["https://example.com/users/charlie"],
          bto: ["https://example.com/users/dave"],
          bcc: ["https://example.com/users/eve"],
        }),
      });
    });
  });

  describe("storeOutboxActivity", () => {
    it("should store activity in outbox", async () => {
      const mockActivity: Activity = {
        id: "activity-4",
        actorUri: "https://example.com/users/alice",
        type: "Create",
        objectId: "https://example.com/posts/123",
        targetId: null,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: null,
        bto: null,
        bcc: null,
        published: new Date("2024-01-01T00:00:00Z"),
        receivedAt: new Date(),
        inboxActorUri: null,
        outboxActorUri: "https://example.com/users/alice",
      };

      (mockPrisma.activity.create as any).mockResolvedValue(mockActivity);

      const activity = {
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/posts/123",
        },
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: "2024-01-01T00:00:00Z",
      };

      const result = await ActivityService.storeOutboxActivity(
        mockPrisma as PrismaClient,
        "https://example.com/users/alice",
        activity,
      );

      expect(mockPrisma.activity.create).toHaveBeenCalledWith({
        data: {
          actorUri: "https://example.com/users/alice",
          type: "Create",
          objectId: "https://example.com/posts/123",
          targetId: undefined,
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: undefined,
          bto: undefined,
          bcc: undefined,
          published: expect.any(Date),
          outboxActorUri: "https://example.com/users/alice",
        },
      });

      expect(result).toEqual(mockActivity);
    });
  });

  describe("getOutboxActivities", () => {
    it("should retrieve paginated outbox activities", async () => {
      const mockActivities: Activity[] = [
        {
          id: "activity-1",
          actorUri: "https://example.com/users/alice",
          type: "Create",
          objectId: "https://example.com/posts/123",
          targetId: null,
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: null,
          bto: null,
          bcc: null,
          published: new Date("2024-01-01T00:00:00Z"),
          receivedAt: new Date(),
          inboxActorUri: null,
          outboxActorUri: "https://example.com/users/alice",
        },
      ];

      (mockPrisma.activity.findMany as any).mockResolvedValue(mockActivities);

      const result = await ActivityService.getOutboxActivities(
        mockPrisma as PrismaClient,
        "https://example.com/users/alice",
        1,
        20,
      );

      expect(mockPrisma.activity.findMany).toHaveBeenCalledWith({
        where: {
          outboxActorUri: "https://example.com/users/alice",
        },
        orderBy: {
          published: "desc",
        },
        skip: 0,
        take: 20,
      });

      expect(result).toEqual(mockActivities);
    });

    it("should handle pagination correctly", async () => {
      (mockPrisma.activity.findMany as any).mockResolvedValue([]);

      await ActivityService.getOutboxActivities(
        mockPrisma as PrismaClient,
        "https://example.com/users/alice",
        2,
        10,
      );

      expect(mockPrisma.activity.findMany).toHaveBeenCalledWith({
        where: {
          outboxActorUri: "https://example.com/users/alice",
        },
        orderBy: {
          published: "desc",
        },
        skip: 10,
        take: 10,
      });
    });
  });

  describe("getOutboxCount", () => {
    it("should return total outbox count", async () => {
      (mockPrisma.activity.count as any).mockResolvedValue(42);

      const result = await ActivityService.getOutboxCount(
        mockPrisma as PrismaClient,
        "https://example.com/users/alice",
      );

      expect(mockPrisma.activity.count).toHaveBeenCalledWith({
        where: {
          outboxActorUri: "https://example.com/users/alice",
        },
      });

      expect(result).toBe(42);
    });
  });

  describe("getInboxActivities", () => {
    it("should retrieve paginated inbox activities", async () => {
      const mockActivities: Activity[] = [
        {
          id: "activity-1",
          actorUri: "https://example.com/users/bob",
          type: "Create",
          objectId: "https://example.com/posts/456",
          targetId: null,
          to: null,
          cc: null,
          bto: null,
          bcc: null,
          published: new Date("2024-01-01T00:00:00Z"),
          receivedAt: new Date("2024-01-01T00:00:01Z"),
          inboxActorUri: "https://example.com/users/alice",
          outboxActorUri: null,
        },
      ];

      (mockPrisma.activity.findMany as any).mockResolvedValue(mockActivities);

      const result = await ActivityService.getInboxActivities(
        mockPrisma as PrismaClient,
        "https://example.com/users/alice",
        1,
        20,
      );

      expect(mockPrisma.activity.findMany).toHaveBeenCalledWith({
        where: {
          inboxActorUri: "https://example.com/users/alice",
        },
        orderBy: {
          receivedAt: "desc",
        },
        skip: 0,
        take: 20,
      });

      expect(result).toEqual(mockActivities);
    });
  });

  describe("getInboxCount", () => {
    it("should return total inbox count", async () => {
      (mockPrisma.activity.count as any).mockResolvedValue(15);

      const result = await ActivityService.getInboxCount(
        mockPrisma as PrismaClient,
        "https://example.com/users/alice",
      );

      expect(mockPrisma.activity.count).toHaveBeenCalledWith({
        where: {
          inboxActorUri: "https://example.com/users/alice",
        },
      });

      expect(result).toBe(15);
    });
  });
});
