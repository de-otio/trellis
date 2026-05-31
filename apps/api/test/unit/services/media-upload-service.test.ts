/**
 * Media Upload Service Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MediaUploadService } from "../../../src/lib/services/media-upload-service.js";

describe("MediaUploadService", () => {
  let mockEnv: any;
  let service: MediaUploadService;

  beforeEach(() => {
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
    it("should upload file to R2 and queue reconciliation", async () => {
      const mockFile = new File(["test content"], "test.jpg", {
        type: "image/jpeg",
      });
      const userId = "user123";

      const result = await service.uploadSingle(mockFile, userId);

      expect(result.success).toBe(true);
      expect(result.contentHash).toBeDefined();
      expect(result.url).toContain("/api/media/");
      expect(result.status).toBe("uploaded");
      expect(mockEnv.MEDIA_BUCKET_R2.put).toHaveBeenCalled();
      expect(mockEnv.MEDIA_RECONCILIATION_QUEUE.send).toHaveBeenCalled();
    });

    it("should include metadata in R2 upload", async () => {
      const mockFile = new File(["test content"], "test.jpg", {
        type: "image/jpeg",
      });
      const userId = "user123";
      const metadata = { width: 1920, height: 1080 };

      await service.uploadSingle(mockFile, userId, metadata);

      const putCall = mockEnv.MEDIA_BUCKET_R2.put.mock.calls[0];
      expect(putCall[2].customMetadata.width).toBe("1920");
      expect(putCall[2].customMetadata.height).toBe("1080");
    });

    it("should throw error if R2 upload fails", async () => {
      mockEnv.MEDIA_BUCKET_R2.put.mockRejectedValue(new Error("R2 error"));
      const mockFile = new File(["test content"], "test.jpg", {
        type: "image/jpeg",
      });

      await expect(service.uploadSingle(mockFile, "user123")).rejects.toThrow();
    });
  });

  describe("uploadBatch", () => {
    it("should upload multiple files in parallel", async () => {
      const mockFiles = [
        new File(["content1"], "test1.jpg", { type: "image/jpeg" }),
        new File(["content2"], "test2.jpg", { type: "image/jpeg" }),
      ];
      const userId = "user123";

      const results = await service.uploadBatch(mockFiles, userId);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(mockEnv.MEDIA_BUCKET_R2.put).toHaveBeenCalledTimes(2);
      expect(mockEnv.MEDIA_RECONCILIATION_QUEUE.send).toHaveBeenCalledTimes(1);
    });

    it("should handle partial failures gracefully", async () => {
      mockEnv.MEDIA_BUCKET_R2.put
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("R2 error"));

      const mockFiles = [
        new File(["content1"], "test1.jpg", { type: "image/jpeg" }),
        new File(["content2"], "test2.jpg", { type: "image/jpeg" }),
      ];

      const results = await service.uploadBatch(mockFiles, "user123");

      expect(results).toHaveLength(2);
      // Concurrent execution means put call order != file index order, so check counts
      expect(results.filter((r) => r.success)).toHaveLength(1);
      expect(results.filter((r) => !r.success)).toHaveLength(1);
    });
  });
});
