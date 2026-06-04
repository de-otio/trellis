/**
 * Unit Tests: Parental Control Handler
 *
 * Tests for guardian management of linked child accounts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { ParentalControlHandler } from "../../src/lib/parental-control-handler.js";

// Mock Prisma client
const mockPrisma = {
  parentalLink: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

describe("ParentalControlHandler", () => {
  let handler: ParentalControlHandler;
  let mockEnv: Env;

  const childUser = {
    id: "child1",
    email: "child@example.com",
    ageTier: "CHILD",
    stealthMode: true,
    showOnlineStatus: false,
    showTypingIndicator: false,
    showLastSeen: false,
    locationTrackingEnabled: false,
    locationAnonymizationLevel: 3,
    analyticsOptOut: true,
    profileVisibility: "PRIVATE",
    dmAccess: "NOBODY",
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
  };

  const teenUser = {
    ...childUser,
    id: "teen1",
    ageTier: "TEEN",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ParentalControlHandler();
    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
    } as Env;
  });

  describe("getChildren", () => {
    it("should return linked children", async () => {
      mockPrisma.parentalLink.findMany.mockResolvedValue([
        {
          child: {
            id: "child1",
            email: "child@example.com",
            ageTier: "CHILD",
            profileVisibility: "PRIVATE",
          },
        },
      ]);

      const response = await handler.getChildren("guardian1", mockEnv);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.children).toHaveLength(1);
      expect(body.children[0].id).toBe("child1");
      expect(body.children[0].ageTier).toBe("CHILD");
    });

    it("should return empty array when no children", async () => {
      mockPrisma.parentalLink.findMany.mockResolvedValue([]);

      const response = await handler.getChildren("guardian1", mockEnv);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.children).toHaveLength(0);
    });
  });

  describe("getChildSettings", () => {
    it("should return settings for valid link", async () => {
      mockPrisma.parentalLink.findFirst.mockResolvedValue({ id: "link1" });
      mockPrisma.user.findUnique.mockResolvedValue(childUser);

      const response = await handler.getChildSettings("guardian1", "child1", mockEnv);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.settings.stealthMode).toBe(true);
      expect(body.settings.dmAccess).toBe("NOBODY");
      expect(body.quietHours.enabled).toBe(false);
    });

    it("should return 403 when no active link", async () => {
      mockPrisma.parentalLink.findFirst.mockResolvedValue(null);

      const response = await handler.getChildSettings("guardian1", "child1", mockEnv);
      expect(response.status).toBe(403);
    });

    it("should return 403 when child is TEEN", async () => {
      mockPrisma.parentalLink.findFirst.mockResolvedValue({ id: "link1" });
      mockPrisma.user.findUnique.mockResolvedValue(teenUser);

      const response = await handler.getChildSettings("guardian1", "teen1", mockEnv);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.message).toContain("not a child");
    });
  });

  describe("updateChildSettings", () => {
    it("should update settings successfully", async () => {
      mockPrisma.parentalLink.findFirst.mockResolvedValue({ id: "link1" });
      mockPrisma.user.findUnique.mockResolvedValue(childUser);
      mockPrisma.user.update.mockResolvedValue({});

      const response = await handler.updateChildSettings(
        "guardian1",
        "child1",
        { showOnlineStatus: true },
        mockEnv,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      // showOnlineStatus is not locked for CHILD, so it passes through
      expect(body.settings.showOnlineStatus).toBe(true);
    });

    it("should not loosen locked fields", async () => {
      mockPrisma.parentalLink.findFirst.mockResolvedValue({ id: "link1" });
      mockPrisma.user.findUnique.mockResolvedValue(childUser);
      mockPrisma.user.update.mockResolvedValue({});

      const response = await handler.updateChildSettings(
        "guardian1",
        "child1",
        { locationTrackingEnabled: true, dmAccess: "ANYONE" },
        mockEnv,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      // Locked fields snap back to defaults
      expect(body.settings.locationTrackingEnabled).toBe(false);
      expect(body.settings.dmAccess).toBe("NOBODY");
    });
  });

  describe("setDmAccess", () => {
    it("should allow NOBODY for CHILD", async () => {
      mockPrisma.parentalLink.findFirst.mockResolvedValue({ id: "link1" });
      mockPrisma.user.findUnique.mockResolvedValue(childUser);
      mockPrisma.user.update.mockResolvedValue({});

      const response = await handler.setDmAccess("guardian1", "child1", "NOBODY", mockEnv);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.dmAccess).toBe("NOBODY");
    });

    it("should reject ANYONE for CHILD", async () => {
      const response = await handler.setDmAccess("guardian1", "child1", "ANYONE", mockEnv);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.message).toContain("NOBODY or CONNECTIONS");
    });
  });

  describe("setQuietHours", () => {
    it("should set valid quiet hours", async () => {
      mockPrisma.parentalLink.findFirst.mockResolvedValue({ id: "link1" });
      mockPrisma.user.findUnique.mockResolvedValue(childUser);
      mockPrisma.user.update.mockResolvedValue({});

      const response = await handler.setQuietHours("guardian1", "child1", 1320, 420, mockEnv);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.quietHours.start).toBe(1320);
      expect(body.quietHours.end).toBe(420);
      expect(body.quietHours.enabled).toBe(true);
    });

    it("should reject invalid range (>1439)", async () => {
      const response = await handler.setQuietHours("guardian1", "child1", 1440, 420, mockEnv);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.message).toContain("0 and 1439");
    });
  });

  describe("removeLink", () => {
    it("should set status to REVOKED", async () => {
      mockPrisma.parentalLink.findFirst.mockResolvedValue({ id: "link1" });
      mockPrisma.parentalLink.update.mockResolvedValue({});

      const response = await handler.removeLink("guardian1", "child1", mockEnv);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("REVOKED");

      expect(mockPrisma.parentalLink.update).toHaveBeenCalledWith({
        where: { id: "link1" },
        data: { status: "REVOKED" },
      });
    });

    it("should return 404 when no active link", async () => {
      mockPrisma.parentalLink.findFirst.mockResolvedValue(null);

      const response = await handler.removeLink("guardian1", "child1", mockEnv);
      expect(response.status).toBe(404);
    });
  });
});
