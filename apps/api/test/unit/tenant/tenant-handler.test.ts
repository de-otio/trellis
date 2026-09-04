/**
 * Unit Tests: TenantHandler
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantHandler } from "../../../src/lib/tenant/tenant-handler.js";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import type { Env } from "../../../src/env.js";
import type { TenantRole, UserRole } from "@prisma/client";

// ── DB mock ───────────────────────────────────────────────────────────────────
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    $transaction: vi.fn(),
    tenant: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    tenantMember: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    user: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../../../src/db", () => ({
  createPrisma: () => mockDb,
}));

// ── Cache mock ─────────────────────────────────────────────────────────────
const { mockCacheInvalidate, mockCachePut } = vi.hoisted(() => ({
  mockCacheInvalidate: vi.fn(),
  mockCachePut: vi.fn(),
}));

vi.mock("../../../src/lib/auth/claims-cache", () => ({
  createClaimsCacheFromEnv: () => ({
    invalidate: mockCacheInvalidate,
    put: mockCachePut,
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeAuth(
  overrides: Partial<AuthContext> = {},
): AuthContext {
  return {
    sub: "cognito-sub",
    userId: "user-id",
    globalRole: "B2B_PARTNER" as UserRole,
    activeTenantId: "tenant-id",
    tenantSlug: "acme",
    tenantRole: "OWNER" as TenantRole,
    handle: "alice",
    membershipsLoader: async () => [],
    ...overrides,
  };
}

const mockEnv = { DATABASE_URL: "postgresql://test" } as unknown as Env;

describe("TenantHandler.handleCreate", () => {
  let handler: TenantHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TenantHandler();

    // Default $transaction: run callback, return its result
    mockDb.$transaction.mockImplementation(async (fn: unknown) => {
      if (typeof fn === "function") return fn(mockDb);
      // Array form (no callback used in create)
      return fn;
    });
  });

  it("returns 201 with tenant body on happy path", async () => {
    const tenantRow = { id: "new-id", slug: "acme-corp", displayName: "Acme Corp" };
    mockDb.tenant.create.mockResolvedValue(tenantRow);
    mockDb.tenantMember.create.mockResolvedValue({});
    mockDb.user.updateMany.mockResolvedValue({ count: 1 });

    const request = new Request("https://api.example.com/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "acme-corp", displayName: "Acme Corp" }),
    });

    const auth = makeAuth({ globalRole: "END_USER" as UserRole });
    const response = await handler.handleCreate(request, auth, mockEnv);

    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.id).toBe("new-id");
    expect(body.slug).toBe("acme-corp");
  });

  it("returns 400 when slug is invalid format", async () => {
    const request = new Request("https://api.example.com/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "--bad-slug", displayName: "x" }),
    });

    const response = await handler.handleCreate(request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.code ?? body.error).toMatch(/INVALID_FORMAT/);
  });

  it("returns 400 when slug is reserved", async () => {
    const request = new Request("https://api.example.com/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "admin", displayName: "x" }),
    });

    const response = await handler.handleCreate(request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.code ?? body.error).toMatch(/RESERVED/);
  });

  it("returns 409 when slug is already taken (P2002)", async () => {
    const prismaConflict = Object.assign(new Error("Unique constraint"), { code: "P2002" });
    mockDb.$transaction.mockRejectedValue(prismaConflict);

    const request = new Request("https://api.example.com/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "taken-slug", displayName: "x" }),
    });

    const response = await handler.handleCreate(request, makeAuth(), mockEnv);
    expect(response.status).toBe(409);
  });

  it("re-throws non-P2002 database errors", async () => {
    const dbError = new Error("Connection failed");
    mockDb.$transaction.mockRejectedValue(dbError);

    const request = new Request("https://api.example.com/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "valid-slug", displayName: "x" }),
    });

    await expect(handler.handleCreate(request, makeAuth(), mockEnv)).rejects.toThrow("Connection failed");
  });

  it("bumps END_USER role to B2B_PARTNER on create", async () => {
    mockDb.tenant.create.mockResolvedValue({ id: "t", slug: "s", displayName: "d" });
    mockDb.tenantMember.create.mockResolvedValue({});
    mockDb.user.updateMany.mockResolvedValue({ count: 1 });

    const request = new Request("https://api.example.com/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "new-org", displayName: "New Org" }),
    });

    await handler.handleCreate(request, makeAuth({ globalRole: "END_USER" as UserRole }), mockEnv);

    expect(mockDb.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-id", role: "END_USER" },
      data: { role: "B2B_PARTNER" },
    });
  });

  it("returns 400 for non-JSON body", async () => {
    const request = new Request("https://api.example.com/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const response = await handler.handleCreate(request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
  });

  it("returns 400 when required fields are missing (zod validation)", async () => {
    const request = new Request("https://api.example.com/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "valid-slug" }), // missing displayName
    });
    const response = await handler.handleCreate(request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("VALIDATION_ERROR");
  });
});

describe("TenantHandler.handleGet", () => {
  let handler: TenantHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TenantHandler();
  });

  it("returns 200 with tenant data for matching active tenant", async () => {
    const tenantRow = { id: "tenant-id", slug: "acme", displayName: "Acme", type: "ORGANIZATION", status: "ACTIVE", createdAt: new Date() };
    mockDb.tenant.findUnique.mockResolvedValue(tenantRow);

    const response = await handler.handleGet("tenant-id", makeAuth(), mockEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.slug).toBe("acme");
  });

  it("returns 404 (not 403) when active tenant does not match — no existence leak", async () => {
    const response = await handler.handleGet("other-tenant-id", makeAuth(), mockEnv);
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("returns 404 when tenant not found", async () => {
    mockDb.tenant.findUnique.mockResolvedValue(null);
    const response = await handler.handleGet("tenant-id", makeAuth(), mockEnv);
    expect(response.status).toBe(404);
  });
});

describe("TenantHandler.handleUpdate", () => {
  let handler: TenantHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TenantHandler();
  });

  it("returns 200 on successful update by OWNER", async () => {
    mockDb.tenant.findUnique.mockResolvedValue({ id: "tenant-id" });
    mockDb.tenant.update.mockResolvedValue({ id: "tenant-id", slug: "acme", displayName: "New Name" });

    const request = new Request("https://api.example.com/api/tenants/tenant-id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "New Name" }),
    });

    const response = await handler.handleUpdate("tenant-id", request, makeAuth({ tenantRole: "OWNER" as TenantRole }), mockEnv);
    expect(response.status).toBe(200);
  });

  it("returns 403 when MEMBER tries to update", async () => {
    const request = new Request("https://api.example.com/api/tenants/tenant-id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    });
    const response = await handler.handleUpdate("tenant-id", request, makeAuth({ tenantRole: "MEMBER" as TenantRole }), mockEnv);
    expect(response.status).toBe(403);
  });

  it("returns 403 when tenants mismatch", async () => {
    const request = new Request("https://api.example.com/api/tenants/other-id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    });
    const response = await handler.handleUpdate("other-id", request, makeAuth(), mockEnv);
    expect(response.status).toBe(403);
  });

  it("returns 404 when tenant not found", async () => {
    mockDb.tenant.findUnique.mockResolvedValue(null);
    const request = new Request("https://api.example.com/api/tenants/tenant-id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    });
    const response = await handler.handleUpdate("tenant-id", request, makeAuth({ tenantRole: "ADMIN" as TenantRole }), mockEnv);
    expect(response.status).toBe(404);
  });

  it("returns 400 for non-JSON body in update", async () => {
    const request = new Request("https://api.example.com/api/tenants/tenant-id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const response = await handler.handleUpdate("tenant-id", request, makeAuth({ tenantRole: "ADMIN" as TenantRole }), mockEnv);
    expect(response.status).toBe(400);
  });

  it("returns 400 when displayName is missing in update", async () => {
    const request = new Request("https://api.example.com/api/tenants/tenant-id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await handler.handleUpdate("tenant-id", request, makeAuth({ tenantRole: "ADMIN" as TenantRole }), mockEnv);
    expect(response.status).toBe(400);
  });
});

describe("TenantHandler.handleListMyTenants", () => {
  let handler: TenantHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TenantHandler();
  });

  it("returns memberships list", async () => {
    mockDb.tenantMember.findMany.mockResolvedValue([
      {
        tenantId: "tid",
        userId: "user-id",
        role: "OWNER",
        tenant: { id: "tid", slug: "acme", displayName: "Acme", type: "ORGANIZATION", status: "ACTIVE" },
      },
    ]);

    const response = await handler.handleListMyTenants(makeAuth(), mockEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].role).toBe("OWNER");
  });

  it("returns empty list when no memberships", async () => {
    mockDb.tenantMember.findMany.mockResolvedValue([]);
    const response = await handler.handleListMyTenants(makeAuth(), mockEnv);
    const body = await response.json() as any;
    expect(body.memberships).toHaveLength(0);
  });
});

describe("TenantHandler.handleSwitchTenant", () => {
  let handler: TenantHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TenantHandler();
    mockCacheInvalidate.mockResolvedValue(undefined);
    mockCachePut.mockResolvedValue(undefined);
  });

  it("returns 200 and writes new claims to cache for valid membership", async () => {
    // First findUnique: membership status check.
    // Second findUnique: tenant slug + role for cache write.
    mockDb.tenantMember.findUnique
      .mockResolvedValueOnce({ status: "ACTIVE" })
      .mockResolvedValueOnce({
        role: "MEMBER",
        tenant: { slug: "new-tenant-slug" },
      });

    const request = new Request("https://api.example.com/api/auth/switch-tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "new-tenant-id" }),
    });

    const response = await handler.handleSwitchTenant(request, makeAuth(), mockEnv);
    expect(response.status).toBe(200);
    expect(mockCacheInvalidate).toHaveBeenCalledWith("cognito-sub");
    expect(mockCachePut).toHaveBeenCalledWith(
      "cognito-sub",
      expect.objectContaining({
        userId: "user-id",
        activeTenantId: "new-tenant-id",
        tenantSlug: "new-tenant-slug",
        tenantRole: "MEMBER",
      }),
    );
  });

  it("returns 403 when not a member", async () => {
    mockDb.tenantMember.findUnique.mockResolvedValue(null);

    const request = new Request("https://api.example.com/api/auth/switch-tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "other-tenant" }),
    });

    const response = await handler.handleSwitchTenant(request, makeAuth(), mockEnv);
    expect(response.status).toBe(403);
    expect(mockCacheInvalidate).not.toHaveBeenCalled();
    expect(mockCachePut).not.toHaveBeenCalled();
  });

  it("returns 403 when membership is SUSPENDED", async () => {
    mockDb.tenantMember.findUnique.mockResolvedValue({ status: "SUSPENDED" });

    const request = new Request("https://api.example.com/api/auth/switch-tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-id" }),
    });

    const response = await handler.handleSwitchTenant(request, makeAuth(), mockEnv);
    expect(response.status).toBe(403);
  });

  it("returns 200 even when cache write fails (best-effort)", async () => {
    mockDb.tenantMember.findUnique
      .mockResolvedValueOnce({ status: "ACTIVE" })
      .mockResolvedValueOnce({
        role: "MEMBER",
        tenant: { slug: "new-tenant-slug" },
      });
    mockCachePut.mockRejectedValue(new Error("DynamoDB unavailable"));

    const request = new Request("https://api.example.com/api/auth/switch-tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "new-tenant-id" }),
    });

    const response = await handler.handleSwitchTenant(request, makeAuth(), mockEnv);
    expect(response.status).toBe(200);
  });

  it("returns 400 when tenantId is missing in body", async () => {
    const request = new Request("https://api.example.com/api/auth/switch-tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await handler.handleSwitchTenant(request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
  });

  it("returns 400 for non-JSON body in switch-tenant", async () => {
    const request = new Request("https://api.example.com/api/auth/switch-tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    const response = await handler.handleSwitchTenant(request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
  });
});

describe("TenantHandler.handleTransferOwnership", () => {
  let handler: TenantHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TenantHandler();
    mockCacheInvalidate.mockResolvedValue(undefined);
    // Callback-form transaction: invoke the callback against mockDb so
    // the inner findUnique calls resolve through our mocks.
    mockDb.$transaction.mockImplementation(async (fn: unknown) => {
      if (typeof fn === "function") return fn(mockDb);
      return fn;
    });
    mockDb.tenantMember.update.mockResolvedValue({});
  });

  it("returns 200 and invalidates both users' caches", async () => {
    // First findUnique call: candidate (new owner) lookup.
    // Second findUnique call: current owner row.
    mockDb.tenantMember.findUnique
      .mockResolvedValueOnce({ status: "ACTIVE", user: { subject: "new-owner-sub" } })
      .mockResolvedValueOnce({ role: "OWNER", user: { subject: "cognito-sub" } });

    const request = new Request("https://api.example.com/api/tenants/tenant-id/transfer-ownership", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newOwnerUserId: "new-owner-id" }),
    });

    const response = await handler.handleTransferOwnership("tenant-id", request, makeAuth(), mockEnv);
    expect(response.status).toBe(200);
    expect(mockCacheInvalidate).toHaveBeenCalledWith("cognito-sub");
    expect(mockCacheInvalidate).toHaveBeenCalledWith("new-owner-sub");
  });

  it("returns 403 when caller is not OWNER", async () => {
    const request = new Request("https://api.example.com/api/tenants/tenant-id/transfer-ownership", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newOwnerUserId: "other" }),
    });

    const response = await handler.handleTransferOwnership(
      "tenant-id",
      request,
      makeAuth({ tenantRole: "ADMIN" as TenantRole }),
      mockEnv,
    );
    expect(response.status).toBe(403);
  });

  it("returns 403 when active tenant mismatches path", async () => {
    const request = new Request("https://api.example.com/api/tenants/other-id/transfer-ownership", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newOwnerUserId: "other" }),
    });

    const response = await handler.handleTransferOwnership("other-id", request, makeAuth(), mockEnv);
    expect(response.status).toBe(403);
  });

  it("returns 404 when new owner is not an active member", async () => {
    mockDb.tenantMember.findUnique.mockResolvedValueOnce(null);

    const request = new Request("https://api.example.com/api/tenants/tenant-id/transfer-ownership", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newOwnerUserId: "nonmember-id" }),
    });

    const response = await handler.handleTransferOwnership("tenant-id", request, makeAuth(), mockEnv);
    expect(response.status).toBe(404);
  });

  it("returns 400 when newOwnerUserId is the caller themselves", async () => {
    const request = new Request("https://api.example.com/api/tenants/tenant-id/transfer-ownership", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newOwnerUserId: "user-id" }),
    });

    const response = await handler.handleTransferOwnership("tenant-id", request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
  });

  it("returns 400 for non-JSON body", async () => {
    const request = new Request("https://api.example.com/api/tenants/tenant-id/transfer-ownership", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    const response = await handler.handleTransferOwnership("tenant-id", request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
  });

  it("returns 400 when newOwnerUserId is missing from body", async () => {
    const request = new Request("https://api.example.com/api/tenants/tenant-id/transfer-ownership", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await handler.handleTransferOwnership("tenant-id", request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
  });
});
