/**
 * Unit tests: ClassificationHandler
 *
 * Covers all four public methods:
 *   handleUpsert    — PUT  /api/tenants/:id/classification
 *   handleGet       — GET  /api/tenants/:id/classification
 *   handleAddTag    — POST /api/tenants/:id/classification/tags
 *   handleRemoveTag — DELETE /api/tenants/:id/classification/tags/:tagId
 *
 * Locked invariants:
 *   - Cross-tenant isolation: requireActiveTenant/requireOwnTenant denials
 *     short-circuit before any DB call (ADMIN of tenant X cannot access tenant Y).
 *   - Capability check fires after cross-tenant guard (non-admin is denied 403).
 *   - Non-existent category → 404; inactive category → 422.
 *   - No free-text category path — only existing active PlatformCategory rows accepted.
 *   - emitClassificationAudit is called on every successful mutation with the
 *     correct action, including both tag events.
 *   - handleGet uses requireOwnTenant (404) not requireActiveTenant (403).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../../src/lib/auth/auth-context.js";
import type { Env } from "../../src/env.js";
import type { TenantRole, UserRole } from "@prisma/client";

// ── Hoisted mock factories ────────────────────────────────────────────────────

const {
  requireActiveTenantMock,
  requireOwnTenantMock,
  requireCapabilityMock,
  emitClassificationAuditMock,
  mockDb,
} = vi.hoisted(() => ({
  requireActiveTenantMock: vi.fn<() => Response | null>().mockReturnValue(null),
  requireOwnTenantMock: vi.fn<() => Response | null>().mockReturnValue(null),
  requireCapabilityMock: vi.fn<() => Response | null>().mockReturnValue(null),
  emitClassificationAuditMock: vi.fn<() => void>(),
  mockDb: {
    platformCategory: {
      findUnique: vi.fn(),
    },
    tenantClassification: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    tenantClassificationTag: {
      create: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../src/db", () => ({
  createPrisma: () => mockDb,
}));

vi.mock("../../src/lib/auth/auth-middleware", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/auth/auth-middleware.js")>()),
  requireActiveTenant: requireActiveTenantMock,
  requireOwnTenant: requireOwnTenantMock,
}));

vi.mock("../../src/lib/auth/require", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/auth/require.js")>()),
  requireCapability: requireCapabilityMock,
}));

vi.mock("../../src/lib/tenant/classification-audit-emit", () => ({
  emitClassificationAudit: emitClassificationAuditMock,
}));

// ── Import SUT (after mocks) ──────────────────────────────────────────────────

import { ClassificationHandler } from "../../src/lib/tenant/classification-handler.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    cognitoSub: "cognito-sub-caller",
    userId: "caller-user-id",
    globalRole: "END_USER" as UserRole,
    activeTenantId: "tenant-abc",
    tenantSlug: "org-a",
    tenantRole: "ADMIN" as TenantRole,
    handle: "caller",
    membershipsLoader: async () => [],
    ...overrides,
  };
}

const mockEnv = {} as Env;

function makeRequest(
  method: string,
  url: string,
  body?: unknown,
): Request {
  if (body !== undefined) {
    return new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return new Request(url, { method });
}

// ── handleUpsert ──────────────────────────────────────────────────────────────

describe("ClassificationHandler.handleUpsert", () => {
  let handler: ClassificationHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    requireActiveTenantMock.mockReturnValue(null);
    requireCapabilityMock.mockReturnValue(null);
    handler = new ClassificationHandler();
  });

  it("returns 201 when creating a new classification", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: "cat-1", isActive: true });
    mockDb.tenantClassification.findUnique.mockResolvedValue(null); // no existing
    const created = {
      id: "cls-1",
      tenantId: "tenant-abc",
      categoryId: "cat-1",
      verificationSource: "SELF_DECLARED",
      verifiedAt: null,
      verificationRevokedAt: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };
    mockDb.tenantClassification.upsert.mockResolvedValue(created);

    const req = makeRequest("PUT", "https://api.example.com/api/tenants/tenant-abc/classification", {
      categoryId: "cat-1",
    });
    const res = await handler.handleUpsert("tenant-abc", req, makeAuth(), mockEnv);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toBe("cls-1");
    expect(body.categoryId).toBe("cat-1");
    // Audit emitted for new classification
    expect(emitClassificationAuditMock).toHaveBeenCalledOnce();
    expect(emitClassificationAuditMock.mock.calls[0][0]).toMatchObject({
      action: "classification.created",
      tenantId: "tenant-abc",
      actorUserId: "caller-user-id",
    });
  });

  it("returns 200 and emits category_changed when category changes", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: "cat-2", isActive: true });
    mockDb.tenantClassification.findUnique.mockResolvedValue({ id: "cls-1", categoryId: "cat-1" });
    const updated = {
      id: "cls-1",
      tenantId: "tenant-abc",
      categoryId: "cat-2",
      verificationSource: "SELF_DECLARED",
      verifiedAt: null,
      verificationRevokedAt: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
    };
    mockDb.tenantClassification.upsert.mockResolvedValue(updated);

    const req = makeRequest("PUT", "https://api.example.com/api/tenants/tenant-abc/classification", {
      categoryId: "cat-2",
    });
    const res = await handler.handleUpsert("tenant-abc", req, makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    expect(emitClassificationAuditMock).toHaveBeenCalledOnce();
    expect(emitClassificationAuditMock.mock.calls[0][0]).toMatchObject({
      action: "classification.category_changed",
      metadata: { oldCategoryId: "cat-1", newCategoryId: "cat-2" },
    });
  });

  it("does not emit audit when updating with same category", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: "cat-1", isActive: true });
    mockDb.tenantClassification.findUnique.mockResolvedValue({ id: "cls-1", categoryId: "cat-1" });
    mockDb.tenantClassification.upsert.mockResolvedValue({
      id: "cls-1",
      tenantId: "tenant-abc",
      categoryId: "cat-1",
      verificationSource: "SELF_DECLARED",
      verifiedAt: null,
      verificationRevokedAt: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    });

    const req = makeRequest("PUT", "https://api.example.com/api/tenants/tenant-abc/classification", {
      categoryId: "cat-1",
    });
    const res = await handler.handleUpsert("tenant-abc", req, makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    expect(emitClassificationAuditMock).not.toHaveBeenCalled();
  });

  it("returns 404 when category does not exist", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue(null);

    const req = makeRequest("PUT", "https://api.example.com/api/tenants/tenant-abc/classification", {
      categoryId: "nonexistent",
    });
    const res = await handler.handleUpsert("tenant-abc", req, makeAuth(), mockEnv);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe("NOT_FOUND");
    expect(mockDb.tenantClassification.upsert).not.toHaveBeenCalled();
  });

  it("returns 422 when category is inactive", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: "cat-inactive", isActive: false });

    const req = makeRequest("PUT", "https://api.example.com/api/tenants/tenant-abc/classification", {
      categoryId: "cat-inactive",
    });
    const res = await handler.handleUpsert("tenant-abc", req, makeAuth(), mockEnv);

    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error).toBe("CATEGORY_INACTIVE");
    expect(mockDb.tenantClassification.upsert).not.toHaveBeenCalled();
  });

  it("returns 403 when non-ADMIN caller tries to upsert", async () => {
    requireCapabilityMock.mockReturnValue(
      new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
    );

    const req = makeRequest("PUT", "https://api.example.com/api/tenants/tenant-abc/classification", {
      categoryId: "cat-1",
    });
    const res = await handler.handleUpsert("tenant-abc", req, makeAuth({ tenantRole: "MEMBER" as TenantRole }), mockEnv);

    expect(res.status).toBe(403);
    expect(mockDb.platformCategory.findUnique).not.toHaveBeenCalled();
  });

  it("returns 403 when ADMIN of tenant X accesses tenant Y (cross-tenant rejection)", async () => {
    requireActiveTenantMock.mockReturnValue(
      new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
    );

    const req = makeRequest("PUT", "https://api.example.com/api/tenants/tenant-xyz/classification", {
      categoryId: "cat-1",
    });
    // auth.activeTenantId = "tenant-abc", but path has "tenant-xyz"
    const res = await handler.handleUpsert("tenant-xyz", req, makeAuth(), mockEnv);

    expect(res.status).toBe(403);
    // capability check must not be called — isolation guard fires first
    expect(requireCapabilityMock).not.toHaveBeenCalled();
    expect(mockDb.platformCategory.findUnique).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON body", async () => {
    const req = new Request("https://api.example.com/api/tenants/tenant-abc/classification", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await handler.handleUpsert("tenant-abc", req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("INVALID_JSON");
  });
});

// ── handleGet ─────────────────────────────────────────────────────────────────

describe("ClassificationHandler.handleGet", () => {
  let handler: ClassificationHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    requireOwnTenantMock.mockReturnValue(null);
    handler = new ClassificationHandler();
  });

  it("returns 200 with classification and tags", async () => {
    mockDb.tenantClassification.findUnique.mockResolvedValue({
      id: "cls-1",
      tenantId: "tenant-abc",
      categoryId: "cat-1",
      verificationSource: "SELF_DECLARED",
      verifiedAt: null,
      verificationRevokedAt: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      category: { code: "nonprofit", displayName: "Nonprofit" },
      tags: [
        {
          id: "tag-1",
          categoryId: "cat-2",
          category: { code: "nonprofit:animal-welfare", displayName: "Animal Welfare" },
        },
      ],
    });

    const res = await handler.handleGet("tenant-abc", makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe("cls-1");
    expect(body.tags).toHaveLength(1);
    expect(body.category.code).toBe("nonprofit");
  });

  it("returns 404 when no classification exists", async () => {
    mockDb.tenantClassification.findUnique.mockResolvedValue(null);

    const res = await handler.handleGet("tenant-abc", makeAuth(), mockEnv);

    expect(res.status).toBe(404);
  });

  it("returns 404 when cross-tenant (existence-leak prevention)", async () => {
    requireOwnTenantMock.mockReturnValue(
      new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 }),
    );

    const res = await handler.handleGet("tenant-xyz", makeAuth(), mockEnv);

    expect(res.status).toBe(404);
    expect(mockDb.tenantClassification.findUnique).not.toHaveBeenCalled();
  });
});

// ── handleAddTag ──────────────────────────────────────────────────────────────

describe("ClassificationHandler.handleAddTag", () => {
  let handler: ClassificationHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    requireActiveTenantMock.mockReturnValue(null);
    requireCapabilityMock.mockReturnValue(null);
    handler = new ClassificationHandler();
  });

  it("returns 201 and emits tag_added on success", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: "cat-2", isActive: true });
    mockDb.tenantClassification.findUnique.mockResolvedValue({ id: "cls-1" });
    const tag = { id: "tag-1", classificationId: "cls-1", categoryId: "cat-2" };
    mockDb.tenantClassificationTag.create.mockResolvedValue(tag);

    const req = makeRequest("POST", "https://api.example.com/api/tenants/tenant-abc/classification/tags", {
      categoryId: "cat-2",
    });
    const res = await handler.handleAddTag("tenant-abc", req, makeAuth(), mockEnv);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toBe("tag-1");

    expect(emitClassificationAuditMock).toHaveBeenCalledOnce();
    expect(emitClassificationAuditMock.mock.calls[0][0]).toMatchObject({
      action: "classification.tag_added",
      tenantId: "tenant-abc",
      actorUserId: "caller-user-id",
      targetId: "tag-1",
      metadata: { classificationId: "cls-1", categoryId: "cat-2" },
    });
  });

  it("returns 404 when category does not exist", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue(null);

    const req = makeRequest("POST", "https://api.example.com/api/tenants/tenant-abc/classification/tags", {
      categoryId: "nonexistent",
    });
    const res = await handler.handleAddTag("tenant-abc", req, makeAuth(), mockEnv);

    expect(res.status).toBe(404);
    expect(mockDb.tenantClassificationTag.create).not.toHaveBeenCalled();
  });

  it("returns 422 when category is inactive", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: "cat-off", isActive: false });

    const req = makeRequest("POST", "https://api.example.com/api/tenants/tenant-abc/classification/tags", {
      categoryId: "cat-off",
    });
    const res = await handler.handleAddTag("tenant-abc", req, makeAuth(), mockEnv);

    expect(res.status).toBe(422);
    expect(mockDb.tenantClassificationTag.create).not.toHaveBeenCalled();
  });

  it("returns 404 when no classification exists for the tenant", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: "cat-2", isActive: true });
    mockDb.tenantClassification.findUnique.mockResolvedValue(null);

    const req = makeRequest("POST", "https://api.example.com/api/tenants/tenant-abc/classification/tags", {
      categoryId: "cat-2",
    });
    const res = await handler.handleAddTag("tenant-abc", req, makeAuth(), mockEnv);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe("NOT_FOUND");
  });

  it("returns 409 on duplicate tag", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: "cat-2", isActive: true });
    mockDb.tenantClassification.findUnique.mockResolvedValue({ id: "cls-1" });
    const p2002 = Object.assign(new Error("Unique constraint"), { code: "P2002" });
    mockDb.tenantClassificationTag.create.mockRejectedValue(p2002);

    const req = makeRequest("POST", "https://api.example.com/api/tenants/tenant-abc/classification/tags", {
      categoryId: "cat-2",
    });
    const res = await handler.handleAddTag("tenant-abc", req, makeAuth(), mockEnv);

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe("TAG_EXISTS");
  });

  it("returns 403 for non-ADMIN", async () => {
    requireCapabilityMock.mockReturnValue(
      new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
    );

    const req = makeRequest("POST", "https://api.example.com/api/tenants/tenant-abc/classification/tags", {
      categoryId: "cat-2",
    });
    const res = await handler.handleAddTag("tenant-abc", req, makeAuth({ tenantRole: "MEMBER" as TenantRole }), mockEnv);

    expect(res.status).toBe(403);
    expect(mockDb.platformCategory.findUnique).not.toHaveBeenCalled();
  });

  it("returns 403 when ADMIN of tenant X accesses tenant Y path", async () => {
    requireActiveTenantMock.mockReturnValue(
      new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
    );

    const req = makeRequest("POST", "https://api.example.com/api/tenants/tenant-xyz/classification/tags", {
      categoryId: "cat-2",
    });
    const res = await handler.handleAddTag("tenant-xyz", req, makeAuth(), mockEnv);

    expect(res.status).toBe(403);
    expect(requireCapabilityMock).not.toHaveBeenCalled();
    expect(mockDb.platformCategory.findUnique).not.toHaveBeenCalled();
  });
});

// ── handleRemoveTag ───────────────────────────────────────────────────────────

describe("ClassificationHandler.handleRemoveTag", () => {
  let handler: ClassificationHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    requireActiveTenantMock.mockReturnValue(null);
    requireCapabilityMock.mockReturnValue(null);
    handler = new ClassificationHandler();
  });

  it("returns 200 and emits tag_removed on success", async () => {
    const tag = { id: "tag-1", classificationId: "cls-1", categoryId: "cat-2" };
    mockDb.tenantClassificationTag.findFirst.mockResolvedValue(tag);
    mockDb.tenantClassificationTag.delete.mockResolvedValue(tag);

    const res = await handler.handleRemoveTag("tenant-abc", "tag-1", makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);

    expect(emitClassificationAuditMock).toHaveBeenCalledOnce();
    expect(emitClassificationAuditMock.mock.calls[0][0]).toMatchObject({
      action: "classification.tag_removed",
      tenantId: "tenant-abc",
      actorUserId: "caller-user-id",
      targetId: "tag-1",
      metadata: { classificationId: "cls-1", categoryId: "cat-2" },
    });
  });

  it("returns 404 when tag does not exist or belongs to another tenant", async () => {
    mockDb.tenantClassificationTag.findFirst.mockResolvedValue(null);

    const res = await handler.handleRemoveTag("tenant-abc", "tag-missing", makeAuth(), mockEnv);

    expect(res.status).toBe(404);
    expect(mockDb.tenantClassificationTag.delete).not.toHaveBeenCalled();
  });

  it("returns 403 for non-ADMIN", async () => {
    requireCapabilityMock.mockReturnValue(
      new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
    );

    const res = await handler.handleRemoveTag("tenant-abc", "tag-1", makeAuth({ tenantRole: "MEMBER" as TenantRole }), mockEnv);

    expect(res.status).toBe(403);
    expect(mockDb.tenantClassificationTag.findFirst).not.toHaveBeenCalled();
  });

  it("returns 403 when ADMIN of tenant X tries to remove tag from tenant Y", async () => {
    requireActiveTenantMock.mockReturnValue(
      new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
    );

    const res = await handler.handleRemoveTag("tenant-xyz", "tag-1", makeAuth(), mockEnv);

    expect(res.status).toBe(403);
    expect(requireCapabilityMock).not.toHaveBeenCalled();
    expect(mockDb.tenantClassificationTag.findFirst).not.toHaveBeenCalled();
  });
});
