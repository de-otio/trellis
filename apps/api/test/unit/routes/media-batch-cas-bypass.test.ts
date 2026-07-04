/**
 * AR16 — batch-upload moderation-bypass regression test.
 *
 * Core media-safety invariant: `cas/` holds ONLY approved, cleaned bytes.
 * Every byte must reach `cas/{tenant}/{hash}` exclusively through the
 * moderated pipeline (stage → moderate → APPROVED → promote), never directly.
 *
 * The legacy `/api/media/upload/batch` route violated this: it called
 * MediaUploadService.uploadSingle, which put bytes at the approved CAS
 * prefix with NO moderation verdict and NO video re-encode, then enqueued to
 * the stub media-reconciliation worker. This suite drives the route with the
 * REAL upload path (no MediaUploadService mock — unlike media.test.ts) and
 * asserts the invariant on the storage spy.
 *
 * Written red-first (§0.4): before the fix, the invariant test fails because
 * bytes land at `cas/…` on a 200 response. After the fix the route returns
 * 501 and never touches storage, moderation, or any queue.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mediaRoutes } from "../../../src/lib/routes/media.js";
import type { Session } from "../../../src/lib/session-cookie.js";

// ── Mocks: request plumbing only. The upload/storage path itself is REAL. ──

const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

const mockCreateSecureResponse = vi.fn();
const mockAddSecurityHeaders = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
  },
}));

const mockApplyRateLimitKV = vi.fn();
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = mockApplyRateLimitKV;
  },
}));

vi.mock("../../../src/lib/cors-handler", () => ({
  CorsHandler: {
    addCorsHeaders: vi.fn((response) => response),
  },
}));

// Re-encode pass-through so the tiny synthetic JPEG doesn't hit real sharp.
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

// Ambient tenant seam — CUID-shaped so the canonical CAS key can be built.
const TEST_TENANT_ID = "ctenant0000000000000000aa";
vi.mock("@de-otio/saas-foundation/tenant", () => ({
  getCurrentTenantId: () => TEST_TENANT_ID,
}));

// Moderation seam spy: this suite asserts it is NEVER consulted by the batch
// path — that absence is what makes any cas/ write a bypass.
const mockModerateImage = vi.fn();
vi.mock("../../../src/lib/media/request-moderation", () => ({
  getMediaModerationProvider: () => ({ moderateImage: mockModerateImage }),
}));

// DB plumbing (tenant fallback lookup etc.) — never the subject here.
const mockWithQueryTimeoutAndRetry = vi.fn();
vi.mock("../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));
vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    executeWithRetry: vi.fn(),
  },
}));
vi.mock("../../../src/db", () => ({
  createPrismaForRegion: vi.fn(),
}));

// ── Spies on every sink a smuggled byte could reach ──

const mockR2Put = vi.fn();
const mockR2Head = vi.fn();
const mockR2Get = vi.fn();
const mockR2Delete = vi.fn();
const mockReconciliationSend = vi.fn();
const mockProcessingSend = vi.fn();

const jpegBytes = () => {
  const b = new Uint8Array(16);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  return b;
};

describe("AR16 /api/media/upload/batch — cas/ moderation-bypass", () => {
  const batchRoute = mediaRoutes.find(
    (r) => r.path === "/api/media/upload/batch" && r.method === "POST",
  );

  let mockEnv: any;
  let mockSession: Session;

  const runBatch = async () => {
    const fd = new FormData();
    fd.append(
      "files[0]",
      new Blob([jpegBytes()], { type: "image/jpeg" }),
      "a.jpg",
    );
    const request = new Request(
      "https://api.example.com/api/media/upload/batch",
      { method: "POST", body: fd },
    );
    return batchRoute!.handler(request, mockEnv, {
      url: new URL("https://api.example.com/api/media/upload/batch"),
      pathname: "/api/media/upload/batch",
      params: {},
    } as any);
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSession = {
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    } as Session;

    mockEnv = {
      APP_DOMAIN: "https://api.example.com",
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
      MEDIA_BUCKET_NAME: "dev-trellis-media",
      MEDIA_BUCKET_R2: {
        head: mockR2Head,
        put: mockR2Put,
        get: mockR2Get,
        delete: mockR2Delete,
      },
      // Present as spies so ANY enqueue by a legacy path is observable.
      MEDIA_RECONCILIATION_QUEUE: { send: mockReconciliationSend },
      MEDIA_PROCESSING_QUEUE: { send: mockProcessingSend },
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
          maxBytes: 1024 * 1024 * 1024,
        },
      },
    };

    mockGetSession.mockResolvedValue(mockSession);
    mockApplyRateLimitKV.mockResolvedValue(null);
    mockCreateSecureResponse.mockImplementation(
      (body: any, options: any) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((response: any) => response);
    mockR2Head.mockResolvedValue(null);
    mockR2Put.mockResolvedValue(undefined);
    mockR2Get.mockResolvedValue(null);
    mockR2Delete.mockResolvedValue(undefined);
    mockReencodeImage.mockImplementation(async (buf: ArrayBuffer) => ({
      buffer: Buffer.from(
        buf instanceof Buffer ? buf : new Uint8Array(buf as ArrayBuffer),
      ),
      canonicalMimeType: "image/jpeg",
    }));
  });

  it("route is registered", () => {
    expect(batchRoute).toBeDefined();
  });

  it("INVARIANT: never lands bytes at the approved cas/ prefix without a completed APPROVED verdict", async () => {
    await runBatch();

    // The batch path never consults moderation at all — so there is no
    // APPROVED verdict in play…
    expect(mockModerateImage).not.toHaveBeenCalled();

    // …therefore NOT ONE object may be written under the approved cas/
    // prefix (or anywhere else in the media bucket) by this route.
    const casPuts = mockR2Put.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("cas/"),
    );
    expect(casPuts).toHaveLength(0);
    expect(mockR2Put).not.toHaveBeenCalled();
  });

  it("does not enqueue to the (stub) media-reconciliation worker or any other queue", async () => {
    await runBatch();

    expect(mockReconciliationSend).not.toHaveBeenCalled();
    expect(mockProcessingSend).not.toHaveBeenCalled();
  });

  it("returns 501 Not Implemented with the { error, message } convention", async () => {
    const response = await runBatch();

    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.error).toBe("Not implemented");
    expect(typeof body.message).toBe("string");
  });
});
