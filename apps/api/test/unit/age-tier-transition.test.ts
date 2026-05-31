/**
 * Unit Tests: Age Tier Transition
 *
 * Tests for automatic age tier transitions based on date of birth.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

// Mock Prisma client
const mockPrisma = {
  user: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  notification: {
    create: vi.fn(),
  },
  parentalLink: {
    findMany: vi.fn(),
  },
};

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

import { checkAgeTierTransitions, computeAgeTier } from "../../src/lib/age-tier-transition.js";

describe("computeAgeTier", () => {
  it("should return CHILD for age < 13", () => {
    const dob = new Date("2015-06-15");
    const now = new Date("2026-03-28");
    expect(computeAgeTier(dob, now)).toBe("CHILD");
  });

  it("should return TEEN for age 13-17", () => {
    const dob = new Date("2010-01-01");
    const now = new Date("2026-03-28");
    expect(computeAgeTier(dob, now)).toBe("TEEN");
  });

  it("should return ADULT for age >= 18", () => {
    const dob = new Date("2000-01-01");
    const now = new Date("2026-03-28");
    expect(computeAgeTier(dob, now)).toBe("ADULT");
  });
});

describe("checkAgeTierTransitions", () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
    } as Env;
  });

  it("should return 0 transitions when no users have DOB", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);

    const result = await checkAgeTierTransitions(mockEnv);
    expect(result.transitioned).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("should transition CHILD to TEEN when birthday crosses 13", async () => {
    // User is 13 years old now but still marked as CHILD
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 13);
    dob.setDate(dob.getDate() - 1); // ensure past birthday

    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: "user1",
        dateOfBirth: dob,
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
        personalTenantId: "tenant-personal-user1",
      },
    ]);
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.notification.create.mockResolvedValue({});
    mockPrisma.parentalLink.findMany.mockResolvedValue([]);

    const result = await checkAgeTierTransitions(mockEnv);
    expect(result.transitioned).toBe(1);
    expect(result.errors).toBe(0);

    // Verify tier was updated
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user1" },
        data: expect.objectContaining({ ageTier: "TEEN" }),
      }),
    );
  });

  it("should keep more restrictive user settings on CHILD to TEEN transition", async () => {
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 13);
    dob.setDate(dob.getDate() - 1);

    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: "user1",
        dateOfBirth: dob,
        ageTier: "CHILD",
        stealthMode: true, // more restrictive than TEEN default (false)
        showOnlineStatus: false, // same as TEEN default
        showTypingIndicator: false, // more restrictive than TEEN default (true)
        showLastSeen: false, // same as TEEN default
        locationTrackingEnabled: false, // same as TEEN default
        locationAnonymizationLevel: 3, // more restrictive than TEEN default (2)
        analyticsOptOut: true, // same as TEEN default
        profileVisibility: "PRIVATE", // more restrictive than TEEN default (CONNECTIONS)
        dmAccess: "NOBODY", // more restrictive than TEEN default (CONNECTIONS)
      },
    ]);
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.notification.create.mockResolvedValue({});
    mockPrisma.parentalLink.findMany.mockResolvedValue([]);

    await checkAgeTierTransitions(mockEnv);

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ageTier: "TEEN",
          stealthMode: true, // kept: more restrictive
          locationAnonymizationLevel: 3, // kept: more restrictive
          profileVisibility: "PRIVATE", // kept: more restrictive
          dmAccess: "NOBODY", // kept: more restrictive
        }),
      }),
    );
  });

  it("should notify guardian on TEEN to ADULT transition", async () => {
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 18);
    dob.setDate(dob.getDate() - 1);

    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: "user2",
        dateOfBirth: dob,
        ageTier: "TEEN",
        stealthMode: false,
        showOnlineStatus: false,
        showTypingIndicator: true,
        showLastSeen: false,
        locationTrackingEnabled: false,
        locationAnonymizationLevel: 2,
        analyticsOptOut: true,
        profileVisibility: "CONNECTIONS",
        dmAccess: "CONNECTIONS",
        personalTenantId: "tenant-personal-user2",
      },
    ]);
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.notification.create.mockResolvedValue({});
    mockPrisma.parentalLink.findMany.mockResolvedValue([
      { guardianId: "guardian1", guardian: { personalTenantId: "tenant-personal-guardian1" } },
    ]);

    await checkAgeTierTransitions(mockEnv);

    // Notification for user
    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user2",
          type: "SYSTEM",
        }),
      }),
    );

    // Notification for guardian
    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "guardian1",
          type: "SYSTEM",
        }),
      }),
    );
  });

  it("should send notifications to user and guardian", async () => {
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 13);
    dob.setDate(dob.getDate() - 1);

    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: "user1",
        dateOfBirth: dob,
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
        personalTenantId: "tenant-personal-user1",
      },
    ]);
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.notification.create.mockResolvedValue({});
    mockPrisma.parentalLink.findMany.mockResolvedValue([
      { guardianId: "guardian1", guardian: { personalTenantId: "tenant-personal-guardian1" } },
    ]);

    await checkAgeTierTransitions(mockEnv);

    // 2 notifications: one for user, one for guardian
    expect(mockPrisma.notification.create).toHaveBeenCalledTimes(2);
  });

  it("should continue processing other users when one fails", async () => {
    const dob13 = new Date();
    dob13.setFullYear(dob13.getFullYear() - 13);
    dob13.setDate(dob13.getDate() - 1);

    const dob18 = new Date();
    dob18.setFullYear(dob18.getFullYear() - 18);
    dob18.setDate(dob18.getDate() - 1);

    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: "user-fail",
        dateOfBirth: dob13,
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
      },
      {
        id: "user-ok",
        dateOfBirth: dob18,
        ageTier: "TEEN",
        stealthMode: false,
        showOnlineStatus: false,
        showTypingIndicator: true,
        showLastSeen: false,
        locationTrackingEnabled: false,
        locationAnonymizationLevel: 2,
        analyticsOptOut: true,
        profileVisibility: "CONNECTIONS",
        dmAccess: "CONNECTIONS",
      },
    ]);

    // First user update fails, second succeeds
    mockPrisma.user.update
      .mockRejectedValueOnce(new Error("DB error"))
      .mockResolvedValueOnce({});
    mockPrisma.notification.create.mockResolvedValue({});
    mockPrisma.parentalLink.findMany.mockResolvedValue([]);

    const result = await checkAgeTierTransitions(mockEnv);
    expect(result.errors).toBe(1);
    expect(result.transitioned).toBe(1);
  });
});
