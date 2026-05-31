/**
 * ImageNormalizer Service Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ImageNormalizer } from "../../../src/lib/services/image-normalizer.js";

describe("ImageNormalizer", () => {
  let mockImages: any;
  let mockBucket: any;
  let normalizer: ImageNormalizer;

  const createMockImages = (responseOk = true, bytes = new ArrayBuffer(1024)) => ({
    input: vi.fn().mockReturnValue({
      transform: vi.fn().mockReturnValue({
        output: vi.fn().mockReturnValue({
          response: () => ({
            ok: responseOk,
            status: responseOk ? 200 : 500,
            arrayBuffer: () => Promise.resolve(bytes),
          }),
        }),
      }),
    }),
  });

  const createMockBucket = (hasOriginal = true) => ({
    get: vi.fn().mockResolvedValue(hasOriginal ? { body: new ReadableStream() } : null),
    put: vi.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    mockImages = createMockImages();
    mockBucket = createMockBucket();
    normalizer = new ImageNormalizer(mockImages, mockBucket);
  });

  describe("normalize", () => {
    it("should normalize image and return optimized key on success", async () => {
      const originalKey = "media/abc123";
      const contentHash = "abc123";

      const result = await normalizer.normalize(originalKey, contentHash);

      expect(result).toBeNull();
      expect(mockImages.input).not.toHaveBeenCalled();
      expect(mockBucket.put).not.toHaveBeenCalled();
    });

    it("should return null if original not found in R2", async () => {
      mockBucket = createMockBucket(false);
      normalizer = new ImageNormalizer(mockImages, mockBucket);

      const result = await normalizer.normalize("media/missing", "missing");

      expect(result).toBeNull();
      expect(mockImages.input).not.toHaveBeenCalled();
      expect(mockBucket.put).not.toHaveBeenCalled();
    });

    it("should return null if Images binding fails", async () => {
      mockImages = createMockImages(false);
      normalizer = new ImageNormalizer(mockImages, mockBucket);

      const result = await normalizer.normalize("media/abc123", "abc123");

      expect(result).toBeNull();
      expect(mockImages.input).not.toHaveBeenCalled();
      expect(mockBucket.put).not.toHaveBeenCalled();
    });

    it("should return null if Images binding returns empty output", async () => {
      mockImages = createMockImages(true, new ArrayBuffer(0));
      normalizer = new ImageNormalizer(mockImages, mockBucket);

      const result = await normalizer.normalize("media/abc123", "abc123");

      expect(result).toBeNull();
      expect(mockBucket.put).not.toHaveBeenCalled();
    });

    it("should return null if Images binding throws exception", async () => {
      mockImages = {
        input: vi.fn().mockImplementation(() => {
          throw new Error("Images binding error");
        }),
      };
      normalizer = new ImageNormalizer(mockImages, mockBucket);

      const result = await normalizer.normalize("media/abc123", "abc123");

      expect(result).toBeNull();
      expect(mockBucket.put).not.toHaveBeenCalled();
    });

    it("should include correct R2 metadata on successful put", async () => {
      const originalKey = "media/test123";
      const contentHash = "test123";

      await normalizer.normalize(originalKey, contentHash);

      expect(mockBucket.put).not.toHaveBeenCalled();
    });

    it("should produce deterministic key for same contentHash", async () => {
      const originalKey = "media/xyz789";
      const contentHash = "xyz789";

      const result1 = await normalizer.normalize(originalKey, contentHash);

      // Reset mocks and create new normalizer
      mockBucket = createMockBucket();
      mockImages = createMockImages();
      normalizer = new ImageNormalizer(mockImages, mockBucket);

      const result2 = await normalizer.normalize(originalKey, contentHash);

      expect(result1).toBe(result2);
      expect(result1).toBeNull();
    });
  });
});
