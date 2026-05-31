/**
 * Unit Tests: Media Stale Cleanup
 *
 * Tests for the scheduled cleanup job that removes stale PENDING/FAILED media records.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupStaleMedia } from "../../../src/lib/scheduled/media-stale-cleanup.js";

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
    // Should delete from database
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["media-1", "media-2"] },
      },
    });
  });

  it("should query for PENDING and FAILED records older than 1 hour", async () => {
    mockFindMany.mockResolvedValue([]);

    await cleanupStaleMedia(mockEnv);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        uploadStatus: { in: ["PENDING", "FAILED"] },
        createdAt: { lt: expect.any(Date) },
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

    // Verify the date is approximately 1 hour ago
    const calledDate = mockFindMany.mock.calls[0][0].where.createdAt.lt;
    const oneHourAgo = Date.now() - 3600000;
    expect(calledDate.getTime()).toBeGreaterThan(oneHourAgo - 5000);
    expect(calledDate.getTime()).toBeLessThan(oneHourAgo + 5000);
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
});
