/**
 * Direct Message Database Utilities
 *
 * Database utility methods for direct messages.
 * ActivityPub serialization is handled by DmServiceFedify.
 */

import type { PrismaClient } from "@prisma/client";

/**
 * Service for database operations on direct messages
 */
export class DmService {
  /**
   * Get DMs for a user (sent or received)
   */
  static async getDms(
    prisma: PrismaClient,
    userId: string,
    type: "sent" | "received" | "all" = "all",
    limit: number = 50,
    cursor?: string,
  ): Promise<{
    messages: Array<{
      id: string;
      senderId: string;
      recipientId: string;
      text: string;
      objectId: string | null;
      activityId: string | null;
      read: boolean;
      readAt: Date | null;
      createdAt: Date;
    }>;
    hasMore: boolean;
    nextCursor?: string;
  }> {
    const where: any = {};

    if (type === "sent") {
      where.senderId = userId;
    } else if (type === "received") {
      where.recipientId = userId;
    } else {
      where.OR = [{ senderId: userId }, { recipientId: userId }];
    }

    if (cursor) {
      where.id = { lt: cursor };
    }

    const messages = await prisma.directMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
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

    const hasMore = messages.length > limit;
    const result = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore ? result[result.length - 1].id : undefined;

    return {
      messages: result,
      hasMore,
      nextCursor,
    };
  }

  /**
   * Mark DM as read
   */
  static async markAsRead(
    prisma: PrismaClient,
    dmId: string,
    userId: string,
  ): Promise<void> {
    await prisma.directMessage.updateMany({
      where: {
        id: dmId,
        recipientId: userId, // Only recipient can mark as read
      },
      data: {
        read: true,
        readAt: new Date(),
      },
    });
  }
}
