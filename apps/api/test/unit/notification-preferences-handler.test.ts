/**
 * Unit Tests: NotificationPreferencesHandler
 *
 * Covers getPreferences and updatePreferences thoroughly:
 *   - stored prefs, default prefs, DB error (getPreferences)
 *   - CHILD guard, boolean validation, empty-fields guard,
 *     happy-path upsert, upsert error (updatePreferences)
 *   - db.release() called in every path (finally block correctness)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

// ---------------------------------------------------------------------------
// Hoist mocks so they are available before module evaluation
// ---------------------------------------------------------------------------

const { mockPrisma, createPrismaMock } = vi.hoisted(() => {
  const mockPrisma = {
    notificationPreference: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    release: vi.fn(),
  };
  const createPrismaMock = vi.fn(() => mockPrisma);
  return { mockPrisma, createPrismaMock };
});

vi.mock("../../src/db", () => ({
  createPrisma: createPrismaMock,
}));

vi.mock("../../src/lib/logger", () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  Logger: class {},
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { NotificationPreferencesHandler } from "../../src/lib/notification-preferences-handler.js";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const DEFAULT_PREFERENCES = {
  dmEnabled: true,
  followEnabled: true,
  digestEnabled: true,
  systemEnabled: true,
};

describe("NotificationPreferencesHandler", () => {
  let handler: NotificationPreferencesHandler;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new NotificationPreferencesHandler();
    env = {} as any;
    // Default: release resolves cleanly
    mockPrisma.release.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // getPreferences
  // -------------------------------------------------------------------------

  describe("getPreferences", () => {
    it("returns 200 with the four boolean fields from the stored row", async () => {
      const storedRow = {
        id: "pref-abc",
        userId: "user-1",
        dmEnabled: false,
        followEnabled: true,
        digestEnabled: false,
        systemEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(storedRow);

      const response = await handler.getPreferences("user-1", env);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        dmEnabled: false,
        followEnabled: true,
        digestEnabled: false,
        systemEnabled: true,
      });
    });

    it("returns 200 with DEFAULT_PREFERENCES (all true) when findUnique returns null", async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

      const response = await handler.getPreferences("user-new", env);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(DEFAULT_PREFERENCES);
    });

    it("returns 500 with error envelope when findUnique throws", async () => {
      mockPrisma.notificationPreference.findUnique.mockRejectedValue(
        new Error("Connection pool exhausted"),
      );

      const response = await handler.getPreferences("user-1", env);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body).toHaveProperty("error");
    });

    it("calls db.release() after a successful fetch (stored prefs)", async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        userId: "user-1",
        dmEnabled: true,
        followEnabled: true,
        digestEnabled: true,
        systemEnabled: true,
      });

      await handler.getPreferences("user-1", env);

      expect(mockPrisma.release).toHaveBeenCalledTimes(1);
    });

    it("calls db.release() after a default-prefs response (null row)", async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

      await handler.getPreferences("user-nobody", env);

      expect(mockPrisma.release).toHaveBeenCalledTimes(1);
    });

    it("calls db.release() even when findUnique throws (finally block, no connection leak)", async () => {
      mockPrisma.notificationPreference.findUnique.mockRejectedValue(
        new Error("DB timeout"),
      );

      await handler.getPreferences("user-1", env);

      expect(mockPrisma.release).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // updatePreferences
  // -------------------------------------------------------------------------

  describe("updatePreferences", () => {
    // --- CHILD guard ---

    it("returns 403 FORBIDDEN when ageTier is CHILD", async () => {
      const response = await handler.updatePreferences(
        "child-user",
        "CHILD",
        { dmEnabled: false },
        env,
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe("FORBIDDEN");
    });

    it("does NOT call upsert when ageTier is CHILD", async () => {
      await handler.updatePreferences("child-user", "CHILD", { dmEnabled: false }, env);

      expect(mockPrisma.notificationPreference.upsert).not.toHaveBeenCalled();
    });

    it("calls db.release() even when CHILD guard fires (finally block)", async () => {
      await handler.updatePreferences("child-user", "CHILD", { followEnabled: true }, env);

      expect(mockPrisma.release).toHaveBeenCalledTimes(1);
    });

    // --- Boolean validation ---

    it("returns 400 VALIDATION_ERROR when a known key has a non-boolean value (string)", async () => {
      const response = await handler.updatePreferences(
        "user-1",
        "ADULT",
        { dmEnabled: "yes" as any },
        env,
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 VALIDATION_ERROR when a known key has a non-boolean value (number)", async () => {
      const response = await handler.updatePreferences(
        "user-1",
        "ADULT",
        { followEnabled: 1 as any },
        env,
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("does NOT call upsert when validation fails on a non-boolean value", async () => {
      await handler.updatePreferences("user-1", "ADULT", { dmEnabled: "yes" as any }, env);

      expect(mockPrisma.notificationPreference.upsert).not.toHaveBeenCalled();
    });

    it("calls db.release() when validation fails on a non-boolean value", async () => {
      await handler.updatePreferences("user-1", "ADULT", { dmEnabled: "yes" as any }, env);

      expect(mockPrisma.release).toHaveBeenCalledTimes(1);
    });

    // --- Empty / no-valid-fields guard ---

    it("returns 400 VALIDATION_ERROR with 'No valid preference fields' when preferences is empty", async () => {
      const response = await handler.updatePreferences("user-1", "ADULT", {}, env);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/No valid preference fields/i);
    });

    it("returns 400 VALIDATION_ERROR when only unknown keys are provided", async () => {
      const response = await handler.updatePreferences(
        "user-1",
        "ADULT",
        { unknownField: true } as any,
        env,
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/No valid preference fields/i);
    });

    it("does NOT call upsert when no valid preference fields are provided", async () => {
      await handler.updatePreferences("user-1", "ADULT", {}, env);

      expect(mockPrisma.notificationPreference.upsert).not.toHaveBeenCalled();
    });

    it("calls db.release() when no valid preference fields are provided", async () => {
      await handler.updatePreferences("user-1", "ADULT", {}, env);

      expect(mockPrisma.release).toHaveBeenCalledTimes(1);
    });

    // --- Happy path ---

    it("returns 200 with the four boolean fields from the upsert result", async () => {
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
        env,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        dmEnabled: false,
        followEnabled: true,
        digestEnabled: true,
        systemEnabled: true,
      });
    });

    it("calls upsert with correct where, create (defaults merged), and update args", async () => {
      mockPrisma.notificationPreference.upsert.mockResolvedValue({
        id: "pref-1",
        userId: "user-1",
        dmEnabled: false,
        followEnabled: true,
        digestEnabled: true,
        systemEnabled: true,
      });

      await handler.updatePreferences("user-1", "ADULT", { dmEnabled: false }, env);

      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        create: {
          userId: "user-1",
          dmEnabled: false,       // override from input
          followEnabled: true,    // default
          digestEnabled: true,    // default
          systemEnabled: true,    // default
        },
        update: { dmEnabled: false },
      });
    });

    it("handles a partial update with multiple fields correctly", async () => {
      mockPrisma.notificationPreference.upsert.mockResolvedValue({
        id: "pref-2",
        userId: "user-2",
        dmEnabled: false,
        followEnabled: false,
        digestEnabled: true,
        systemEnabled: true,
      });

      const response = await handler.updatePreferences(
        "user-2",
        "TEEN",
        { dmEnabled: false, followEnabled: false },
        env,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.dmEnabled).toBe(false);
      expect(body.followEnabled).toBe(false);

      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalledWith({
        where: { userId: "user-2" },
        create: {
          userId: "user-2",
          dmEnabled: false,
          followEnabled: false,
          digestEnabled: true,
          systemEnabled: true,
        },
        update: { dmEnabled: false, followEnabled: false },
      });
    });

    it("calls db.release() on the happy path", async () => {
      mockPrisma.notificationPreference.upsert.mockResolvedValue({
        id: "pref-1",
        userId: "user-1",
        dmEnabled: true,
        followEnabled: true,
        digestEnabled: true,
        systemEnabled: true,
      });

      await handler.updatePreferences("user-1", "ADULT", { dmEnabled: true }, env);

      expect(mockPrisma.release).toHaveBeenCalledTimes(1);
    });

    // --- Upsert error ---

    it("returns 500 when upsert throws", async () => {
      mockPrisma.notificationPreference.upsert.mockRejectedValue(
        new Error("unique constraint violation"),
      );

      const response = await handler.updatePreferences(
        "user-1",
        "ADULT",
        { digestEnabled: false },
        env,
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body).toHaveProperty("error");
    });

    it("calls db.release() even when upsert throws (finally block, no connection leak)", async () => {
      mockPrisma.notificationPreference.upsert.mockRejectedValue(
        new Error("DB connection lost"),
      );

      await handler.updatePreferences("user-1", "ADULT", { systemEnabled: false }, env);

      expect(mockPrisma.release).toHaveBeenCalledTimes(1);
    });

    // --- Age-tier boundary: non-CHILD tiers are allowed ---

    it("allows updates for ADULT age tier", async () => {
      mockPrisma.notificationPreference.upsert.mockResolvedValue({
        userId: "user-adult",
        dmEnabled: true,
        followEnabled: true,
        digestEnabled: true,
        systemEnabled: false,
      });

      const response = await handler.updatePreferences(
        "user-adult",
        "ADULT",
        { systemEnabled: false },
        env,
      );

      expect(response.status).toBe(200);
    });

    it("allows updates for TEEN age tier", async () => {
      mockPrisma.notificationPreference.upsert.mockResolvedValue({
        userId: "user-teen",
        dmEnabled: true,
        followEnabled: false,
        digestEnabled: true,
        systemEnabled: true,
      });

      const response = await handler.updatePreferences(
        "user-teen",
        "TEEN",
        { followEnabled: false },
        env,
      );

      expect(response.status).toBe(200);
    });
  });
});
