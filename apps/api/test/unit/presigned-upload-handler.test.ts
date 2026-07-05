/**
 * Unit tests for the presigned direct-to-S3 upload handler (T14).
 *
 * Focus: the AR-SEC properties of the flow —
 *  - the grant is signed with the byte rail (content-length-range) and the
 *    exact staging key,
 *  - completion AUTHZ: a caller cannot complete (or abandon) another user's
 *    session — the ownership-scoped lookup 404s,
 *  - completion can NEVER promote: the media row lands on UPLOADED (or keeps
 *    the pipeline's resolved state), never APPROVED,
 *  - a resolved verdict is never rewound by a late completion call,
 *  - abandon/expiry drive UPLOAD_FAILED + staged-object cleanup (pending/
 *    only), and refuse once a verdict exists.
 *
 * The DB is an in-memory fake bound through the mocked db-query-helper; the
 * presign port is injected (no AWS).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory DB fake (uploadSession + mediaFile subset the handler touches).
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  userId: string;
  kind: string;
  mediaIds: string[];
  status: string;
  expiresAt: Date;
  tenantId?: string | null;
  mediaId?: string | null;
  objectKey?: string | null;
  declaredMimeType?: string | null;
  declaredBytes?: number | null;
  uploadedAt?: Date | null;
}

interface MediaRow {
  id: string;
  tenantId: string;
  lifecycle: string;
  uploadId: string | null;
  size: number;
  mimeType: string;
}

const state = {
  sessions: [] as SessionRow[],
  media: [] as MediaRow[],
  nextId: 1,
  // T16: the tenant quota-override row returned by fakeDb.tenant.findUnique
  // (null = no override → env defaults apply).
  tenantOverride: null as {
    storageQuotaBytes: bigint | number | null;
    storageQuotaObjects: number | null;
  } | null,
};

/** Match a MediaRow against the (subset of) Prisma where the gates use. */
function matchesMediaWhere(m: MediaRow, where: any): boolean {
  if (!where) return true;
  if (where.tenantId !== undefined && m.tenantId !== where.tenantId) return false;
  if (typeof where.lifecycle === "string" && m.lifecycle !== where.lifecycle) {
    return false;
  }
  if (
    where.lifecycle &&
    typeof where.lifecycle === "object" &&
    Array.isArray(where.lifecycle.in) &&
    !where.lifecycle.in.includes(m.lifecycle)
  ) {
    return false;
  }
  // MediaRow has no deletedAt/updatedAt columns in this fake: treat every row
  // as non-deleted and inside the review window (conservative for the gates).
  return true;
}

function cuid(prefix: string): string {
  // cuid-shaped: 'c' + 24 [a-z0-9]
  const n = String(state.nextId++);
  return ("c" + prefix + "0".repeat(24)).slice(0, 25 - n.length) + n;
}

const fakeDb = {
  uploadSession: {
    create: async ({ data }: any) => {
      const row: SessionRow = { id: cuid("s"), mediaIds: [], ...data };
      state.sessions.push(row);
      return { ...row };
    },
    findFirst: async ({ where }: any) => {
      const hit = state.sessions.find(
        (s) =>
          s.id === where.id &&
          s.userId === where.userId &&
          (where.kind === undefined || s.kind === where.kind),
      );
      return hit ? { ...hit } : null;
    },
    update: async ({ where, data }: any) => {
      const hit = state.sessions.find((s) => s.id === where.id);
      if (!hit) throw new Error("not found");
      Object.assign(hit, data);
      return { ...hit };
    },
    deleteMany: async ({ where }: any) => {
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((s) => s.id !== where.id);
      return { count: before - state.sessions.length };
    },
  },
  mediaFile: {
    create: async ({ data }: any) => {
      const row: MediaRow = {
        id: cuid("m"),
        lifecycle: "AWAITING_UPLOAD",
        ...data,
      };
      state.media.push(row);
      return { ...row };
    },
    findUnique: async ({ where }: any) => {
      const hit = state.media.find((m) => m.id === where.id);
      return hit ? { ...hit } : null;
    },
    updateMany: async ({ where, data }: any) => {
      const hits = state.media.filter(
        (m) =>
          m.id === where.id &&
          (where.lifecycle === undefined || m.lifecycle === where.lifecycle),
      );
      for (const h of hits) Object.assign(h, data);
      return { count: hits.length };
    },
    deleteMany: async ({ where }: any) => {
      const before = state.media.length;
      state.media = state.media.filter(
        (m) =>
          !(
            m.id === where.id &&
            (where.lifecycle === undefined || m.lifecycle === where.lifecycle)
          ),
      );
      return { count: before - state.media.length };
    },
    count: async ({ where }: any = {}) =>
      state.media.filter((m) => matchesMediaWhere(m, where)).length,
    aggregate: async ({ where }: any = {}) => ({
      _sum: {
        size: state.media
          .filter((m) => matchesMediaWhere(m, where))
          .reduce((a, m) => a + m.size, 0),
      },
    }),
  },
  tenant: {
    findUnique: async () =>
      state.tenantOverride === null ? null : { ...state.tenantOverride },
  },
};

vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: async (
    _mgr: unknown,
    _region: string,
    _env: unknown,
    fn: (db: unknown) => Promise<unknown>,
  ) => fn(fakeDb),
  QueryTimeoutPresets: {
    STANDARD: {},
    USER_FACING: {},
  },
}));

vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {},
}));

// The handler resolves the tenant through routes/media.js — mock the module
// so the heavy route file never loads.
const TENANT = "ctenant0000000000000000aa";
const mockResolveTenant = vi.fn(async () => TENANT);
vi.mock("../../src/lib/routes/media", () => ({
  resolveUploadTenantId: (...args: unknown[]) => mockResolveTenant(...args),
}));

vi.mock("../../src/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  Logger: class {},
}));

import {
  PresignedUploadHandler,
  type PresignPort,
} from "../../src/lib/presigned-upload-handler.js";
import type { Env } from "../../src/env.js";

// ---------------------------------------------------------------------------
// Env + port fixtures
// ---------------------------------------------------------------------------

const mockHead = vi.fn();
const mockDelete = vi.fn();

function makeEnv(): Env {
  return {
    MEDIA_BUCKET_NAME: "test-media-bucket",
    MEDIA_BUCKET_R2: { head: mockHead, delete: mockDelete },
    media: {
      maxBytes: { image: 10_000_000, video: 200_000_000, audio: 100_000_000 },
      allowlist: {
        image: ["image/jpeg"],
        video: ["video/mp4", "video/webm", "video/quicktime"],
        audio: ["audio/mpeg", "audio/mp4"],
      },
      uploadQuota: { maxObjects: 1000, maxBytes: 1_000_000_000 },
      // T15c: review-rate cap (flagged objects per rolling window).
      reviewRateCap: 20,
      maxDurationSeconds: 60,
      presignExpirySeconds: 900,
    },
  } as unknown as Env;
}

/** A presign port that records its input and returns a canned grant. */
function makePort(): { port: PresignPort; calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    port: {
      async presignPost(input) {
        calls.push(input);
        return {
          url: `https://${input.bucket}.s3.eu-central-1.amazonaws.com/`,
          fields: {
            key: input.key,
            "Content-Type": input.contentType,
            policy: "b64policy",
            "x-amz-signature": "sig",
          },
        };
      },
    },
  };
}

const USER = "cuser0000000000000000000a";
const OTHER_USER = "cuser0000000000000000000b";

async function createHappySession(handler: PresignedUploadHandler, env: Env) {
  const res = await handler.createSession(USER, "US", env, {
    mimeType: "video/mp4",
    sizeBytes: 5_000_000,
  });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  return res;
}

