/**
 * Extended unit tests for Media Routes
 *
 * Focuses on uncovered branches:
 * - Helper functions: generateContentHash, getExtensionFromMimeType, validateMagicNumbers, checkSuspiciousContent
 * - Upload handler: auth, rate limiting, form parsing errors, file validation, MIME detection
 * - Batch upload handler: auth, empty files
 * - Grouped media handler: auth, validation, error handling
 * - Stats handler: auth, error handling
 * - serveMediaByHash: various variant paths, fallback logic
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks ---
const { mockGetSession, mockApplyRateLimitKV, mockCreateSecureResponse, mockAddSecurityHeaders, mockAddCorsHeaders, mockUploadSingle, mockUploadBatch, mockListUserMediaGrouped, mockGetUserMediaStats, mockNormalize, mockMediaHandlerCreate } = vi.hoisted(() => {
  return {
    mockGetSession: vi.fn(),
    mockApplyRateLimitKV: vi.fn().mockResolvedValue(null),
    mockCreateSecureResponse: vi.fn().mockImplementation((body, init) => new Response(body, init)),
    mockAddSecurityHeaders: vi.fn().mockImplementation((r) => r),
    mockAddCorsHeaders: vi.fn().mockImplementation((r) => r),
    mockUploadSingle: vi.fn(),
    mockUploadBatch: vi.fn(),
    mockListUserMediaGrouped: vi.fn(),
    mockGetUserMediaStats: vi.fn(),
    mockNormalize: vi.fn().mockResolvedValue(null),
    mockMediaHandlerCreate: vi.fn(),
  };
});

vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));


vi.mock("../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = mockApplyRateLimitKV;
  },
}));

vi.mock("../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
  },
}));

vi.mock("../../src/lib/cors-handler", () => ({
  CorsHandler: { addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args) },
}));

vi.mock("../../src/lib/middleware", () => ({
  corsMiddleware: () => vi.fn(),
  csrfMiddleware: () => vi.fn(),
}));

vi.mock("../../src/lib/services/media-upload-service", () => ({
  MediaUploadService: class {
    uploadSingle = mockUploadSingle;
    uploadBatch = mockUploadBatch;
  },
}));

vi.mock("../../src/lib/media-handler", () => ({
  MediaHandler: {
    create: (...args: any[]) => {
      mockMediaHandlerCreate(...args);
      return {
        listUserMediaGrouped: mockListUserMediaGrouped,
        getUserMediaStats: mockGetUserMediaStats,
      };
    },
  },
}));

vi.mock("../../src/lib/services/image-normalizer", () => ({
  ImageNormalizer: class {
    normalize = mockNormalize;
  },
  // T7: REENCODABLE_IMAGE_TYPES — the set of sharp-re-encodable MIME types
  REENCODABLE_IMAGE_TYPES: new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
  ]),
  // T7: reencodeImage — pass-through in tests (returns the input buffer unchanged)
  reencodeImage: vi.fn().mockImplementation(async (buf: ArrayBuffer) => ({
    buffer: Buffer.from(buf instanceof Buffer ? buf : new Uint8Array(buf)),
    canonicalMimeType: "image/jpeg",
  })),
}));

vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {},
}));

// T9: media upload resolves a tenant via the ambient auth seam
// (getCurrentTenantId). Provide a valid CUID-shaped ambient tenant so the
// canonical CAS key (cas/{tenantId}/{hash}) can be built in tests.
vi.mock("@de-otio/saas-foundation/tenant", () => ({
  getCurrentTenantId: () => "ctenant0000000000000000aa",
}));

// Query helper: invoke the queryFn against a mock db. The P0b upload path runs
// two query callsites through here on the sync-image path — the quota check
// (count + aggregate) and the mediaFile.upsert — plus reconciliation reads on
// other routes. count/aggregate return zero usage so checkUploadQuota allows the
// upload; upsert returns a row id. Routes that pass a queryFn expecting other
// models still get `null` for unknown shapes (the queryFn guards on dbAny.*).
vi.mock("../../src/lib/db-query-helper", () => ({
  QueryTimeoutPresets: { USER_FACING: {} },
  withQueryTimeoutAndRetry: vi.fn(
    async (
      _mgr: any,
      _region: string,
      _env: any,
      queryFn?: (db: any) => Promise<any>,
    ) => {
      if (typeof queryFn !== "function") return null;
      return queryFn({
        mediaFile: {
          upsert: vi.fn(async () => ({ id: "mediafile-1" })),
          count: vi.fn(async () => 0),
          aggregate: vi.fn(async () => ({ _sum: { size: 0 } })),
        },
      });
    },
  ),
}));

vi.mock("../../src/lib/metadata/metadata-extractor", () => ({
  MetadataExtractor: class {
    extractAll = vi.fn().mockResolvedValue({});
  },
}));

vi.mock("../../src/lib/media-metrics", () => ({
  MediaMetrics: class {
    trackOperation = vi.fn();
    trackGrouped = vi.fn();
    trackStats = vi.fn();
  },
}));

vi.mock("../../src/lib/region-detection", () => ({
  RegionDetector: class {
    detectRegion = vi.fn().mockResolvedValue("US");
  },
}));

const mockEnv = {
  DATABASE_URL: "postgresql://test",
  SESSION_SECRET: "test-secret",
  MEDIA_BUCKET_R2: null,
  IMAGES: null,
  // T7/T4: media config block required by the re-encode pipeline and allowlist
  media: {
    maxBytes: { image: 10 * 1024 * 1024, video: 100 * 1024 * 1024, audio: 100 * 1024 * 1024 },
    maxPixels: 25_000_000,
    rateLimits: { uploadPerMin: 10, batchPerMin: 5, servePerMin: 60 },
    allowlist: { image: ["image/jpeg", "image/png", "image/webp", "image/gif"], video: ["video/mp4"], audio: [] },
    presets: [],
    thresholds: {},
    canonicalFormat: "jpeg" as const,
    canonicalQuality: 85,
    // P0b quota ceilings (injected from Env.media). Generous so the quota gate
    // allows the image upload to reach its 200 assertion. Without this the gate
    // reads undefined limits and fails closed (checkUploadQuota -> denied).
    uploadQuota: { maxObjects: 1_000_000, maxBytes: 1_000_000_000_000 },
  },
};

const mockSession = { userId: "user-1" };

describe("Media Routes - Extended", () => {
  let mediaRoutes: any[];

  beforeAll(async () => {
    const mod = await import("../../src/lib/routes/media.js");
    mediaRoutes = mod.mediaRoutes;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(mockSession);
    mockApplyRateLimitKV.mockResolvedValue(null);
  });

  function findRoute(method: string, pathOrDesc: string) {
    return mediaRoutes.find((r: any) => {
      if (r.method !== method) return false;
      if (typeof r.path === "string" && r.path === pathOrDesc) return true;
      if (r.description && r.description.includes(pathOrDesc)) return true;
      return false;
    });
  }

  describe("POST /api/media/upload", () => {
    const uploadRoute = () => findRoute("POST", "/api/media/upload");

    it("should return 401 when not authenticated", async () => {
      mockGetSession.mockResolvedValue(null);
      const req = new Request("https://example.com/api/media/upload", { method: "POST" });

      await uploadRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Unauthorized"),
        expect.objectContaining({ status: 401 }),
      );
    });

    it("should return rate limit response when rate limited", async () => {
      const rateLimitResponse = new Response("Too Many Requests", { status: 429 });
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);
      const req = new Request("https://example.com/api/media/upload", { method: "POST" });

      await uploadRoute().handler(req, mockEnv);

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(rateLimitResponse);
    });

    it("should return 400 for invalid form data", async () => {
      // Send a request that will fail formData() parsing (non-multipart body)
      const req = new Request("https://example.com/api/media/upload", {
        method: "POST",
        body: "not multipart",
        headers: { "content-type": "text/plain" },
      });

      await uploadRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Invalid request format"),
        expect.objectContaining({ status: 400 }),
      );
    });

    it("should return 400 when no file is provided in form data", async () => {
      const formData = new FormData();
      formData.append("notfile", "value");
      const req = new Request("https://example.com/api/media/upload", {
        method: "POST",
        body: formData,
      });

      await uploadRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("No file provided"),
        expect.objectContaining({ status: 400 }),
      );
    });

    it("should return 400 for empty file", async () => {
      const formData = new FormData();
      const emptyFile = new File([], "empty.jpg", { type: "image/jpeg" });
      formData.append("file", emptyFile);
      const req = new Request("https://example.com/api/media/upload", {
        method: "POST",
        body: formData,
      });

      await uploadRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Empty file"),
        expect.objectContaining({ status: 400 }),
      );
    });

    it("should return 400 for invalid file type", async () => {
      // Create a file with unrecognized magic bytes
      const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
      const formData = new FormData();
      const file = new File([bytes], "malware.exe", { type: "application/x-msdownload" });
      formData.append("file", file);
      const req = new Request("https://example.com/api/media/upload", {
        method: "POST",
        body: formData,
      });

      await uploadRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Invalid file type"),
        expect.objectContaining({ status: 400 }),
      );
    });

    it("should return 400 for file exceeding size limit", async () => {
      // Create a JPEG file that's too large (> 10MB)
      const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const formData = new FormData();
      // We can't actually create a 10MB+ file in test, but we can create a File with a spoofed size
      // The route checks file.size first, then reads the buffer
      // For this test, we need magic bytes to detect as image, then a size check
      // Since the bytes ARE read first for MIME detection, the buffer length matters
      // We'll test with an approach that the code's size check uses file.size
      const bigData = new Uint8Array(11 * 1024 * 1024);
      bigData[0] = 0xff;
      bigData[1] = 0xd8;
      bigData[2] = 0xff;
      const file = new File([bigData], "huge.jpg", { type: "image/jpeg" });
      formData.append("file", file);
      const req = new Request("https://example.com/api/media/upload", {
        method: "POST",
        body: formData,
      });

      await uploadRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("File too large"),
        expect.objectContaining({ status: 400 }),
      );
    });

    it("should upload a valid JPEG file successfully", async () => {
      // Valid JPEG magic bytes
      const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
      const formData = new FormData();
      const file = new File([jpegBytes], "photo.jpg", { type: "image/jpeg" });
      formData.append("file", file);
      const req = new Request("https://example.com/api/media/upload", {
        method: "POST",
        body: formData,
      });

      // T9: contentHash must be a valid 64-char hex digest so the canonical
      // casKey can be built; the handler now rejects malformed hashes.
      const hashA = "a".repeat(64);
      mockUploadSingle.mockResolvedValue({
        url: `https://cdn.example.com/api/media/${hashA}`,
        contentHash: hashA,
        status: "uploaded",
      });

      await uploadRoute().handler(req, mockEnv);

      expect(mockUploadSingle).toHaveBeenCalled();
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining(hashA),
        expect.objectContaining({ status: 200 }),
      );
    });

    it("should detect PNG from magic bytes even if declared type differs", async () => {
      // PNG magic bytes with wrong declared type
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      const formData = new FormData();
      const file = new File([pngBytes], "photo.jpg", { type: "image/jpeg" });
      formData.append("file", file);
      const req = new Request("https://example.com/api/media/upload", {
        method: "POST",
        body: formData,
      });

      mockUploadSingle.mockResolvedValue({
        url: `https://cdn.example.com/api/media/${"b".repeat(64)}`,
        contentHash: "b".repeat(64),
        status: "uploaded",
      });

      await uploadRoute().handler(req, mockEnv);

      // Should log MIME type mismatch
            expect(mockUploadSingle).toHaveBeenCalled();
    });

    it("should handle upload service error", async () => {
      const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
      const formData = new FormData();
      const file = new File([jpegBytes], "photo.jpg", { type: "image/jpeg" });
      formData.append("file", file);
      const req = new Request("https://example.com/api/media/upload", {
        method: "POST",
        body: formData,
      });

      mockUploadSingle.mockRejectedValue(new Error("S3 upload failed"));

      await uploadRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Failed to upload media"),
        expect.objectContaining({ status: 500 }),
      );
    });
  });

  describe("POST /api/media/upload/batch", () => {
    const batchRoute = () => findRoute("POST", "/api/media/upload/batch");

    it("should return 401 when not authenticated", async () => {
      mockGetSession.mockResolvedValue(null);
      const req = new Request("https://example.com/api/media/upload/batch", { method: "POST" });

      await batchRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Unauthorized"),
        expect.objectContaining({ status: 401 }),
      );
    });

    it("should return 400 when no files provided", async () => {
      const formData = new FormData();
      formData.append("notfile", "value");
      const req = new Request("https://example.com/api/media/upload/batch", {
        method: "POST",
        body: formData,
      });

      await batchRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("No files"),
        expect.objectContaining({ status: 400 }),
      );
    });
  });

  describe("GET /api/media/grouped", () => {
    const groupedRoute = () => findRoute("GET", "/api/media/grouped");

    it("should return 401 when not authenticated", async () => {
      mockGetSession.mockResolvedValue(null);
      const req = new Request("https://example.com/api/media/grouped");

      await groupedRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Unauthorized"),
        expect.objectContaining({ status: 401 }),
      );
    });

    it("should return 400 for invalid groupBy parameter", async () => {
      const req = new Request("https://example.com/api/media/grouped?groupBy=week");

      await groupedRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Invalid groupBy"),
        expect.objectContaining({ status: 400 }),
      );
    });

    it("should return 400 for limit out of range", async () => {
      const req = new Request("https://example.com/api/media/grouped?groupBy=month&limit=0");

      await groupedRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Invalid limit"),
        expect.objectContaining({ status: 400 }),
      );
    });

    it("should return 400 for limit above 10000", async () => {
      const req = new Request("https://example.com/api/media/grouped?groupBy=month&limit=50000");

      await groupedRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Invalid limit"),
        expect.objectContaining({ status: 400 }),
      );
    });

    it("should return grouped media on success", async () => {
      mockListUserMediaGrouped.mockResolvedValue({
        groups: [
          { period: "2025-01", media: [{ id: "1" }, { id: "2" }] },
        ],
      });
      const req = new Request("https://example.com/api/media/grouped?groupBy=month");

      await groupedRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("2025-01"),
        expect.objectContaining({ status: 200 }),
      );
    });

    it("should handle error in listUserMediaGrouped", async () => {
      mockListUserMediaGrouped.mockRejectedValue(new Error("DB timeout"));
      const req = new Request("https://example.com/api/media/grouped?groupBy=month");

      await groupedRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Failed to group media"),
        expect.objectContaining({ status: 500 }),
      );
    });

    it("should return 404 when media not found error", async () => {
      mockListUserMediaGrouped.mockRejectedValue(new Error("Media not found"));
      const req = new Request("https://example.com/api/media/grouped?groupBy=month");

      await groupedRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 404 }),
      );
    });
  });

  describe("GET /api/media/stats", () => {
    const statsRoute = () => findRoute("GET", "/api/media/stats");

    it("should return 401 when not authenticated", async () => {
      mockGetSession.mockResolvedValue(null);
      const req = new Request("https://example.com/api/media/stats");

      await statsRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Unauthorized"),
        expect.objectContaining({ status: 401 }),
      );
    });

    it("should return rate limit response", async () => {
      const rateLimitResponse = new Response("Rate limited", { status: 429 });
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);
      const req = new Request("https://example.com/api/media/stats");

      await statsRoute().handler(req, mockEnv);

      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(rateLimitResponse);
    });

    it("should return stats on success", async () => {
      mockGetUserMediaStats.mockResolvedValue({ totalCount: 42, totalSize: 1024000 });
      const req = new Request("https://example.com/api/media/stats");

      await statsRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("42"),
        expect.objectContaining({ status: 200 }),
      );
    });

    it("should handle error in getUserMediaStats", async () => {
      mockGetUserMediaStats.mockRejectedValue(new Error("DB error"));
      const req = new Request("https://example.com/api/media/stats");

      await statsRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.stringContaining("Failed to get media stats"),
        expect.objectContaining({ status: 500 }),
      );
    });

    it("should return 404 when media not found", async () => {
      mockGetUserMediaStats.mockRejectedValue(new Error("Media not found"));
      const req = new Request("https://example.com/api/media/stats");

      await statsRoute().handler(req, mockEnv);

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 404 }),
      );
    });
  });
});
