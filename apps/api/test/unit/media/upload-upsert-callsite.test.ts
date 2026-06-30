/**
 * Call-site dedup-safety test for the /api/media/upload route (T9).
 *
 * The pure `buildMediaUpsertArgs` builder is already proven to keep the `update`
 * payload free of `uploadedBy` and `moderationStatus` (media-upsert.test.ts).
 * But the BUILDER being correct does not prove the CALL SITE uses it correctly:
 * a spread-and-merge at the route (e.g. `upsert({ ...buildMediaUpsertArgs(x),
 * update: { ...args.update, uploadedBy, moderationStatus } })`) would silently
 * re-introduce ownership-takeover / de-publish on a within-tenant dedup hit.
 *
 * This drives the ACTUAL upload route handler from `mediaRoutes`, mocks the I/O
 * edges (session, rate limit, re-encode, upload service, metadata, DB), captures
 * the args handed to `db.mediaFile.upsert`, and asserts the `update` payload
 * carries NEITHER `uploadedBy` NOR `moderationStatus`. A merge at the call site
 * turns this red.
 *
 * Follows CLAUDE.md vitest patterns: vi.hoisted mock factories, vi.clearAllMocks
 * in beforeEach, full-URL Request, mocked Prisma via the query-helper seam.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// A valid CUID tenant (matches TENANT_ID_RE: c + 24 [a-z0-9]) so the real
// casKey() builder succeeds at the call site.
const TENANT = "ctenant0000000000000000aa";
const USER_ID = "cuser000000000000000000aa";

// --- hoisted capture handles ---------------------------------------------
const { upsertMock, uploadSingleMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(async (_args: any) => ({ id: "mediafile-1" })),
  uploadSingleMock: vi.fn(),
}));

// Session: always authenticated.
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    async getSession() {
      return { userId: USER_ID, email: "u@example.com", role: "END_USER" };
    }
  },
}));

// Rate limiter: never limits.
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    async applyRateLimitKV() {
      return null;
    }
  },
}));

// Logger: silent.
vi.mock("../../../src/lib/logger", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  Logger: class {},
}));

// Ambient tenant present so resolveUploadTenantId returns it WITHOUT a DB read
// (the personal-tenant fallback only runs when ambient is absent + scope off).
vi.mock("@de-otio/saas-foundation/tenant", () => ({
  getCurrentTenantId: () => TENANT,
}));

// Image re-encode: identity passthrough that keeps the JPEG bytes valid and
// declares the canonical mime. (Real sharp is not exercised here.)
vi.mock("../../../src/lib/services/image-normalizer", () => ({
  ImageNormalizer: class {},
  REENCODABLE_IMAGE_TYPES: new Set(["image/jpeg", "image/png", "image/webp"]),
  reencodeImage: vi.fn(async (buf: ArrayBuffer) => ({
    buffer: Buffer.from(new Uint8Array(buf)),
    canonicalMimeType: "image/jpeg",
  })),
}));

// Upload service: still mocked (used by the batch path); the sync-image path no
// longer calls it (it stages + moderates + promotes via the storage port).
vi.mock("../../../src/lib/services/media-upload-service", () => ({
  MediaUploadService: class {
    uploadSingle = uploadSingleMock;
  },
}));

// Request-path moderation seam (T1): default verdict = approved so the
// sync-image path promotes to cas/ and records APPROVED on the create.
const moderateImageMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ decision: "approved", labels: [], provider: "mock" }),
);
vi.mock("../../../src/lib/media/request-moderation", () => ({
  getMediaModerationProvider: () => ({ moderateImage: moderateImageMock }),
}));

// Metadata extractor (dynamic import): no-op.
vi.mock("../../../src/lib/metadata/metadata-extractor", () => ({
  MetadataExtractor: class {
    async extractAll() {
      return {};
    }
  },
}));

vi.mock("../../../src/lib/media-handler", () => ({
  MediaHandler: { create: vi.fn() },
}));

vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {},
}));

// Query helper: route the queryFn against a db whose mediaFile.upsert we capture.
// resolveUploadTenantId does NOT hit this path (ambient present). Two query
// callsites flow through here on the sync-image path: the P0b quota check
// (count + aggregate) and the route's mediaFile.upsert. The quota mock returns
// zero usage so checkUploadQuota allows the upload and the flow reaches upsert.
vi.mock("../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: async (
    _mgr: any,
    _region: string,
    _env: any,
    queryFn: (db: any) => Promise<any>,
  ) =>
    queryFn({
      mediaFile: {
        upsert: upsertMock,
        count: vi.fn(async () => 0),
        aggregate: vi.fn(async () => ({ _sum: { size: 0 } })),
      },
    }),
  QueryTimeoutPresets: { USER_FACING: {}, INTERNAL: {} },
}));

import { mediaRoutes } from "../../../src/lib/routes/media.js";

const uploadRoute = mediaRoutes.find(
  (r) => r.path === "/api/media/upload" && r.method === "POST",
)!;

/** Minimal but structurally valid JPEG: SOI + APP0 (JFIF) + EOI. */
function makeJpegBytes(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, // APP0, length 16
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // JFIF payload
    0xff, 0xd9, // EOI
  ]);
}

