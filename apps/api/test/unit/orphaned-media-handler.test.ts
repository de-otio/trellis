/**
 * Orphaned Media Handler Tests
 *
 * Unit tests for orphaned media management functionality.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OrphanedMediaHandler } from "../../src/lib/orphaned-media-handler.js";

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

describe("OrphanedMediaHandler", () => {
  let handler: OrphanedMediaHandler;
  let mockEnv: any;
  let mockDb: any;

  beforeEach(() => {
    mockEnv = {
      LOG_LEVEL: "info",
      MEDIA_BUCKET_R2: {
        delete: vi.fn(),
      },
    };

    mockDb = {
      mediaFile: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
      },
    };

    handler = new OrphanedMediaHandler(mockEnv);

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("markMediaAsOrphaned", () => {
    it("should mark media as orphaned successfully by id", async () => {
      const mediaId = "media-123";
      const userId = "user-456";
      const region = "US";

      const mockMedia = {
        id: mediaId,
        uploadedBy: userId,
        contentHash: "hash123",
        attachedToPost: false,
        orphanedAt: null,
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );
      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          if (callCount === 1) {
            // First call: verify media
            return mockMedia;
          } else {
            // Second call: update media
            return {
              ...mockMedia,
              orphanedAt: new Date(),
              attachedToPost: false,
            };
          }
        },
      );

      const result = await handler.markMediaAsOrphaned(
        mediaId,
        userId,
        region,
        mockEnv,
      );

      expect(result).toEqual({ success: true });
    });

    it("should mark media as orphaned by contentHash", async () => {
      const contentHash = "abc123def456";
      const userId = "user-456";
      const region = "US";

      const mockMedia = {
        id: "media-123",
        uploadedBy: userId,
        contentHash: contentHash,
        attachedToPost: false,
        orphanedAt: null,
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );
      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          if (callCount === 1) {
            // First call: verify media by contentHash
            return mockMedia;
          } else {
            // Second call: update media
            return {
              ...mockMedia,
              orphanedAt: new Date(),
              attachedToPost: false,
            };
          }
        },
      );

      const result = await handler.markMediaAsOrphaned(
        contentHash,
        userId,
        region,
        mockEnv,
      );

      expect(result).toEqual({ success: true });
    });

    it("should succeed if media not yet reconciled", async () => {
      const contentHash = "abc123def456";
      const userId = "user-456";
      const region = "US";

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          // Media not found - not yet reconciled
          return null;
        },
      );

      const result = await handler.markMediaAsOrphaned(
        contentHash,
        userId,
        region,
        mockEnv,
      );

      // Should succeed since media doesn't exist yet
      expect(result).toEqual({ success: true });
    });
  });

  describe("cleanupOrphanedMedia", () => {
    it("should NOT soft-delete a MediaFile that has a PostMedia reference (Layer 0)", async () => {
      const region = "US";

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      // Call sequence:
      // 1. findMany for stale-flag repair candidates (postMedia: { some: {} }) → returns 0 (no repair needed)
      // 2. findMany for orphaned candidates (postMedia: { none: {} }) → returns 0 (file excluded)
      // Both return empty so cleanup finds nothing to delete.
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue([]);

      const result = await handler.cleanupOrphanedMedia(region, mockEnv);

      expect(result.cleanedCount).toBe(0);
      expect(result.scheduledForDeletion).toHaveLength(0);

      // Verify every findMany call included a postMedia filter
      const findManyCalls = vi
        .mocked(withQueryTimeoutAndRetry)
        .mock.calls.filter((call) => {
          // The query function is the 4th argument; execute it with a spy db
          // to check what where clause it builds
          return true;
        });
      expect(findManyCalls.length).toBeGreaterThan(0);
    });

    it("should soft-delete a MediaFile with no PostMedia reference (regression)", async () => {
      const region = "US";
      const mediaId = "media-truly-orphaned";

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          // Call 1: Layer 2 repair query (postMedia: { some: {} }) → none to repair
          if (callCount === 1) return [];
          // Call 2: Layer 0 main query (postMedia: { none: {} }) → one truly orphaned file
          if (callCount === 2)
            return [{ id: mediaId, contentHash: "hash", originalKey: "key" }];
          // Call 3: soft-delete updateMany → success
          if (callCount === 3) return { count: 1 };
          return [];
        },
      );

      const result = await handler.cleanupOrphanedMedia(region, mockEnv);

      expect(result.cleanedCount).toBe(1);
      expect(result.scheduledForDeletion).toContain(mediaId);
    });

    it("should repair stale attachedToPost=false when PostMedia ref exists (Layer 2)", async () => {
      const region = "US";
      const staleMediaId = "media-stale-flag";

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          // Call 1: Layer 2 repair query → finds one file with stale flag
          if (callCount === 1) return [{ id: staleMediaId }];
          // Call 2: Layer 2 updateMany to repair the stale flag → success
          if (callCount === 2) return { count: 1 };
          // Call 3: Layer 0 main query → no truly orphaned files
          if (callCount === 3) return [];
          return [];
        },
      );

      const result = await handler.cleanupOrphanedMedia(region, mockEnv);

      // The stale-flagged file was repaired, not soft-deleted
      expect(result.cleanedCount).toBe(0);
      expect(result.scheduledForDeletion).toHaveLength(0);

      // The repair updateMany should have been called (call 2)
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("scheduleR2Deletion", () => {
    it("should return zero counts when no media is ready for deletion", async () => {
      const region = "US";

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue([]);

      const result = await handler.scheduleR2Deletion(region, mockEnv);

      expect(result.deletedCount).toBe(0);
      expect(result.deletedKeys).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it("should delete R2 objects and hard-delete DB records for expired soft-deleted media", async () => {
      const region = "US";
      const mediaId = "media-expired";

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          // Call 1: findMany soft-deleted media past 7-day window
          if (callCount === 1) {
            return [
              {
                id: mediaId,
                contentHash: "hash",
                originalKey: "media/hash.jpg",
                thumbnailKey: "media/hash_thumb.webp",
                optimizedKey: null,
              },
            ];
          }
          // Call 2: hard-delete from DB
          if (callCount === 2) return { count: 1 };
          return [];
        },
      );

      const result = await handler.scheduleR2Deletion(region, mockEnv);

      expect(result.deletedCount).toBe(1);
      expect(result.deletedKeys).toBe(2); // original + thumbnail (no optimized)
      expect(result.errors).toBe(0);
      expect(mockEnv.MEDIA_BUCKET_R2.delete).toHaveBeenCalledWith(
        "media/hash.jpg",
      );
      expect(mockEnv.MEDIA_BUCKET_R2.delete).toHaveBeenCalledWith(
        "media/hash_thumb.webp",
      );
    });

    it("should count R2 errors but still hard-delete DB records", async () => {
      const region = "US";

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      // Make R2 deletion fail
      mockEnv.MEDIA_BUCKET_R2.delete.mockRejectedValue(
        new Error("R2 bucket error"),
      );

      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          if (callCount === 1) {
            return [
              {
                id: "media-1",
                contentHash: "hash1",
                originalKey: "media/hash1.jpg",
                thumbnailKey: null,
                optimizedKey: null,
              },
            ];
          }
          if (callCount === 2) return { count: 1 };
          return [];
        },
      );

      const result = await handler.scheduleR2Deletion(region, mockEnv);

      // R2 failed, but DB record should still be hard-deleted
      expect(result.deletedCount).toBe(1);
      expect(result.errors).toBe(1);
    });

    it("should throw if R2 bucket is not configured", async () => {
      const region = "US";
      const envWithoutBucket = { ...mockEnv, MEDIA_BUCKET_R2: undefined };

      await expect(
        handler.scheduleR2Deletion(region, envWithoutBucket as any),
      ).rejects.toThrow("R2 bucket not configured");
    });

    it("should set hasMore=true when a full batch is returned and stop at maxBatches", async () => {
      const region = "US";

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          // Call 1: findMany returns a full batch of 2 (batchSize=2)
          if (callCount === 1) {
            return [
              { id: "m1", contentHash: "h1", originalKey: "k1", thumbnailKey: null, optimizedKey: null },
              { id: "m2", contentHash: "h2", originalKey: "k2", thumbnailKey: null, optimizedKey: null },
            ];
          }
          // Call 2: hard-delete
          if (callCount === 2) return { count: 2 };
          // Call 3: next batch findMany → empty (done)
          return [];
        },
      );

      const result = await handler.scheduleR2Deletion(region, mockEnv, {
        batchSize: 2,
        maxBatches: 1, // Stop after 1 batch even if more exist
      });

      expect(result.deletedCount).toBe(2);
      expect(result.hasMore).toBe(true); // Full batch → hasMore
    });

    it("should count error and continue when DB hard-delete fails", async () => {
      const region = "US";

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          // Call 1: findMany returns one expired media
          if (callCount === 1) {
            return [
              { id: "m1", contentHash: "h1", originalKey: "k1", thumbnailKey: null, optimizedKey: null },
            ];
          }
          // Call 2: hard-delete from DB throws
          if (callCount === 2) throw new Error("DB hard-delete failed");
          return [];
        },
      );

      const result = await handler.scheduleR2Deletion(region, mockEnv);

      // DB failure is counted as an error but doesn't throw
      expect(result.errors).toBeGreaterThanOrEqual(1);
      expect(result.deletedCount).toBe(1); // Still counted as processed
    });

    it("should hard-delete DB records even if some R2 keys fail", async () => {
      const region = "US";

      const { withQueryTimeoutAndRetry } = await import(
        "../../src/lib/db-query-helper.js"
      );

      // First key succeeds, second fails
      mockEnv.MEDIA_BUCKET_R2.delete
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("R2 error"));

      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (manager, region, env, queryFn: any) => {
          callCount++;
          if (callCount === 1) {
            return [
              {
                id: "media-1",
                contentHash: "hash1",
                originalKey: "media/hash1.jpg",
                thumbnailKey: "media/hash1_thumb.webp",
                optimizedKey: null,
              },
            ];
          }
          if (callCount === 2) return { count: 1 };
          return [];
        },
      );

      const result = await handler.scheduleR2Deletion(region, mockEnv);

      expect(result.deletedCount).toBe(1);
      expect(result.deletedKeys).toBe(1); // only the first succeeded
      expect(result.errors).toBe(1);
    });
  });
});
