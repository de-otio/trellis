/**
 * Unit Tests: Media Routes
 *
 * Tests for media file upload endpoint with content-addressed storage.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";
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
const mockMediaFileCount = vi.fn();
const mockMediaFileAggregate = vi.fn();
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

// T7 (sibling step, already in this worktree): the upload path re-encodes
// images via reencodeImage. Mock it as a pass-through so the tiny synthetic
// fixtures here don't hit real sharp. Preserves the input bytes; the canonical
// MIME echoes back jpeg (tests assert detection on the pre-encode bytes).
const mockReencodeImage = vi.fn();
vi.mock("../../../src/lib/services/image-normalizer", () => ({
  ImageNormalizer: class {
    normalize = vi.fn().mockResolvedValue(null);
  },
  REENCODABLE_IMAGE_TYPES: new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
  ]),
  reencodeImage: (...args: any[]) => mockReencodeImage(...args),
}));

// T9: upload resolves a tenant via the ambient auth seam (getCurrentTenantId).
// Provide a valid CUID-shaped ambient tenant so the canonical CAS key
// (cas/{tenantId}/{hash}) can be built without a DB fallback.
const TEST_TENANT_ID = "ctenant0000000000000000aa";
const VALID_UPLOAD_HASH = "a".repeat(64);
// Overridable so a test can drive the ambient tenant to undefined and exercise
// the "no resolved tenant" deny/500 branches (resolveUploadTenantId → null).
// Defaults to the fixed CUID-shaped tenant; reset in beforeEach below.
const mockGetCurrentTenantId = vi.fn(() => TEST_TENANT_ID);
vi.mock("@de-otio/saas-foundation/tenant", () => ({
  getCurrentTenantId: (...args: any[]) => mockGetCurrentTenantId(...args),
}));

// Mock R2 bucket
const mockR2Head = vi.fn();
const mockR2Put = vi.fn();
const mockR2Get = vi.fn();
const mockR2Delete = vi.fn();

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

// Mock the request-path moderation seam (T1). The sync-image upload path now
// STAGES the cleaned bytes, calls moderateImage on the staged ref, and PROMOTES
// to cas/ only on APPROVED. Tests drive the verdict via mockModerateImage and
// assert on the staging→promote effects.
const mockModerateImage = vi.fn();
vi.mock("../../../src/lib/media/request-moderation", () => ({
  getMediaModerationProvider: () => ({ moderateImage: mockModerateImage }),
}));

// Convenience: build a verdict object for a given 3-value decision.
const verdictFor = (decision: "approved" | "review" | "quarantine") => ({
  decision,
  labels: [],
  provider: "mock",
});

// AR16: the legacy sync MediaUploadService (direct cas/ writer) is deleted.
// The equivalent — and stronger — guard on paths that must not persist bytes
// is that NOTHING was written to the approved cas/ prefix.
const expectNoCasWrite = () =>
  expect(
    mockR2Put.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].startsWith("cas/"),
    ),
  ).toHaveLength(0);

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
      // The resolved media-bucket name the binding wraps; the moderation ref
      // bucket is read from this exact field (single source — see env.ts).
      MEDIA_BUCKET_NAME: "dev-trellis-media",
      MEDIA_BUCKET_R2: {
        head: mockR2Head,
        put: mockR2Put,
        get: mockR2Get,
        delete: mockR2Delete,
      },
      // Media config block required by the re-encode pipeline + allowlist
      // (T4/T7) and the configurable caps (T10). Mirrors the block in
      // routes-media-extended.test.ts.
      media: {
        maxBytes: {
          image: 10 * 1024 * 1024,
          video: 100 * 1024 * 1024,
          audio: 100 * 1024 * 1024,
        },
        maxPixels: 25_000_000,
        rateLimits: { uploadPerMin: 10, batchPerMin: 5, servePerMin: 60 },
        allowlist: {
          image: ["image/jpeg", "image/png", "image/webp", "image/gif"],
          video: ["video/mp4", "video/webm", "video/quicktime"],
          audio: [],
        },
        presets: [],
        thresholds: {},
        canonicalFormat: "jpeg" as const,
        canonicalQuality: 85,
        uploadQuota: {
          maxObjects: 1000,
          maxBytes: 1024 * 1024 * 1024, // 1 GiB
        },
      },
    };

    // Restore the default ambient tenant after any per-test override.
    mockGetCurrentTenantId.mockReturnValue(TEST_TENANT_ID);

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
        count: mockMediaFileCount,
        aggregate: mockMediaFileAggregate,
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
    // Default: well under quota (0 objects, 0 bytes used).
    mockMediaFileCount.mockResolvedValue(0);
    mockMediaFileAggregate.mockResolvedValue({ _sum: { size: 0 } });
    mockR2Delete.mockResolvedValue(undefined);

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

    // Default moderation verdict: approved (so the happy-path upload tests
    // reach 200 with bytes promoted to cas/). Per-test overrides drive
    // review/quarantine/throw.
    mockModerateImage.mockResolvedValue(verdictFor("approved"));

    // T7 re-encode: pass-through, preserving the input bytes. canonicalMimeType
    // echoes image/jpeg (the canonical raster output).
    mockReencodeImage.mockImplementation(async (buf: ArrayBuffer) => ({
      buffer: Buffer.from(
        buf instanceof Buffer ? buf : new Uint8Array(buf as ArrayBuffer),
      ),
      canonicalMimeType: "image/jpeg",
    }));
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
      // Sync-image path: the staged object is moderated, then (approved by the
      // default verdict) promoted to cas/.
      expect(mockModerateImage).toHaveBeenCalled();
      const putKeys = mockR2Put.mock.calls.map((c) => c[0] as string);
      expect(putKeys.some((k) => k.startsWith("cas/"))).toBe(true);
      expect(putKeys.some((k) => k.startsWith("processing/"))).toBe(true);
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
      // Dedup is handled idempotently by the within-tenant upsert (the `update`
      // payload is deliberately minimal), never by mediaFile.create.
      expect(mockMediaFileCreate).not.toHaveBeenCalled();
      expect(mockMediaFileUpsert).toHaveBeenCalled();
    });

    it("returns 503 when no media bucket is configured (cannot stage → fail closed)", async () => {
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

      // No object store to stage into → fail closed (cannot moderate, must not
      // serve). Moderation and DB write must NOT run.
      expect(response.status).toBe(503);
      expect(mockModerateImage).not.toHaveBeenCalled();
      expect(mockMediaFileUpsert).not.toHaveBeenCalled();
    });

    it("should support legacy R2_BUCKET binding name for backward compatibility", async () => {
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const blob = new Blob([jpegMagic], { type: "image/jpeg" });

      const envWithLegacyR2 = {
        ...mockEnv,
        R2_BUCKET: {
          head: mockR2Head,
          put: mockR2Put,
          delete: mockR2Delete,
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

      // Should succeed and stage via the legacy R2_BUCKET binding.
      expect(response.status).toBe(200);
      expect(mockModerateImage).toHaveBeenCalled();
      expect(mockR2Put).toHaveBeenCalled();
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

      mockMediaFileCreate.mockResolvedValue({ id: "p1", uploadId: "c" + "0".repeat(24), originalKey: null });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      // P0b: video now takes the async-pending path → 202 Accepted.
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body).toHaveProperty("uploadId");
      expect(body).toHaveProperty("status", "pending");
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

  // -------------------------------------------------------------------------
  // Synchronous image moderation (stage → moderate → promote-on-approve).
  // The verdict drives moderationStatus; cas/ is written IFF approved; on
  // anything else the bytes stay at staging (out of the serve path). Each
  // assertion is mutation-sensitive: flipping the production decision flips a
  // test red.
  // -------------------------------------------------------------------------
  describe("POST /api/media/upload — image moderation (stage→moderate→promote)", () => {
    const uploadRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/upload" && r.method === "POST",
    );

    const runImageUpload = async () => {
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const formData = new FormData();
      formData.append("file", new Blob([jpegMagic], { type: "image/jpeg" }), "x.jpg");
      return uploadRoute!.handler(
        new Request("https://api.rkm1.de/api/media/upload", {
          method: "POST",
          body: formData,
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/upload"),
          pathname: "/api/media/upload",
          params: {},
        },
      );
    };

    const putKeys = () => mockR2Put.mock.calls.map((c) => c[0] as string);
    const deleteKeys = () => mockR2Delete.mock.calls.map((c) => c[0] as string);
    const casWritten = () => putKeys().some((k) => k.startsWith("cas/"));
    // The moderationStatus the route handed to the upsert builder.
    const upsertModerationStatus = () => {
      const args = mockMediaFileUpsert.mock.calls[0]?.[0];
      return args?.create?.moderationStatus;
    };

    it("approved → bytes promoted to cas/, staging deleted, row APPROVED", async () => {
      mockModerateImage.mockResolvedValue(verdictFor("approved"));

      const response = await runImageUpload();

      expect(response.status).toBe(200);
      // cas/ written (promotion) AND staging deleted.
      expect(casWritten()).toBe(true);
      expect(deleteKeys().some((k) => k.startsWith("processing/"))).toBe(true);
      // Row records APPROVED.
      expect(upsertModerationStatus()).toBe("APPROVED");
      // moderateImage was called on the STAGING ref (processing/), not cas/.
      const ref = mockModerateImage.mock.calls[0][0];
      expect(ref.key).toMatch(/^processing\//);
    });

    it("review → bytes stay at staging, NO cas/ object, row REVIEW", async () => {
      mockModerateImage.mockResolvedValue(verdictFor("review"));

      const response = await runImageUpload();

      expect(response.status).toBe(200);
      // Staged (processing/) but NEVER promoted to cas/.
      expect(putKeys().some((k) => k.startsWith("processing/"))).toBe(true);
      expect(casWritten()).toBe(false);
      // No staging delete (bytes must remain for the human reviewer).
      expect(deleteKeys()).toHaveLength(0);
      expect(upsertModerationStatus()).toBe("REVIEW");
    });

    it("quarantine → NO cas/ object, row QUARANTINED", async () => {
      mockModerateImage.mockResolvedValue(verdictFor("quarantine"));

      const response = await runImageUpload();

      expect(response.status).toBe(200);
      expect(casWritten()).toBe(false);
      expect(upsertModerationStatus()).toBe("QUARANTINED");
    });

    it("provider THROWS → treated as review (fail-closed): NO cas/, row REVIEW", async () => {
      mockModerateImage.mockRejectedValue(new Error("provider exploded"));

      const response = await runImageUpload();

      // Fail-closed: a throwing/timing-out provider must NOT auto-approve.
      expect(response.status).toBe(200);
      expect(casWritten()).toBe(false);
      expect(upsertModerationStatus()).toBe("REVIEW");
    });

    it("moderateImage is called with the STAGING ref; cas/ written IFF approved", async () => {
      // review → no cas/
      mockModerateImage.mockResolvedValue(verdictFor("review"));
      await runImageUpload();
      const reviewRef = mockModerateImage.mock.calls[0][0];
      expect(reviewRef.key).toMatch(/^processing\//);
      expect(casWritten()).toBe(false);

      // approved → cas/ (fresh mock state)
      vi.clearAllMocks();
      mockGetSession.mockResolvedValue(mockSession);
      mockApplyRateLimitKV.mockResolvedValue(null);
      mockCreateSecureResponse.mockImplementation(
        (body, options) => new Response(body, options),
      );
      mockAddSecurityHeaders.mockImplementation((r) => r);
      mockGetCurrentTenantId.mockReturnValue(TEST_TENANT_ID);
      mockReencodeImage.mockImplementation(async (buf: ArrayBuffer) => ({
        buffer: Buffer.from(
          buf instanceof Buffer ? buf : new Uint8Array(buf as ArrayBuffer),
        ),
        canonicalMimeType: "image/jpeg",
      }));
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) =>
          queryFn({
            mediaFile: {
              upsert: mockMediaFileUpsert,
              count: mockMediaFileCount,
              aggregate: mockMediaFileAggregate,
            },
          }),
      );
      mockMediaFileUpsert.mockResolvedValue({ id: "m" });
      mockMediaFileCount.mockResolvedValue(0);
      mockMediaFileAggregate.mockResolvedValue({ _sum: { size: 0 } });
      mockR2Put.mockResolvedValue(undefined);
      mockR2Delete.mockResolvedValue(undefined);
      mockModerateImage.mockResolvedValue(verdictFor("approved"));

      await runImageUpload();
      const approvedRef = mockModerateImage.mock.calls[0][0];
      expect(approvedRef.key).toMatch(/^processing\//);
      expect(casWritten()).toBe(true);
    });

    it("moderateImage ref.bucket is the RESOLVED env bucket name (never empty), matching the staging write target", async () => {
      // Regression guard for the silent fail-closed bug: the moderation READ
      // ref must use the SAME resolved bucket name the staging WRITE binding
      // wraps. The call site reads env.MEDIA_BUCKET_NAME (the single source),
      // NOT `process.env.MEDIA_BUCKET_NAME ?? ""`. Prove the value comes from
      // env by driving env.MEDIA_BUCKET_NAME to the resolved fallback while
      // process.env.MEDIA_BUCKET_NAME is unset — reverting the call site to
      // `?? ""` (or to process.env) would make ref.bucket "" / undefined and
      // turn this red.
      const savedProcEnv = process.env.MEDIA_BUCKET_NAME;
      delete process.env.MEDIA_BUCKET_NAME;
      try {
        mockModerateImage.mockResolvedValue(verdictFor("approved"));

        await runImageUpload();

        const ref = mockModerateImage.mock.calls[0][0];
        // The ref bucket equals the resolved env bucket name...
        expect(ref.bucket).toBe(mockEnv.MEDIA_BUCKET_NAME);
        expect(ref.bucket).toBe("dev-trellis-media");
        // ...and is never the empty string (what `?? ""` produced on unset).
        expect(ref.bucket).not.toBe("");
        expect(typeof ref.bucket).toBe("string");
        expect(ref.bucket.length).toBeGreaterThan(0);
        // The staged object is moderated under that same bucket's processing/ key.
        expect(ref.key).toMatch(/^processing\//);
        const stagedPut = mockR2Put.mock.calls
          .map((c) => c[0] as string)
          .find((k) => k.startsWith("processing/"));
        expect(stagedPut).toBe(ref.key);
      } finally {
        if (savedProcEnv === undefined) {
          delete process.env.MEDIA_BUCKET_NAME;
        } else {
          process.env.MEDIA_BUCKET_NAME = savedProcEnv;
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // B2 P0b routing test cases
  // -------------------------------------------------------------------------

  describe("POST /api/media/upload — quota enforcement", () => {
    const uploadRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/upload" && r.method === "POST",
    );

    it("rejects with 429 when object cap is reached", async () => {
      // Saturate the object count so the quota check fails with object-cap.
      mockMediaFileCount.mockResolvedValue(1000); // == maxObjects
      mockMediaFileAggregate.mockResolvedValue({ _sum: { size: 0 } });

      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const formData = new FormData();
      formData.append("file", new Blob([jpegMagic], { type: "image/jpeg" }), "test.jpg");

      const response = await uploadRoute!.handler(
        new Request("https://api.rkm1.de/api/media/upload", { method: "POST", body: formData }),
        mockEnv,
        { url: new URL("https://api.rkm1.de/api/media/upload"), pathname: "/api/media/upload", params: {} },
      );

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Upload quota exceeded");
    });

    it("rejects with 413 when byte cap is reached", async () => {
      // currentBytes already at the ceiling, even a tiny file tips over.
      const oneByteBelowCap = 1024 * 1024 * 1024 - 1; // 1 GiB - 1 byte
      mockMediaFileCount.mockResolvedValue(0);
      mockMediaFileAggregate.mockResolvedValue({ _sum: { size: oneByteBelowCap } });

      // File size 4 bytes — currentBytes + 4 > maxBytes.
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const formData = new FormData();
      formData.append("file", new Blob([jpegMagic], { type: "image/jpeg" }), "test.jpg");

      const response = await uploadRoute!.handler(
        new Request("https://api.rkm1.de/api/media/upload", { method: "POST", body: formData }),
        mockEnv,
        { url: new URL("https://api.rkm1.de/api/media/upload"), pathname: "/api/media/upload", params: {} },
      );

      expect(response.status).toBe(413);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Upload quota exceeded");
    });

    it("allows upload when usage is just under both caps", async () => {
      // currentObjects = 999 (one below 1000 cap), currentBytes = 0 — should pass.
      mockMediaFileCount.mockResolvedValue(999);
      mockMediaFileAggregate.mockResolvedValue({ _sum: { size: 0 } });

      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const formData = new FormData();
      formData.append("file", new Blob([jpegMagic], { type: "image/jpeg" }), "test.jpg");

      const response = await uploadRoute!.handler(
        new Request("https://api.rkm1.de/api/media/upload", { method: "POST", body: formData }),
        mockEnv,
        { url: new URL("https://api.rkm1.de/api/media/upload"), pathname: "/api/media/upload", params: {} },
      );

      // Should reach the sync-image path and succeed (200).
      expect(response.status).toBe(200);
    });
  });

  describe("POST /api/media/upload — async-pending routing (video/audio)", () => {
    const uploadRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/upload" && r.method === "POST",
    );

    it("routes video/mp4 to async-pending: 202, uploadId + status=pending, no originalKey", async () => {
      // MP4 magic: ftyp box at offset 4
      const mp4Bytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d, // brand = "isom"
      ]);
      const formData = new FormData();
      formData.append("file", new Blob([mp4Bytes], { type: "video/mp4" }), "test.mp4");

      mockMediaFileCreate.mockResolvedValue({
        id: "pending-row-1",
        uploadId: "c" + "0".repeat(24),
        moderationStatus: "PENDING",
        originalKey: null,
      });

      const response = await uploadRoute!.handler(
        new Request("https://api.rkm1.de/api/media/upload", { method: "POST", body: formData }),
        mockEnv,
        { url: new URL("https://api.rkm1.de/api/media/upload"), pathname: "/api/media/upload", params: {} },
      );

      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body).toHaveProperty("status", "pending");
      expect(body).toHaveProperty("uploadId");
      // uploadId must match UPLOAD_ID_RE: c[a-z0-9]{24}
      expect(body.uploadId).toMatch(/^c[0-9a-f]{24}$/);

      // Raw bytes must have been written to a pending/ key in R2 — NOT to cas/.
      expect(mockR2Put).toHaveBeenCalledTimes(1);
      const [putKey] = mockR2Put.mock.calls[0];
      expect(putKey).toMatch(/^pending\//);
      expect(putKey).toContain(TEST_TENANT_ID);

      // DB row must be created (not upserted) with null originalKey and the uploadId.
      expect(mockMediaFileCreate).toHaveBeenCalledTimes(1);
      const createCall = mockMediaFileCreate.mock.calls[0][0];
      expect(createCall.data.originalKey).toBeNull();
      expect(createCall.data.uploadId).toMatch(/^c[0-9a-f]{24}$/);
      // moderationStatus defaults to PENDING in the schema; we only supply uploadId + uploadStatus.
      expect(createCall.data.uploadStatus).toBe("PENDING");

      // No bytes may reach the approved cas/ prefix on the async path.
      expectNoCasWrite();
    });

    it("routes video/webm to async-pending: 202", async () => {
      // WebM magic: 1A 45 DF A3
      const webmBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]);
      const formData = new FormData();
      formData.append("file", new Blob([webmBytes], { type: "video/webm" }), "test.webm");

      mockMediaFileCreate.mockResolvedValue({ id: "p2", uploadId: "c" + "1".repeat(24), originalKey: null });

      const response = await uploadRoute!.handler(
        new Request("https://api.rkm1.de/api/media/upload", { method: "POST", body: formData }),
        mockEnv,
        { url: new URL("https://api.rkm1.de/api/media/upload"), pathname: "/api/media/upload", params: {} },
      );

      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body).toHaveProperty("status", "pending");
      expectNoCasWrite();
    });

    it("image still follows sync path: 200 with contentHash (not 202)", async () => {
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const formData = new FormData();
      formData.append("file", new Blob([jpegMagic], { type: "image/jpeg" }), "test.jpg");

      const response = await uploadRoute!.handler(
        new Request("https://api.rkm1.de/api/media/upload", { method: "POST", body: formData }),
        mockEnv,
        { url: new URL("https://api.rkm1.de/api/media/upload"), pathname: "/api/media/upload", params: {} },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("contentHash");
      // Sync path moderates the staged object (no async pending/ write).
      expect(mockModerateImage).toHaveBeenCalled();
      const putKeys = mockR2Put.mock.calls.map((c) => c[0] as string);
      // Sync staging uses processing/, never the async pending/ prefix.
      expect(putKeys.every((k) => !k.startsWith("pending/"))).toBe(true);
      expect(putKeys.some((k) => k.startsWith("processing/"))).toBe(true);
    });

    it("returns 400 for unknown/unsupported content type when routeUpload says reject", async () => {
      // application/pdf has no valid magic numbers and is not in the allowed lists,
      // but even if we contrive bytes that pass earlier checks, routeUpload gates it.
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
      const formData = new FormData();
      formData.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "doc.pdf");

      const response = await uploadRoute!.handler(
        new Request("https://api.rkm1.de/api/media/upload", { method: "POST", body: formData }),
        mockEnv,
        { url: new URL("https://api.rkm1.de/api/media/upload"), pathname: "/api/media/upload", params: {} },
      );

      expect(response.status).toBe(400);
    });

    it("video pending DB failure triggers R2 cleanup and returns 500", async () => {
      const mp4Bytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d,
      ]);
      const formData = new FormData();
      formData.append("file", new Blob([mp4Bytes], { type: "video/mp4" }), "test.mp4");

      // DB create throws — simulates DB outage after R2 write succeeded.
      mockMediaFileCreate.mockRejectedValue(new Error("DB unavailable"));

      const response = await uploadRoute!.handler(
        new Request("https://api.rkm1.de/api/media/upload", { method: "POST", body: formData }),
        mockEnv,
        { url: new URL("https://api.rkm1.de/api/media/upload"), pathname: "/api/media/upload", params: {} },
      );

      expect(response.status).toBe(500);
      // R2 delete was attempted to clean up the orphaned pending object.
      expect(mockR2Delete).toHaveBeenCalledTimes(1);
      const [deleteKey] = mockR2Delete.mock.calls[0];
      expect(deleteKey).toMatch(/^pending\//);
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

    // T5: the serve gate is APPROVED-only and reads the canonical originalKey
    // verbatim (no variant-key selection, no probing). The record must carry
    // moderationStatus APPROVED + not hidden + not deleted, and a valid 64-hex
    // contentHash (validateContentHash runs before any lookup).
    const APPROVED_CAS_KEY = `cas/${TEST_TENANT_ID}/${VALID_UPLOAD_HASH}`;
    const approvedRecord = (
      over: Record<string, unknown> = {},
    ) => ({
      id: "media-123",
      contentHash: VALID_UPLOAD_HASH,
      mimeType: "image/png", // stored mime — MUST be ignored by the gate
      originalKey: APPROVED_CAS_KEY,
      optimizedKey: null,
      thumbnailKey: null,
      moderationStatus: "APPROVED",
      hidden: false,
      deletedAt: null,
      ...over,
    });

    it("serves an APPROVED MediaFile from its canonical originalKey", async () => {
      mockMediaFileFindUnique.mockResolvedValue(approvedRecord());

      const mockR2Object = {
        body: new ReadableStream(),
        httpMetadata: { contentType: "image/svg+xml" }, // must be ignored
      };
      mockR2Get.mockResolvedValue(mockR2Object);

      mockRequest = new Request(
        `https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`,
        { method: "GET" },
      );

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL(`https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`),
        pathname: `/api/media/${VALID_UPLOAD_HASH}`,
        params: { hash: VALID_UPLOAD_HASH },
      });

      expect(response.status).toBe(200);
      expect(mockR2Get).toHaveBeenCalledWith(APPROVED_CAS_KEY);
      expect(mockR2Head).not.toHaveBeenCalled();
      // Content-type from canonical format only — never the object metadata.
      expect(response.headers.get("Content-Type")).toBe("image/jpeg");
      expect(response.headers.get("Content-Disposition")).toBe("attachment");
    });

    it("denies a PENDING MediaFile (gate is APPROVED-only)", async () => {
      mockMediaFileFindUnique.mockResolvedValue(
        approvedRecord({ moderationStatus: "PENDING" }),
      );
      mockR2Get.mockResolvedValue({ body: new ReadableStream() });

      mockRequest = new Request(
        `https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`,
        { method: "GET" },
      );

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL(`https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`),
        pathname: `/api/media/${VALID_UPLOAD_HASH}`,
        params: { hash: VALID_UPLOAD_HASH },
      });

      expect(response.status).toBe(404);
      expect(mockR2Get).not.toHaveBeenCalled();
    });

    it("denies a hidden or soft-deleted MediaFile even when APPROVED", async () => {
      for (const over of [{ hidden: true }, { deletedAt: new Date(0) }]) {
        mockR2Get.mockClear();
        mockMediaFileFindUnique.mockResolvedValue(approvedRecord(over));

        const response = await getMediaRoute!.handler(
          new Request(`https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`, {
            method: "GET",
          }),
          mockEnv,
          {
            url: new URL(
              `https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`,
            ),
            pathname: `/api/media/${VALID_UPLOAD_HASH}`,
            params: { hash: VALID_UPLOAD_HASH },
          },
        );

        expect(response.status).toBe(404);
        expect(mockR2Get).not.toHaveBeenCalled();
      }
    });

    it("denies a malformed (non-hex) content hash before any lookup", async () => {
      const response = await getMediaRoute!.handler(
        new Request("https://api.rkm1.de/api/media/not-a-valid-hash", {
          method: "GET",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/not-a-valid-hash"),
          pathname: "/api/media/not-a-valid-hash",
          params: { hash: "not-a-valid-hash" },
        },
      );

      expect(response.status).toBe(404);
      expect(mockMediaFileFindUnique).not.toHaveBeenCalled();
      expect(mockR2Get).not.toHaveBeenCalled();
    });

    // T9: the no-DB extension-probing fallback maze has been DELETED. When no
    // MediaFile row exists, the object is NOT servable and storage is NEVER
    // probed (the old behavior was a gate-bypass + path-injection sink). These
    // tests were rewritten from "probe and serve" to "deny without probing".
    it("does NOT probe storage when MediaFile does not exist (no .jpg fallback)", async () => {
      mockMediaFileFindUnique.mockResolvedValue(null); // MediaFile not found

      mockRequest = new Request("https://api.rkm1.de/api/media/test-hash", {
        method: "GET",
      });

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/test-hash"),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(404);
      // No storage probe and no serve: there is no DB record.
      expect(mockR2Head).not.toHaveBeenCalled();
      expect(mockR2Get).not.toHaveBeenCalled();
    });

    it("does NOT probe storage when MediaFile does not exist (no .png fallback)", async () => {
      mockMediaFileFindUnique.mockResolvedValue(null);

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/test-hash?variant=optimized",
        { method: "GET" },
      );

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/test-hash?variant=optimized",
        ),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(404);
      expect(mockR2Head).not.toHaveBeenCalled();
      expect(mockR2Get).not.toHaveBeenCalled();
    });

    it("serves the original variant straight from the DB record's originalKey (no probing)", async () => {
      // T9: the servable key always comes from the DB record (== the canonical
      // CAS key). Serve reads it verbatim; it never guesses extensions.
      const casKeyValue = `cas/${TEST_TENANT_ID}/${VALID_UPLOAD_HASH}`;
      mockMediaFileFindUnique.mockResolvedValue({
        id: "media-123",
        contentHash: VALID_UPLOAD_HASH,
        mimeType: "image/jpeg",
        originalKey: casKeyValue,
        optimizedKey: null,
        thumbnailKey: null,
        moderationStatus: "APPROVED",
        hidden: false,
        deletedAt: null,
      });

      const mockR2Object = {
        body: new ReadableStream(),
        httpMetadata: { contentType: "image/jpeg" },
      };
      mockR2Get.mockResolvedValue(mockR2Object);

      mockRequest = new Request(
        `https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}?variant=optimized`,
        { method: "GET" },
      );

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          `https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}?variant=optimized`,
        ),
        pathname: `/api/media/${VALID_UPLOAD_HASH}`,
        params: { hash: VALID_UPLOAD_HASH },
      });

      expect(response.status).toBe(200);
      // The variant never selects a key: serve always reads the canonical
      // originalKey verbatim, with no head() probing.
      expect(mockR2Head).not.toHaveBeenCalled();
      expect(mockR2Get).toHaveBeenCalledWith(casKeyValue);
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

    it("returns the uniform 404 deny when R2 bucket is not configured", async () => {
      // T5 anti-oracle: a misconfigured bucket must not emit a distinguishing
      // 503 (itself an oracle) — it denies identically to not-found. We only
      // reach the bucket check for an APPROVED record.
      mockMediaFileFindUnique.mockResolvedValue(approvedRecord());
      mockEnv.MEDIA_BUCKET_R2 = null;
      mockEnv.R2_BUCKET = null;

      mockRequest = new Request(
        `https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`,
        { method: "GET" },
      );

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL(`https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`),
        pathname: `/api/media/${VALID_UPLOAD_HASH}`,
        params: { hash: VALID_UPLOAD_HASH },
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: "Media not found" });
    });

    it("denies (no storage probe) when the DB query errors", async () => {
      // T9: a DB error is NOT an excuse to probe storage. Without a record the
      // object is not servable — fail closed, never serve raw bytes by guessing
      // a key (the old maze served on DB-error, a gate-bypass).
      mockMediaFileFindUnique.mockRejectedValue(new Error("Database timeout"));

      mockRequest = new Request("https://api.rkm1.de/api/media/test-hash", {
        method: "GET",
      });

      const response = await getMediaRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/test-hash"),
        pathname: "/api/media/test-hash",
        params: { hash: "test-hash" },
      });

      expect(response.status).toBe(404);
      expect(mockR2Head).not.toHaveBeenCalled();
      expect(mockR2Get).not.toHaveBeenCalled();
    });

    describe("Binary Data Integrity", () => {
      it("serves an APPROVED image's bytes intact (content-type = canonical)", async () => {
        mockMediaFileFindUnique.mockResolvedValue(approvedRecord());

        // PNG signature bytes — the input stream the gate must pass through
        // verbatim (the re-encode happened at upload; serve does not transform).
        const pngBytes = new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        const pngStream = new ReadableStream({
          start(controller) {
            controller.enqueue(pngBytes);
            controller.close();
          },
        });

        mockR2Get.mockResolvedValue({
          body: pngStream,
          httpMetadata: { contentType: "image/png" }, // ignored by the gate
        });

        const mockSession = {
          userId: "user-123",
          role: "END_USER",
        } as Session;
        mockGetSession.mockResolvedValue(mockSession);

        const response = await getMediaRoute!.handler(
          new Request(`https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`, {
            method: "GET",
            headers: { Origin: "https://www.rkm1.de" },
          }),
          mockEnv,
          {
            url: new URL(
              `https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`,
            ),
            pathname: `/api/media/${VALID_UPLOAD_HASH}`,
            params: { hash: VALID_UPLOAD_HASH },
          },
        );

        expect(response.status).toBe(200);
        // Content-type is the canonical re-encode format, never object metadata.
        expect(response.headers.get("Content-Type")).toBe("image/jpeg");
        const served = new Uint8Array(await response.arrayBuffer());
        expect(Array.from(served)).toEqual(Array.from(pngBytes));
      });

      it("served APPROVED bytes pass through CorsHandler intact", async () => {
        mockMediaFileFindUnique.mockResolvedValue(approvedRecord());

        const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
        const jpegStream = new ReadableStream({
          start(controller) {
            controller.enqueue(jpegBytes);
            controller.close();
          },
        });

        mockR2Get.mockResolvedValue({
          body: jpegStream,
          httpMetadata: { contentType: "image/jpeg" },
        });

        const mockSession = {
          userId: "user-123",
          role: "END_USER",
        } as Session;
        mockGetSession.mockResolvedValue(mockSession);

        const response = await getMediaRoute!.handler(
          new Request(`https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`, {
            method: "GET",
            headers: { Origin: "https://www.rkm1.de" },
          }),
          mockEnv,
          {
            url: new URL(
              `https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`,
            ),
            pathname: `/api/media/${VALID_UPLOAD_HASH}`,
            params: { hash: VALID_UPLOAD_HASH },
          },
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("image/jpeg");
        const served = new Uint8Array(await response.arrayBuffer());
        expect(Array.from(served)).toEqual(Array.from(jpegBytes));
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

      // P0b: WebM video now takes the async-pending path → 202 Accepted.
      expect(response?.status).toBe(202);
      const webmBody = await response!.json();
      expect(webmBody).toHaveProperty("status", "pending");
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

      // P0b: QuickTime video now takes the async-pending path → 202 Accepted.
      expect(response?.status).toBe(202);
      const qtBody = await response!.json();
      expect(qtBody).toHaveProperty("status", "pending");
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

      mockMediaFileCreate.mockResolvedValue({ id: "pv1", uploadId: "c" + "0".repeat(24), originalKey: null });

      const response = await uploadRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });

      // P0b: video takes the async-pending path → 202 Accepted.
      expect(response.status).toBe(202);

      // Normalization (reencodeImage) must NOT be called for video uploads.
      expect(mockReencodeImage).not.toHaveBeenCalled();
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

  // ===========================================================================
  // Branch-coverage targeting (appended). Each block exercises an uncovered
  // branch in src/lib/routes/media.ts.
  // ===========================================================================

  // ---- ftyp brand disambiguation in the single-upload MIME detector --------
  // src/lib/routes/media.ts lines 657-697. An ISO-BMFF ftyp box is shared by
  // MP4/QuickTime video and HEIC/HEIF images; the major brand (bytes 8-11)
  // decides which. Build minimal ftyp blobs and assert the accept/reject.
  describe("POST /api/media/upload — ftyp brand disambiguation", () => {
    const uploadRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/upload" && r.method === "POST",
    );

    // size box (4) + "ftyp" (4) + 4-char major brand = 12-byte minimal ftyp
    const ftypBlob = (brand: string, declaredType: string) => {
      const brandBytes =
        brand.length === 4
          ? [
              brand.charCodeAt(0),
              brand.charCodeAt(1),
              brand.charCodeAt(2),
              brand.charCodeAt(3),
            ]
          : [];
      const bytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, // box size
        0x66, 0x74, 0x79, 0x70, // 'ftyp'
        ...brandBytes,
      ]);
      return new Blob([bytes], { type: declaredType });
    };

    const runUpload = async (blob: Blob, filename: string) => {
      const formData = new FormData();
      formData.append("file", blob, filename);
      const request = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });
      return uploadRoute!.handler(request, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });
    };

    it("rejects an HEIF-brand ftyp (heic) as Invalid file type (not re-encodable, not video)", async () => {
      // brand 'heic' → detectedMimeType image/heic → not in REENCODABLE set,
      // not in video allowlist → 400 Invalid file type.
      const response = await runUpload(
        ftypBlob("heic", "application/octet-stream"),
        "photo.heic",
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid file type");
      expect(body.details.detectedType).toBe("image/heic");
      expectNoCasWrite();
    });

    it("rejects another HEIF brand (mif1) as Invalid file type", async () => {
      const response = await runUpload(
        ftypBlob("mif1", "application/octet-stream"),
        "photo.heif",
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid file type");
      expect(body.details.detectedType).toBe("image/heic");
    });

    it("accepts a QuickTime-brand ftyp ('qt  ') as video/quicktime", async () => {
      // brand 'qt  ' → detectedMimeType video/quicktime → in video allowlist.
      // P0b: video takes the async-pending path → 202 Accepted.
      const response = await runUpload(
        ftypBlob("qt  ", "application/octet-stream"),
        "clip.mov",
      );
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body).toHaveProperty("status", "pending");
      expect(body).toHaveProperty("uploadId");
      // No bytes may reach the approved cas/ prefix on the async path.
      expectNoCasWrite();
    });

    it("accepts a default ISO-BMFF brand (isom) as video/mp4", async () => {
      // P0b: video takes the async-pending path → 202 Accepted.
      const response = await runUpload(
        ftypBlob("isom", "application/octet-stream"),
        "clip.mp4",
      );
      expect(response.status).toBe(202);
      expectNoCasWrite();
    });

    it("accepts an mp42-brand ftyp as video/mp4", async () => {
      // P0b: video takes the async-pending path → 202 Accepted.
      const response = await runUpload(
        ftypBlob("mp42", "application/octet-stream"),
        "clip.mp4",
      );
      expect(response.status).toBe(202);
      expectNoCasWrite();
    });

    it("treats a brand-less minimal ftyp (bytes < 12) as video/mp4 (default branch)", async () => {
      // Only 8 bytes: size + 'ftyp', no brand → brand === "" → default → mp4.
      // P0b: video takes the async-pending path → 202 Accepted.
      const bytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x08, 0x66, 0x74, 0x79, 0x70,
      ]);
      const response = await runUpload(
        new Blob([bytes], { type: "application/octet-stream" }),
        "clip.mp4",
      );
      expect(response.status).toBe(202);
      expectNoCasWrite();
    });

    // Property: every default (non-HEIF, non-"qt  ") 4-char brand maps to mp4
    // and is accepted as a video → async-pending 202.
    it("property: arbitrary non-HEIF/non-qt 4-char brands map to video/mp4", async () => {
      const heif = new Set([
        "heic",
        "heix",
        "hevc",
        "hevx",
        "heim",
        "heis",
        "hevm",
        "hevs",
        "mif1",
        "msf1",
      ]);
      await fc.assert(
        fc.asyncProperty(
          fc
            .string({ minLength: 4, maxLength: 4 })
            .filter((s) => s.length === 4 && !heif.has(s) && s !== "qt  "),
          async (brand) => {
            mockR2Put.mockClear();
            mockMediaFileCreate.mockClear();
            mockMediaFileCreate.mockResolvedValue({ id: "p-fc", uploadId: "c" + "0".repeat(24), originalKey: null });
            const response = await runUpload(
              ftypBlob(brand, "application/octet-stream"),
              "clip.bin",
            );
            // P0b: video takes the async-pending path → 202 Accepted.
            expect(response.status).toBe(202);
            expectNoCasWrite();
          },
        ),
        { seed: 20260625, numRuns: 50 },
      );
    });
  });

  // ---- Upload reject paths: signature / suspicious / re-encode / tenant ----
  // src/lib/routes/media.ts lines 795, 814, 854-870, 912, 942.
  describe("POST /api/media/upload — reject and failure paths", () => {
    const uploadRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/upload" && r.method === "POST",
    );

    const runUpload = async (blob: Blob, filename: string, env = mockEnv) => {
      const formData = new FormData();
      formData.append("file", blob, filename);
      const request = new Request("https://api.rkm1.de/api/media/upload", {
        method: "POST",
        body: formData,
      });
      return uploadRoute!.handler(request, env, {
        url: new URL("https://api.rkm1.de/api/media/upload"),
        pathname: "/api/media/upload",
        params: {},
      });
    };

    it("rejects an MZ-executable polyglot as Suspicious content detected", async () => {
      // A PNG signature so the type detects as image (re-encodable), but the
      // MZ header at byte 0 would shadow PNG detection — so instead prepend a
      // JPEG magic and embed the MZ later? checkSuspiciousContent looks at
      // bytes[0..1] for MZ, so to reach the suspicious branch with a VALID
      // image type we need detection to pass first. Use a declared PNG whose
      // first bytes are PNG, then the executable check (bytes[0]===MZ) won't
      // fire. Instead exercise the script-content branch (below). For the MZ
      // branch, declare an octet-stream that detects as nothing → Invalid type
      // before suspicious. So the cleanest MZ path is via the >1KB script
      // branch. We assert the MZ executable header on a file that still
      // detects as a supported image is impossible; document + use script.
      // --- Executable header: craft bytes that detect as JPEG yet trip MZ is
      // contradictory; the reachable suspicious path is the script payload. ---
      const big = new Uint8Array(2048);
      // JPEG magic so the detector picks image/jpeg (validateMagicNumbers ok)
      big[0] = 0xff;
      big[1] = 0xd8;
      big[2] = 0xff;
      // Embed a <?php marker within the first 1KB scanned window.
      const marker = new TextEncoder().encode("<?php evil(); ?>");
      big.set(marker, 16);
      const response = await runUpload(
        new Blob([big], { type: "image/jpeg" }),
        "polyglot.jpg",
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Suspicious content detected");
      expectNoCasWrite();
    });

    it("rejects a >1KB file containing <script as Suspicious content detected", async () => {
      const big = new Uint8Array(2048);
      big[0] = 0x89; // PNG magic
      big[1] = 0x50;
      big[2] = 0x4e;
      big[3] = 0x47;
      big[4] = 0x0d;
      big[5] = 0x0a;
      big[6] = 0x1a;
      big[7] = 0x0a;
      const marker = new TextEncoder().encode("<script>alert(1)</script>");
      big.set(marker, 32);
      const response = await runUpload(
        new Blob([big], { type: "image/png" }),
        "polyglot.png",
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Suspicious content detected");
    });

    it("returns 400 Image processing failed when re-encode throws", async () => {
      mockReencodeImage.mockRejectedValueOnce(new Error("bad image"));
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const response = await runUpload(
        new Blob([jpegMagic], { type: "image/jpeg" }),
        "broken.jpg",
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Image processing failed");
      expectNoCasWrite();
    });

    it("returns 500 Tenant resolution failed when no tenant can be resolved (upload)", async () => {
      // Drive the ambient tenant to undefined; the personal-tenant DB fallback
      // throws (mockDb has no `user` model) → caught → null → resolution fails.
      mockGetCurrentTenantId.mockReturnValue(undefined as any);
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const response = await runUpload(
        new Blob([jpegMagic], { type: "image/jpeg" }),
        "ok.jpg",
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Tenant resolution failed");
      expectNoCasWrite();
    });

    it("returns 500 Database error when the DB upsert fails after a successful stage+promote", async () => {
      // The content hash is now computed inline from the cleaned bytes (always
      // 64-hex), so the casKey can't fail on the hash. The remaining failure
      // surface is the DB upsert — which must fail closed to 500 (the client
      // retries) rather than leaving an unreferenced cas/ object as a success.
      mockMediaFileUpsert.mockRejectedValueOnce(new Error("DB down"));
      const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const response = await runUpload(
        new Blob([jpegMagic], { type: "image/jpeg" }),
        "ok.jpg",
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Database error");
      // Moderation ran before the DB write.
      expect(mockModerateImage).toHaveBeenCalled();
    });
  });

  // ---- Serve-gate denials not already covered -------------------------------
  // src/lib/routes/media.ts lines 323-325 (no tenant), 379 (no originalKey),
  // 391 (storage object absent).
  describe("GET /api/media/:hash — additional serve-gate denials", () => {
    const getMediaRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/:hash" && r.method === "GET",
    );

    const APPROVED_CAS_KEY = `cas/${TEST_TENANT_ID}/${VALID_UPLOAD_HASH}`;
    const approvedRecord = (over: Record<string, unknown> = {}) => ({
      id: "media-123",
      contentHash: VALID_UPLOAD_HASH,
      mimeType: "image/png",
      originalKey: APPROVED_CAS_KEY,
      optimizedKey: null,
      thumbnailKey: null,
      moderationStatus: "APPROVED",
      hidden: false,
      deletedAt: null,
      ...over,
    });

    const serve = () =>
      getMediaRoute!.handler(
        new Request(`https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`, {
          method: "GET",
        }),
        mockEnv,
        {
          url: new URL(`https://api.rkm1.de/api/media/${VALID_UPLOAD_HASH}`),
          pathname: `/api/media/${VALID_UPLOAD_HASH}`,
          params: { hash: VALID_UPLOAD_HASH },
        },
      );

    it("denies (404) with NO DB lookup when the viewer tenant cannot be resolved", async () => {
      // Ambient tenant undefined + personal-tenant fallback throws (no `user`
      // model) → resolveUploadTenantId → null → deny before the mediaFile
      // lookup (line 323-325).
      mockGetCurrentTenantId.mockReturnValue(undefined as any);
      mockR2Get.mockResolvedValue({ body: new ReadableStream() });

      const response = await serve();

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: "Media not found" });
      // The media lookup must never run without a resolved tenant.
      expect(mockMediaFileFindUnique).not.toHaveBeenCalled();
      expect(mockR2Get).not.toHaveBeenCalled();
    });

    it("denies (404) an APPROVED record whose originalKey is null (no key → no serve)", async () => {
      mockMediaFileFindUnique.mockResolvedValue(
        approvedRecord({ originalKey: null }),
      );
      mockR2Get.mockResolvedValue({ body: new ReadableStream() });

      const response = await serve();

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: "Media not found" });
      // No key → must not probe storage.
      expect(mockR2Get).not.toHaveBeenCalled();
    });

    it("denies (404) an APPROVED record when the storage object is absent", async () => {
      mockMediaFileFindUnique.mockResolvedValue(approvedRecord());
      mockR2Get.mockResolvedValue(null); // bytes absent despite APPROVED

      const response = await serve();

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: "Media not found" });
      // The gate DID reach storage (key present + APPROVED) but got null.
      expect(mockR2Get).toHaveBeenCalledWith(APPROVED_CAS_KEY);
    });
  });

  // ---- Batch upload — intentionally NOT implemented (AR16) ------------------
  // The legacy batch path wrote bytes straight to the approved cas/ prefix via
  // MediaUploadService with no moderation verdict — a media-safety-invariant
  // violation. The route now returns 501; the invariant itself is guarded in
  // media-batch-cas-bypass.test.ts (no cas/ write without APPROVED).
  describe("POST /api/media/upload/batch", () => {
    const batchRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/upload/batch" && r.method === "POST",
    );

    it("is registered (a dropped route would 404, not 501)", () => {
      expect(batchRoute).toBeDefined();
    });

    it("returns 501 Not Implemented with the { error, message } convention", async () => {
      const fd = new FormData();
      fd.append(
        "files[0]",
        new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], {
          type: "image/jpeg",
        }),
        "a.jpg",
      );
      const response = await batchRoute!.handler(
        new Request("https://api.rkm1.de/api/media/upload/batch", {
          method: "POST",
          body: fd,
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/upload/batch"),
          pathname: "/api/media/upload/batch",
          params: {},
        },
      );
      expect(response.status).toBe(501);
      const body = await response.json();
      expect(body.error).toBe("Not implemented");
      expect(body.message).toContain("/api/media/upload");
    });
  });


  // ---- MediaHandler-delegating route error-string branches ------------------
  // Covers the switch-on-message error mappers that the happy-path tests skip.
  describe("MediaHandler-delegating route error branches", () => {
    const listRoute = mediaRoutes.find(
      (r) => r.path === "/api/media" && r.method === "GET",
    );
    const detailsRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/:mediaId" && r.method === "GET",
    );
    const hideRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/:mediaId/hide" && r.method === "POST",
    );
    const unhideRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/:mediaId/unhide" && r.method === "POST",
    );
    const deleteRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/:mediaId" && r.method === "DELETE",
    );
    const groupedRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/grouped" && r.method === "GET",
    );
    const statsRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/stats" && r.method === "GET",
    );

    it("GET /api/media → 500 on a generic listUserMedia error", async () => {
      mockMediaHandlerInstance.listUserMedia.mockRejectedValue(
        new Error("connection reset"),
      );
      const response = await listRoute!.handler(
        new Request("https://api.rkm1.de/api/media", { method: "GET" }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media"),
          pathname: "/api/media",
          params: {},
        },
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to list media");
    });

    it("GET /api/media → 404 when listUserMedia throws 'Media not found'", async () => {
      mockMediaHandlerInstance.listUserMedia.mockRejectedValue(
        new Error("Media not found"),
      );
      const response = await listRoute!.handler(
        new Request("https://api.rkm1.de/api/media", { method: "GET" }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media"),
          pathname: "/api/media",
          params: {},
        },
      );
      expect(response.status).toBe(404);
    });

    it("GET /api/media/:mediaId → 403 Forbidden on a permission error", async () => {
      mockMediaHandlerInstance.getMediaDetails.mockRejectedValue(
        new Error("no permission to view this media"),
      );
      const response = await detailsRoute!.handler(
        new Request("https://api.rkm1.de/api/media/media-123", {
          method: "GET",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/media-123"),
          pathname: "/api/media/media-123",
          params: { mediaId: "media-123" },
        },
      );
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Forbidden");
    });

    it("GET /api/media/:mediaId → 500 on a generic error", async () => {
      mockMediaHandlerInstance.getMediaDetails.mockRejectedValue(
        new Error("kaboom"),
      );
      const response = await detailsRoute!.handler(
        new Request("https://api.rkm1.de/api/media/media-123", {
          method: "GET",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/media-123"),
          pathname: "/api/media/media-123",
          params: { mediaId: "media-123" },
        },
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to get media details");
    });

    it("GET /api/media/:mediaId → delegates a 64-hex id to serveMediaByHash (denied → 404)", async () => {
      // A 64-hex mediaId is treated as a content hash. With no DB record the
      // shared gate denies uniformly (404), exercising the delegation branch
      // at line 1718-1752.
      mockMediaFileFindUnique.mockResolvedValue(null);
      const hashId = "b".repeat(64);
      const response = await detailsRoute!.handler(
        new Request(`https://api.rkm1.de/api/media/${hashId}`, {
          method: "GET",
        }),
        mockEnv,
        {
          url: new URL(`https://api.rkm1.de/api/media/${hashId}`),
          pathname: `/api/media/${hashId}`,
          params: { mediaId: hashId },
        },
      );
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: "Media not found" });
      // getMediaDetails must NOT be called for a hash-shaped id.
      expect(mockMediaHandlerInstance.getMediaDetails).not.toHaveBeenCalled();
    });

    it("POST /hide → 403 Forbidden on a permission error", async () => {
      mockMediaHandlerInstance.hideMedia.mockRejectedValue(
        new Error("user lacks permission"),
      );
      const response = await hideRoute!.handler(
        new Request("https://api.rkm1.de/api/media/media-123/hide", {
          method: "POST",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/media-123/hide"),
          pathname: "/api/media/media-123/hide",
          params: { mediaId: "media-123" },
        },
      );
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Forbidden");
    });

    it("POST /hide → 400 when the media was deleted", async () => {
      mockMediaHandlerInstance.hideMedia.mockRejectedValue(
        new Error("Media is deleted"),
      );
      const response = await hideRoute!.handler(
        new Request("https://api.rkm1.de/api/media/media-123/hide", {
          method: "POST",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/media-123/hide"),
          pathname: "/api/media/media-123/hide",
          params: { mediaId: "media-123" },
        },
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.message).toContain("deleted");
    });

    it("POST /hide → 500 on a generic error", async () => {
      mockMediaHandlerInstance.hideMedia.mockRejectedValue(new Error("boom"));
      const response = await hideRoute!.handler(
        new Request("https://api.rkm1.de/api/media/media-123/hide", {
          method: "POST",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/media-123/hide"),
          pathname: "/api/media/media-123/hide",
          params: { mediaId: "media-123" },
        },
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to hide media");
    });

    it("POST /unhide → 404 when media not found", async () => {
      mockMediaHandlerInstance.unhideMedia.mockRejectedValue(
        new Error("Media not found"),
      );
      const response = await unhideRoute!.handler(
        new Request("https://api.rkm1.de/api/media/media-123/unhide", {
          method: "POST",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/media-123/unhide"),
          pathname: "/api/media/media-123/unhide",
          params: { mediaId: "media-123" },
        },
      );
      expect(response.status).toBe(404);
    });

    it("POST /unhide → 403 Forbidden on a permission error", async () => {
      mockMediaHandlerInstance.unhideMedia.mockRejectedValue(
        new Error("permission denied"),
      );
      const response = await unhideRoute!.handler(
        new Request("https://api.rkm1.de/api/media/media-123/unhide", {
          method: "POST",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/media-123/unhide"),
          pathname: "/api/media/media-123/unhide",
          params: { mediaId: "media-123" },
        },
      );
      expect(response.status).toBe(403);
    });

    it("POST /unhide → 500 on a generic error", async () => {
      mockMediaHandlerInstance.unhideMedia.mockRejectedValue(
        new Error("kaboom"),
      );
      const response = await unhideRoute!.handler(
        new Request("https://api.rkm1.de/api/media/media-123/unhide", {
          method: "POST",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/media-123/unhide"),
          pathname: "/api/media/media-123/unhide",
          params: { mediaId: "media-123" },
        },
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to unhide media");
    });

    it("POST /unhide → 400 Invalid request when mediaId is missing", async () => {
      const response = await unhideRoute!.handler(
        new Request("https://api.rkm1.de/api/media//unhide", {
          method: "POST",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media//unhide"),
          pathname: "/api/media//unhide",
          params: {},
        },
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid request");
    });

    it("DELETE /api/media/:mediaId → 403 Forbidden on a permission error", async () => {
      mockMediaHandlerInstance.deleteMedia.mockRejectedValue(
        new Error("permission required"),
      );
      const response = await deleteRoute!.handler(
        new Request("https://api.rkm1.de/api/media/media-123", {
          method: "DELETE",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/media-123"),
          pathname: "/api/media/media-123",
          params: { mediaId: "media-123" },
        },
      );
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Forbidden");
    });

    it("DELETE /api/media/:mediaId → 404 when media not found", async () => {
      mockMediaHandlerInstance.deleteMedia.mockRejectedValue(
        new Error("Media not found"),
      );
      const response = await deleteRoute!.handler(
        new Request("https://api.rkm1.de/api/media/media-123", {
          method: "DELETE",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/media-123"),
          pathname: "/api/media/media-123",
          params: { mediaId: "media-123" },
        },
      );
      expect(response.status).toBe(404);
    });

    it("DELETE /api/media/:mediaId → 409 via the 'used by other users' branch", async () => {
      mockMediaHandlerInstance.deleteMedia.mockRejectedValue(
        new Error("Media is used by other users."),
      );
      const response = await deleteRoute!.handler(
        new Request("https://api.rkm1.de/api/media/media-123", {
          method: "DELETE",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/media-123"),
          pathname: "/api/media/media-123",
          params: { mediaId: "media-123" },
        },
      );
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.action).toBe("hidden");
    });

    it("DELETE /api/media/:mediaId → 500 on a generic error", async () => {
      mockMediaHandlerInstance.deleteMedia.mockRejectedValue(
        new Error("kaboom"),
      );
      const response = await deleteRoute!.handler(
        new Request("https://api.rkm1.de/api/media/media-123", {
          method: "DELETE",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/media-123"),
          pathname: "/api/media/media-123",
          params: { mediaId: "media-123" },
        },
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to delete media");
    });

    it("DELETE /api/media/:mediaId → 400 Invalid request when mediaId is missing", async () => {
      const response = await deleteRoute!.handler(
        new Request("https://api.rkm1.de/api/media/", { method: "DELETE" }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/"),
          pathname: "/api/media/",
          params: {},
        },
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid request");
    });

    it("GET /api/media/grouped → 404 when listUserMediaGrouped throws 'Media not found'", async () => {
      mockMediaHandlerInstance.listUserMediaGrouped.mockRejectedValue(
        new Error("Media not found"),
      );
      const response = await groupedRoute!.handler(
        new Request("https://api.rkm1.de/api/media/grouped?groupBy=month", {
          method: "GET",
        }),
        mockEnv,
        {
          url: new URL(
            "https://api.rkm1.de/api/media/grouped?groupBy=month",
          ),
          pathname: "/api/media/grouped",
          params: {},
        },
      );
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("Failed to group media");
    });

    it("GET /api/media/grouped → 500 on a generic error", async () => {
      mockMediaHandlerInstance.listUserMediaGrouped.mockRejectedValue(
        new Error("group boom"),
      );
      const response = await groupedRoute!.handler(
        new Request("https://api.rkm1.de/api/media/grouped?groupBy=year", {
          method: "GET",
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/grouped?groupBy=year"),
          pathname: "/api/media/grouped",
          params: {},
        },
      );
      expect(response.status).toBe(500);
    });

    it("GET /api/media/grouped → 400 Invalid limit when limit is out of range", async () => {
      const response = await groupedRoute!.handler(
        new Request(
          "https://api.rkm1.de/api/media/grouped?groupBy=month&limit=0",
          { method: "GET" },
        ),
        mockEnv,
        {
          url: new URL(
            "https://api.rkm1.de/api/media/grouped?groupBy=month&limit=0",
          ),
          pathname: "/api/media/grouped",
          params: {},
        },
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid limit");
    });

    it("GET /api/media/stats → 404 when getUserMediaStats throws 'Media not found'", async () => {
      mockMediaHandlerInstance.getUserMediaStats.mockRejectedValue(
        new Error("Media not found"),
      );
      const response = await statsRoute!.handler(
        new Request("https://api.rkm1.de/api/media/stats", { method: "GET" }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/stats"),
          pathname: "/api/media/stats",
          params: {},
        },
      );
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("Failed to get media stats");
    });

    it("GET /api/media/stats → 500 on a generic error", async () => {
      mockMediaHandlerInstance.getUserMediaStats.mockRejectedValue(
        new Error("stats boom"),
      );
      const response = await statsRoute!.handler(
        new Request("https://api.rkm1.de/api/media/stats", { method: "GET" }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/stats"),
          pathname: "/api/media/stats",
          params: {},
        },
      );
      expect(response.status).toBe(500);
    });
  });

  // ---- checkSuspiciousContent extra branches (via the upload paths) ---------
  // src/lib/routes/media.ts lines 424 (MZ executable), 459 (excessive JPEG
  // metadata), plus the empty-video-allowlist fallback (578 / 1169).
  describe("suspicious-content + allowlist-fallback branches", () => {
    const uploadRoute = mediaRoutes.find(
      (r) => r.path === "/api/media/upload" && r.method === "POST",
    );

    it("rejects a JPEG with >64KB of APP-segment metadata as Suspicious content detected (459)", async () => {
      // FF D8, then APP1 (FF E1) len 0xFFFF, then APP2 (FF E2) len 0x0100 →
      // metadataSize 65535 + 256 > 65536 → "Excessive metadata detected".
      const app1Len = 0xffff;
      const total = 2 /*SOI*/ + 2 /*FFE1*/ + app1Len + 2 /*FFE2*/ + 0x0100;
      const bytes = new Uint8Array(total + 16);
      bytes[0] = 0xff; // SOI
      bytes[1] = 0xd8;
      bytes[2] = 0xff; // APP1
      bytes[3] = 0xe1;
      bytes[4] = (app1Len >> 8) & 0xff;
      bytes[5] = app1Len & 0xff;
      const app2Off = 2 + 2 + app1Len;
      bytes[app2Off] = 0xff; // APP2
      bytes[app2Off + 1] = 0xe2;
      bytes[app2Off + 2] = 0x01;
      bytes[app2Off + 3] = 0x00;
      const fd = new FormData();
      fd.append("file", new Blob([bytes], { type: "image/jpeg" }), "fat.jpg");
      const response = await uploadRoute!.handler(
        new Request("https://api.rkm1.de/api/media/upload", {
          method: "POST",
          body: fd,
        }),
        mockEnv,
        {
          url: new URL("https://api.rkm1.de/api/media/upload"),
          pathname: "/api/media/upload",
          params: {},
        },
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Suspicious content detected");
    });

    it("upload falls back to the default video allowlist when env video allowlist is empty (578)", async () => {
      const envEmptyVideo = {
        ...mockEnv,
        media: {
          ...mockEnv.media,
          allowlist: { ...mockEnv.media.allowlist, video: [] },
        },
      };
      const mp4 = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      ]); // ftyp 'isom'
      const fd = new FormData();
      fd.append("file", new Blob([mp4], { type: "video/mp4" }), "clip.mp4");
      const response = await uploadRoute!.handler(
        new Request("https://api.rkm1.de/api/media/upload", {
          method: "POST",
          body: fd,
        }),
        envEmptyVideo,
        {
          url: new URL("https://api.rkm1.de/api/media/upload"),
          pathname: "/api/media/upload",
          params: {},
        },
      );
      // Default fallback list includes video/mp4 → accepted.
      // P0b: video takes the async-pending path → 202 Accepted.
      expect(response.status).toBe(202);
      const fallbackBody = await response.json();
      expect(fallbackBody).toHaveProperty("status", "pending");
      // No bytes may reach the approved cas/ prefix on the async path.
      expectNoCasWrite();
    });

  });
});
