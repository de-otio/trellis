/**
 * Unit Tests: Media Reconciliation Service
 *
 * Tests for the MediaReconciliationService that processes queued media uploads
 * and creates database records with deduplication and R2 metadata updates.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MediaReconciliationService } from "../../../src/lib/services/media-reconciliation-service.js";
import type { MediaReconciliationMessage } from "../../../src/lib/types/media-reconciliation.js";

// Mock database connection manager
const mockAcquireClient = vi.fn();
vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    acquireClient: (...args: any[]) => mockAcquireClient(...args),
  },
}));

describe("MediaReconciliationService", () => {
  let service: MediaReconciliationService;
  let mockEnv: any;
  let mockDb: any;
  let mockR2Get: ReturnType<typeof vi.fn>;
  let mockR2Put: ReturnType<typeof vi.fn>;

  const createMessage = (
    overrides: Partial<MediaReconciliationMessage> = {},
  ): MediaReconciliationMessage => ({
    type: "SINGLE_UPLOAD",
    batchId: "batch-001",
    timestamp: Date.now(),
    uploads: [
      {
        contentHash: "hash-abc",
        originalKey: "uploads/user-1/hash-abc.jpg",
        mimeType: "image/jpeg",
        size: 1024,
        uploadedBy: "user-1",
        uploadedAt: new Date().toISOString(),
        width: 800,
        height: 600,
      },
    ],
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockR2Get = vi.fn();
    mockR2Put = vi.fn().mockResolvedValue(undefined);

    mockEnv = {
      ENVIRONMENT: "dev",
      MEDIA_BUCKET_R2: {
        get: mockR2Get,
        put: mockR2Put,
      },
    };

    mockDb = {
      mediaFile: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    mockAcquireClient.mockReturnValue({ client: mockDb });

    service = new MediaReconciliationService(mockEnv);
  });

  describe("reconcileBatch", () => {
    it("should handle empty uploads gracefully", async () => {
      const message = createMessage({ uploads: [] });

      await service.reconcileBatch([message]);

      // Should not attempt database operations
      expect(mockAcquireClient).not.toHaveBeenCalled();
    });

    it("should deduplicate uploads already in the database", async () => {
      const message = createMessage();

      // Simulate existing record for the upload hash
      mockDb.mediaFile.findMany.mockResolvedValue([
        { id: "existing-media-1", contentHash: "hash-abc" },
      ]);

      // Mock R2 get for updateR2MetadataForExisting
      mockR2Get.mockResolvedValue({
        body: "file-content",
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: { reconciled: "false" },
      });

      await service.reconcileBatch([message]);

      // Should check for existing records
      expect(mockDb.mediaFile.findMany).toHaveBeenCalledWith({
        where: { contentHash: { in: ["hash-abc"] } },
        select: { id: true, contentHash: true },
      });

      // Should NOT create new records (all deduplicated)
      expect(mockDb.$transaction).not.toHaveBeenCalled();

      // Should update R2 metadata for existing records
      expect(mockR2Put).toHaveBeenCalled();
    });

    it("should create database records for new uploads", async () => {
      const message = createMessage();

      // No existing records
      mockDb.mediaFile.findMany.mockResolvedValue([]);

      // Mock transaction to return created records
      const createdRecords = [
        { id: "new-media-1", contentHash: "hash-abc" },
      ];
      mockDb.$transaction.mockResolvedValue(createdRecords);

      // Mock R2 for metadata update
      mockR2Get.mockResolvedValue({
        body: "file-content",
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: {},
      });

      await service.reconcileBatch([message]);

      // Should create records via transaction
      expect(mockDb.$transaction).toHaveBeenCalled();
      const transactionArgs = mockDb.$transaction.mock.calls[0];
      // Transaction should be called with an array of create operations and timeout option
      expect(transactionArgs[1]).toEqual({ timeout: 30000 });
    });

    it("should flatten uploads from multiple messages", async () => {
      const msg1 = createMessage({
        batchId: "batch-001",
        uploads: [
          {
            contentHash: "hash-1",
            originalKey: "uploads/user-1/hash-1.jpg",
            mimeType: "image/jpeg",
            size: 1024,
            uploadedBy: "user-1",
            uploadedAt: new Date().toISOString(),
          },
        ],
      });
      const msg2 = createMessage({
        batchId: "batch-002",
        uploads: [
          {
            contentHash: "hash-2",
            originalKey: "uploads/user-1/hash-2.jpg",
            mimeType: "image/png",
            size: 2048,
            uploadedBy: "user-1",
            uploadedAt: new Date().toISOString(),
          },
        ],
      });

      mockDb.mediaFile.findMany.mockResolvedValue([]);
      mockDb.$transaction.mockResolvedValue([
        { id: "new-1", contentHash: "hash-1" },
        { id: "new-2", contentHash: "hash-2" },
      ]);
      mockR2Get.mockResolvedValue({
        body: "file-content",
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: {},
      });

      await service.reconcileBatch([msg1, msg2]);

      // Should check both hashes
      expect(mockDb.mediaFile.findMany).toHaveBeenCalledWith({
        where: { contentHash: { in: ["hash-1", "hash-2"] } },
        select: { id: true, contentHash: true },
      });
    });

    it("should handle R2 object not found during metadata update", async () => {
      const message = createMessage();

      mockDb.mediaFile.findMany.mockResolvedValue([]);
      mockDb.$transaction.mockResolvedValue([
        { id: "new-media-1", contentHash: "hash-abc" },
      ]);

      // R2 get returns null (object not found)
      mockR2Get.mockResolvedValue(null);

      // Should not throw
      await service.reconcileBatch([message]);

      // Should not attempt to put since object was not found
      expect(mockR2Put).not.toHaveBeenCalled();
    });

    it("should handle R2 metadata update failures gracefully", async () => {
      const message = createMessage();

      mockDb.mediaFile.findMany.mockResolvedValue([]);
      mockDb.$transaction.mockResolvedValue([
        { id: "new-media-1", contentHash: "hash-abc" },
      ]);

      // R2 get succeeds but put fails
      mockR2Get.mockResolvedValue({
        body: "file-content",
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: {},
      });
      mockR2Put.mockRejectedValue(new Error("R2 write error"));

      // Should not throw - R2 metadata updates are best-effort
      await service.reconcileBatch([message]);
    });

    it("should rethrow unique constraint violation (P2002)", async () => {
      const message = createMessage();

      mockDb.mediaFile.findMany.mockResolvedValue([]);

      const prismaError = new Error("Unique constraint failed");
      (prismaError as any).code = "P2002";
      mockDb.$transaction.mockRejectedValue(prismaError);

      await expect(service.reconcileBatch([message])).rejects.toThrow(
        "Unique constraint failed",
      );
    });

    it("should rethrow general database errors", async () => {
      const message = createMessage();

      mockDb.mediaFile.findMany.mockResolvedValue([]);
      mockDb.$transaction.mockRejectedValue(
        new Error("Connection refused"),
      );

      await expect(service.reconcileBatch([message])).rejects.toThrow(
        "Connection refused",
      );
    });

    it("should skip R2 update for existing records already reconciled", async () => {
      const message = createMessage();

      // All uploads already exist
      mockDb.mediaFile.findMany.mockResolvedValue([
        { id: "existing-1", contentHash: "hash-abc" },
      ]);

      // R2 object already reconciled
      mockR2Get.mockResolvedValue({
        body: "file-content",
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: { reconciled: "true" },
      });

      await service.reconcileBatch([message]);

      // Should not re-upload since already reconciled
      expect(mockR2Put).not.toHaveBeenCalled();
    });

    it("should update R2 metadata with correct fields for new records", async () => {
      const message = createMessage();

      mockDb.mediaFile.findMany.mockResolvedValue([]);
      mockDb.$transaction.mockResolvedValue([
        { id: "new-media-1", contentHash: "hash-abc" },
      ]);

      mockR2Get.mockResolvedValue({
        body: "file-content",
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: { uploadedBy: "user-1" },
      });

      await service.reconcileBatch([message]);

      expect(mockR2Put).toHaveBeenCalledWith(
        "uploads/user-1/hash-abc.jpg",
        "file-content",
        expect.objectContaining({
          httpMetadata: { contentType: "image/jpeg" },
          customMetadata: expect.objectContaining({
            uploadedBy: "user-1",
            mediaId: "new-media-1",
            reconciled: "true",
            needsReconciliation: "false",
          }),
        }),
      );
    });

    it("should handle mixed new and existing uploads", async () => {
      const message = createMessage({
        uploads: [
          {
            contentHash: "hash-existing",
            originalKey: "uploads/user-1/hash-existing.jpg",
            mimeType: "image/jpeg",
            size: 1024,
            uploadedBy: "user-1",
            uploadedAt: new Date().toISOString(),
          },
          {
            contentHash: "hash-new",
            originalKey: "uploads/user-1/hash-new.jpg",
            mimeType: "image/png",
            size: 2048,
            uploadedBy: "user-1",
            uploadedAt: new Date().toISOString(),
          },
        ],
      });

      // One existing, one new
      mockDb.mediaFile.findMany.mockResolvedValue([
        { id: "existing-1", contentHash: "hash-existing" },
      ]);

      mockDb.$transaction.mockResolvedValue([
        { id: "new-1", contentHash: "hash-new" },
      ]);

      mockR2Get.mockResolvedValue({
        body: "file-content",
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: {},
      });

      await service.reconcileBatch([message]);

      // Transaction should only create the new upload
      expect(mockDb.$transaction).toHaveBeenCalled();
    });
  });
});
