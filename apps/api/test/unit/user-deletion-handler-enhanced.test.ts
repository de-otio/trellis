/**
 * Unit Tests for UserDeletionHandlerEnhanced
 *
 * Tests:
 * - Rate limiting
 * - Grace period
 * - Confirmation code generation, validation, and one-time use
 * - Cancellation within grace period
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { UserDeletionHandlerEnhanced } from "../../src/lib/user-deletion-handler-enhanced.js";
import type { Env } from "../../src/lib/user-deletion-handler-enhanced.js";
import type { Session } from "../../src/lib/session-cookie.js";

// Mock dependencies
vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(),
}));

vi.mock("../../src/lib/email-provider", () => ({
  createEmailProvider: vi.fn(() => ({
    sendEmail: vi.fn().mockResolvedValue({ messageId: "test-message-id" }),
  })),
}));

describe("UserDeletionHandlerEnhanced", () => {
  let handler: UserDeletionHandlerEnhanced;
  let mockEnv: Env;
  let mockSession: Session;
  let mockDb: any;
  let mockKV: any;
  let mockDeleteJobsKV: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    handler = new UserDeletionHandlerEnhanced();

    mockDb = {
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(),
      },
    };

    mockKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    mockDeleteJobsKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    mockEnv = {
      DATABASE_URL: "test-db-url",
      RATE_LIMIT_KV: mockKV,
      DELETE_JOBS_KV: mockDeleteJobsKV,
      RESEND_API_KEY: "test-api-key",
      FROM_EMAIL: "test@example.com",
      APP_URL: "https://test.example.com",
    };

    mockSession = {
      userId: "test-user-id",
      email: "test@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 3600000,
      dataRegion: "EU",
      profileContext: "primary",
    };

    const { createPrisma } = await import("../../src/db.js");
    (createPrisma as any).mockReturnValue(mockDb);
  });

  describe("requestDeletion", () => {
    it("should request deletion with grace period and generate confirmation code", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        suspended: false,
        deletionRequestedAt: null,
        deletionScheduledAt: null,
        deletionConfirmedAt: null,
      });
      mockDb.user.update.mockResolvedValue({});

      const result = await handler.requestDeletion(mockSession, mockEnv);

      expect(result.success).toBe(true);
      expect(result.confirmationRequired).toBe(true);
      expect(result.scheduledAt).toBeDefined();
      expect(mockDb.user.update).toHaveBeenCalledWith({
        where: { id: "test-user-id" },
        data: expect.objectContaining({
          deletionRequestedAt: expect.any(Date),
          deletionScheduledAt: expect.any(Date),
          suspended: true,
        }),
      });

      // Confirmation code stored in KV
      expect(mockDeleteJobsKV.put).toHaveBeenCalledWith(
        "deletion-confirm:test-user-id",
        expect.stringContaining("code"),
        { expirationTtl: 86400 },
      );
    });

    it("should enforce rate limiting", async () => {
      mockKV.get.mockResolvedValue(
        JSON.stringify({ count: 3, resetAt: Date.now() + 3600000 }),
      );

      await expect(
        handler.requestDeletion(mockSession, mockEnv),
      ).rejects.toThrow("Rate limit exceeded");
    });

    it("should prevent duplicate deletion requests", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        suspended: false,
        deletionRequestedAt: new Date(),
        deletionScheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        deletionConfirmedAt: null,
      });

      const result = await handler.requestDeletion(mockSession, mockEnv);
      expect(result.success).toBe(false);
      expect(result.confirmationRequired).toBe(true);
    });

    it("should return scheduled time if already confirmed", async () => {
      const scheduledAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        suspended: true,
        deletionRequestedAt: new Date(),
        deletionScheduledAt: scheduledAt,
        deletionConfirmedAt: new Date(),
      });

      const result = await handler.requestDeletion(mockSession, mockEnv);
      expect(result.success).toBe(true);
      expect(result.scheduledAt).toBe(scheduledAt.toISOString());
    });
  });

  // The confirmation-code check used to live inside `if (env.DELETE_JOBS_KV)`,
  // so with no binding the whole block was skipped and any code confirmed the
  // deletion. Nothing here covered that: every existing test wired the binding.
  // The email step exists to prove mailbox control before an irreversible
  // action, so skipping it removed the second factor rather than degrading it.
  describe("confirmDeletion — the store is not optional", () => {
    const requestedUser = {
      id: "test-user-id",
      email: "test@example.com",
      deletionRequestedAt: new Date(),
      deletionScheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      deletionConfirmedAt: null,
    };

    it("refuses to confirm when DELETE_JOBS_KV is missing", async () => {
      mockDb.user.findUnique.mockResolvedValue(requestedUser);
      delete (mockEnv as any).DELETE_JOBS_KV;

      await expect(
        handler.confirmDeletion("test-user-id", "123456", mockEnv),
      ).rejects.toThrow(/unavailable/i);
    });

    it("does not mark the account confirmed when it cannot validate the code", async () => {
      // The assertion that actually matters — a thrown error is worth nothing
      // if the row was already updated.
      mockDb.user.findUnique.mockResolvedValue(requestedUser);
      delete (mockEnv as any).DELETE_JOBS_KV;

      await expect(
        handler.confirmDeletion("test-user-id", "123456", mockEnv),
      ).rejects.toThrow();
      expect(mockDb.user.update).not.toHaveBeenCalled();
    });

    it("propagates a store read failure rather than confirming", async () => {
      mockDb.user.findUnique.mockResolvedValue(requestedUser);
      mockDeleteJobsKV.get.mockRejectedValue(new Error("KV unreachable"));

      await expect(
        handler.confirmDeletion("test-user-id", "123456", mockEnv),
      ).rejects.toThrow();
      expect(mockDb.user.update).not.toHaveBeenCalled();
    });
  });

  describe("requestDeletion — the store is not optional", () => {
    const freshUser = {
      id: "test-user-id",
      email: "test@example.com",
      suspended: false,
      deletionRequestedAt: null,
      deletionScheduledAt: null,
      deletionConfirmedAt: null,
    };

    it("refuses before touching the row when DELETE_JOBS_KV is missing", async () => {
      // Order is the point. Suspending the account and THEN failing would set
      // deletionRequestedAt, which makes every retry take the "already
      // requested, please confirm" branch — with no code ever issued. That is
      // a lockout, and it is why the check runs first.
      mockDb.user.findUnique.mockResolvedValue(freshUser);
      delete (mockEnv as any).DELETE_JOBS_KV;

      await expect(
        handler.requestDeletion(mockSession, mockEnv),
      ).rejects.toThrow(/unavailable/i);
      expect(mockDb.user.update).not.toHaveBeenCalled();
    });

    it("reverts the suspension when the code cannot be stored", async () => {
      mockDb.user.findUnique.mockResolvedValue(freshUser);
      mockDb.user.update.mockResolvedValue({});
      mockDeleteJobsKV.put.mockRejectedValue(new Error("KV unreachable"));

      await expect(
        handler.requestDeletion(mockSession, mockEnv),
      ).rejects.toThrow(/unavailable/i);

      // Two updates: the mark, then the undo. There is no transaction across
      // Postgres and the KV store, so the undo is hand-rolled.
      expect(mockDb.user.update).toHaveBeenCalledTimes(2);
      expect(mockDb.user.update).toHaveBeenLastCalledWith({
        where: { id: "test-user-id" },
        data: {
          deletionRequestedAt: null,
          deletionScheduledAt: null,
          suspended: false,
          suspendedAt: null,
          suspendedReason: null,
        },
      });
    });
  });

  describe("confirmDeletion", () => {
    it("should accept valid confirmation code", async () => {
      const scheduledAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        deletionRequestedAt: new Date(),
        deletionScheduledAt: scheduledAt,
        deletionConfirmedAt: null,
      });
      mockDb.user.update.mockResolvedValue({});

      // Code stored in KV
      mockDeleteJobsKV.get.mockResolvedValue(
        JSON.stringify({ code: "123456", createdAt: new Date().toISOString() }),
      );

      const result = await handler.confirmDeletion(
        "test-user-id",
        "123456",
        mockEnv,
      );

      expect(result.success).toBe(true);
      expect(result.scheduledAt).toBe(scheduledAt.toISOString());
      expect(mockDb.user.update).toHaveBeenCalledWith({
        where: { id: "test-user-id" },
        data: { deletionConfirmedAt: expect.any(Date) },
      });
    });

    it("should reject invalid confirmation code", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        deletionRequestedAt: new Date(),
        deletionScheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        deletionConfirmedAt: null,
      });

      mockDeleteJobsKV.get.mockResolvedValue(
        JSON.stringify({ code: "123456", createdAt: new Date().toISOString() }),
      );

      await expect(
        handler.confirmDeletion("test-user-id", "999999", mockEnv),
      ).rejects.toThrow("Invalid confirmation code");
    });

    it("should reject expired confirmation code (KV entry gone)", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        deletionRequestedAt: new Date(),
        deletionScheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        deletionConfirmedAt: null,
      });

      // No code in KV (expired)
      mockDeleteJobsKV.get.mockResolvedValue(null);

      await expect(
        handler.confirmDeletion("test-user-id", "123456", mockEnv),
      ).rejects.toThrow("Confirmation code expired or not found");
    });

    it("should delete code from KV after successful validation (one-time use)", async () => {
      const scheduledAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        deletionRequestedAt: new Date(),
        deletionScheduledAt: scheduledAt,
        deletionConfirmedAt: null,
      });
      mockDb.user.update.mockResolvedValue({});

      mockDeleteJobsKV.get.mockResolvedValue(
        JSON.stringify({ code: "123456", createdAt: new Date().toISOString() }),
      );

      await handler.confirmDeletion("test-user-id", "123456", mockEnv);

      expect(mockDeleteJobsKV.delete).toHaveBeenCalledWith(
        "deletion-confirm:test-user-id",
      );
    });

    it("should reject confirmation if no deletion requested", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        deletionRequestedAt: null,
        deletionScheduledAt: null,
        deletionConfirmedAt: null,
      });

      await expect(
        handler.confirmDeletion("test-user-id", "123456", mockEnv),
      ).rejects.toThrow("No deletion request found");
    });

    it("should return success if already confirmed", async () => {
      const scheduledAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        deletionRequestedAt: new Date(),
        deletionScheduledAt: scheduledAt,
        deletionConfirmedAt: new Date(),
      });

      const result = await handler.confirmDeletion(
        "test-user-id",
        "123456",
        mockEnv,
      );

      expect(result.success).toBe(true);
      expect(mockDb.user.update).not.toHaveBeenCalled();
    });
  });

  describe("cancelDeletion", () => {
    it("should cancel deletion within grace period", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        deletionRequestedAt: new Date(),
        deletionScheduledAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      });
      mockDb.user.update.mockResolvedValue({});

      const result = await handler.cancelDeletion(mockSession, mockEnv);

      expect(result.success).toBe(true);
      expect(mockDb.user.update).toHaveBeenCalledWith({
        where: { id: "test-user-id" },
        data: {
          deletionRequestedAt: null,
          deletionScheduledAt: null,
          deletionConfirmedAt: null,
          suspended: false,
          suspendedAt: null,
          suspendedReason: null,
        },
      });
    });

    it("should reject cancellation after grace period", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        deletionRequestedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        deletionScheduledAt: new Date(Date.now() - 1000),
      });

      await expect(
        handler.cancelDeletion(mockSession, mockEnv),
      ).rejects.toThrow("Grace period has expired");
    });

    it("should reject if no deletion requested", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        deletionRequestedAt: null,
        deletionScheduledAt: null,
      });

      await expect(
        handler.cancelDeletion(mockSession, mockEnv),
      ).rejects.toThrow("No deletion request found");
    });
  });

  describe("email notifications", () => {
    it("should include confirmation code in email", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "test-user-id",
        email: "test@example.com",
        suspended: false,
        deletionRequestedAt: null,
        deletionScheduledAt: null,
        deletionConfirmedAt: null,
      });
      mockDb.user.update.mockResolvedValue({});

      const { createEmailProvider } = await import("../../src/lib/email-provider.js");
      const mockEmailProvider = {
        sendEmail: vi.fn().mockResolvedValue({ messageId: "test-id" }),
      };
      vi.mocked(createEmailProvider).mockReturnValue(mockEmailProvider as any);

      await handler.requestDeletion(mockSession, mockEnv);

      expect(mockEmailProvider.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "test@example.com",
          subject: "Confirm Your Trellis Account Deletion",
          html: expect.stringContaining("confirmation code"),
        }),
      );
    });
  });
});
