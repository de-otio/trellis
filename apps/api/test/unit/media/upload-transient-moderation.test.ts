/**
 * Transient image-check failures answer 503 (+ Retry-After) and never create a
 * hold; verdicts, oversize and unsupported formats keep their existing outcome.
 * Harness mirrors upload-upsert-callsite.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "ctenant0000000000000000aa";
const USER_ID = "cuser000000000000000000aa";

const { upsertMock, moderateImageMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(async (_args: any) => ({ id: "mediafile-1" })),
  moderateImageMock: vi.fn(),
}));

vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    async getSession() {
      return { userId: USER_ID, email: "u@example.com", role: "END_USER" };
    }
  },
}));
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    async applyRateLimitKV() {
      return null;
    }
  },
}));
vi.mock("../../../src/lib/logger", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  Logger: class {},
}));
vi.mock("@de-otio/saas-foundation/tenant", () => ({
  getCurrentTenantId: () => TENANT,
}));
vi.mock("../../../src/lib/services/image-normalizer", () => ({
  REENCODABLE_IMAGE_TYPES: new Set(["image/jpeg", "image/png", "image/webp"]),
  reencodeImage: vi.fn(async (buf: ArrayBuffer) => ({
    buffer: Buffer.from(new Uint8Array(buf)),
    canonicalMimeType: "image/jpeg",
  })),
}));
vi.mock("../../../src/lib/media/request-moderation", () => ({
  getMediaModerationProvider: () => ({ moderateImage: moderateImageMock }),
  interpretVerdict: (v: { decision: string }) => v.decision,
}));
vi.mock("../../../src/lib/metadata/metadata-extractor", () => ({
  MetadataExtractor: class {
    async extractAll() {
      return {};
    }
  },
}));
vi.mock("../../../src/lib/media-handler", () => ({ MediaHandler: { create: vi.fn() } }));
vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {},
}));
vi.mock("../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: async (_m: any, _r: string, _e: any, fn: (db: any) => Promise<any>) =>
    fn({
      mediaFile: {
        upsert: upsertMock,
        count: vi.fn(async () => 0),
        aggregate: vi.fn(async () => ({ _sum: { size: 0 } })),
      },
    }),
  QueryTimeoutPresets: { USER_FACING: {}, INTERNAL: {} },
}));

import { mediaRoutes } from "../../../src/lib/routes/media.js";
import { ModerationProviderError } from "../../../src/lib/media/moderation-provider.js";

const uploadRoute = mediaRoutes.find(
  (r) => r.path === "/api/media/upload" && r.method === "POST",
)!;

const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

function makeEnv(media: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: "dev",
    SESSION_SECRET: "test-secret-32-characters-long!!",
    MEDIA_BUCKET_NAME: "dev-trellis-media",
    MEDIA_BUCKET_R2: { put: vi.fn(), get: vi.fn(), delete: vi.fn() },
    media: {
      canonicalFormat: "jpeg" as const,
      maxBytes: { image: 10_000_000, video: 100_000_000 },
      allowlist: { video: ["video/mp4"] },
      rateLimits: { uploadPerMin: 60, batchPerMin: 10, servePerMin: 600 },
      uploadQuota: { maxObjects: 1_000_000, maxBytes: 1_000_000_000_000 },
      reviewRateCap: 1_000_000,
      moderationRetryAfterSeconds: 30,
      ...media,
    },
  };
}

function req(bytes: Uint8Array = JPEG, type = "image/jpeg", name = "photo.jpg"): Request {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  return new Request("https://api.example.com/api/media/upload", { method: "POST", body: form });
}

async function run(env = makeEnv(), r = req()) {
  const res = await uploadRoute.handler(r, env as any, { params: {} } as any);
  return { res, env };
}

describe("/api/media/upload — transient image-check failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertMock.mockResolvedValue({ id: "mediafile-1" });
  });

  const transient: Array<[string, () => unknown]> = [
    ["retryable provider error", () => new ModerationProviderError("throttled", { retryable: true })],
    [
      "capacity / spend cap (infra fault)",
      () => new ModerationProviderError("cap reached", { retryable: false, infraFault: true }),
    ],
    [
      "capacity flag (non-retryable, capacity ceiling)",
      () => new ModerationProviderError("ceiling", { retryable: false, capacity: true }),
    ],
    [
      "credential error (unattributed provider fault)",
      () => new ModerationProviderError("bad credentials", { retryable: false, unknownCause: true }),
    ],
    [
      "deadline error",
      () => new ModerationProviderError("moderation deadline exceeded", { retryable: true }),
    ],
    ["untyped unknown error (classifier default is retryable)", () => new Error("provider exploded")],
    ["untyped network error", () => Object.assign(new Error("socket hang up"), { name: "FetchError" })],
  ];

  it.each(transient)("%s → 503 + Retry-After, no row, nothing promoted", async (_n, mk) => {
    moderateImageMock.mockRejectedValue(mk());
    const { res, env } = await run();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(upsertMock).not.toHaveBeenCalled();
    // Only the staging write happened; cas/ was never written, staging dropped.
    expect(env.MEDIA_BUCKET_R2.put).toHaveBeenCalledTimes(1);
    expect(String(env.MEDIA_BUCKET_R2.put.mock.calls[0][0])).toMatch(/^processing\//);
    expect(env.MEDIA_BUCKET_R2.delete).toHaveBeenCalledTimes(1);
  });

  it("omits Retry-After when no value is configured (no default in code)", async () => {
    moderateImageMock.mockRejectedValue(new ModerationProviderError("x", { retryable: true }));
    const { res } = await run(makeEnv({ moderationRetryAfterSeconds: undefined }));
    expect(res.status).toBe(503);
    expect(res.headers.has("Retry-After")).toBe(false);
  });

  it("a staging-delete failure does not mask the 503", async () => {
    moderateImageMock.mockRejectedValue(new ModerationProviderError("x", { retryable: true }));
    const env = makeEnv();
    env.MEDIA_BUCKET_R2.delete.mockRejectedValue(new Error("nope"));
    const { res } = await run(env);
    expect(res.status).toBe(503);
  });
});

describe("/api/media/upload — outcomes that still hold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertMock.mockResolvedValue({ id: "mediafile-1" });
  });

  it("a provider verdict of review is held as REVIEW, not 503", async () => {
    moderateImageMock.mockResolvedValue({ decision: "review", labels: [], provider: "mock" });
    const { res, env } = await run();
    expect(res.status).not.toBe(503);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][0].create.lifecycle).toBe("REVIEW");
    // Never promoted to cas/.
    expect(env.MEDIA_BUCKET_R2.put).toHaveBeenCalledTimes(1);
  });

  it("a non-transient untyped failure (corrupt media) still fails closed to REVIEW", async () => {
    moderateImageMock.mockRejectedValue(Object.assign(new Error("invalid image"), { name: "InvalidImageError" }));
    const { res } = await run();
    expect(res.status).not.toBe(503);
    expect(upsertMock.mock.calls[0][0].create.lifecycle).toBe("REVIEW");
  });

  it("a typed, non-retryable provider error with no capacity or infra flag still holds as REVIEW", async () => {
    moderateImageMock.mockRejectedValue(
      new ModerationProviderError("rejected these bytes", { retryable: false }),
    );
    const { res } = await run();
    expect(res.status).not.toBe(503);
    expect(upsertMock.mock.calls[0][0].create.lifecycle).toBe("REVIEW");
  });

  it("an oversize image is refused before moderation and never 503", async () => {
    const env = makeEnv({ maxBytes: { image: 4, video: 100 } });
    const { res } = await run(env);
    expect(res.status).toBe(400);
    expect(moderateImageMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("an unsupported format is refused before moderation and never 503", async () => {
    const { res } = await run(makeEnv(), req(new Uint8Array([1, 2, 3]), "application/x-msdownload", "a.exe"));
    expect(res.status).not.toBe(503);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(moderateImageMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
