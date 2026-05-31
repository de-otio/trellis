/**
 * Unit Tests: DM Service
 *
 * Tests for direct message database operations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DmService } from "../../../src/lib/activitypub/dm-service.js";
import type { PrismaClient, DirectMessage } from "@prisma/client";

describe("DmService", () => {
  let mockPrisma: Partial<PrismaClient>;

  beforeEach(() => {
    mockPrisma = {
      directMessage: {
        findMany: vi.fn(),
        updateMany: vi.fn(),
      },
    } as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("getDms", () => {
    it("should get all DMs for a user", async () => {
      const userId = "user-123";
      const mockMessages: DirectMessage[] = [
        {
          id: "dm-1",
          senderId: "user-123",
          recipientId: "user-456",
          text: "Hello",
          objectId: null,
          activityId: null,
          read: false,
          readAt: null,
          createdAt: new Date("2024-01-01T00:00:00Z"),
        } as DirectMessage,
        {
          id: "dm-2",
          senderId: "user-456",
          recipientId: "user-123",
          text: "Hi there",
          objectId: null,
          activityId: null,
          read: true,
          readAt: new Date("2024-01-01T01:00:00Z"),
          createdAt: new Date("2024-01-01T00:30:00Z"),
        } as DirectMessage,
      ];

      (mockPrisma.directMessage.findMany as any).mockResolvedValue(
        mockMessages,
      );

      const result = await DmService.getDms(
        mockPrisma as PrismaClient,
        userId,
        "all",
      );

      expect(result.messages).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      expect(mockPrisma.directMessage.findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ senderId: userId }, { recipientId: userId }],
        },
        orderBy: { createdAt: "desc" },
        take: 51, // limit + 1
        select: {
          id: true,
          senderId: true,
          recipientId: true,
          text: true,
          objectId: true,
          activityId: true,
          read: true,
          readAt: true,
          createdAt: true,
        },
      });
    });

    it("should get sent DMs only", async () => {
      const userId = "user-123";
      const mockMessages: DirectMessage[] = [
        {
          id: "dm-1",
          senderId: "user-123",
          recipientId: "user-456",
          text: "Hello",
          objectId: null,
          activityId: null,
          read: false,
          readAt: null,
          createdAt: new Date("2024-01-01T00:00:00Z"),
        } as DirectMessage,
      ];

      (mockPrisma.directMessage.findMany as any).mockResolvedValue(
        mockMessages,
      );

      const result = await DmService.getDms(
        mockPrisma as PrismaClient,
        userId,
        "sent",
      );

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].senderId).toBe(userId);
      expect(mockPrisma.directMessage.findMany).toHaveBeenCalledWith({
        where: {
          senderId: userId,
        },
        orderBy: { createdAt: "desc" },
        take: 51,
        select: expect.any(Object),
      });
    });

    it("should get received DMs only", async () => {
      const userId = "user-123";
      const mockMessages: DirectMessage[] = [
        {
          id: "dm-1",
          senderId: "user-456",
          recipientId: "user-123",
          text: "Hello",
          objectId: null,
          activityId: null,
          read: false,
          readAt: null,
          createdAt: new Date("2024-01-01T00:00:00Z"),
        } as DirectMessage,
      ];

      (mockPrisma.directMessage.findMany as any).mockResolvedValue(
        mockMessages,
      );

      const result = await DmService.getDms(
        mockPrisma as PrismaClient,
        userId,
        "received",
      );

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].recipientId).toBe(userId);
      expect(mockPrisma.directMessage.findMany).toHaveBeenCalledWith({
        where: {
          recipientId: userId,
        },
        orderBy: { createdAt: "desc" },
        take: 51,
        select: expect.any(Object),
      });
    });

    it("should handle pagination with cursor", async () => {
      const userId = "user-123";
      const cursor = "dm-2";
      const mockMessages: DirectMessage[] = [
        {
          id: "dm-3",
          senderId: "user-123",
          recipientId: "user-456",
          text: "Message 3",
          objectId: null,
          activityId: null,
          read: false,
          readAt: null,
          createdAt: new Date("2024-01-01T02:00:00Z"),
        } as DirectMessage,
      ];

      (mockPrisma.directMessage.findMany as any).mockResolvedValue(
        mockMessages,
      );

      const result = await DmService.getDms(
        mockPrisma as PrismaClient,
        userId,
        "all",
        50,
        cursor,
      );

      expect(mockPrisma.directMessage.findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ senderId: userId }, { recipientId: userId }],
          id: { lt: cursor },
        },
        orderBy: { createdAt: "desc" },
        take: 51,
        select: expect.any(Object),
      });
    });

    it("should indicate hasMore when more messages exist", async () => {
      const userId = "user-123";
      const mockMessages: DirectMessage[] = Array.from(
        { length: 51 },
        (_, i) => ({
          id: `dm-${i}`,
          senderId: "user-123",
          recipientId: "user-456",
          text: `Message ${i}`,
          objectId: null,
          activityId: null,
          read: false,
          readAt: null,
          createdAt: new Date(
            `2024-01-01T${String(i).padStart(2, "0")}:00:00Z`,
          ),
        }),
      ) as DirectMessage[];

      (mockPrisma.directMessage.findMany as any).mockResolvedValue(
        mockMessages,
      );

      const result = await DmService.getDms(
        mockPrisma as PrismaClient,
        userId,
        "all",
        50,
      );

      expect(result.hasMore).toBe(true);
      expect(result.messages).toHaveLength(50);
      expect(result.nextCursor).toBe(mockMessages[49].id);
    });

    it("should use custom limit", async () => {
      const userId = "user-123";
      const limit = 20;
      const mockMessages: DirectMessage[] = [];

      (mockPrisma.directMessage.findMany as any).mockResolvedValue(
        mockMessages,
      );

      await DmService.getDms(mockPrisma as PrismaClient, userId, "all", limit);

      expect(mockPrisma.directMessage.findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ senderId: userId }, { recipientId: userId }],
        },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        select: expect.any(Object),
      });
    });

    it("should return empty array when no messages", async () => {
      const userId = "user-123";
      (mockPrisma.directMessage.findMany as any).mockResolvedValue([]);

      const result = await DmService.getDms(
        mockPrisma as PrismaClient,
        userId,
        "all",
      );

      expect(result.messages).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });

    it("should return all selected fields", async () => {
      const userId = "user-123";
      const mockMessage: DirectMessage = {
        id: "dm-1",
        senderId: "user-123",
        recipientId: "user-456",
        text: "Hello",
        objectId: "https://example.com/object/123",
        activityId: "https://example.com/activity/123",
        read: true,
        readAt: new Date("2024-01-01T01:00:00Z"),
        createdAt: new Date("2024-01-01T00:00:00Z"),
      } as DirectMessage;

      (mockPrisma.directMessage.findMany as any).mockResolvedValue([
        mockMessage,
      ]);

      const result = await DmService.getDms(
        mockPrisma as PrismaClient,
        userId,
        "all",
      );

      expect(result.messages[0]).toEqual({
        id: mockMessage.id,
        senderId: mockMessage.senderId,
        recipientId: mockMessage.recipientId,
        text: mockMessage.text,
        objectId: mockMessage.objectId,
        activityId: mockMessage.activityId,
        read: mockMessage.read,
        readAt: mockMessage.readAt,
        createdAt: mockMessage.createdAt,
      });
    });
  });

  describe("markAsRead", () => {
    it("should mark DM as read", async () => {
      const dmId = "dm-123";
      const userId = "user-456";

      (mockPrisma.directMessage.updateMany as any).mockResolvedValue({
        count: 1,
      });

      await DmService.markAsRead(mockPrisma as PrismaClient, dmId, userId);

      expect(mockPrisma.directMessage.updateMany).toHaveBeenCalledWith({
        where: {
          id: dmId,
          recipientId: userId,
        },
        data: {
          read: true,
          readAt: expect.any(Date),
        },
      });
    });

    it("should only update if user is recipient", async () => {
      const dmId = "dm-123";
      const userId = "user-456";

      (mockPrisma.directMessage.updateMany as any).mockResolvedValue({
        count: 0,
      });

      await DmService.markAsRead(mockPrisma as PrismaClient, dmId, userId);

      expect(mockPrisma.directMessage.updateMany).toHaveBeenCalledWith({
        where: {
          id: dmId,
          recipientId: userId, // Only recipient can mark as read
        },
        data: {
          read: true,
          readAt: expect.any(Date),
        },
      });
    });

    it("should set readAt timestamp", async () => {
      const dmId = "dm-123";
      const userId = "user-456";
      const beforeTime = new Date();

      (mockPrisma.directMessage.updateMany as any).mockResolvedValue({
        count: 1,
      });

      await DmService.markAsRead(mockPrisma as PrismaClient, dmId, userId);

      const afterTime = new Date();
      const callArgs = (mockPrisma.directMessage.updateMany as any).mock
        .calls[0][0];
      const readAt = callArgs.data.readAt;

      expect(readAt).toBeInstanceOf(Date);
      expect(readAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(readAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });

    it("should handle case where DM does not exist", async () => {
      const dmId = "dm-nonexistent";
      const userId = "user-456";

      (mockPrisma.directMessage.updateMany as any).mockResolvedValue({
        count: 0,
      });

      await expect(
        DmService.markAsRead(mockPrisma as PrismaClient, dmId, userId),
      ).resolves.not.toThrow();

      expect(mockPrisma.directMessage.updateMany).toHaveBeenCalled();
    });

    it("should handle case where user is not recipient", async () => {
      const dmId = "dm-123";
      const userId = "user-789"; // Not the recipient

      (mockPrisma.directMessage.updateMany as any).mockResolvedValue({
        count: 0,
      });

      await expect(
        DmService.markAsRead(mockPrisma as PrismaClient, dmId, userId),
      ).resolves.not.toThrow();

      expect(mockPrisma.directMessage.updateMany).toHaveBeenCalledWith({
        where: {
          id: dmId,
          recipientId: userId,
        },
        data: {
          read: true,
          readAt: expect.any(Date),
        },
      });
    });
  });
});