beforeEach(() => {
  state.sessions = [];
  state.media = [];
  state.nextId = 1;
  state.tenantOverride = null;
  mockHead.mockReset();
  mockDelete.mockReset();
  mockResolveTenant.mockClear();
  mockResolveTenant.mockResolvedValue(TENANT);
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe("PresignedUploadHandler.createSession", () => {
  it("signs the grant with the byte rail and the exact pending/ key; rows born fail-closed", async () => {
    const env = makeEnv();
    const { port, calls } = makePort();
    const handler = new PresignedUploadHandler(env, port);

    const res = await createHappySession(handler, env);

    // The signed grant used the byte rail [1, maxBytes.video] and the exact key.
    expect(calls).toHaveLength(1);
    expect(calls[0].minBytes).toBe(1);
    expect(calls[0].maxBytes).toBe(200_000_000);
    expect(calls[0].key).toBe(`pending/${TENANT}/${res.session.sessionId}`);
    expect(calls[0].contentType).toBe("video/mp4");
    expect(calls[0].expirySeconds).toBe(900);

    // Response carries the upload grant + constraints for the client trimmer.
    expect(res.upload.method).toBe("POST");
    expect(res.upload.fields["Content-Type"]).toBe("video/mp4");
    expect(res.constraints.maxBytes).toBe(200_000_000);
    expect(res.constraints.maxDurationSeconds).toBe(60);

    // DB state: session awaiting-upload; media born AWAITING_UPLOAD (never
    // anything closer to servable).
    expect(state.sessions[0].status).toBe("awaiting-upload");
    expect(state.sessions[0].kind).toBe("presigned");
    expect(state.sessions[0].objectKey).toBe(res.upload.objectKey);
    expect(state.media[0].lifecycle).toBe("AWAITING_UPLOAD");
    expect(state.media[0].uploadId).toBe(res.session.sessionId);
  });

  it("refuses an image MIME with 415 (images keep the proxied sync path)", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const res = await handler.createSession(USER, "US", env, {
      mimeType: "image/jpeg",
      sizeBytes: 1000,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(415);
    // No dangling rows survive a refusal.
    expect(state.sessions).toHaveLength(0);
  });

  it("refuses an over-cap declared size with 413 and leaves no rows", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const res = await handler.createSession(USER, "US", env, {
      mimeType: "video/mp4",
      sizeBytes: 200_000_001,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(413);
    expect(state.sessions).toHaveLength(0);
    expect(state.media).toHaveLength(0);
  });

  // ── T16 quota resolution + T15c review-rate cap on the presigned gate ──

  /** Seed a media row directly (bypasses the handler). */
  const seedMedia = (lifecycle: string, size: number, n = 1) => {
    for (let i = 0; i < n; i++) {
      state.media.push({
        id: cuid("m"),
        tenantId: TENANT,
        lifecycle,
        uploadId: null,
        size,
        mimeType: "video/mp4",
      });
    }
  };

  const createSmallVideoSession = async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    return handler.createSession(USER, "US", env, {
      mimeType: "video/mp4",
      sizeBytes: 1000,
    });
  };

  it("denies 413 when APPROVED usage saturates the env-default byte quota", async () => {
    seedMedia("APPROVED", 1_000_000_000); // == env default maxBytes
    const res = await createSmallVideoSession();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(413);
    expect(res.error).toBe("Upload quota exceeded");
  });

  it("non-APPROVED rows do NOT count against quota (shared storage-accounting predicate)", async () => {
    // The same byte volume in non-verdict/rejected states must not deny.
    seedMedia("UPLOADED", 500_000_000);
    seedMedia("REJECTED", 500_000_000);
    const res = await createSmallVideoSession();
    expect(res.ok).toBe(true);
  });

  it("tenant byte override WINS over the env default (413 at the override)", async () => {
    state.tenantOverride = { storageQuotaBytes: BigInt(1000), storageQuotaObjects: null };
    seedMedia("APPROVED", 999);
    const res = await createSmallVideoSession(); // 999 + 1000 > 1000
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(413);
  });

  it("tenant object override WINS over the env default (429 object-cap)", async () => {
    state.tenantOverride = { storageQuotaBytes: null, storageQuotaObjects: 1 };
    seedMedia("APPROVED", 10);
    const res = await createSmallVideoSession();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(429);
    expect(res.error).toBe("Upload quota exceeded");
  });

  it("NULL override columns fall back to the env default (allowed)", async () => {
    state.tenantOverride = { storageQuotaBytes: null, storageQuotaObjects: null };
    seedMedia("APPROVED", 10, 3);
    const res = await createSmallVideoSession();
    expect(res.ok).toBe(true);
  });

  it("fail-closed: a broken (NaN) byte override denies instead of widening", async () => {
    state.tenantOverride = {
      storageQuotaBytes: Number.NaN,
      storageQuotaObjects: null,
    };
    const res = await createSmallVideoSession();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect([413, 429]).toContain(res.status);
    expect(res.error).toBe("Upload quota exceeded");
  });

  it("denies 429 (Upload rate limited) when the review-rate cap is reached", async () => {
    seedMedia("REVIEW", 10, 15);
    seedMedia("QUARANTINED", 10, 5); // 15 + 5 == cap (20)
    const res = await createSmallVideoSession();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(429);
    expect(res.error).toBe("Upload rate limited");
  });

  it("allows when flagged objects are one below the review-rate cap", async () => {
    seedMedia("REVIEW", 10, 19);
    const res = await createSmallVideoSession();
    expect(res.ok).toBe(true);
  });

  it("fails closed (500) when no tenant resolves", async () => {
    mockResolveTenant.mockResolvedValue(null);
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const res = await handler.createSession(USER, "US", env, {
      mimeType: "video/mp4",
      sizeBytes: 1000,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(500);
  });

  it("cleans up the session + media rows when signing fails (no orphaned grant state)", async () => {
    const env = makeEnv();
    const failingPort: PresignPort = {
      presignPost: async () => {
        throw new Error("KMS on fire");
      },
    };
    const handler = new PresignedUploadHandler(env, failingPort);
    const res = await handler.createSession(USER, "US", env, {
      mimeType: "video/mp4",
      sizeBytes: 1000,
    });
    expect(res.ok).toBe(false);
    expect(state.sessions).toHaveLength(0);
    expect(state.media).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// completeSession
// ---------------------------------------------------------------------------

describe("PresignedUploadHandler.completeSession", () => {
  it("AUTHZ: another user's session id yields 404 and mutates nothing", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const created = await createHappySession(handler, env);

    mockHead.mockResolvedValue({ size: 5_000_000 });
    const res = await handler.completeSession(
      created.session.sessionId,
      OTHER_USER,
      "US",
      env,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(404);
    // Nothing moved: media still AWAITING_UPLOAD, session still awaiting.
    expect(state.media[0].lifecycle).toBe("AWAITING_UPLOAD");
    expect(state.sessions[0].status).toBe("awaiting-upload");
  });

  it("refuses (409) when the staged object has not arrived — completion cannot conjure bytes", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const created = await createHappySession(handler, env);

    mockHead.mockResolvedValue(null);
    const res = await handler.completeSession(
      created.session.sessionId,
      USER,
      "US",
      env,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(state.media[0].lifecycle).toBe("AWAITING_UPLOAD");
  });

  it("drives AWAITING_UPLOAD -> UPLOADED and flips the session — and NEVER lands on APPROVED", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const created = await createHappySession(handler, env);

    mockHead.mockResolvedValue({ size: 4_900_000 });
    const res = await handler.completeSession(
      created.session.sessionId,
      USER,
      "US",
      env,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.media.lifecycle).toBe("UPLOADED"); // never APPROVED from here
    expect(state.media[0].lifecycle).toBe("UPLOADED");
    expect(state.media[0].size).toBe(4_900_000); // actual size adopted
    expect(state.sessions[0].status).toBe("uploaded");
  });

  it("is idempotent: a second complete reports the current state without rewinding", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const created = await createHappySession(handler, env);

    mockHead.mockResolvedValue({ size: 100 });
    const first = await handler.completeSession(
      created.session.sessionId,
      USER,
      "US",
      env,
    );
    expect(first.ok).toBe(true);
    const second = await handler.completeSession(
      created.session.sessionId,
      USER,
      "US",
      env,
    );
    expect(second.ok).toBe(true);
    expect(state.media[0].lifecycle).toBe("UPLOADED");
  });

  it("AR-SEC F1: persists the real object size even when the worker won the race (media already UPLOADED)", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const created = await createHappySession(handler, env);

    // The S3 OBJECT_CREATED worker already drove bytes-arrived: media is
    // UPLOADED, but the row still carries the client-DECLARED size (the
    // quota-abuse vector: declare 1 byte, upload megabytes).
    state.media[0].lifecycle = "UPLOADED";
    state.media[0].size = 1;
    mockHead.mockResolvedValue({ size: 4_900_000 });

    const res = await handler.completeSession(
      created.session.sessionId,
      USER,
      "US",
      env,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.media.lifecycle).toBe("UPLOADED");
    // The lifecycle transition was an idempotent no-op, but the authoritative
    // HEAD size must be persisted regardless — quota (_sum: size) counts it.
    expect(state.media[0].size).toBe(4_900_000);
  });

  it("does NOT rewind a resolved verdict (fast pipeline won the race)", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const created = await createHappySession(handler, env);

    // Pipeline resolved REVIEW before the client called complete.
    state.media[0].lifecycle = "REVIEW";
    mockHead.mockResolvedValue({ size: 100 });

    const res = await handler.completeSession(
      created.session.sessionId,
      USER,
      "US",
      env,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The verdict stands; completion reports it and cannot rewind it.
    expect(res.media.lifecycle).toBe("REVIEW");
    expect(state.media[0].lifecycle).toBe("REVIEW");
  });

  it("expired session ⇒ 410, media driven to UPLOAD_FAILED, staged object removed", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const created = await createHappySession(handler, env);
    state.sessions[0].expiresAt = new Date(Date.now() - 1000);

    const res = await handler.completeSession(
      created.session.sessionId,
      USER,
      "US",
      env,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(410);
    expect(state.media[0].lifecycle).toBe("UPLOAD_FAILED");
    expect(state.sessions[0].status).toBe("expired");
    expect(mockDelete).toHaveBeenCalledWith(
      `pending/${TENANT}/${created.session.sessionId}`,
    );
  });
});

// ---------------------------------------------------------------------------
// abandonSession
// ---------------------------------------------------------------------------

describe("PresignedUploadHandler.abandonSession", () => {
  it("AUTHZ: another user's session id yields 404", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const created = await createHappySession(handler, env);

    const res = await handler.abandonSession(
      created.session.sessionId,
      OTHER_USER,
      "US",
      env,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(404);
    expect(state.sessions[0].status).toBe("awaiting-upload");
  });

  it("marks the session abandoned, drives UPLOAD_FAILED, deletes the staged object", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const created = await createHappySession(handler, env);

    const res = await handler.abandonSession(
      created.session.sessionId,
      USER,
      "US",
      env,
    );
    expect(res.ok).toBe(true);
    expect(state.sessions[0].status).toBe("abandoned");
    expect(state.media[0].lifecycle).toBe("UPLOAD_FAILED");
    expect(mockDelete).toHaveBeenCalledWith(
      `pending/${TENANT}/${created.session.sessionId}`,
    );
  });

  it("refuses (409) once the pipeline has resolved a verdict — abandon cannot destroy audit state", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const created = await createHappySession(handler, env);
    state.media[0].lifecycle = "APPROVED";

    const res = await handler.abandonSession(
      created.session.sessionId,
      USER,
      "US",
      env,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(state.media[0].lifecycle).toBe("APPROVED");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("is idempotent: abandoning an abandoned session succeeds", async () => {
    const env = makeEnv();
    const handler = new PresignedUploadHandler(env, makePort().port);
    const created = await createHappySession(handler, env);

    await handler.abandonSession(created.session.sessionId, USER, "US", env);
    const res = await handler.abandonSession(
      created.session.sessionId,
      USER,
      "US",
      env,
    );
    expect(res.ok).toBe(true);
  });
});
