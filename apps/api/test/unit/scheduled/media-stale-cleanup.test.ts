/**
 * Unit Tests: Media Stale Cleanup
 *
 * Tests for the scheduled cleanup job that removes stale PENDING/FAILED media records.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupStaleMedia } from "../../../src/lib/scheduled/media-stale-cleanup.js";
import {
  makeFakeMediaDb,
  mediaRow,
  type FakeMediaRow,
} from "../helpers/fake-media-db.js";

// Mock database connection manager
const mockFindMany = vi.fn();
const mockDeleteMany = vi.fn();
const mockClient = {
  mediaFile: {
    findMany: mockFindMany,
    deleteMany: mockDeleteMany,
  },
};

vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    acquireClient: vi.fn(() => ({
      client: mockClient,
    })),
  },
}));

const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();

describe("cleanupStaleMedia", () => {
  let mockEnv: any;
  let mockR2Delete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockR2Delete = vi.fn().mockResolvedValue(undefined);

    mockEnv = {
      ENVIRONMENT: "dev",
      MEDIA_BUCKET_R2: {
        delete: mockR2Delete,
      },
    };
  });

  it("should return zero counts when no stale records found", async () => {
    mockFindMany.mockResolvedValue([]);

    const result = await cleanupStaleMedia(mockEnv);

    expect(result).toEqual({ deleted: 0, errors: 0 });
        expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockR2Delete).not.toHaveBeenCalled();
  });

  it("should delete stale records from both R2 and database", async () => {
    const staleRecords = [
      {
        id: "media-1",
        contentHash: "hash1",
        originalKey: "uploads/media-1.jpg",
        uploadStatus: "PENDING",
        createdAt: new Date(Date.now() - 7200000),
      },
      {
        id: "media-2",
        contentHash: "hash2",
        originalKey: "uploads/media-2.png",
        uploadStatus: "FAILED",
        createdAt: new Date(Date.now() - 7200000),
      },
    ];
    mockFindMany.mockResolvedValue(staleRecords);
    mockDeleteMany.mockResolvedValue({ count: 2 });

    const result = await cleanupStaleMedia(mockEnv);

    expect(result).toEqual({ deleted: 2, errors: 0 });
    // Should delete from R2
    expect(mockR2Delete).toHaveBeenCalledTimes(2);
    expect(mockR2Delete).toHaveBeenCalledWith("uploads/media-1.jpg");
    expect(mockR2Delete).toHaveBeenCalledWith("uploads/media-2.png");
    // Should delete from database, RE-ASSERTING the reap scope (AR4: not
    // id-only — a row that acquired a moderation job between the findMany and
    // the delete must be re-excluded atomically at delete time).
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["media-1", "media-2"] },
        uploadStatus: { in: ["PENDING", "FAILED"] },
        createdAt: { lt: expect.any(Date) },
        moderationJobs: { none: {} },
      },
    });
  });

  it("should query for jobless PENDING and FAILED records older than the reap window (AR4 scope)", async () => {
    mockFindMany.mockResolvedValue([]);

    await cleanupStaleMedia(mockEnv);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        uploadStatus: { in: ["PENDING", "FAILED"] },
        createdAt: { lt: expect.any(Date) },
        // AR4: never a row the moderation pipeline has engaged with.
        moderationJobs: { none: {} },
      },
      take: 100,
      select: {
        id: true,
        contentHash: true,
        originalKey: true,
        uploadStatus: true,
        createdAt: true,
      },
    });

    // Verify the cutoff is approximately the 24h reap window (≫ moderation
    // SLA — the pre-AR4 1h window reaped queue-delayed uploads).
    const calledDate = mockFindMany.mock.calls[0][0].where.createdAt.lt;
    const windowAgo = Date.now() - 24 * 3600000;
    expect(calledDate.getTime()).toBeGreaterThan(windowAgo - 5000);
    expect(calledDate.getTime()).toBeLessThan(windowAgo + 5000);
  });

  it("should handle partial R2 deletion failures gracefully", async () => {
    const staleRecords = [
      {
        id: "media-1",
        contentHash: "hash1",
        originalKey: "uploads/media-1.jpg",
        uploadStatus: "PENDING",
        createdAt: new Date(Date.now() - 7200000),
      },
      {
        id: "media-2",
        contentHash: "hash2",
        originalKey: "uploads/media-2.png",
        uploadStatus: "FAILED",
        createdAt: new Date(Date.now() - 7200000),
      },
    ];
    mockFindMany.mockResolvedValue(staleRecords);
    mockDeleteMany.mockResolvedValue({ count: 2 });

    // First R2 delete succeeds, second fails
    mockR2Delete
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("R2 error"));

    const result = await cleanupStaleMedia(mockEnv);

    // Should still delete DB records even if R2 fails
    expect(result).toEqual({ deleted: 2, errors: 1 });
    expect(mockDeleteMany).toHaveBeenCalled();
      });

  it("should limit batch size to 100 records", async () => {
    mockFindMany.mockResolvedValue([]);

    await cleanupStaleMedia(mockEnv);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
      }),
    );
  });

  it("should handle database query failure", async () => {
    mockFindMany.mockRejectedValue(new Error("Database connection failed"));

    const result = await cleanupStaleMedia(mockEnv);

    expect(result).toEqual({ deleted: 0, errors: 1 });
      });

  it("should handle database delete failure", async () => {
    const staleRecords = [
      {
        id: "media-1",
        contentHash: "hash1",
        originalKey: "uploads/media-1.jpg",
        uploadStatus: "PENDING",
        createdAt: new Date(Date.now() - 7200000),
      },
    ];
    mockFindMany.mockResolvedValue(staleRecords);
    mockDeleteMany.mockRejectedValue(new Error("Delete failed"));

    const result = await cleanupStaleMedia(mockEnv);

    expect(result).toEqual({ deleted: 0, errors: 1 });
      });

  it("should log start and completion of cleanup", async () => {
    const staleRecords = [
      {
        id: "media-1",
        contentHash: "hash1",
        originalKey: "uploads/media-1.jpg",
        uploadStatus: "PENDING",
        createdAt: new Date(Date.now() - 7200000),
      },
    ];
    mockFindMany.mockResolvedValue(staleRecords);
    mockDeleteMany.mockResolvedValue({ count: 1 });

    await cleanupStaleMedia(mockEnv);

              });

  // -------------------------------------------------------------------------
  // AR4 — reproduce-then-fix: the reaper must NEVER delete a row that is still
  // inside the moderation pipeline. These tests are BEHAVIORAL: the mock
  // Prisma client actually evaluates the reaper's where clauses against seeded
  // rows, so the assertion is on which rows SURVIVE, not on query shape.
  //
  // Bug being reproduced (architecture-review/02-architecture-traps.md §6.1):
  // async video uploads are born `uploadStatus: "PENDING"` and nothing
  // advanced it, so this reaper hard-deleted in-flight video rows (and their
  // S3 objects, cascading MediaModerationJob) at T+1h — approved videos then
  // 404'd an hour after upload.
  // -------------------------------------------------------------------------
  describe("AR4: never reaps rows still inside the moderation pipeline", () => {
    const HOUR = 3600000;

    /** Wire the shared mocks to a behavioral in-memory MediaFile table. */
    function seedBehavioralDb(rows: FakeMediaRow[]) {
      const fake = makeFakeMediaDb(rows);
      mockFindMany.mockImplementation(fake.mediaFile.findMany);
      mockDeleteMany.mockImplementation(fake.mediaFile.deleteMany);
      return rows;
    }

    it("a PENDING video row with an OPEN moderation job survives the reaper at T+1h (and beyond)", async () => {
      const rows = seedBehavioralDb([
        // In-flight: moderation started (open VISUAL job), row older than the
        // legacy 1h cutoff. Pre-fix this row was deleted; it MUST survive.
        mediaRow({
          id: "in-flight-open-job",
          uploadStatus: "PENDING",
          createdAt: new Date(Date.now() - 2 * HOUR),
          originalKey: "processing/tenant-1/upload-1",
          moderationJobs: [{ decision: null }],
        }),
        // In-flight even PAST the widened window: the open-job guard alone
        // must protect it, independent of any age window.
        mediaRow({
          id: "in-flight-open-job-old",
          uploadStatus: "PENDING",
          createdAt: new Date(Date.now() - 48 * HOUR),
          originalKey: "processing/tenant-1/upload-2",
          moderationJobs: [{ decision: null }],
        }),
      ]);

      const result = await cleanupStaleMedia(mockEnv);

      expect(rows.map((r) => r.id)).toEqual([
        "in-flight-open-job",
        "in-flight-open-job-old",
      ]);
      expect(result.deleted).toBe(0);
      expect(mockR2Delete).not.toHaveBeenCalled();
    });

    it("a row whose moderation jobs have ALL resolved is still protected (completion may not have advanced uploadStatus yet)", async () => {
      const rows = seedBehavioralDb([
        mediaRow({
          id: "resolved-jobs-not-yet-complete",
          uploadStatus: "PENDING",
          createdAt: new Date(Date.now() - 48 * HOUR),
          originalKey: "cas/tenant-1/deadbeef",
          moderationJobs: [{ decision: "approved" }, { decision: "approved" }],
        }),
      ]);

      const result = await cleanupStaleMedia(mockEnv);

      // Deleting this row would destroy an approved video (the exact §6.1
      // failure) AND cascade its moderation-job audit records. Any row the
      // pipeline has engaged with is off-limits to the reaper.
      expect(rows.map((r) => r.id)).toEqual(["resolved-jobs-not-yet-complete"]);
      expect(result.deleted).toBe(0);
    });

    it("a jobless PENDING row younger than the reap window survives (processing may be queue-delayed)", async () => {
      const rows = seedBehavioralDb([
        // 2h old, no moderation job yet: could be a backlogged processing
        // queue. The reap window must be ≫ the moderation SLA, so this row
        // is NOT abandoned yet.
        mediaRow({
          id: "young-jobless",
          uploadStatus: "PENDING",
          createdAt: new Date(Date.now() - 2 * HOUR),
          moderationJobs: [],
        }),
      ]);

      const result = await cleanupStaleMedia(mockEnv);

      expect(rows.map((r) => r.id)).toEqual(["young-jobless"]);
      expect(result.deleted).toBe(0);
    });

    it("still reaps genuinely abandoned uploads (jobless, older than the reap window)", async () => {
      const rows = seedBehavioralDb([
        mediaRow({
          id: "abandoned-pending",
          uploadStatus: "PENDING",
          createdAt: new Date(Date.now() - 25 * HOUR),
          originalKey: "pending/tenant-1/upload-9",
          moderationJobs: [],
        }),
        mediaRow({
          id: "abandoned-failed",
          uploadStatus: "FAILED",
          createdAt: new Date(Date.now() - 25 * HOUR),
          // Async-pending rows are born with a NULL originalKey (the worker
          // fills it post-transcode) — the S3 delete must skip those.
          originalKey: null,
          moderationJobs: [],
        }),
        mediaRow({
          id: "complete-untouched",
          uploadStatus: "COMPLETE",
          createdAt: new Date(Date.now() - 25 * HOUR),
          originalKey: "cas/tenant-1/cafebabe",
          moderationJobs: [{ decision: "approved" }],
        }),
      ]);

      const result = await cleanupStaleMedia(mockEnv);

      expect(rows.map((r) => r.id)).toEqual(["complete-untouched"]);
      expect(result.deleted).toBe(2);
      // S3 cleanup only for the abandoned row that HAS a key — never a
      // delete(null) call.
      expect(mockR2Delete).toHaveBeenCalledTimes(1);
      expect(mockR2Delete).toHaveBeenCalledWith("pending/tenant-1/upload-9");
    });
  });
});
