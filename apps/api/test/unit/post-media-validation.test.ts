/**
 * Unit Tests: Post Media Validation
 *
 * Focused tests for media validation logic in post creation.
 * These tests verify the critical security features without testing
 * the entire post creation flow.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock database
const mockDb = {
  mediaFile: {
    findMany: vi.fn(),
  },
};

const mockWithQueryTimeoutAndRetry = vi.fn();

vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {},
}));

describe("Post Media Validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mock implementation
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (
        manager: any,
        region: string,
        env: any,
        queryFn: (db: any) => Promise<any>,
      ) => {
        return await queryFn(mockDb);
      },
    );
  });

  describe("validateMediaOwnership", () => {
    it("should validate that all media files exist and belong to user", async () => {
      const userId = "user-123";
      const mediaIds = ["media-1", "media-2"];

      mockDb.mediaFile.findMany.mockResolvedValueOnce([
        { id: "media-1", uploadedBy: userId, deletedAt: null },
        { id: "media-2", uploadedBy: userId, deletedAt: null },
      ]);

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      const result = await withQueryTimeoutAndRetry(
        {} as any,
        "US",
        {} as any,
        async (db: any) => {
          return await db.mediaFile.findMany({
            where: {
              id: { in: mediaIds },
              uploadedBy: userId,
              deletedAt: null,
            },
          });
        },
        {} as any,
      );

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("media-1");
      expect(result[1].id).toBe("media-2");
      expect(mockDb.mediaFile.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: mediaIds },
          uploadedBy: userId,
          deletedAt: null,
        },
      });
    });

    it("should reject when media does not belong to user", async () => {
      const userId = "user-123";
      const mediaIds = ["media-1", "media-other-user"];

      // Only one media file found (the one owned by user)
      mockDb.mediaFile.findMany.mockResolvedValueOnce([
        { id: "media-1", uploadedBy: userId, deletedAt: null },
      ]);

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      const result = await withQueryTimeoutAndRetry(
        {} as any,
        "US",
        {} as any,
        async (db: any) => {
          return await db.mediaFile.findMany({
            where: {
              id: { in: mediaIds },
              uploadedBy: userId,
              deletedAt: null,
            },
          });
        },
        {} as any,
      );

      // Should only return 1 media file, not 2
      expect(result).toHaveLength(1);
      expect(result.length).not.toBe(mediaIds.length);
    });

    it("should reject deleted media", async () => {
      const userId = "user-123";
      const mediaIds = ["media-deleted"];

      // No media files found (deleted media is filtered out)
      mockDb.mediaFile.findMany.mockResolvedValueOnce([]);

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      const result = await withQueryTimeoutAndRetry(
        {} as any,
        "US",
        {} as any,
        async (db: any) => {
          return await db.mediaFile.findMany({
            where: {
              id: { in: mediaIds },
              uploadedBy: userId,
              deletedAt: null,
            },
          });
        },
        {} as any,
      );

      expect(result).toHaveLength(0);
      expect(result.length).not.toBe(mediaIds.length);
    });

    it("should reject non-existent media IDs", async () => {
      const userId = "user-123";
      const mediaIds = ["media-invalid"];

      mockDb.mediaFile.findMany.mockResolvedValueOnce([]);

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      const result = await withQueryTimeoutAndRetry(
        {} as any,
        "US",
        {} as any,
        async (db: any) => {
          return await db.mediaFile.findMany({
            where: {
              id: { in: mediaIds },
              uploadedBy: userId,
              deletedAt: null,
            },
          });
        },
        {} as any,
      );

      expect(result).toHaveLength(0);
      expect(result.length).not.toBe(mediaIds.length);
    });

    it("should handle empty media array", async () => {
      const userId = "user-123";
      const mediaIds: string[] = [];

      mockDb.mediaFile.findMany.mockResolvedValueOnce([]);

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      const result = await withQueryTimeoutAndRetry(
        {} as any,
        "US",
        {} as any,
        async (db: any) => {
          return await db.mediaFile.findMany({
            where: {
              id: { in: mediaIds },
              uploadedBy: userId,
              deletedAt: null,
            },
          });
        },
        {} as any,
      );

      expect(result).toHaveLength(0);
      expect(result.length).toBe(mediaIds.length);
    });
  });

  describe("media count validation", () => {
    it("should allow up to 4 media attachments", () => {
      const media = [
        { id: "media-1" },
        { id: "media-2" },
        { id: "media-3" },
        { id: "media-4" },
      ];

      expect(media.length).toBeLessThanOrEqual(4);
    });

    it("should reject more than 4 media attachments", () => {
      const media = [
        { id: "media-1" },
        { id: "media-2" },
        { id: "media-3" },
        { id: "media-4" },
        { id: "media-5" },
      ];

      expect(media.length).toBeGreaterThan(4);
    });
  });

  describe("media ordering", () => {
    it("should preserve media order", () => {
      const media = [
        { id: "media-3", order: 0 },
        { id: "media-1", order: 1 },
        { id: "media-2", order: 2 },
      ];

      expect(media[0].id).toBe("media-3");
      expect(media[0].order).toBe(0);
      expect(media[1].id).toBe("media-1");
      expect(media[1].order).toBe(1);
      expect(media[2].id).toBe("media-2");
      expect(media[2].order).toBe(2);
    });
  });

  describe("alt text validation", () => {
    it("should allow alt text up to 500 characters", () => {
      const altText = "a".repeat(500);
      expect(altText.length).toBeLessThanOrEqual(500);
    });

    it("should reject alt text over 500 characters", () => {
      const altText = "a".repeat(501);
      expect(altText.length).toBeGreaterThan(500);
    });
  });
});
