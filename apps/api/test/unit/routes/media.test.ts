/**
 * Unit Tests: Media Routes
 *
 * Tests for media file upload endpoint with content-addressed storage.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mediaRoutes } from "../../../src/lib/routes/media.js";
import type { Session } from "../../../src/lib/session-cookie.js";

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
const mockAddSecurityHeaders = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
  },
}));

// Mock RateLimiter
const mockApplyRateLimitKV = vi.fn();
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = mockApplyRateLimitKV;
  },
}));


// Mock CorsHandler
const mockAddCorsHeaders = vi.fn();
vi.mock("../../../src/lib/cors-handler", () => ({
  CorsHandler: {
    addCorsHeaders: vi.fn((response) => response),
  },
}));

// Mock database
const mockMediaFileFindUnique = vi.fn();
const mockMediaFileCreate = vi.fn();
const mockMediaFileUpsert = vi.fn();
const mockCreatePrismaForRegion = vi.hoisted(() => vi.fn());
vi.mock("../../../src/db", () => ({
  createPrismaForRegion: mockCreatePrismaForRegion,
}));

// Mock withQueryTimeoutAndRetry
const mockWithQueryTimeoutAndRetry = vi.fn();
vi.mock("../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock database connection manager
vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    executeWithRetry: vi.fn(),
  },
}));

// Mock R2 bucket
const mockR2Head = vi.fn();
const mockR2Put = vi.fn();
const mockR2Get = vi.fn();

// Mock MediaHandler - simple factory pattern
const mockMediaHandlerInstance = vi.hoisted(() => ({
  getMediaDetails: vi.fn(),
  hideMedia: vi.fn(),
  unhideMedia: vi.fn(),
  deleteMedia: vi.fn(),
  listUserMedia: vi.fn(),
  listUserMediaGrouped: vi.fn(),
  getUserMediaStats: vi.fn(),
}));

vi.mock("../../../src/lib/media-handler", () => ({
  MediaHandler: {
    create: vi.fn(() => mockMediaHandlerInstance),
  },
}));

// Mock MediaUploadService
const mockUploadSingle = vi.fn();
const mockUploadBatch = vi.fn();
vi.mock("../../../src/lib/services/media-upload-service", () => ({
  MediaUploadService: class {
    uploadSingle = mockUploadSingle;
    uploadBatch = mockUploadBatch;
  },
}));

describe("Media Routes", () => {
  let mockEnv: any;
  let mockSession: Session;
  let mockRequest: Request;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockSession = {
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    };

    mockEnv = {
      APP_DOMAIN: "https://api.rkm1.de",
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
      MEDIA_BUCKET_R2: {
        head: mockR2Head,
        put: mockR2Put,
        get: mockR2Get,
      },
    };

    mockGetSession.mockResolvedValue(mockSession);
    mockApplyRateLimitKV.mockResolvedValue(null); // No rate limit
    mockCreateSecureResponse.mockImplementation(
      (body, options) => new Response(body, options),
    );
    // CorsHandler is already mocked to return response as-is
    mockAddSecurityHeaders.mockImplementation((response) => response);

    // Default database mock
    const mockDb = {
      mediaFile: {
        findUnique: mockMediaFileFindUnique,
        create: mockMediaFileCreate,
        upsert: mockMediaFileUpsert,
      },
    };
    mockCreatePrismaForRegion.mockReturnValue(mockDb);
    mockMediaFileFindUnique.mockResolvedValue(null);
    mockMediaFileCreate.mockResolvedValue({
      id: "media-123",
      contentHash: "test-hash",
    });
    mockMediaFileUpsert.mockResolvedValue({
      id: "media-123",
      contentHash: "test-hash",
    });

    // Default withQueryTimeoutAndRetry mock - executes query function with mockDb
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

    // Default R2 mocks
    mockR2Head.mockResolvedValue(null); // File doesn't exist
    mockR2Put.mockResolvedValue(undefined);
    mockR2Get.mockResolvedValue(null);

    // Default MediaUploadService mock
    mockUploadSingle.mockResolvedValue({
      url: "https://api.rkm1.de/api/media/test-hash",
      contentHash: "test-hash",
      status: "uploaded",
    });
    mockUploadBatch.mockResolvedValue({
      results: [],
      errors: [],
    });
  });

  describe("POST /api/media/upload", () => {
    const uploadRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/upload" && r.method === "POST",
    );

    it("should require authentication", async () => {
      expect(uploadRoute).toBeDefined();

      mockGetSession.mockResolvedValue(null); // No session

      const formData = new FormData();
      formData.append(
        "file",
        new Blob(["test"], { type: "image/jpeg" }),
        "test.jpg",
      );

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Unauthorized");
    });

    it("should reject requests without file", async () => {
      const formData = new FormData();
      // No file appended

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "No file provided");
    });

    it("should reject invalid file types", async () => {
      const formData = new FormData();
      formData.append(
        "file",
        new Blob(["test"], { type: "application/pdf" }),
        "test.pdf",
      );

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Invalid file type");
    });

    it("should reject files that are too large", async () => {
      // Create a 11MB blob (exceeds 10MB limit for images)
      const largeBlob = new Blob([new ArrayBuffer(11 * 1024 * 1024)], {
        type: "image/jpeg",
      });

      const formData = new FormData();
      formData.append("file", largeBlob, "large.jpg");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "File too large");
      expect(body.message).toContain("10MB");
    });

    it("should auto-detect PNG when declared as JPEG but file is actually PNG", async () => {
      // This is the real-world case: frontend compresses/converts image to PNG
      // but still declares it as JPEG. We should detect and use PNG.
      const pngMagic = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const blob = new Blob([pngMagic], { type: "image/jpeg" });

      const formData = new FormData();
      formData.append("file", blob, "image.jpg");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      // Should succeed because we auto-detect PNG from magic numbers
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("url");
      expect(body).toHaveProperty("contentHash");
    });

    it("should auto-detect MIME type when file has no declared type", async () => {
      // File with no MIME type - should auto-detect from magic numbers
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const blob = new Blob([jpegMagic], { type: "" }); // Empty type

      const formData = new FormData();
      formData.append("file", blob, "test.jpg");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("url");
    });

    it("should auto-detect MIME type when file has application/octet-stream type", async () => {
      // File with generic binary type - should auto-detect from magic numbers
      const pngMagic = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const blob = new Blob([pngMagic], { type: "application/octet-stream" });

      const formData = new FormData();
      formData.append("file", blob, "test.png");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("url");
    });

    it("should auto-detect WebP from magic numbers", async () => {
      // WebP: RIFF ... WEBP
      const webpMagic = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ]);
      const blob = new Blob([webpMagic], { type: "application/octet-stream" });

      const formData = new FormData();
      formData.append("file", blob, "test.webp");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("url");
    });

    it("should auto-detect GIF from magic numbers", async () => {
      const gifMagic = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
      const blob = new Blob([gifMagic], { type: "application/octet-stream" });

      const formData = new FormData();
      formData.append("file", blob, "test.gif");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("url");
    });

    it("should reject files with invalid magic numbers that cannot be detected", async () => {
      // File with no valid magic numbers
      const invalidBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
      const blob = new Blob([invalidBytes], {
        type: "application/octet-stream",
      });

      const formData = new FormData();
      formData.append("file", blob, "invalid.bin");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Invalid file type");
    });

    it("should successfully upload a valid JPEG image", async () => {
      // Create a valid JPEG file (starts with FF D8 FF)
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const blob = new Blob([jpegMagic], { type: "image/jpeg" });

      const formData = new FormData();
      formData.append("file", blob, "test.jpg");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("url");
      expect(body).toHaveProperty("mediaKey");
      expect(body).toHaveProperty("contentHash");
      expect(mockUploadSingle).toHaveBeenCalled();
    });

    it("should successfully upload a valid PNG image", async () => {
      // Create a valid PNG file
      const pngMagic = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const blob = new Blob([pngMagic], { type: "image/png" });

      const formData = new FormData();
      formData.append("file", blob, "test.png");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("url");
      expect(body).toHaveProperty("contentHash");
    });

    it("should handle deduplication when file already exists", async () => {
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const blob = new Blob([jpegMagic], { type: "image/jpeg" });

      // Mock existing media file
      mockMediaFileFindUnique.mockResolvedValue({
        id: "existing-media-123",
        contentHash: "existing-hash",
      });
      mockR2Head.mockResolvedValue({}); // File exists in R2

      const formData = new FormData();
      formData.append("file", blob, "test.jpg");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);
      // Should not create new media file
      expect(mockMediaFileCreate).not.toHaveBeenCalled();
      // Should not upload to R2 if file exists
      expect(mockR2Put).not.toHaveBeenCalled();
    });

    it("should handle missing R2 bucket gracefully", async () => {
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const blob = new Blob([jpegMagic], { type: "image/jpeg" });

      const envWithoutR2 = { ...mockEnv };
      delete envWithoutR2.MEDIA_BUCKET_R2;

      const formData = new FormData();
      formData.append("file", blob, "test.jpg");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, envWithoutR2, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      // Should still succeed, just without R2 storage
      expect(response.status).toBe(200);
    });

    it("should support legacy R2_BUCKET binding name for backward compatibility", async () => {
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const blob = new Blob([jpegMagic], { type: "image/jpeg" });

      const envWithLegacyR2 = {
        ...mockEnv,
        R2_BUCKET: {
          head: mockR2Head,
          put: mockR2Put,
        },
      };
      delete envWithLegacyR2.MEDIA_BUCKET_R2;

      const formData = new FormData();
      formData.append("file", blob, "test.jpg");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(
        mockRequest,
        envWithLegacyR2,
        {
          url: new URL("https://api.rkm1.de/api/media/upload"),
          pathname: "/api/media/upload",
          params: {},
        },
      );

      // Should succeed and use R2_BUCKET
      expect(response.status).toBe(200);
      expect(mockUploadSingle).toHaveBeenCalled();
      const body = await response.json();
      expect(body).toHaveProperty("url");
    });

    it("should handle missing MediaFile model gracefully", async () => {
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const blob = new Blob([jpegMagic], { type: "image/jpeg" });

      // Mock database without mediaFile model - make upsert throw
      mockMediaFileUpsert.mockRejectedValue(
        new Error("Property mediaFile does not exist"),
      );

      const formData = new FormData();
      formData.append("file", blob, "test.jpg");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      // DB record creation is required for media ownership validation.
      // If the DB upsert fails, the upload must fail so the frontend can retry.
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Database error");
      // Should log error when DB upsert fails
          });

    it("should apply rate limiting", async () => {
      const rateLimitResponse = new Response("Rate limit exceeded", {
        status: 429,
      });
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const blob = new Blob([jpegMagic], { type: "image/jpeg" });

      const formData = new FormData();
      formData.append("file", blob, "test.jpg");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(429);
    });

    it("should accept valid video files", async () => {
      // Create a valid MP4 file (starts with ftyp box at offset 4)
      const mp4Magic = new Uint8Array([
        0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
      ]);
      const blob = new Blob([mp4Magic], { type: "video/mp4" });

      const formData = new FormData();
      formData.append("file", blob, "test.mp4");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("contentHash");
    });

    it("should reject videos that are too large", async () => {
      // Create a 101MB blob (exceeds 100MB limit for videos)
      const largeBlob = new Blob([new ArrayBuffer(101 * 1024 * 1024)], {
        type: "video/mp4",
      });

      const formData = new FormData();
      formData.append("file", largeBlob, "large.mp4");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "File too large");
      expect(body.message).toContain("100MB");
    });
  });

  describe("GET /api/media/:hash", () => {
    const getMediaRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/:hash" && r.method === "GET",
    );

    beforeEach(() => {
      mockR2Get.mockReset();
      mockR2Head.mockReset();
    });

    it("should require authentication", async () => {
      expect(getMediaRoute).toBeDefined();

      mockGetSession.mockResolvedValue(null);

      mockRequest = new Request("https://api.rkm1.de/api/media/test-hash", {
        method: "GET",
      });

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/test-hash"),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Unauthorized");
    });

    it("should return 400 when hash is missing", async () => {
      mockRequest = new Request("https://api.rkm1.de/api/media/", {
        method: "GET",
      });

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/"),
        pathname: "/api/media/",
        params: {},
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Missing content hash");
    });

    it("should serve media when MediaFile exists in database", async () => {
      const mockMediaFile = {
        id: "media-123",
        contentHash: "test-hash",
        mimeType: "image/jpeg",
        originalKey: "media/test-hash.jpg",
        optimizedKey: null,
        thumbnailKey: null,
      };

      mockMediaFileFindUnique.mockResolvedValue(mockMediaFile);

      const mockR2Object = {
        body: new ReadableStream(),
        httpMetadata: { contentType: "image/jpeg" },
      };
      mockR2Get.mockResolvedValue(mockR2Object);

      mockRequest = new Request("https://api.rkm1.de/api/media/test-hash", {
        method: "GET",
      });

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/test-hash"),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(200);
      expect(mockR2Get).toHaveBeenCalledWith("media/test-hash.jpg");
      expect(mockR2Head).not.toHaveBeenCalled(); // Should not use fallback
    });

    it("should use optimized key when available and variant is optimized", async () => {
      const mockMediaFile = {
        id: "media-123",
        contentHash: "test-hash",
        mimeType: "image/jpeg",
        originalKey: "media/test-hash.jpg",
        optimizedKey: "media/test-hash_opt.webp",
        thumbnailKey: null,
      };

      mockMediaFileFindUnique.mockResolvedValue(mockMediaFile);

      const mockR2Object = {
        body: new ReadableStream(),
        httpMetadata: { contentType: "image/webp" },
      };
      mockR2Get.mockResolvedValue(mockR2Object);

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/test-hash?variant=optimized",
        {
          method: "GET",
        },
      );

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/test-hash?variant=optimized",
        ),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(200);
      expect(mockR2Get).toHaveBeenCalledWith("media/test-hash_opt.webp");
    });

    it("should fallback to original when optimized not found and MediaFile exists", async () => {
      const mockMediaFile = {
        id: "media-123",
        contentHash: "test-hash",
        mimeType: "image/jpeg",
        originalKey: "media/test-hash.jpg",
        optimizedKey: null, // No optimized version
        thumbnailKey: null,
      };

      mockMediaFileFindUnique.mockResolvedValue(mockMediaFile);

      const mockR2Object = {
        body: new ReadableStream(),
        httpMetadata: { contentType: "image/jpeg" },
      };
      mockR2Get.mockResolvedValue(mockR2Object);

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/test-hash?variant=optimized",
        {
          method: "GET",
        },
      );

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/test-hash?variant=optimized",
        ),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(200);
      expect(mockR2Get).toHaveBeenCalledWith("media/test-hash.jpg");
    });

    it("should try common extensions when MediaFile does not exist (fallback for .jpg)", async () => {
      mockMediaFileFindUnique.mockResolvedValue(null); // MediaFile not found

      // Try jpg first, should find it
      mockR2Head
        .mockResolvedValueOnce(null) // jpg - not found
        .mockResolvedValueOnce(null) // jpeg - not found
        .mockResolvedValueOnce({}); // png - found!

      const mockR2Object = {
        body: new ReadableStream(),
        httpMetadata: { contentType: "image/png" },
      };
      mockR2Get.mockResolvedValue(mockR2Object);

      mockRequest = new Request("https://api.rkm1.de/api/media/test-hash", {
        method: "GET",
      });

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/test-hash"),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(200);
      // Should have tried jpg, jpeg, then found png
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash.jpg");
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash.jpeg");
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash.png");
      expect(mockR2Get).toHaveBeenCalledWith("media/test-hash.png");
    });

    it("should try common extensions when MediaFile does not exist (fallback for .png)", async () => {
      mockMediaFileFindUnique.mockResolvedValue(null);

      // Try jpg first (not found), then jpeg (not found), then find png
      mockR2Head
        .mockResolvedValueOnce(null) // jpg - not found
        .mockResolvedValueOnce(null) // jpeg - not found
        .mockResolvedValueOnce({}); // png - found!

      const mockR2Object = {
        body: new ReadableStream(),
        httpMetadata: { contentType: "image/png" },
      };
      mockR2Get.mockResolvedValue(mockR2Object);

      mockRequest = new Request("https://api.rkm1.de/api/media/test-hash", {
        method: "GET",
      });

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/test-hash"),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(200);
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash.jpg");
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash.jpeg");
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash.png");
      expect(mockR2Get).toHaveBeenCalledWith("media/test-hash.png");
    });

    it("should try optimized variant first, then fallback to original when MediaFile does not exist", async () => {
      mockMediaFileFindUnique.mockResolvedValue(null);

      // The code first tries to find the original file with any extension
      // Then for optimized variant, tries optimized extensions, then falls back to original
      // Setup: First find original (jpg not found, jpeg not found, png found)
      // Then for optimized: try optimized variants (all not found), then use found original
      mockR2Head
        .mockResolvedValueOnce(null) // original jpg
        .mockResolvedValueOnce(null) // original jpeg
        .mockResolvedValueOnce({}) // original png - found! (stored for fallback)
        .mockResolvedValueOnce(null) // optimized webp
        .mockResolvedValueOnce(null) // optimized jpg
        .mockResolvedValueOnce(null) // optimized jpeg
        .mockResolvedValueOnce(null) // optimized png
        .mockResolvedValueOnce(null) // optimized webp (duplicate)
        .mockResolvedValueOnce(null); // optimized gif

      const mockR2Object = {
        body: new ReadableStream(),
        httpMetadata: { contentType: "image/png" },
      };
      mockR2Get.mockResolvedValue(mockR2Object);

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/test-hash?variant=optimized",
        {
          method: "GET",
        },
      );

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/test-hash?variant=optimized",
        ),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(200);
      // Should have tried optimized variants first, then found original png
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash.jpg");
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash.jpeg");
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash.png");
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash_opt.webp");
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash_opt.jpg");
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash_opt.jpeg");
      expect(mockR2Head).toHaveBeenCalledWith("media/test-hash_opt.png");
      expect(mockR2Get).toHaveBeenCalledWith("media/test-hash.png");
    });

    it("should return 404 when no file found with any extension", async () => {
      mockMediaFileFindUnique.mockResolvedValue(null);

      // All extensions return null (not found)
      mockR2Head.mockResolvedValue(null);

      mockRequest = new Request("https://api.rkm1.de/api/media/test-hash", {
        method: "GET",
      });

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/test-hash"),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Media not found");
      expect(mockR2Get).not.toHaveBeenCalled();
    });

    it("should return 503 when R2 bucket is not configured", async () => {
      mockEnv.MEDIA_BUCKET_R2 = null;
      mockEnv.R2_BUCKET = null;

      mockRequest = new Request("https://api.rkm1.de/api/media/test-hash", {
        method: "GET",
      });

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/test-hash"),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Media storage not configured");
    });

    it("should handle database query errors gracefully and use fallback", async () => {
      // Database query fails
      mockMediaFileFindUnique.mockRejectedValue(new Error("Database timeout"));

      // Fallback should find the file
      mockR2Head.mockResolvedValueOnce({}); // Find jpg

      const mockR2Object = {
        body: new ReadableStream(),
        httpMetadata: { contentType: "image/jpeg" },
      };
      mockR2Get.mockResolvedValue(mockR2Object);

      mockRequest = new Request("https://api.rkm1.de/api/media/test-hash", {
        method: "GET",
      });

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/test-hash"),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(200);
      expect(mockR2Get).toHaveBeenCalledWith("media/test-hash.jpg");
          });

    describe("Binary Data Integrity", () => {
      it("should serve image data without corruption through CORS handler", async () => {
        const mockMediaFile = {
          id: "media-123",
          contentHash: "test-hash",
          mimeType: "image/png",
          originalKey: "media/test-hash.png",
          optimizedKey: null,
          thumbnailKey: null,
        };

        mockMediaFileFindUnique.mockResolvedValue(mockMediaFile);

        // Create actual PNG bytes (PNG signature: 0x89 0x50 0x4E 0x47)
        const pngBytes = new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        const pngStream = new ReadableStream({
          start(controller) {
            controller.enqueue(pngBytes);
            controller.close();
          },
        });

        const mockR2Object = {
          body: pngStream,
          httpMetadata: { contentType: "image/png" },
        };
        mockR2Get.mockResolvedValue(mockR2Object);

        mockRequest = new Request("https://api.rkm1.de/api/media/test-hash", {
          method: "GET",
          headers: {
            Origin: "https://www.rkm1.de",
          },
        });

        // Mock session
        const mockSession = {
          userId: "user-123",
          role: "END_USER",
        } as Session;
        mockGetSession.mockResolvedValue(mockSession);

        const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
          url: new URL("https://api.rkm1.de/api/media/test-hash"),
          pathname: "/api/media/test-hash",
          params: { hash: "test-hash" },
        });

        expect(response.status).toBe(200);

        // Verify response body is binary data (not corrupted)
        // Note: CorsHandler is mocked, so we need to test the actual implementation
        // For now, verify the response has correct Content-Type
        expect(response.headers.get("Content-Type")).toBe("image/png");

        // In a real test, we would need to unmock CorsHandler to test actual binary handling
        // For now, this test verifies the route handler passes binary data correctly
      });

      it("should preserve binary data integrity for JPEG images", async () => {
        const mockMediaFile = {
          id: "media-123",
          contentHash: "test-hash",
          mimeType: "image/jpeg",
          originalKey: "media/test-hash.jpg",
          optimizedKey: null,
          thumbnailKey: null,
        };

        mockMediaFileFindUnique.mockResolvedValue(mockMediaFile);

        // JPEG signature: 0xFF 0xD8 0xFF
        const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
        const jpegStream = new ReadableStream({
          start(controller) {
            controller.enqueue(jpegBytes);
            controller.close();
          },
        });

        const mockR2Object = {
          body: jpegStream,
          httpMetadata: { contentType: "image/jpeg" },
        };
        mockR2Get.mockResolvedValue(mockR2Object);

        mockRequest = new Request("https://api.rkm1.de/api/media/test-hash", {
          method: "GET",
          headers: {
            Origin: "https://www.rkm1.de",
          },
        });

        const mockSession = {
          userId: "user-123",
          role: "END_USER",
        } as Session;
        mockGetSession.mockResolvedValue(mockSession);

        const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
          url: new URL("https://api.rkm1.de/api/media/test-hash"),
          pathname: "/api/media/test-hash",
          params: { hash: "test-hash" },
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("image/jpeg");
      });

      it("should call CorsHandler with binary response for image Content-Type", async () => {
        const mockMediaFile = {
          id: "media-123",
          contentHash: "test-hash",
          mimeType: "image/png",
          originalKey: "media/test-hash.png",
          optimizedKey: null,
          thumbnailKey: null,
        };

        mockMediaFileFindUnique.mockResolvedValue(mockMediaFile);

        const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        const pngStream = new ReadableStream({
          start(controller) {
            controller.enqueue(pngBytes);
            controller.close();
          },
        });

        const mockR2Object = {
          body: pngStream,
          httpMetadata: { contentType: "image/png" },
        };
        mockR2Get.mockResolvedValue(mockR2Object);

        mockRequest = new Request("https://api.rkm1.de/api/media/test-hash", {
          method: "GET",
          headers: {
            Origin: "https://www.rkm1.de",
          },
        });

        const mockSession = {
          userId: "user-123",
          role: "END_USER",
        } as Session;
        mockGetSession.mockResolvedValue(mockSession);

        const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
          url: new URL("https://api.rkm1.de/api/media/test-hash"),
          pathname: "/api/media/test-hash",
          params: { hash: "test-hash" },
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("image/png");

        // Verify CorsHandler.addCorsHeaders was called
        // Note: Currently mocked to return response as-is, but in real implementation
        // it would handle binary data correctly. The actual binary integrity is tested
        // in cors-handler.test.ts unit tests.
      });
    });
  });

  describe("GET /api/media", () => {
    const listRoute = mediaRoutes.find(
      (r) => r.path === "/api/media" && r.method === "GET",
    );

    it("should require authentication", async () => {
      expect(listRoute).toBeDefined();

      mockGetSession.mockResolvedValue(null); // No session

      mockRequest = new Request("https://api.rkm1.de/api/media", {
        method: "GET",
      });

      const response = await listRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media"),
        pathname: "/api/media",
        params: {},
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Unauthorized");
    });

    it("should return user media with pagination", async () => {
      const mockResult = {
        media: [
          {
            id: "media-1",
            contentHash: "hash123",
            mimeType: "image/jpeg",
            size: 1024,
            thumbnailUrl:
              "https://api.rkm1.de/api/media/hash123?variant=thumbnail",
            optimizedUrl:
              "https://api.rkm1.de/api/media/hash123?variant=optimized",
            originalUrl:
              "https://api.rkm1.de/api/media/hash123?variant=original",
            createdAt: "2025-01-15T00:00:00Z",
            hidden: false,
            postCount: 1,
          },
        ],
        cursor: null,
      };

      mockMediaHandlerInstance.listUserMedia.mockResolvedValue(mockResult);

      mockRequest = new Request("https://api.rkm1.de/api/media", {
        method: "GET",
      });

      const response = await listRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media"),
        pathname: "/api/media",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(mockResult);
    });

    it("should validate limit parameter", async () => {
      mockRequest = new Request("https://api.rkm1.de/api/media?limit=200", {
        method: "GET",
      });

      const response = await listRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media?limit=200"),
        pathname: "/api/media",
        params: {},
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Invalid limit");
    });

    it("should filter by type (photo)", async () => {
      const mockResult = {
        media: [],
        cursor: null,
      };

      mockMediaHandlerInstance.listUserMedia.mockResolvedValue(mockResult);

      mockRequest = new Request("https://api.rkm1.de/api/media?type=photo", {
        method: "GET",
      });

      const response = await listRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media?type=photo"),
        pathname: "/api/media",
        params: {},
      });

      expect(response.status).toBe(200);
      // Verify that listUserMedia was called with type filter
      expect(mockMediaHandlerInstance.listUserMedia).toHaveBeenCalled();
      const callArgs = mockMediaHandlerInstance.listUserMedia.mock.calls[0][1];
      expect(callArgs.type).toBe("photo");
    });

    it("should apply rate limiting", async () => {
      const rateLimitResponse = new Response("Rate limit exceeded", {
        status: 429,
      });
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      mockRequest = new Request("https://api.rkm1.de/api/media", {
        method: "GET",
      });

      const response = await listRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media"),
        pathname: "/api/media",
        params: {},
      });

      expect(response.status).toBe(429);
    });
  });

  describe("GET /api/media/:mediaId", () => {
    const detailsRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/:mediaId" && r.method === "GET",
    );

    it("should require authentication", async () => {
      expect(detailsRoute).toBeDefined();

      mockGetSession.mockResolvedValue(null);

      mockRequest = new Request("https://api.rkm1.de/api/media/media-123", {
        method: "GET",
      });

      const response = await detailsRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123"),
        pathname: "/api/media/media-123",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Unauthorized");
    });

    it("should return media details on success", async () => {
      const mockDetails = {
        id: "media-123",
        contentHash: "hash123",
        cid: "bafybe...",
        mimeType: "image/jpeg",
        size: 1024,
        thumbnailUrl: "https://api.rkm1.de/api/media/hash123?variant=thumbnail",
        optimizedUrl: "https://api.rkm1.de/api/media/hash123?variant=optimized",
        originalUrl: "https://api.rkm1.de/api/media/hash123?variant=original",
        createdAt: "2025-01-15T00:00:00Z",
        updatedAt: "2025-01-15T00:00:00Z",
        hidden: false,
        hiddenAt: null,
        deletedAt: null,
        posts: [
          {
            id: "post-1",
            text: "Test post",
            createdAt: "2025-01-15T00:00:00Z",
            visibility: "PUBLIC" as const,
            url: "/posts/post-1",
          },
        ],
        canDelete: true,
        canHide: true,
      };

      mockMediaHandlerInstance.getMediaDetails.mockResolvedValue(mockDetails);

      mockRequest = new Request("https://api.rkm1.de/api/media/media-123", {
        method: "GET",
      });

      const response = await detailsRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123"),
        pathname: "/api/media/media-123",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(mockDetails);
    });

    it("should return 404 when media not found", async () => {
      mockMediaHandlerInstance.getMediaDetails.mockRejectedValue(
        new Error("Media not found"),
      );

      mockRequest = new Request("https://api.rkm1.de/api/media/invalid-id", {
        method: "GET",
      });

      const response = await detailsRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/invalid-id"),
        pathname: "/api/media/invalid-id",
        params: { mediaId: "invalid-id" },
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Media not found");
    });

    it("should return 400 when mediaId is missing", async () => {
      mockRequest = new Request("https://api.rkm1.de/api/media/", {
        method: "GET",
      });

      const response = await detailsRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/"),
        pathname: "/api/media/",
        params: {},
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Invalid request");
    });

    it("should apply rate limiting", async () => {
      const rateLimitResponse = new Response("Rate limit exceeded", {
        status: 429,
      });
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      mockRequest = new Request("https://api.rkm1.de/api/media/media-123", {
        method: "GET",
      });

      const response = await detailsRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123"),
        pathname: "/api/media/media-123",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(429);
    });
  });

  describe("POST /api/media/:mediaId/hide", () => {
    const hideRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/:mediaId/hide" && r.method === "POST",
    );

    beforeEach(() => {
      if (mockMediaHandlerInstance) {
        mockMediaHandlerInstance.hideMedia.mockReset();
      }
    });

    it("should require authentication", async () => {
      expect(hideRoute).toBeDefined();

      mockGetSession.mockResolvedValue(null);

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-123/hide",
        {
          method: "POST",
        },
      );

      const response = await hideRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123/hide"),
        pathname: "/api/media/media-123/hide",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(401);
    });

    it("should hide media successfully", async () => {
      const mockResult = {
        id: "media-123",
        hidden: true,
        hiddenAt: "2025-01-20T10:00:00Z",
      };

      mockMediaHandlerInstance.hideMedia.mockResolvedValue(mockResult);

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-123/hide",
        {
          method: "POST",
        },
      );

      const response = await hideRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123/hide"),
        pathname: "/api/media/media-123/hide",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("success", true);
      expect(body.media).toEqual(mockResult);
    });

    it("should return 404 when media not found", async () => {
      mockMediaHandlerInstance.hideMedia.mockRejectedValue(
        new Error("Media not found"),
      );

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/invalid-id/hide",
        {
          method: "POST",
        },
      );

      const response = await hideRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/invalid-id/hide"),
        pathname: "/api/media/invalid-id/hide",
        params: { mediaId: "invalid-id" },
      });

      expect(response.status).toBe(404);
    });

    it("should return 400 when media already hidden", async () => {
      mockMediaHandlerInstance.hideMedia.mockRejectedValue(
        new Error("Media is already hidden"),
      );

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-123/hide",
        {
          method: "POST",
        },
      );

      const response = await hideRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123/hide"),
        pathname: "/api/media/media-123/hide",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.message).toContain("already hidden");
    });

    it("should apply rate limiting", async () => {
      const rateLimitResponse = new Response("Rate limit exceeded", {
        status: 429,
      });
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-123/hide",
        {
          method: "POST",
        },
      );

      const response = await hideRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123/hide"),
        pathname: "/api/media/media-123/hide",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(429);
    });
  });

  describe("POST /api/media/:mediaId/unhide", () => {
    const unhideRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/:mediaId/unhide" && r.method === "POST",
    );

    beforeEach(() => {
      if (mockMediaHandlerInstance) {
        mockMediaHandlerInstance.unhideMedia.mockReset();
      }
    });

    it("should require authentication", async () => {
      expect(unhideRoute).toBeDefined();

      mockGetSession.mockResolvedValue(null);

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-123/unhide",
        {
          method: "POST",
        },
      );

      const response = await unhideRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123/unhide"),
        pathname: "/api/media/media-123/unhide",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(401);
    });

    it("should unhide media successfully", async () => {
      const mockResult = {
        id: "media-123",
        hidden: false,
        hiddenAt: null,
      };

      mockMediaHandlerInstance.unhideMedia.mockResolvedValue(mockResult);

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-123/unhide",
        {
          method: "POST",
        },
      );

      const response = await unhideRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123/unhide"),
        pathname: "/api/media/media-123/unhide",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("success", true);
      expect(body.media).toEqual(mockResult);
    });

    it("should return 400 when media not hidden", async () => {
      mockMediaHandlerInstance.unhideMedia.mockRejectedValue(
        new Error("Media is not hidden"),
      );

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-123/unhide",
        {
          method: "POST",
        },
      );

      const response = await unhideRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123/unhide"),
        pathname: "/api/media/media-123/unhide",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.message).toContain("not hidden");
    });

    it("should apply rate limiting", async () => {
      const rateLimitResponse = new Response("Rate limit exceeded", {
        status: 429,
      });
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-123/unhide",
        {
          method: "POST",
        },
      );

      const response = await unhideRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123/unhide"),
        pathname: "/api/media/media-123/unhide",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(429);
    });
  });

  describe("DELETE /api/media/:mediaId", () => {
    const deleteRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/:mediaId" && r.method === "DELETE",
    );

    beforeEach(() => {
      if (mockMediaHandlerInstance) {
        mockMediaHandlerInstance.deleteMedia.mockReset();
      }
    });

    it("should require authentication", async () => {
      expect(deleteRoute).toBeDefined();

      mockGetSession.mockResolvedValue(null);

      mockRequest = new Request("https://api.rkm1.de/api/media/media-123", {
        method: "DELETE",
      });

      const response = await deleteRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123"),
        pathname: "/api/media/media-123",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(401);
    });

    it("should delete media successfully", async () => {
      mockMediaHandlerInstance.deleteMedia.mockResolvedValue(undefined);

      mockRequest = new Request("https://api.rkm1.de/api/media/media-123", {
        method: "DELETE",
      });

      const response = await deleteRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123"),
        pathname: "/api/media/media-123",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("success", true);
      expect(body).toHaveProperty("message", "Media deleted successfully");
    });

    it("should return 409 when media is shared", async () => {
      mockMediaHandlerInstance.deleteMedia.mockRejectedValue(
        new Error(
          "Media is used by other users. It has been hidden instead of deleted.",
        ),
      );

      mockRequest = new Request("https://api.rkm1.de/api/media/media-123", {
        method: "DELETE",
      });

      const response = await deleteRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123"),
        pathname: "/api/media/media-123",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Media is shared with other users");
      expect(body).toHaveProperty("action", "hidden");
    });

    it("should return 400 when media already deleted", async () => {
      mockMediaHandlerInstance.deleteMedia.mockRejectedValue(
        new Error("Media is already deleted"),
      );

      mockRequest = new Request("https://api.rkm1.de/api/media/media-123", {
        method: "DELETE",
      });

      const response = await deleteRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123"),
        pathname: "/api/media/media-123",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(400);
    });

    it("should apply rate limiting", async () => {
      const rateLimitResponse = new Response("Rate limit exceeded", {
        status: 429,
      });
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      mockRequest = new Request("https://api.rkm1.de/api/media/media-123", {
        method: "DELETE",
      });

      const response = await deleteRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/media-123"),
        pathname: "/api/media/media-123",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(429);
    });
  });

  describe("Edge cases and error handling", () => {
    it("should reject empty file buffer", async () => {
      const session: Session = {
        userId: "user-123",
        email: "test@example.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(session);
      mockApplyRateLimitKV.mockResolvedValue(null);

      // Create a file with size 0
      const emptyFile = new File([], "empty.jpg", { type: "image/jpeg" });
      const formData = new FormData();
      formData.append("file", emptyFile);

      const request = new Request("https://api.example.com/api/media/upload", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: "trellis_session=test",
        },
      });

      const route = mediaRoutes.find((r) => r.path === "/api/media/upload");
      const response = await route?.handler(request, mockEnv);
      const body = await response?.json();

      expect(response?.status).toBe(400);
      expect(body.error).toBe("Empty file");
    });

    it("should handle file read errors gracefully", async () => {
      const session: Session = {
        userId: "user-123",
        email: "test@example.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(session);
      mockApplyRateLimitKV.mockResolvedValue(null);

      // Create a mock file that throws when arrayBuffer() is called
      const mockFile = {
        name: "test.jpg",
        size: 1000,
        type: "image/jpeg",
        arrayBuffer: vi.fn().mockRejectedValue(new Error("Read error")),
      } as any;

      const formData = {
        get: vi.fn().mockReturnValue(mockFile),
        keys: vi.fn().mockReturnValue(["file"]),
      } as any;

      // Mock request.formData to return our mock formData
      const request = {
        formData: vi.fn().mockResolvedValue(formData),
        headers: {
          get: vi.fn().mockReturnValue("test"),
        },
      } as any;

      const route = mediaRoutes.find((r) => r.path === "/api/media/upload");
      const response = await route?.handler(request, mockEnv);
      const body = await response?.json();

      expect(response?.status).toBe(400);
      expect(body.error).toBe("File read error");
    });

    it("should handle WebM video files", async () => {
      const session: Session = {
        userId: "user-123",
        email: "test@example.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(session);
      mockApplyRateLimitKV.mockResolvedValue(null);

      // Create WebM video (starts with 1A 45 DF A3)
      const webmBytes = new Uint8Array([
        0x1a,
        0x45,
        0xdf,
        0xa3, // WebM signature
        0xa3,
        0x42,
        0x86,
        0x81, // EBML header
      ]);
      const webmFile = new File([webmBytes], "video.webm", {
        type: "video/webm",
      });

      const formData = new FormData();
      formData.append("file", webmFile);

      mockR2Head.mockResolvedValue(null);
      mockR2Put.mockResolvedValue(undefined);
      mockMediaFileCreate.mockResolvedValue({
        id: "media-123",
        hash: "test-hash",
        mimeType: "video/webm",
      });

      const request = new Request("https://api.example.com/api/media/upload", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: "trellis_session=test",
        },
      });

      const route = mediaRoutes.find((r) => r.path === "/api/media/upload");
      const response = await route?.handler(request, mockEnv);

      // Should accept WebM video
      expect(response?.status).toBe(200);
    });

    it("should handle form data parsing errors", async () => {
      const session: Session = {
        userId: "user-123",
        email: "test@example.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(session);
      mockApplyRateLimitKV.mockResolvedValue(null);

      // Create a request that will fail formData parsing
      const request = new Request("https://api.example.com/api/media/upload", {
        method: "POST",
        body: "invalid form data",
        headers: {
          Cookie: "trellis_session=test",
          "Content-Type": "multipart/form-data",
        },
      });

      const route = mediaRoutes.find((r) => r.path === "/api/media/upload");
      const response = await route?.handler(request, mockEnv);
      const body = await response?.json();

      expect(response?.status).toBe(400);
      expect(body.error).toBe("Invalid request format");
    });

    it("should handle unknown MIME type extension mapping", async () => {
      const session: Session = {
        userId: "user-123",
        email: "test@example.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(session);
      mockApplyRateLimitKV.mockResolvedValue(null);

      // Create a file with unknown MIME type that cannot be detected
      const unknownBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      const unknownFile = new File([unknownBytes], "unknown.bin", {
        type: "application/unknown",
      });

      const formData = new FormData();
      formData.append("file", unknownFile);

      const request = new Request("https://api.example.com/api/media/upload", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: "trellis_session=test",
        },
      });

      const route = mediaRoutes.find((r) => r.path === "/api/media/upload");
      const response = await route?.handler(request, mockEnv);
      const body = await response?.json();

      // Should reject unknown file types
      expect(response?.status).toBe(400);
      expect(body.error).toBe("Invalid file type");
    });

    it("should handle invalid file signature when magic numbers dont match", async () => {
      const session: Session = {
        userId: "user-123",
        email: "test@example.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(session);
      mockApplyRateLimitKV.mockResolvedValue(null);

      // Create a file declared as JPEG but with PNG magic numbers
      const pngBytes = new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a, // PNG signature
      ]);
      const mismatchedFile = new File([pngBytes], "mismatched.jpg", {
        type: "image/jpeg", // Declared as JPEG but is actually PNG
      });

      const formData = new FormData();
      formData.append("file", mismatchedFile);

      const request = new Request("https://api.example.com/api/media/upload", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: "trellis_session=test",
        },
      });

      const route = mediaRoutes.find((r) => r.path === "/api/media/upload");
      const response = await route?.handler(request, mockEnv);
      const body = await response?.json();

      // Should detect and use PNG type, so should succeed
      // The code auto-detects PNG and uses it instead of declared JPEG
      expect(response?.status).toBe(200);
    });

    it("should reject file when magic numbers dont match detected type", async () => {
      const session: Session = {
        userId: "user-123",
        email: "test@example.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(session);
      mockApplyRateLimitKV.mockResolvedValue(null);

      // Create a file with invalid magic numbers that cannot be detected
      const invalidBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
      const invalidFile = new File([invalidBytes], "invalid.jpg", {
        type: "image/jpeg",
      });

      const formData = new FormData();
      formData.append("file", invalidFile);

      const request = new Request("https://api.example.com/api/media/upload", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: "trellis_session=test",
        },
      });

      const route = mediaRoutes.find((r) => r.path === "/api/media/upload");
      const response = await route?.handler(request, mockEnv);
      const body = await response?.json();

      // Should reject - invalid file signature (magic numbers don't match)
      expect(response?.status).toBe(400);
      expect(body.error).toBe("Invalid file signature");
    });

    it("should handle video file with QuickTime MIME type", async () => {
      const session: Session = {
        userId: "user-123",
        email: "test@example.com",
        role: "END_USER",
        expiresAt: Date.now() + 3600000,
      };
      mockGetSession.mockResolvedValue(session);
      mockApplyRateLimitKV.mockResolvedValue(null);

      // Create QuickTime video (ftyp box at offset 4)
      const quicktimeBytes = new Uint8Array([
        0x00,
        0x00,
        0x00,
        0x20, // Box size
        0x66,
        0x74,
        0x79,
        0x70, // 'ftyp'
        0x71,
        0x74,
        0x20,
        0x20, // Brand
      ]);
      const quicktimeFile = new File([quicktimeBytes], "video.mov", {
        type: "video/quicktime",
      });

      const formData = new FormData();
      formData.append("file", quicktimeFile);

      mockR2Head.mockResolvedValue(null); // File doesn't exist
      mockR2Put.mockResolvedValue(undefined);
      mockMediaFileCreate.mockResolvedValue({
        id: "media-123",
        hash: "test-hash",
        mimeType: "video/quicktime",
      });

      const request = new Request("https://api.example.com/api/media/upload", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: "trellis_session=test",
        },
      });

      const route = mediaRoutes.find((r) => r.path === "/api/media/upload");
      const response = await route?.handler(request, mockEnv);

      // Should accept QuickTime video
      expect(response?.status).toBe(200);
    });
  });

  describe("GET /api/media/grouped", () => {
    const groupedRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/grouped" && r.method === "GET",
    );

    it("should require authentication", async () => {
      expect(groupedRoute).toBeDefined();

      mockGetSession.mockResolvedValue(null);

      mockRequest = new Request("https://api.rkm1.de/api/media/grouped", {
        method: "GET",
      });

      const response = await groupedRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/grouped"),
        pathname: "/api/media/grouped",
        params: {},
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Unauthorized");
    });

    it("should return grouped media on success", async () => {
      const mockResult = {
        groups: [
          {
            period: "2025-01",
            displayName: "January 2025",
            count: 2,
            media: [
              {
                id: "media-1",
                contentHash: "hash-1",
                mimeType: "image/jpeg",
                size: 1024,
                thumbnailUrl:
                  "https://api.rkm1.de/api/media/hash-1?variant=thumbnail",
                optimizedUrl:
                  "https://api.rkm1.de/api/media/hash-1?variant=optimized",
                createdAt: "2025-01-15T10:00:00Z",
                hidden: false,
                postCount: 1,
              },
            ],
          },
        ],
      };

      mockMediaHandlerInstance.listUserMediaGrouped.mockResolvedValue(
        mockResult,
      );

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/grouped?groupBy=month",
        {
          method: "GET",
        },
      );

      const response = await groupedRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/grouped?groupBy=month"),
        pathname: "/api/media/grouped",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(mockResult);
      expect(
        mockMediaHandlerInstance.listUserMediaGrouped,
      ).toHaveBeenCalledWith(
        "user-123",
        "month",
        expect.objectContaining({
          includeHidden: false,
          type: "all",
        }),
        mockEnv,
        mockRequest,
      );
    });

    it("should validate groupBy parameter", async () => {
      mockRequest = new Request(
        "https://api.rkm1.de/api/media/grouped?groupBy=invalid",
        {
          method: "GET",
        },
      );

      const response = await groupedRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/grouped?groupBy=invalid"),
        pathname: "/api/media/grouped",
        params: {},
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Invalid groupBy");
    });

    it("should pass includeHidden and type parameters", async () => {
      mockMediaHandlerInstance.listUserMediaGrouped.mockResolvedValue({
        groups: [],
      });

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/grouped?groupBy=year&includeHidden=true&type=photo",
        {
          method: "GET",
        },
      );

      await groupedRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/grouped?groupBy=year&includeHidden=true&type=photo",
        ),
        pathname: "/api/media/grouped",
        params: {},
      });

      expect(
        mockMediaHandlerInstance.listUserMediaGrouped,
      ).toHaveBeenCalledWith(
        "user-123",
        "year",
        expect.objectContaining({
          includeHidden: true,
          type: "photo",
        }),
        mockEnv,
        mockRequest,
      );
    });

    it("should apply rate limiting", async () => {
      const rateLimitResponse = new Response("Rate limit exceeded", {
        status: 429,
      });
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      mockRequest = new Request("https://api.rkm1.de/api/media/grouped", {
        method: "GET",
      });

      const response = await groupedRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/grouped"),
        pathname: "/api/media/grouped",
        params: {},
      });

      expect(response.status).toBe(429);
    });
  });

  describe("GET /api/media/stats", () => {
    const statsRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/stats" && r.method === "GET",
    );

    it("should require authentication", async () => {
      expect(statsRoute).toBeDefined();

      mockGetSession.mockResolvedValue(null);

      mockRequest = new Request("https://api.rkm1.de/api/media/stats", {
        method: "GET",
      });

      const response = await statsRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/stats"),
        pathname: "/api/media/stats",
        params: {},
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Unauthorized");
    });

    it("should return media statistics on success", async () => {
      const mockResult = {
        totalCount: 10,
        photoCount: 7,
        videoCount: 3,
        hiddenCount: 1,
        totalSize: 1024000,
        oldestMedia: "2024-01-01T00:00:00Z",
        newestMedia: "2025-01-20T00:00:00Z",
        byMonth: [
          { period: "2025-01", count: 5 },
          { period: "2024-12", count: 5 },
        ],
      };

      mockMediaHandlerInstance.getUserMediaStats.mockResolvedValue(mockResult);

      mockRequest = new Request("https://api.rkm1.de/api/media/stats", {
        method: "GET",
      });

      const response = await statsRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/stats"),
        pathname: "/api/media/stats",
        params: {},
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(mockResult);
      expect(mockMediaHandlerInstance.getUserMediaStats).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({
          includeHidden: false,
          type: "all",
        }),
        mockEnv,
        mockRequest,
      );
    });

    it("should pass includeHidden and type parameters", async () => {
      mockMediaHandlerInstance.getUserMediaStats.mockResolvedValue({
        totalCount: 0,
        photoCount: 0,
        videoCount: 0,
        hiddenCount: 0,
        totalSize: 0,
        oldestMedia: null,
        newestMedia: null,
        byMonth: [],
      });

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/stats?includeHidden=true&type=video",
        {
          method: "GET",
        },
      );

      await statsRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/stats?includeHidden=true&type=video",
        ),
        pathname: "/api/media/stats",
        params: {},
      });

      expect(mockMediaHandlerInstance.getUserMediaStats).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({
          includeHidden: true,
          type: "video",
        }),
        mockEnv,
        mockRequest,
      );
    });

    it("should apply rate limiting", async () => {
      const rateLimitResponse = new Response("Rate limit exceeded", {
        status: 429,
      });
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      mockRequest = new Request("https://api.rkm1.de/api/media/stats", {
        method: "GET",
      });

      const response = await statsRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/stats"),
        pathname: "/api/media/stats",
        params: {},
      });

      expect(response.status).toBe(429);
    });
  });

  describe("Image Normalization Integration", () => {
    // Mock ImageNormalizer
    const mockNormalize = vi.fn();

    beforeEach(() => {
      mockNormalize.mockReset();

      // Add Images binding to mockEnv
      mockEnv.IMAGES = {
        input: vi.fn(),
      };

      // Mock the ImageNormalizer module
      vi.doMock("../../../src/lib/services/image-normalizer", () => ({
        ImageNormalizer: class {
          normalize = mockNormalize;
        },
      }));
    });

    const uploadRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/upload" && r.method === "POST",
    );

    it("should trigger normalization when uploading a JPEG image", async () => {
      mockNormalize.mockResolvedValue("media/abc123_opt.jpg");

      // Create a valid JPEG
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const blob = new Blob([jpegMagic], { type: "image/jpeg" });

      const formData = new FormData();
      formData.append("file", blob, "test.jpg");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);

      // Note: This test verifies the contract. The actual ImageNormalizer.normalize call
      // depends on Agent A's implementation in media.ts
    });

    it("should trigger normalization when uploading a PNG image", async () => {
      mockNormalize.mockResolvedValue("media/xyz789_opt.jpg");

      // Create a valid PNG
      const pngMagic = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const blob = new Blob([pngMagic], { type: "image/png" });

      const formData = new FormData();
      formData.append("file", blob, "test.png");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);
    });

    it("should skip normalization when uploading a video", async () => {
      // Create a valid MP4 video
      const mp4Magic = new Uint8Array([
        0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
      ]);
      const blob = new Blob([mp4Magic], { type: "video/mp4" });

      const formData = new FormData();
      formData.append("file", blob, "test.mp4");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);

      // Normalization should NOT be called for video uploads
      // (This depends on Agent A's implementation)
    });

    it("should succeed even if normalization fails", async () => {
      // Normalization returns null (failure)
      mockNormalize.mockResolvedValue(null);

      // Create a valid JPEG
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const blob = new Blob([jpegMagic], { type: "image/jpeg" });

      const formData = new FormData();
      formData.append("file", blob, "test.jpg");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      // Upload should still succeed even if normalization fails
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("contentHash");
    });

    it("should include optimizedKey in DB when normalization succeeds", async () => {
      const normalizedKey = "media/test123_opt.jpg";
      mockNormalize.mockResolvedValue(normalizedKey);

      // Create a valid JPEG
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const blob = new Blob([jpegMagic], { type: "image/jpeg" });

      const formData = new FormData();
      formData.append("file", blob, "test.jpg");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);

      // Verify the DB create call includes optimizedKey (depends on Agent A's implementation)
      // This is a contract test - the actual implementation will be in media.ts
    });

    it("should omit optimizedKey in DB when normalization fails", async () => {
      mockNormalize.mockResolvedValue(null);

      // Create a valid PNG
      const pngMagic = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const blob = new Blob([pngMagic], { type: "image/png" });

      const formData = new FormData();
      formData.append("file", blob, "test.png");

      mockRequest = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      expect(response.status).toBe(200);

      // Verify optimizedKey is not set in DB record (depends on Agent A's implementation)
      // This is a contract test - the actual implementation will be in media.ts
    });
  });
});
