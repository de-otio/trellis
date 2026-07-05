/**
 * Unit tests: T9 media-review moderator ROUTES (routes/media-review.ts).
 *
 * Exercises the request→route→handler wiring with a mocked session, a mocked
 * region DB (DataRouter), and a mocked audit logger, so the authenticated
 * happy-paths and the role gate run end-to-end at the route layer:
 *   - 401 when unauthenticated (no session);
 *   - 403 when authenticated but NOT a moderator (role gate, server-side);
 *   - 200 list for a moderator (image + video items, per-track verdicts);
 *   - 200 approve → promoted; 200 reject; 409 illegal-state;
 *   - CSAM escalate → locked + paged;
 *   - audited content byte-view via a mocked R2 bucket.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

const mockDb = {
  user: { findUnique: vi.fn() },
  mediaFile: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
};
vi.mock("../../../src/lib/data-router", () => ({
  DataRouter: { getDatabaseForRegion: vi.fn(() => mockDb) },
}));

const mockLogSystemAction = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/lib/audit-composer", () => ({
  createAuditLogger: vi.fn(() => ({ logSystemAction: mockLogSystemAction })),
}));

vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (res: Response) => res,
}));

vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse(body: BodyInit | null, init: ResponseInit) {
      return new Response(body, init);
    }
    addSecurityHeaders(response: Response) {
      return response;
    }
  },
}));

vi.mock("../../../src/lib/middleware", () => ({
  corsMiddleware: vi.fn(() => ({ name: "cors" })),
  csrfMiddleware: vi.fn(() => ({ name: "csrf" })),
}));

import { mediaReviewRoutes } from "../../../src/lib/routes/media-review.js";

const env = {
  SESSION_SECRET: "test-secret-32-characters-long!!",
  DEFAULT_REGION: "EU",
  media: { canonicalFormat: "jpeg" },
} as any;

function routeFor(method: string, matchPath: string) {
  const r = mediaReviewRoutes.find((rt) => {
    const m = Array.isArray(rt.method) ? rt.method : [rt.method];
    if (!m.includes(method as any)) return false;
    return typeof rt.path === "string"
      ? rt.path === matchPath
      : rt.path.test(matchPath);
  });
  if (!r) throw new Error(`no route for ${method} ${matchPath}`);
  return r;
}

function ctx(pathname: string, search = "") {
  return {
    url: new URL(`https://api.example.com${pathname}${search}`),
    pathname,
    params: {},
    requestContext: { region: "EU" },
  } as any;
}

function req(method: string, pathname: string, body?: unknown): Request {
  return new Request(`https://api.example.com${pathname}`, {
    method,
    ...(body !== undefined
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLogSystemAction.mockResolvedValue(undefined);
});

describe("GET /api/admin/media-review", () => {
  const route = routeFor("GET", "/api/admin/media-review");

  it("401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await route.handler(
      req("GET", "/api/admin/media-review"),
      env,
      ctx("/api/admin/media-review"),
    );
    expect(res.status).toBe(401);
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });

  it("403 when authenticated but NOT a moderator (server-side role gate)", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1" });
    mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });
    const res = await route.handler(
      req("GET", "/api/admin/media-review"),
      env,
      ctx("/api/admin/media-review"),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Moderator access required/);
  });

  it("500 when the list query throws (error path)", async () => {
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockDb.user.findUnique.mockResolvedValue({ role: "MODERATOR" });
    mockDb.mediaFile.findMany.mockRejectedValue(new Error("db down"));
    const res = await route.handler(
      req("GET", "/api/admin/media-review"),
      env,
      ctx("/api/admin/media-review"),
    );
    expect(res.status).toBe(500);
  });

  it("200 list for a MODERATOR — image + video with per-track verdicts", async () => {
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockDb.user.findUnique.mockResolvedValue({ role: "MODERATOR" });
    mockDb.mediaFile.findMany.mockResolvedValue([
      {
        id: "img1",
        tenantId: "t1",
        mimeType: "image/jpeg",
        lifecycle: "QUARANTINED",
        size: 10,
        width: 100,
        height: 100,
        duration: null,
        createdAt: new Date("2026-07-05T00:00:00Z"),
        moderationJobs: [{ track: "VISUAL", decision: "quarantine" }],
      },
      {
        id: "vid1",
        tenantId: "t1",
        mimeType: "video/mp4",
        lifecycle: "REVIEW",
        size: 999,
        width: 1080,
        height: 1920,
        duration: 30,
        createdAt: new Date("2026-07-05T00:00:00Z"),
        moderationJobs: [
          { track: "VISUAL", decision: "review" },
          { track: "AUDIO", decision: "approved" },
        ],
      },
    ]);

    const res = await route.handler(
      req("GET", "/api/admin/media-review"),
      env,
      ctx("/api/admin/media-review", "?limit=10"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].kind).toBe("image");
    expect(body.items[1].kind).toBe("video");
    expect(body.items[1].tracks).toEqual([
      { track: "VISUAL", decision: "review" },
      { track: "AUDIO", decision: "approved" },
    ]);
  });
});

describe("POST /api/admin/media-review/:id/decision", () => {
  const route = routeFor("POST", "/api/admin/media-review/vid1/decision");

  async function asModerator() {
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockDb.user.findUnique.mockResolvedValue({ role: "MODERATOR" });
  }

  it("403 for a non-moderator", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1" });
    mockDb.user.findUnique.mockResolvedValue({ role: "CONTENT_CREATOR" });
    const res = await route.handler(
      req("POST", "/api/admin/media-review/vid1/decision", { decision: "approve" }),
      env,
      ctx("/api/admin/media-review/vid1/decision"),
    );
    expect(res.status).toBe(403);
  });

  it("200 approve → promoted, audit written", async () => {
    await asModerator();
    mockDb.mediaFile.findUnique.mockResolvedValue({
      id: "vid1",
      tenantId: "t1",
      lifecycle: "REVIEW",
      originalKey: "cas/t1/h",
      deletedAt: null,
    });
    const res = await route.handler(
      req("POST", "/api/admin/media-review/vid1/decision", { decision: "approve" }),
      env,
      ctx("/api/admin/media-review/vid1/decision"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, lifecycle: "APPROVED", promoted: true });
    expect(mockLogSystemAction).toHaveBeenCalledWith(
      "media.moderation.approved",
      expect.objectContaining({ resourceId: "vid1", userId: "mod1" }),
      env,
    );
  });

  it("200 reject → REJECTED", async () => {
    await asModerator();
    mockDb.mediaFile.findUnique.mockResolvedValue({
      id: "vid1",
      tenantId: "t1",
      lifecycle: "REVIEW",
      originalKey: "cas/t1/h",
      deletedAt: null,
    });
    const res = await route.handler(
      req("POST", "/api/admin/media-review/vid1/decision", { decision: "reject" }),
      env,
      ctx("/api/admin/media-review/vid1/decision"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).lifecycle).toBe("REJECTED");
  });

  it("409 when the item is not awaiting review (illegal state)", async () => {
    await asModerator();
    mockDb.mediaFile.findUnique.mockResolvedValue({
      id: "vid1",
      tenantId: "t1",
      lifecycle: "APPROVED",
      originalKey: "cas/t1/h",
      deletedAt: null,
    });
    const res = await route.handler(
      req("POST", "/api/admin/media-review/vid1/decision", { decision: "reject" }),
      env,
      ctx("/api/admin/media-review/vid1/decision"),
    );
    expect(res.status).toBe(409);
  });

  it("400 on an invalid decision body", async () => {
    await asModerator();
    const res = await route.handler(
      req("POST", "/api/admin/media-review/vid1/decision", { decision: "maybe" }),
      env,
      ctx("/api/admin/media-review/vid1/decision"),
    );
    expect(res.status).toBe(400);
  });

  it("404 when the item does not exist", async () => {
    await asModerator();
    mockDb.mediaFile.findUnique.mockResolvedValue(null);
    const res = await route.handler(
      req("POST", "/api/admin/media-review/gone/decision", { decision: "approve" }),
      env,
      ctx("/api/admin/media-review/gone/decision"),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/media-review/:id/escalate-csam", () => {
  const route = routeFor("POST", "/api/admin/media-review/vid1/escalate-csam");

  it("200 locks + pages, critical audit; 403 for non-moderator", async () => {
    // non-moderator
    mockGetSession.mockResolvedValue({ userId: "u1" });
    mockDb.user.findUnique.mockResolvedValue({ role: "END_USER" });
    const denied = await route.handler(
      req("POST", "/api/admin/media-review/vid1/escalate-csam"),
      env,
      ctx("/api/admin/media-review/vid1/escalate-csam"),
    );
    expect(denied.status).toBe(403);

    // moderator
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockDb.user.findUnique.mockResolvedValue({ role: "SUPER_ADMIN" });
    mockDb.mediaFile.findUnique.mockResolvedValue({
      id: "vid1",
      tenantId: "t1",
      lifecycle: "REVIEW",
      deletedAt: null,
    });
    const res = await route.handler(
      req("POST", "/api/admin/media-review/vid1/escalate-csam"),
      env,
      ctx("/api/admin/media-review/vid1/escalate-csam"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ locked: true, pagedForHumanReview: true, lifecycle: "REJECTED" });
    expect(mockLogSystemAction).toHaveBeenCalledWith(
      "media.moderation.csam_escalated",
      expect.objectContaining({ severity: "critical" }),
      env,
    );
  });
});

describe("GET /api/admin/media-review/:id/content (audited byte view)", () => {
  const route = routeFor("GET", "/api/admin/media-review/vid1/content");

  it("serves bytes for a REVIEW item + writes the view audit", async () => {
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockDb.user.findUnique.mockResolvedValue({ role: "MODERATOR" });
    mockDb.mediaFile.findUnique.mockResolvedValue({
      id: "vid1",
      tenantId: "t1",
      lifecycle: "REVIEW",
      deletedAt: null,
      originalKey: "cas/t1/h",
      mimeType: "video/mp4",
    });
    const bucketEnv = {
      ...env,
      MEDIA_BUCKET_R2: { get: vi.fn().mockResolvedValue({ body: "VIDEOBYTES" }) },
    };
    const res = await route.handler(
      req("GET", "/api/admin/media-review/vid1/content"),
      bucketEnv,
      ctx("/api/admin/media-review/vid1/content"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mockLogSystemAction).toHaveBeenCalledWith(
      "media.moderation.viewed",
      expect.objectContaining({ resourceId: "vid1" }),
      bucketEnv,
    );
  });

  it("404 when the bytes are absent in the bucket (bucket.get → null)", async () => {
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockDb.user.findUnique.mockResolvedValue({ role: "MODERATOR" });
    mockDb.mediaFile.findUnique.mockResolvedValue({
      id: "vid1",
      tenantId: "t1",
      lifecycle: "REVIEW",
      deletedAt: null,
      originalKey: "cas/t1/h",
      mimeType: "image/jpeg",
    });
    const res = await route.handler(
      req("GET", "/api/admin/media-review/vid1/content"),
      { ...env, MEDIA_BUCKET_R2: { get: vi.fn().mockResolvedValue(null) } },
      ctx("/api/admin/media-review/vid1/content"),
    );
    expect(res.status).toBe(404);
    // Image content uses the canonical content-type, exercised via the served path.
  });

  it("serves an IMAGE review item with the canonical content-type", async () => {
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockDb.user.findUnique.mockResolvedValue({ role: "MODERATOR" });
    mockDb.mediaFile.findUnique.mockResolvedValue({
      id: "img1",
      tenantId: "t1",
      lifecycle: "QUARANTINED",
      deletedAt: null,
      originalKey: "cas/t1/h",
      mimeType: "image/heic",
    });
    const res = await route.handler(
      req("GET", "/api/admin/media-review/img1/content"),
      { ...env, MEDIA_BUCKET_R2: { get: vi.fn().mockResolvedValue({ body: "IMG" }) } },
      ctx("/api/admin/media-review/img1/content"),
    );
    expect(res.status).toBe(200);
    // canonicalFormat "jpeg" → image/jpeg, never the attacker-influenced mime.
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("404 for an APPROVED (non-reviewable) item, no audit", async () => {
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockDb.user.findUnique.mockResolvedValue({ role: "MODERATOR" });
    mockDb.mediaFile.findUnique.mockResolvedValue({
      id: "ok1",
      tenantId: "t1",
      lifecycle: "APPROVED",
      deletedAt: null,
      originalKey: "cas/t1/h",
      mimeType: "image/jpeg",
    });
    const res = await route.handler(
      req("GET", "/api/admin/media-review/ok1/content"),
      { ...env, MEDIA_BUCKET_R2: { get: vi.fn() } },
      ctx("/api/admin/media-review/ok1/content"),
    );
    expect(res.status).toBe(404);
    expect(mockLogSystemAction).not.toHaveBeenCalled();
  });
});
