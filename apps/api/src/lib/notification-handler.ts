/**
 * Notification Handler
 *
 * Manages notification creation, retrieval, and read status.
 * Respects user preferences and quiet hours.
 * SAFETY_ALERT and PARENTAL_LINK notifications always bypass preferences and quiet hours.
 * Part of Stream C: Notifications.
 */

import type { Env } from "../env.js";
import type { Session } from "./session-cookie.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { NotificationType } from "@prisma/client";
import { createPrisma } from "../db.js";
import { getLogger, Logger } from "./logger.js";

export interface NotificationListResponse {
  notifications: Array<{
    id: string;
    type: NotificationType;
    title: string;
    body: string;
    data: any;
    read: boolean;
    createdAt: string;
  }>;
  cursor?: string;
  hasMore: boolean;
}

/** Notification types that always bypass preferences and quiet hours */
const ALWAYS_DELIVER_TYPES: NotificationType[] = [
  "SAFETY_ALERT",
  "PARENTAL_LINK",
];

export class NotificationHandler {
  /**
   * Create a notification for a user.
   * Checks preferences (unless SAFETY_ALERT or PARENTAL_LINK) and quiet hours.
   */
  async createNotification(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data: any,
    env: Env,
    tenantId: string,
  ): Promise<{ id: string }> {
    const logger = getLogger();
    const db = createPrisma(env);

    try {
      const bypassPreferences = ALWAYS_DELIVER_TYPES.includes(type);

      // 1. Check user's NotificationPreference (skip for SAFETY_ALERT and PARENTAL_LINK)
      if (!bypassPreferences) {
        const prefs = await db.notificationPreference.findUnique({
          where: { userId },
        });

        if (prefs) {
          // 2. Check type-specific preference
          const enabled = this.isTypeEnabled(type, prefs);
          if (!enabled) {
            logger.info("Notification skipped due to preferences", {
              userId,
              type,
            });
            return { id: "" };
          }
        }
      }

      // 3. Check quiet hours (skip for SAFETY_ALERT and PARENTAL_LINK)
      let deliveredAt: Date | null = new Date();

      if (!bypassPreferences) {
        const user = await db.user.findUnique({
          where: { id: userId },
          select: {
            quietHoursEnabled: true,
            quietHoursStart: true,
            quietHoursEnd: true,
          },
        });

        if (user?.quietHoursEnabled && this.isInQuietHours(user)) {
          // 4. In quiet hours: create with deliveredAt=null
          deliveredAt = null;
        }
      }

      // 5. Create notification
      const notification = await db.notification.create({
        data: {
          userId,
          type,
          title,
          body,
          data: data ?? undefined,
          deliveredAt,
          tenantId,
        },
      });

      return { id: notification.id };
    } catch (error) {
      logger.error("Error creating notification:", error);
      throw error;
    } finally {
      await db.release();
    }
  }

  /**
   * Get paginated notifications for a user.
   */
  async getNotifications(
    userId: string,
    cursor: string | null,
    limit: number,
    env: Env,
    tenantId: string,
  ): Promise<NotificationListResponse> {
    const db = createPrisma(env);

    try {
      const safeLimit = Math.min(Math.max(limit, 1), 50);

      const notifications = await db.notification.findMany({
        where: {
          userId,
          tenantId,
          ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: safeLimit + 1,
      });

      const hasMore = notifications.length > safeLimit;
      const items = notifications.slice(0, safeLimit);

      return {
        notifications: items.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          data: n.data,
          read: n.read,
          createdAt: n.createdAt.toISOString(),
        })),
        cursor: hasMore
          ? items[items.length - 1].createdAt.toISOString()
          : undefined,
        hasMore,
      };
    } finally {
      await db.release();
    }
  }

  /**
   * Mark a single notification as read. Verifies it belongs to the user.
   */
  async markRead(
    userId: string,
    notificationId: string,
    env: Env,
    tenantId: string,
  ): Promise<void> {
    const db = createPrisma(env);

    try {
      const notification = await db.notification.findFirst({
        where: { id: notificationId, userId, tenantId },
      });

      if (!notification) {
        throw new NotificationNotFoundError(notificationId);
      }

      await db.notification.update({
        where: { id: notificationId },
        data: { read: true },
      });
    } finally {
      await db.release();
    }
  }

  /**
   * Mark all unread notifications as read for a user.
   */
  async markAllRead(userId: string, env: Env, tenantId: string): Promise<void> {
    const db = createPrisma(env);

    try {
      await db.notification.updateMany({
        where: { userId, tenantId, read: false },
        data: { read: true },
      });
    } finally {
      await db.release();
    }
  }

  /**
   * Get unread notification count.
   * CHILD/TEEN: return { hasUnread: boolean } only (no exact count).
   * ADULT: return { hasUnread: boolean, count: number }.
   */
  async getUnreadCount(
    userId: string,
    ageTier: string,
    env: Env,
    tenantId: string,
  ): Promise<{ hasUnread: boolean; count?: number }> {
    const db = createPrisma(env);

    try {
      if (ageTier === "CHILD" || ageTier === "TEEN") {
        // For minors, only check existence (no exact count)
        const first = await db.notification.findFirst({
          where: { userId, tenantId, read: false },
          select: { id: true },
        });
        return { hasUnread: !!first };
      }

      // ADULT: return exact count
      const count = await db.notification.count({
        where: { userId, tenantId, read: false },
      });

      return { hasUnread: count > 0, count };
    } finally {
      await db.release();
    }
  }

  /**
   * Check whether a notification type is enabled in preferences.
   */
  private isTypeEnabled(
    type: NotificationType,
    prefs: {
      dmEnabled: boolean;
      followEnabled: boolean;
      digestEnabled: boolean;
      systemEnabled: boolean;
      relationshipEnabled: boolean;
    },
  ): boolean {
    switch (type) {
      case "DIRECT_MESSAGE":
        return prefs.dmEnabled;
      case "FOLLOW":
        return prefs.followEnabled;
      case "SENTIMENT_DIGEST":
        return prefs.digestEnabled;
      case "SYSTEM":
        return prefs.systemEnabled;
      case "RELATIONSHIP_CREATED":
      case "RELATIONSHIP_RECIPROCATED":
      case "TIER_CHANGED":
      case "ENTITY_RELATIONSHIP_PROPOSED":
      case "ENTITY_RELATIONSHIP_CONFIRMED":
      case "CONNECTION_CODE_REDEEMED":
        return prefs.relationshipEnabled;
      // SAFETY_ALERT and PARENTAL_LINK are handled before this check
      default:
        return true;
    }
  }

  /**
   * Check if current time falls within user's quiet hours.
   */
  private isInQuietHours(user: {
    quietHoursStart: number | null;
    quietHoursEnd: number | null;
    quietHoursEnabled: boolean;
  }): boolean {
    if (
      !user.quietHoursEnabled ||
      user.quietHoursStart == null ||
      user.quietHoursEnd == null
    ) {
      return false;
    }

    const now = new Date();
    const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();
    const start = user.quietHoursStart;
    const end = user.quietHoursEnd;

    // Handle overnight quiet hours (e.g., 22:00 to 07:00)
    if (start > end) {
      return minutesSinceMidnight >= start || minutesSinceMidnight < end;
    }

    // Same-day quiet hours (e.g., 13:00 to 15:00)
    return minutesSinceMidnight >= start && minutesSinceMidnight < end;
  }
}

export class NotificationNotFoundError extends Error {
  constructor(notificationId: string) {
    super(`Notification ${notificationId} not found`);
    this.name = "NotificationNotFoundError";
  }
}
