/**
 * Unit tests for Media Cleanup Handler
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted so variables are available in vi.mock factories (which are hoisted)
const { mockWithQueryTimeoutAndRetry } = vi.hoisted(() => ({
  mockWithQueryTimeoutAndRetry: vi.fn(),
}));

// Mock dependencies before importing

vi.mock("../../src/lib/db-query-helper", () => {
  return {
    withQueryTimeoutAndRetry: mockWithQueryTimeoutAndRetry,
    QueryTimeoutPresets: {
      BACKGROUND: { timeoutMs: 30000 },
    },
  };
});

vi.mock("../../src/lib/database-connection-manager", () => {
  return {
    sharedDatabaseConnectionManager: {},
  };
});

vi.mock("../../src/lib/data-router", () => {
  return {
    DataRouter: class MockDataRouter {},
  };
});

import { MediaCleanupHandler, type Env } from "../../src/lib/media-cleanup-handler.js";

describe("MediaCleanupHandler", () => {
  let handler: MediaCleanupHandler;
  let mockR2Bucket: { delete: ReturnType<typeof vi.fn> };
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();

    mockR2Bucket = {
      delete: vi.fn().mockResolvedValue(undefined),
    };

    env = {
      LOG_LEVEL: "DEBUG",
      NODE_ENV: "test",
      MEDIA_BUCKET_R2: mockR2Bucket as any,
      MEDIA_CLEANUP_GRACE_PERIOD_DAYS: "7",
    };

    handler = new MediaCleanupHandler(env);
  });

  describe("runCleanup()", () => {
    it("processes all three regions", async () => {
      mockWithQueryTimeoutAndRetry.mockResolvedValue([]);

      const result = await handler.runCleanup(env);

      expect(result.processed).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.skipped).toBe(0);
      // Should be called once per region (US, EU, CN)
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(3);
    });

    it("aggregates results across regions", async () => {
      // US region: 2 media files
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([
        { id: "1", contentHash: "h1", originalKey: "orig1", thumbnailKey: "thumb1", optimizedKey: null, deletedAt: new Date() },
        { id: "2", contentHash: "h2", originalKey: "orig2", thumbnailKey: null, optimizedKey: null, deletedAt: new Date() },
      ]);
      // EU region: 1 media file
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([
        { id: "3", contentHash: "h3", originalKey: "orig3", thumbnailKey: null, optimizedKey: "opt3", deletedAt: new Date() },
      ]);
      // CN region: empty
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([]);

      const result = await handler.runCleanup(env);

      expect(result.processed).toBe(3);
      expect(result.deleted).toBe(3);
      expect(result.errors).toBe(0);
    });

    it("handles region cleanup errors gracefully", async () => {
      // US throws
      mockWithQueryTimeoutAndRetry.mockRejectedValueOnce(new Error("DB down"));
      // EU succeeds
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([]);
      // CN succeeds
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([]);

      const result = await handler.runCleanup(env);

      expect(result.errors).toBe(1);
    });
  });

  describe("R2 object deletion", () => {
    it("deletes original, thumbnail, and optimized keys", async () => {
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([
        {
          id: "1",
          contentHash: "h1",
          originalKey: "media/orig.jpg",
          thumbnailKey: "media/thumb.jpg",
          optimizedKey: "media/opt.jpg",
          deletedAt: new Date(),
        },
      ]);
      // Other regions empty
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([]);
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([]);

      const result = await handler.runCleanup(env);

      expect(mockR2Bucket.delete).toHaveBeenCalledTimes(3);
      expect(mockR2Bucket.delete).toHaveBeenCalledWith("media/orig.jpg");
      expect(mockR2Bucket.delete).toHaveBeenCalledWith("media/thumb.jpg");
      expect(mockR2Bucket.delete).toHaveBeenCalledWith("media/opt.jpg");
      expect(result.deleted).toBe(1);
    });

    it("skips thumbnail/optimized when null", async () => {
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([
        {
          id: "1",
          contentHash: "h1",
          originalKey: "media/orig.jpg",
          thumbnailKey: null,
          optimizedKey: null,
          deletedAt: new Date(),
        },
      ]);
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([]);
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([]);

      await handler.runCleanup(env);

      expect(mockR2Bucket.delete).toHaveBeenCalledTimes(1);
      expect(mockR2Bucket.delete).toHaveBeenCalledWith("media/orig.jpg");
    });

    it("ignores 'No such key' errors from R2", async () => {
      mockR2Bucket.delete.mockRejectedValueOnce(new Error("No such key"));

      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([
        {
          id: "1",
          contentHash: "h1",
          originalKey: "media/gone.jpg",
          thumbnailKey: null,
          optimizedKey: null,
          deletedAt: new Date(),
        },
      ]);
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([]);
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([]);

      const result = await handler.runCleanup(env);

      // Should count as skipped (0 objects actually deleted)
      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);
    });

    it("counts errors when R2 delete fails with unexpected error", async () => {
      mockR2Bucket.delete.mockRejectedValueOnce(new Error("S3 internal error"));

      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([
        {
          id: "1",
          contentHash: "h1",
          originalKey: "media/orig.jpg",
          thumbnailKey: null,
          optimizedKey: null,
          deletedAt: new Date(),
        },
      ]);
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([]);
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce([]);

      const result = await handler.runCleanup(env);

      expect(result.errors).toBe(1);
    });
  });

  describe("R2 bucket not configured", () => {
    it("skips cleanup when no R2 bucket is available", async () => {
      const envNoBucket: Env = {
        LOG_LEVEL: "DEBUG",
        NODE_ENV: "test",
      };
      const handlerNoBucket = new MediaCleanupHandler(envNoBucket);

      const result = await handlerNoBucket.runCleanup(envNoBucket);

      expect(result.processed).toBe(0);
      expect(result.deleted).toBe(0);
      expect(mockWithQueryTimeoutAndRetry).not.toHaveBeenCalled();
    });
  });

  describe("grace period configuration", () => {
    it("uses default 7-day grace period", () => {
      const envDefault: Env = { LOG_LEVEL: "DEBUG", NODE_ENV: "test" };
      // Constructor should not throw
      const h = new MediaCleanupHandler(envDefault);
      expect(h).toBeDefined();
    });

    it("uses custom grace period from env", () => {
      const envCustom: Env = {
        LOG_LEVEL: "DEBUG",
        NODE_ENV: "test",
        MEDIA_CLEANUP_GRACE_PERIOD_DAYS: "30",
      };
      const h = new MediaCleanupHandler(envCustom);
      expect(h).toBeDefined();
    });
  });
});
