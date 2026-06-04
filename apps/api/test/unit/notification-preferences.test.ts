/**
 * Unit Tests: Notification Preferences Handler
 *
 * Tests preference retrieval, updates, defaults, and CHILD restrictions.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

// Hoist mocks
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    notificationPreference: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    release: vi.fn(),
  },
}));

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

import { NotificationPreferencesHandler } from "../../src/lib/notification-preferences-handler.js";

describe("NotificationPreferencesHandler", () => {
  let handler: NotificationPreferencesHandler;
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new NotificationPreferencesHandler();
    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
    } as unknown as Env;
    mockPrisma.release.mockResolvedValue(undefined);
  });

  describe("getPreferences", () => {
    it("should return defaults for new user with no stored preferences", async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

      const response = await handler.getPreferences("user-new", mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        dmEnabled: true,
        followEnabled: true,
        digestEnabled: true,
        systemEnabled: true,
      });
    });

    it("should return stored preferences", async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        id: "pref-1",
        userId: "user-1",
        dmEnabled: false,
        followEnabled: true,
        digestEnabled: false,
        systemEnabled: true,
      });

      const response = await handler.getPreferences("user-1", mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        dmEnabled: false,
        followEnabled: true,
        digestEnabled: false,
        systemEnabled: true,
      });
    });
  });

  describe("updatePreferences", () => {
    it("should persist preference changes", async () => {
      mockPrisma.notificationPreference.upsert.mockResolvedValue({
        id: "pref-1",
        userId: "user-1",
        dmEnabled: false,
        followEnabled: true,
        digestEnabled: true,
        systemEnabled: true,
      });

      const response = await handler.updatePreferences(
        "user-1",
        "ADULT",
        { dmEnabled: false },
        mockEnv,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.dmEnabled).toBe(false);
      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1" },
          update: { dmEnabled: false },
        }),
      );
    });

    it("should return 403 when CHILD tries to edit preferences", async () => {
      const response = await handler.updatePreferences(
        "child-user",
        "CHILD",
        { dmEnabled: false },
        mockEnv,
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe("FORBIDDEN");
      expect(mockPrisma.notificationPreference.upsert).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid preference values", async () => {
      const response = await handler.updatePreferences(
        "user-1",
        "ADULT",
        { dmEnabled: "yes" as any },
        mockEnv,
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("should return 400 when no valid preference fields provided", async () => {
      const response = await handler.updatePreferences(
        "user-1",
        "ADULT",
        { unknownField: true } as any,
        mockEnv,
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("No valid preference fields");
    });
  });
});
