/**
 * Media Upload Service Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MediaUploadService } from "../../../src/lib/services/media-upload-service.js";

// Valid CUID-shaped ids (c + 24 lowercase base-36 chars) so the canonical
// casKey builder (anchored allowlist) accepts them. Abstract tokens only.
const TENANT_ID = "ctenant0000000000000000aa";
const USER_ID = "cuser000000000000000000aa";

describe("MediaUploadService", () => {
  let mockEnv: any;
  let service: MediaUploadService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      ENVIRONMENT: "dev",
      MEDIA_BUCKET_R2: {
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(),
        delete: vi.fn(),
      },
      MEDIA_RECONCILIATION_QUEUE: {
        send: vi.fn().mockResolvedValue(undefined),
      },
    };
    service = new MediaUploadService(mockEnv);
  });

  describe("uploadSingle", () => {
    it("should upload file to R2 under the canonical CAS key and queue reconciliation", async () => {
      const mockFile = new File(["test content"], "test.jpg", {
        type: "image/jpeg",
      });

      const result = await service.uploadSingle(mockFile, USER_ID, TENANT_ID);

      expect(result.success).toBe(true);
      expect(result.contentHash).toBeDefined();
      expect(result.url).toContain("/api/media/");
      expect(result.status).toBe("uploaded");
      expect(mockEnv.MEDIA_BUCKET_R2.put).toHaveBeenCalled();
      expect(mockEnv.MEDIA_RECONCILIATION_QUEUE.send).toHaveBeenCalled();

      // T9: bytes are written under cas/{tenantId}/{hash}, NOT the old
      // originals/user-{id}/... or media/{hash}.{ext} schemes.
      const writtenKey = mockEnv.MEDIA_BUCKET_R2.put.mock.calls[0][0];
      expect(writtenKey).toBe(`cas/${TENANT_ID}/${result.contentHash}`);
    });

    it("should include metadata in R2 upload", async () => {
      const mockFile = new File(["test content"], "test.jpg", {
        type: "image/jpeg",
      });
      const metadata = { width: 1920, height: 1080 };

      await service.uploadSingle(mockFile, USER_ID, TENANT_ID, metadata);

      const putCall = mockEnv.MEDIA_BUCKET_R2.put.mock.calls[0];
      expect(putCall[2].customMetadata.width).toBe("1920");
      expect(putCall[2].customMetadata.height).toBe("1080");
    });

    it("should throw error if R2 upload fails", async () => {
      mockEnv.MEDIA_BUCKET_R2.put.mockRejectedValue(new Error("R2 error"));
      const mockFile = new File(["test content"], "test.jpg", {
        type: "image/jpeg",
      });

      await expect(
        service.uploadSingle(mockFile, USER_ID, TENANT_ID),
      ).rejects.toThrow();
    });

    it("should reject a malformed tenantId rather than build an unsafe key", async () => {
      const mockFile = new File(["test content"], "test.jpg", {
        type: "image/jpeg",
      });

      await expect(
        service.uploadSingle(mockFile, USER_ID, "../evil"),
      ).rejects.toThrow(/Invalid CAS key inputs/);
    });
  });

  describe("uploadBatch", () => {
    it("should upload multiple files in parallel under canonical CAS keys", async () => {
      const mockFiles = [
        new File(["content1"], "test1.jpg", { type: "image/jpeg" }),
        new File(["content2"], "test2.jpg", { type: "image/jpeg" }),
      ];

      const results = await service.uploadBatch(mockFiles, USER_ID, TENANT_ID);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(mockEnv.MEDIA_BUCKET_R2.put).toHaveBeenCalledTimes(2);
      expect(mockEnv.MEDIA_RECONCILIATION_QUEUE.send).toHaveBeenCalledTimes(1);

      for (const call of mockEnv.MEDIA_BUCKET_R2.put.mock.calls) {
        expect(call[0]).toMatch(
          new RegExp(`^cas/${TENANT_ID}/[0-9a-f]{64}$`),
        );
      }
    });

    it("should handle partial failures gracefully", async () => {
      mockEnv.MEDIA_BUCKET_R2.put
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("R2 error"));

      const mockFiles = [
        new File(["content1"], "test1.jpg", { type: "image/jpeg" }),
        new File(["content2"], "test2.jpg", { type: "image/jpeg" }),
      ];

      const results = await service.uploadBatch(mockFiles, USER_ID, TENANT_ID);

      expect(results).toHaveLength(2);
      // Concurrent execution means put call order != file index order, so check counts
      expect(results.filter((r) => r.success)).toHaveLength(1);
      expect(results.filter((r) => !r.success)).toHaveLength(1);
    });
  });
});
