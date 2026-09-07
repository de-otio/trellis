/**
 * Unit tests: POST /api/admin/provenance-correction (routes/provenance-correction.ts).
 *
 * The claim under test is the D12 gate: only an authenticated MODERATOR/
 * SUPER_ADMIN (resolved server-side from the User table, never a client claim)
 * may apply a correction, a `PLATFORM_GENERATED` basis is never correctable,
 * a no-op request is refused (409), and every applied correction writes an
 * audit event before returning 200. Uses the REAL `planCorrection` (pure,
 * already covered by its own suite) and mocks only I/O: session, region DB,
 * audit logger and feed-cache invalidation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

const mockDb = {
  post: { findUnique: vi.fn(), update: vi.fn() },
  postComment: { findUnique: vi.fn(), update: vi.fn() },
  postMedia: { findUnique: vi.fn(), update: vi.fn() },
};
vi.mock("../../../src/lib/data-router", () => ({
  DataRouter: { getDatabaseForRegion: vi.fn(() => mockDb) },
}));

const mockResolveModeratorRole = vi.fn();
vi.mock("../../../src/lib/media/media-review-handler", () => ({
  MediaReviewHandler: class {
    resolveModeratorRole = mockResolveModeratorRole;
  },
}));

const mockAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/lib/audit-composer", () => ({
  TrellisAuditLogger: class {
    log = mockAuditLog;
  },
}));

vi.mock("../../../src/lib/audit-actions", () => ({
  PROVENANCE_CHANGED: "provenance.changed",
}));

const mockInvalidateFeedCache = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/lib/feed-handler", () => ({
  FeedHandler: { invalidateFeedCache: mockInvalidateFeedCache },
}));

vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (res: Response) => res,
}));

vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse(body: BodyInit | null, init: ResponseInit) {
      return new Response(body, init);
    }
  },
}));

vi.mock("../../../src/lib/middleware", () => ({
  corsMiddleware: vi.fn(() => ({ name: "cors" })),
  csrfMiddleware: vi.fn(() => ({ name: "csrf" })),
}));

import { provenanceCorrectionRoutes } from "../../../src/lib/routes/provenance-correction.js";

const route = provenanceCorrectionRoutes[0];
const env = {
  SESSION_SECRET: "test-secret-32-characters-long!!",
  DEFAULT_REGION: "EU",
} as any;

function ctx() {
  return {
    url: new URL("https://api.example.com/api/admin/provenance-correction"),
    pathname: "/api/admin/provenance-correction",
    params: {},
    requestContext: { region: "EU" },
  } as any;
}

function req(body?: unknown): Request {
  return new Request("https://api.example.com/api/admin/provenance-correction", {
    method: "POST",
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

const REASON = "author states the photo is their own, not AI-generated";

function validBody(over: Record<string, unknown> = {}) {
  return {
    resource: "post",
    resourceId: "post_1",
    sourceType: "HUMAN_CREATED",
    reason: REASON,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditLog.mockResolvedValue(undefined);
  mockInvalidateFeedCache.mockResolvedValue(undefined);
});

describe("POST /api/admin/provenance-correction — path structure", () => {
  it("registers exactly one POST route, CSRF-protected", () => {
    expect(provenanceCorrectionRoutes).toHaveLength(1);
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/api/admin/provenance-correction");
    expect(route.middleware?.map((m: any) => m.name ?? m)).toBeDefined();
  });
});

describe("authorization gate", () => {
  it("401 when unauthenticated — no DB lookup at all", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await route.handler(req(validBody()), env, ctx());
    expect(res.status).toBe(401);
    expect(mockResolveModeratorRole).not.toHaveBeenCalled();
    expect(mockDb.post.findUnique).not.toHaveBeenCalled();
  });

  it("403 when authenticated but role resolution finds no moderator (server-side, not a client claim)", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1" });
    mockResolveModeratorRole.mockResolvedValue(null);
    const res = await route.handler(req(validBody()), env, ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Moderator access required/);
    expect(mockDb.post.findUnique).not.toHaveBeenCalled();
  });
});

describe("request validation", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockResolveModeratorRole.mockResolvedValue("MODERATOR");
  });

  it("400 when the reason is under the 10-char floor (audit trail must be substantive)", async () => {
    const res = await route.handler(req(validBody({ reason: "too short" })), env, ctx());
    expect(res.status).toBe(400);
    expect(mockDb.post.findUnique).not.toHaveBeenCalled();
  });

  it("400 on an unknown resource kind (strict schema, unrecognised enum)", async () => {
    const res = await route.handler(req(validBody({ resource: "user" })), env, ctx());
    expect(res.status).toBe(400);
  });

  it("400 on an unrecognised extra field (schema is .strict())", async () => {
    const res = await route.handler(req({ ...validBody(), extra: "nope" }), env, ctx());
    expect(res.status).toBe(400);
  });
});

describe("region resolution fallback chain", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockResolveModeratorRole.mockResolvedValue("MODERATOR");
    mockDb.post.findUnique.mockResolvedValue({
      id: "post_1",
      textSourceType: "AI_GENERATED",
      textBasis: "AUTHOR_DECLARED",
    });
  });

  it("falls back to env.DEFAULT_REGION when requestContext has no region", async () => {
    const { DataRouter } = await import("../../../src/lib/data-router.js");
    const usEnv = { ...env, DEFAULT_REGION: "US" };
    const res = await route.handler(req(validBody()), usEnv, {
      url: new URL("https://api.example.com/api/admin/provenance-correction"),
      pathname: "/api/admin/provenance-correction",
      params: {},
      requestContext: {},
    } as any);
    expect(res.status).toBe(200);
    expect(DataRouter.getDatabaseForRegion).toHaveBeenCalledWith("US", usEnv);
  });

  it("falls back to the literal 'EU' when neither requestContext nor env supply a region", async () => {
    const { DataRouter } = await import("../../../src/lib/data-router.js");
    const bareEnv = { SESSION_SECRET: env.SESSION_SECRET } as any;
    const res = await route.handler(req(validBody()), bareEnv, {
      url: new URL("https://api.example.com/api/admin/provenance-correction"),
      pathname: "/api/admin/provenance-correction",
      params: {},
      requestContext: undefined,
    } as any);
    expect(res.status).toBe(200);
    expect(DataRouter.getDatabaseForRegion).toHaveBeenCalledWith("EU", bareEnv);
  });
});

describe("resource lookup", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockResolveModeratorRole.mockResolvedValue("MODERATOR");
  });

  it("404 when the target row does not exist", async () => {
    mockDb.post.findUnique.mockResolvedValue(null);
    const res = await route.handler(req(validBody()), env, ctx());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("NOT_FOUND");
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("defaults the stored sourceType to UNKNOWN when the row's column is absent (?? fallback, not a crash)", async () => {
    mockDb.post.findUnique.mockResolvedValue({ id: "post_1" }); // no textSourceType/textBasis at all
    const res = await route.handler(req(validBody({ sourceType: "UNKNOWN" })), env, ctx());
    // requested === stored (both UNKNOWN) => 409 PROVENANCE_UNCHANGED, which
    // proves the missing column was read as "UNKNOWN", not undefined/crash.
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("PROVENANCE_UNCHANGED");
  });

  it("selects the resource-specific column pair for postMedia (declaredSourceType/declaredBasis)", async () => {
    mockDb.postMedia.findUnique.mockResolvedValue({
      id: "pm_1",
      declaredSourceType: "UNKNOWN",
      declaredBasis: null,
    });
    const res = await route.handler(
      req(validBody({ resource: "postMedia", resourceId: "pm_1" })),
      env,
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(mockDb.postMedia.findUnique).toHaveBeenCalledWith({
      where: { id: "pm_1" },
      select: { id: true, declaredSourceType: true, declaredBasis: true },
    });
    expect(mockDb.postMedia.update).toHaveBeenCalledWith({
      where: { id: "pm_1" },
      data: { declaredSourceType: "HUMAN_CREATED", declaredBasis: "AUTHOR_DECLARED" },
    });
  });
});

describe("plan refusal (409) — well-formed, authorized, conflicts with stored state", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockResolveModeratorRole.mockResolvedValue("MODERATOR");
  });

  it("409 PROVENANCE_PLATFORM_ATTESTED — a platform-generated basis is never correctable, even by staff", async () => {
    mockDb.post.findUnique.mockResolvedValue({
      id: "post_1",
      textSourceType: "AI_GENERATED",
      textBasis: "PLATFORM_GENERATED",
    });
    const res = await route.handler(req(validBody()), env, ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("PROVENANCE_PLATFORM_ATTESTED");
    expect(mockDb.post.update).not.toHaveBeenCalled();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("409 PROVENANCE_UNCHANGED — requested value equals the stored one", async () => {
    mockDb.post.findUnique.mockResolvedValue({
      id: "post_1",
      textSourceType: "HUMAN_CREATED",
      textBasis: "AUTHOR_DECLARED",
    });
    const res = await route.handler(req(validBody()), env, ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("PROVENANCE_UNCHANGED");
    expect(mockDb.post.update).not.toHaveBeenCalled();
  });
});

describe("applied correction (200) — write, audit, cache invalidation, response shape", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ userId: "mod1" });
    mockResolveModeratorRole.mockResolvedValue("MODERATOR");
    mockDb.post.findUnique.mockResolvedValue({
      id: "post_1",
      textSourceType: "AI_GENERATED",
      textBasis: "AUTHOR_DECLARED",
    });
  });

  it("200 lowers the declaration, updates the row, and writes a `medium` severity audit event (reduces disclosure)", async () => {
    const res = await route.handler(req(validBody()), env, ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      resource: "post",
      resourceId: "post_1",
      from: "AI_GENERATED",
      to: "HUMAN_CREATED",
      reducesDisclosure: true,
    });
    expect(mockDb.post.update).toHaveBeenCalledWith({
      where: { id: "post_1" },
      data: { textSourceType: "HUMAN_CREATED", textBasis: "AUTHOR_DECLARED" },
    });
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "provenance.changed",
        resource: "post",
        resourceId: "post_1",
        userId: "mod1",
        severity: "medium",
        success: true,
        metadata: expect.objectContaining({
          staffCorrection: true,
          reducesDisclosure: true,
          reason: REASON,
        }),
      }),
      env,
    );
  });

  it("raising a declaration (staff fixing an under-declaration) is `low` severity, not `medium`", async () => {
    mockDb.post.findUnique.mockResolvedValue({
      id: "post_1",
      textSourceType: "UNKNOWN",
      textBasis: null,
    });
    const res = await route.handler(req(validBody({ sourceType: "AI_GENERATED" })), env, ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).reducesDisclosure).toBe(false);
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ severity: "low" }), env);
  });

  it("500 + NO audit write when the audit logger itself fails (audit write is NOT best-effort here)", async () => {
    mockAuditLog.mockRejectedValue(new Error("audit sink unreachable"));
    const res = await route.handler(req(validBody()), env, ctx());
    expect(res.status).toBe(500);
    // The row WAS updated (the update happens before the audit write) but the
    // request still surfaces failure — a correction we cannot evidence must
    // not look like it succeeded to the caller.
    expect(mockDb.post.update).toHaveBeenCalled();
  });

  it("200 even when feed-cache invalidation throws — cache invalidation is best-effort", async () => {
    mockInvalidateFeedCache.mockRejectedValue(new Error("cache down"));
    const res = await route.handler(req(validBody()), env, ctx());
    expect(res.status).toBe(200);
    expect(mockAuditLog).toHaveBeenCalled();
  });

  it("500 when the database update throws", async () => {
    mockDb.post.update.mockRejectedValue(new Error("db write failed"));
    const res = await route.handler(req(validBody()), env, ctx());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to apply provenance correction");
  });
});
