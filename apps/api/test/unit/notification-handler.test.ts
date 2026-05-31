/**
 * Unit Tests: Notification Handler
 *
 * Tests notification creation, preferences, quiet hours, pagination, and read status.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

// Hoist mocks
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    notification: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    notificationPreference: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    release: vi.fn(),
  },
}));

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

import {
  NotificationHandler,
  NotificationNotFoundError,
} from "../../src/lib/notification-handler.js";

const TEST_TENANT_ID = "tenant-test-123";

describe("NotificationHandler", () => {
  let handler: NotificationHandler;
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new NotificationHandler();
    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
    } as unknown as Env;
    mockPrisma.release.mockResolvedValue(undefined);
  });

  describe("createNotification", () => {
    it("should skip notification when followEnabled is false", async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        userId: "user-1",
        dmEnabled: true,
        followEnabled: false,
        digestEnabled: true,
        systemEnabled: true,
      });

      const result = await handler.createNotification(
        "user-1",
        "FOLLOW",
        "New follower",
        "Someone followed you",
        {},
        mockEnv,
        TEST_TENANT_ID,
      );

      expect(result.id).toBe("");
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it("should bypass preferences for SAFETY_ALERT", async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        userId: "user-1",
        dmEnabled: false,
        followEnabled: false,
        digestEnabled: false,
        systemEnabled: false,
      });

      mockPrisma.notification.create.mockResolvedValue({
        id: "notif-1",
        type: "SAFETY_ALERT",
      });

      const result = await handler.createNotification(
        "user-1",
        "SAFETY_ALERT",
        "Safety alert",
        "Important safety notification",
        { severity: "high" },
        mockEnv,
        TEST_TENANT_ID,
      );

      expect(result.id).toBe("notif-1");
      expect(mockPrisma.notification.create).toHaveBeenCalled();
      // Should NOT have checked preferences
      expect(
        mockPrisma.notificationPreference.findUnique,
      ).not.toHaveBeenCalled();
    });

    it("should set deliveredAt to null during quiet hours", async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

      // Set quiet hours from 22:00 (1320 min) to 07:00 (420 min)
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();

      // Make quiet hours cover current time
      const start = (currentMinutes - 60 + 1440) % 1440;
      const end = (currentMinutes + 60) % 1440;

      mockPrisma.user.findUnique.mockResolvedValue({
        quietHoursEnabled: true,
        quietHoursStart: start,
        quietHoursEnd: end,
      });

      mockPrisma.notification.create.mockResolvedValue({
        id: "notif-quiet",
      });

      await handler.createNotification(
        "user-1",
        "FOLLOW",
        "New follower",
        "Someone followed you",
        {},
        mockEnv,
        TEST_TENANT_ID,
      );

      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deliveredAt: null,
          }),
        }),
      );
    });

    it("should bypass quiet hours for SAFETY_ALERT", async () => {
      mockPrisma.notification.create.mockResolvedValue({
        id: "notif-urgent",
      });

      const result = await handler.createNotification(
        "user-1",
        "SAFETY_ALERT",
        "Urgent safety alert",
        "This is urgent",
        {},
        mockEnv,
        TEST_TENANT_ID,
      );

      expect(result.id).toBe("notif-urgent");
      // Should NOT have checked user quiet hours
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      // deliveredAt should be set (not null)
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deliveredAt: expect.any(Date),
          }),
        }),
      );
    });

    it("should bypass quiet hours for PARENTAL_LINK", async () => {
      mockPrisma.notification.create.mockResolvedValue({
        id: "notif-parental",
      });

      const result = await handler.createNotification(
        "user-1",
        "PARENTAL_LINK",
        "Parental link request",
        "A guardian wants to link",
        {},
        mockEnv,
        TEST_TENANT_ID,
      );

      expect(result.id).toBe("notif-parental");
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("getNotifications", () => {
    it("should return cursor-paginated notifications", async () => {
      const mockNotifications = [
        {
          id: "n1",
          type: "FOLLOW",
          title: "New follower",
          body: "User followed you",
          data: null,
          read: false,
          createdAt: new Date("2025-03-01"),
        },
        {
          id: "n2",
          type: "SYSTEM",
          title: "Update",
          body: "System update",
          data: null,
          read: true,
          createdAt: new Date("2025-02-28"),
        },
      ];

      mockPrisma.notification.findMany.mockResolvedValue(mockNotifications);

      const result = await handler.getNotifications(
        "user-1",
        null,
        20,
        mockEnv,
        TEST_TENANT_ID,
      );

      expect(result.notifications).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeUndefined();
      expect(result.notifications[0].id).toBe("n1");
    });

    it("should return empty list when no notifications exist", async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);

      const result = await handler.getNotifications(
        "user-1",
        null,
        20,
        mockEnv,
        TEST_TENANT_ID,
      );

      expect(result.notifications).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });

    it("should indicate hasMore when more results exist", async () => {
      // Return limit+1 items to indicate hasMore
      const notifications = Array.from({ length: 3 }, (_, i) => ({
        id: `n${i}`,
        type: "FOLLOW" as const,
        title: "Follower",
        body: "Body",
        data: null,
        read: false,
        createdAt: new Date(2025, 2, 1 - i),
      }));

      mockPrisma.notification.findMany.mockResolvedValue(notifications);

      const result = await handler.getNotifications(
        "user-1",
        null,
        2,
        mockEnv,
        TEST_TENANT_ID,
      );

      expect(result.notifications).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBeDefined();
    });
  });

  describe("markRead", () => {
    it("should mark a notification as read", async () => {
      mockPrisma.notification.findFirst.mockResolvedValue({
        id: "n1",
        userId: "user-1",
      });
      mockPrisma.notification.update.mockResolvedValue({
        id: "n1",
        read: true,
      });

      await handler.markRead("user-1", "n1", mockEnv, TEST_TENANT_ID);

      expect(mockPrisma.notification.update).toHaveBeenCalledWith({
        where: { id: "n1" },
        data: { read: true },
      });
    });

    it("should throw NotificationNotFoundError for wrong user's notification", async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null);

      await expect(
        handler.markRead("user-1", "n-other", mockEnv, TEST_TENANT_ID),
      ).rejects.toThrow(NotificationNotFoundError);
    });
  });

  describe("markAllRead", () => {
    it("should mark all unread notifications as read", async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 5 });

      await handler.markAllRead("user-1", mockEnv, TEST_TENANT_ID);

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", tenantId: TEST_TENANT_ID, read: false },
        data: { read: true },
      });
    });
  });

  describe("getUnreadCount", () => {
    it("should return hasUnread only for CHILD", async () => {
      mockPrisma.notification.findFirst.mockResolvedValue({ id: "n1" });

      const result = await handler.getUnreadCount("user-1", "CHILD", mockEnv, TEST_TENANT_ID);

      expect(result).toEqual({ hasUnread: true });
      expect(result.count).toBeUndefined();
      expect(mockPrisma.notification.count).not.toHaveBeenCalled();
    });

    it("should return hasUnread only for TEEN", async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null);

      const result = await handler.getUnreadCount("user-1", "TEEN", mockEnv, TEST_TENANT_ID);

      expect(result).toEqual({ hasUnread: false });
      expect(result.count).toBeUndefined();
    });

    it("should return hasUnread and count for ADULT", async () => {
      mockPrisma.notification.count.mockResolvedValue(7);

      const result = await handler.getUnreadCount("user-1", "ADULT", mockEnv, TEST_TENANT_ID);

      expect(result).toEqual({ hasUnread: true, count: 7 });
    });

    it("should return count 0 for ADULT with no unread", async () => {
      mockPrisma.notification.count.mockResolvedValue(0);

      const result = await handler.getUnreadCount("user-1", "ADULT", mockEnv, TEST_TENANT_ID);

      expect(result).toEqual({ hasUnread: false, count: 0 });
    });
  });
});