/**
 * The content hash the route computes inline from the cleaned bytes — the
 * re-encode mock is identity, so this is SHA-256 of makeJpegBytes(). Computed
 * the same way the route does (crypto.subtle.digest) so the expected CAS/where
 * key matches exactly.
 */
async function expectedContentHash(): Promise<string> {
  const bytes = makeJpegBytes();
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function makeEnv() {
  return {
    ENVIRONMENT: "dev",
    SESSION_SECRET: "test-secret-32-characters-long!!",
    MEDIA_BUCKET_NAME: "dev-trellis-media",
    MEDIA_BUCKET_R2: { put: vi.fn(), get: vi.fn(), delete: vi.fn() },
    MEDIA_RECONCILIATION_QUEUE: { send: vi.fn() },
    media: {
      canonicalFormat: "jpeg" as const,
      maxBytes: { image: 10_000_000, video: 100_000_000 },
      allowlist: { video: ["video/mp4", "video/webm", "video/quicktime"] },
      rateLimits: { uploadPerMin: 60, batchPerMin: 10, servePerMin: 600 },
      // P0b quota ceilings (injected from Env.media). Generous so the quota
      // gate allows the upload and the flow reaches the upsert under test.
      uploadQuota: { maxObjects: 1_000_000, maxBytes: 1_000_000_000_000 },
    },
  };
}

function makeUploadRequest(): Request {
  const form = new FormData();
  const blob = new Blob([makeJpegBytes()], { type: "image/jpeg" });
  form.append("file", blob, "photo.jpg");
  return new Request("https://api.example.com/api/media/upload", {
    method: "POST",
    body: form,
  });
}

describe("/api/media/upload — upsert call-site dedup safety (T9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The sync-image path no longer calls uploadSingle; the default approved
    // verdict must be re-asserted after clearAllMocks so the create records
    // APPROVED and the flow reaches the upsert under test.
    moderateImageMock.mockResolvedValue({
      decision: "approved",
      labels: [],
      provider: "mock",
    });
    upsertMock.mockResolvedValue({ id: "mediafile-1" });
  });

  it("calls db.mediaFile.upsert exactly once during an upload", async () => {
    const res = await uploadRoute.handler(makeUploadRequest(), makeEnv() as any, {
      params: {},
    } as any);
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("the upsert UPDATE payload carries NEITHER uploadedBy NOR moderationStatus (no ownership takeover / de-publish on dedup hit)", async () => {
    await uploadRoute.handler(makeUploadRequest(), makeEnv() as any, {
      params: {},
    } as any);

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const args = upsertMock.mock.calls[0][0];

    // The load-bearing invariant: a within-tenant dedup hit must not mutate the
    // shared row's ownership or publish state.
    expect("uploadedBy" in args.update).toBe(false);
    expect("moderationStatus" in args.update).toBe(false);
    // It must touch ONLY the idempotent COMPLETE re-assert.
    expect(Object.keys(args.update)).toEqual(["uploadStatus"]);
    expect(args.update.uploadStatus).toBe("COMPLETE");
  });

  it("the upsert is scoped by the within-tenant composite unique and creates a born-owned row", async () => {
    const hash = await expectedContentHash();
    await uploadRoute.handler(makeUploadRequest(), makeEnv() as any, {
      params: {},
    } as any);

    const args = upsertMock.mock.calls[0][0];
    // Scoped to (tenantId, contentHash) — the within-tenant dedup key (D18).
    // contentHash is now computed inline from the cleaned bytes.
    expect(args.where).toEqual({
      tenantId_contentHash: { tenantId: TENANT, contentHash: hash },
    });
    // create carries ownership (new rows are born owned)...
    expect(args.create.uploadedBy).toBe(USER_ID);
    expect(args.create.tenantId).toBe(TENANT);
    expect(args.create.originalKey).toBe(`cas/${TENANT}/${hash}`);
    // ...and create now pins the moderation verdict for the CANONICAL upload
    // (approved by the default mock verdict). The dedup-no-takeover invariant
    // still holds on `update` (proven above).
    expect(args.create.moderationStatus).toBe("APPROVED");
  });
});
