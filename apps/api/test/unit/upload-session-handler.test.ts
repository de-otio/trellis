/**
 * Upload Session Handler Tests
 *
 * Unit tests for upload session management functionality.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UploadSessionHandler } from "../../src/lib/upload-session-handler.js";

// Mock dependencies
vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    executeWithRetry: vi.fn(),
  },
}));

vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: vi.fn(),
  QueryTimeoutPresets: {
    STANDARD: { timeoutMs: 2000, retryTimeoutMs: 2000 },
    BACKGROUND: { timeoutMs: 12000, retryTimeoutMs: 5000 },
  },
}));

describe("UploadSessionHandler", () => {
  let handler: UploadSessionHandler;
  let mockEnv: any;
  let mockDb: any;

  beforeEach(() => {
    mockEnv = {
      LOG_LEVEL: "info",
    };

    mockDb = {
      uploadSession: {
        create: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      mediaFile: {
        findFirst: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    };

    handler = new UploadSessionHandler(mockEnv);

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createSession", () => {
    it("should create a new upload session with 24-hour expiry", async () => {
      const userId = "user-123";
      const region = "US";
      const sessionId = "session-456";
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const mockSession = {
        id: sessionId,
        userId,
        mediaIds: [],
        status: "active",
        createdAt: now,
        expiresAt,
      };

      // Mock withQueryTimeoutAndRetry to call the query function
      const { withQueryTimeoutAndRetry } = await import("../../src/lib/db-query-helper.js");
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          return await queryFn(mockDb);
        },
      );

      mockDb.uploadSession.create.mockResolvedValue(mockSession);

      const result = await handler.createSession(userId, region, mockEnv);

      expect(result).toEqual({
        sessionId,
        expiresAt: expiresAt.toISOString(),
      });
      expect(mockDb.uploadSession.create).toHaveBeenCalledWith({
        data: {
          userId,
          mediaIds: [],
          status: "active",
          expiresAt: expect.any(Date),
        },
      });
    });

    it("should throw error if session creation fails", async () => {
      const userId = "user-123";
      const region = "US";

      const { withQueryTimeoutAndRetry } = await import("../../src/lib/db-query-helper.js");
      vi.mocked(withQueryTimeoutAndRetry).mockRejectedValue(
        new Error("Database error"),
      );

      await expect(
        handler.createSession(userId, region, mockEnv),
      ).rejects.toThrow("Database error");
    });
  });

  describe("validateSession", () => {
    it("should return session if valid and not expired", async () => {
      const sessionId = "session-456";
      const userId = "user-123";
      const region = "US";
      const futureDate = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

      const mockSession = {
        id: sessionId,
        userId,
        mediaIds: ["media-1", "media-2"],
        status: "active",
        createdAt: new Date(),
        expiresAt: futureDate,
      };

      const { withQueryTimeoutAndRetry } = await import("../../src/lib/db-query-helper.js");
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          return await queryFn(mockDb);
        },
      );

      mockDb.uploadSession.findFirst.mockResolvedValue(mockSession);

      const result = await handler.validateSession(
        sessionId,
        userId,
        region,
        mockEnv,
      );

      expect(result).toEqual(mockSession);
      expect(mockDb.uploadSession.findFirst).toHaveBeenCalledWith({
        where: {
          id: sessionId,
          userId,
        },
      });
    });

    it("should return null if session not found", async () => {
      const sessionId = "session-456";
      const userId = "user-123";
      const region = "US";

      const { withQueryTimeoutAndRetry } = await import("../../src/lib/db-query-helper.js");
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          return await queryFn(mockDb);
        },
      );

      mockDb.uploadSession.findFirst.mockResolvedValue(null);

      const result = await handler.validateSession(
        sessionId,
        userId,
        region,
        mockEnv,
      );

      expect(result).toBeNull();
    });

    it("should return null if session is expired", async () => {
      const sessionId = "session-456";
      const userId = "user-123";
      const region = "US";
      const pastDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

      const mockSession = {
        id: sessionId,
        userId,
        mediaIds: [],
        status: "active",
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        expiresAt: pastDate,
      };

      const { withQueryTimeoutAndRetry } = await import("../../src/lib/db-query-helper.js");
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          return await queryFn(mockDb);
        },
      );

      mockDb.uploadSession.findFirst.mockResolvedValue(mockSession);

      const result = await handler.validateSession(
        sessionId,
        userId,
        region,
        mockEnv,
      );

      expect(result).toBeNull();
    });
  });

  describe("addMediaToSession", () => {
    it("should add media to session successfully", async () => {
      const sessionId = "session-456";
      const userId = "user-123";
      const mediaId = "media-789";
      const region = "US";

      const mockSession = {
        id: sessionId,
        userId,
        mediaIds: ["media-1"],
        status: "active",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };

      const mockMedia = {
        id: mediaId,
        uploadedBy: userId,
        contentHash: "hash123",
      };

      const { withQueryTimeoutAndRetry } = await import("../../src/lib/db-query-helper.js");
      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          if (callCount === 1) {
            // First call: validateSession
            return await queryFn(mockDb);
          } else if (callCount === 2) {
            // Second call: verify media
            return mockMedia;
          } else if (callCount === 3) {
            // Third call: update session
            return { ...mockSession, mediaIds: ["media-1", mediaId] };
          } else {
            // Fourth call: update media lastAccessedAt
            return mockMedia;
          }
        },
      );

      mockDb.uploadSession.findFirst.mockResolvedValue(mockSession);
      mockDb.mediaFile.findFirst.mockResolvedValue(mockMedia);
      mockDb.uploadSession.update.mockResolvedValue({
        ...mockSession,
        mediaIds: ["media-1", mediaId],
      });
      mockDb.mediaFile.update.mockResolvedValue(mockMedia);

      const result = await handler.addMediaToSession(
        sessionId,
        userId,
        mediaId,
        region,
        mockEnv,
      );

      expect(result).toEqual({ success: true });
    });

    it("should return error if session not found", async () => {
      const sessionId = "session-456";
      const userId = "user-123";
      const mediaId = "media-789";
      const region = "US";

      const { withQueryTimeoutAndRetry } = await import("../../src/lib/db-query-helper.js");
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          return await queryFn(mockDb);
        },
      );

      mockDb.uploadSession.findFirst.mockResolvedValue(null);

      const result = await handler.addMediaToSession(
        sessionId,
        userId,
        mediaId,
        region,
        mockEnv,
      );

      expect(result).toEqual({
        success: false,
        error: "Session not found or expired",
      });
    });

    it("should add media to session even if media not yet reconciled in database", async () => {
      // When media is not found, the handler adds it to the session anyway
      // to handle async reconciliation (upload just completed, DB not yet updated).
      const sessionId = "session-456";
      const userId = "user-123";
      const mediaId = "media-789";
      const region = "US";

      const mockSession = {
        id: sessionId,
        userId,
        mediaIds: [],
        status: "active",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };

      const { withQueryTimeoutAndRetry } = await import("../../src/lib/db-query-helper.js");
      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          if (callCount === 1) {
            // First call: validateSession
            return await queryFn(mockDb);
          } else if (callCount === 2) {
            // Second call: verify media — not found (async reconciliation)
            return await queryFn(mockDb);
          } else {
            // Third call: update session
            return await queryFn(mockDb);
          }
        },
      );

      mockDb.uploadSession.findFirst.mockResolvedValue(mockSession);
      mockDb.mediaFile.findFirst.mockResolvedValue(null); // Media not yet reconciled
      mockDb.uploadSession.update.mockResolvedValue({
        ...mockSession,
        mediaIds: [mediaId],
      });

      const result = await handler.addMediaToSession(
        sessionId,
        userId,
        mediaId,
        region,
        mockEnv,
      );

      // Source intentionally succeeds when media not found — adds mediaId for async reconciliation
      expect(result).toEqual({ success: true });
    });
  });

  describe("completeSession", () => {
    it("should mark session as completed and media as attached", async () => {
      const sessionId = "session-456";
      const userId = "user-123";
      const region = "US";

      const mockSession = {
        id: sessionId,
        userId,
        mediaIds: ["media-1", "media-2"],
        status: "active",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };

      const { withQueryTimeoutAndRetry } = await import("../../src/lib/db-query-helper.js");
      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          if (callCount === 1) {
            // First call: validateSession
            return await queryFn(mockDb);
          } else if (callCount === 2) {
            // Second call: update session status
            return await queryFn(mockDb);
          } else {
            // Third call: update media
            return await queryFn(mockDb);
          }
        },
      );

      mockDb.uploadSession.findFirst.mockResolvedValue(mockSession);
      mockDb.uploadSession.update.mockResolvedValue({
        ...mockSession,
        status: "completed",
      });
      mockDb.mediaFile.updateMany.mockResolvedValue({ count: 2 });

      const result = await handler.completeSession(
        sessionId,
        userId,
        region,
        mockEnv,
      );

      expect(result).toEqual({ success: true });
      expect(mockDb.uploadSession.update).toHaveBeenCalledWith({
        where: { id: sessionId },
        data: { status: "completed" },
      });
      expect(mockDb.mediaFile.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["media-1", "media-2"] } },
        data: {
          attachedToPost: true,
          orphanedAt: null,
          lastAccessedAt: expect.any(Date),
        },
      });
    });

    it("should return error if session not found", async () => {
      const sessionId = "session-456";
      const userId = "user-123";
      const region = "US";

      const { withQueryTimeoutAndRetry } = await import("../../src/lib/db-query-helper.js");
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          return await queryFn(mockDb);
        },
      );

      mockDb.uploadSession.findFirst.mockResolvedValue(null);

      const result = await handler.completeSession(
        sessionId,
        userId,
        region,
        mockEnv,
      );

      expect(result).toEqual({
        success: false,
        error: "Session not found or expired",
      });
    });
  });

  describe("abandonSession", () => {
    it("should mark session as abandoned and media as orphaned", async () => {
      const sessionId = "session-456";
      const userId = "user-123";
      const region = "US";

      const mockSession = {
        id: sessionId,
        userId,
        mediaIds: ["media-1", "media-2"],
        status: "active",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };

      const { withQueryTimeoutAndRetry } = await import("../../src/lib/db-query-helper.js");
      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          if (callCount === 1) {
            // First call: validateSession
            return await queryFn(mockDb);
          } else if (callCount === 2) {
            // Second call: update session status
            return await queryFn(mockDb);
          } else {
            // Third call: update media
            return await queryFn(mockDb);
          }
        },
      );

      mockDb.uploadSession.findFirst.mockResolvedValue(mockSession);
      mockDb.uploadSession.update.mockResolvedValue({
        ...mockSession,
        status: "abandoned",
      });
      mockDb.mediaFile.updateMany.mockResolvedValue({ count: 2 });

      const result = await handler.abandonSession(
        sessionId,
        userId,
        region,
        mockEnv,
      );

      expect(result).toEqual({ success: true });
      expect(mockDb.uploadSession.update).toHaveBeenCalledWith({
        where: { id: sessionId },
        data: { status: "abandoned" },
      });
      expect(mockDb.mediaFile.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["media-1", "media-2"] } },
        data: {
          orphanedAt: expect.any(Date),
          attachedToPost: false,
          lastAccessedAt: expect.any(Date),
        },
      });
    });

    it("should return error if session not found", async () => {
      const sessionId = "session-456";
      const userId = "user-123";
      const region = "US";

      const { withQueryTimeoutAndRetry } = await import("../../src/lib/db-query-helper.js");
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          return await queryFn(mockDb);
        },
      );

      mockDb.uploadSession.findFirst.mockResolvedValue(null);

      const result = await handler.abandonSession(
        sessionId,
        userId,
        region,
        mockEnv,
      );

      expect(result).toEqual({
        success: false,
        error: "Session not found or expired",
      });
    });
  });
});
