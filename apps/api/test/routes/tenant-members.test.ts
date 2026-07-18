/**
 * Unit tests — MemberHandler.
 *
 * Covers:
 *  - GET list (pagination, capability gate, cross-tenant denial).
 *  - PATCH role (capability, OWNER promotion 422, OWNER demotion 422,
 *    self-demotion 422, cache invalidation, cross-tenant).
 *  - DELETE (capability, OWNER 422, self 422, cache invalidation,
 *    AdminUserGlobalSignOut best-effort, cross-tenant).
 *  - Transfer-ownership (caller must be OWNER, atomic transaction, cache
 *    invalidation for both, simulated mid-tx failure).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantRole, UserRole } from "@prisma/client";
import { MemberHandler } from "../../src/lib/tenant/member-handler.js";
import type { AuthContext } from "../../src/lib/auth/auth-context.js";
import type { Env } from "../../src/env.js";

// ── Prisma mock ───────────────────────────────────────────────────────────────
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    $transaction: vi.fn(),
    tenantMember: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../../src/db", () => ({
  createPrisma: () => mockDb,
}));

// ── Cache mock ───────────────────────────────────────────────────────────────
const { mockCacheInvalidate } = vi.hoisted(() => ({
  mockCacheInvalidate: vi.fn(),
}));

vi.mock("../../src/lib/auth/claims-cache", () => ({
  createClaimsCacheFromEnv: () => ({ invalidate: mockCacheInvalidate }),
}));

// ── Cognito mock ─────────────────────────────────────────────────────────────
const { mockCognitoSend } = vi.hoisted(() => ({
  mockCognitoSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: class {
    send(...args: unknown[]) {
      return mockCognitoSend(...args);
    }
  },
  AdminUserGlobalSignOutCommand: class {
    constructor(public input: unknown) {}
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    sub: "owner-sub",
    userId: "owner-id",
    globalRole: "B2B_PARTNER" as UserRole,
    activeTenantId: "tenant-id",
    tenantSlug: "acme",
    tenantRole: "OWNER" as TenantRole,
    handle: "owner",
    membershipsLoader: async () => [],
    ...overrides,
  };
}

const mockEnv = {
  DATABASE_URL: "postgresql://test",
  COGNITO_USER_POOL_ID: "pool-id",
  COGNITO_REGION: "eu-central-1",
} as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  mockCacheInvalidate.mockResolvedValue(undefined);
  mockCognitoSend.mockResolvedValue({});
  mockDb.$transaction.mockImplementation(async (fn: unknown) => {
    if (typeof fn === "function") return fn(mockDb);
    return fn;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tenants/:id/members
// ─────────────────────────────────────────────────────────────────────────────
describe("MemberHandler.handleList", () => {
  let handler: MemberHandler;
  beforeEach(() => {
    handler = new MemberHandler();
  });

  it("returns paginated members for active members of the tenant", async () => {
    mockDb.tenantMember.findMany.mockResolvedValue([
      {
        id: "m1",
        userId: "u1",
        role: "ADMIN",
        status: "ACTIVE",
        joinedAt: new Date("2026-01-01"),
        invitedAt: null,
        lastActiveAt: new Date("2026-01-15"),
        user: { id: "u1", email: "alice@test.example.com", handle: "alice" },
      },
    ]);

    const request = new Request("https://api.example.com/api/tenants/tenant-id/members?limit=50");
    const response = await handler.handleList("tenant-id", request, makeAuth(), mockEnv);

    expect(response.status).toBe(200);
    const body = await response.json() as { members: unknown[]; nextCursor: string | null };
    expect(body.members).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });

  it("paginates with cursor when more results exist than the page", async () => {
    const page = Array.from({ length: 11 }, (_, i) => ({
      id: `m${i}`,
      userId: `u${i}`,
      role: "MEMBER",
      status: "ACTIVE",
      joinedAt: new Date(),
      invitedAt: null,
      lastActiveAt: null,
      user: { id: `u${i}`, email: `user${i}@test.example.com`, handle: `u${i}` },
    }));
    mockDb.tenantMember.findMany.mockResolvedValue(page);

    const request = new Request("https://api.example.com/api/tenants/tenant-id/members?limit=10");
    const response = await handler.handleList("tenant-id", request, makeAuth(), mockEnv);

    const body = await response.json() as { members: unknown[]; nextCursor: string };
    expect(body.members).toHaveLength(10);
    expect(body.nextCursor).toBe("m9");
  });

  it("rejects GUEST (no member.view capability)", async () => {
    const auth = makeAuth({ tenantRole: "GUEST" as TenantRole });
    const request = new Request("https://api.example.com/api/tenants/tenant-id/members");
    const response = await handler.handleList("tenant-id", request, auth, mockEnv);
    expect(response.status).toBe(403);
  });

  it("returns 403 when active tenant mismatches path (cross-tenant)", async () => {
    const request = new Request("https://api.example.com/api/tenants/other-id/members");
    const response = await handler.handleList("other-id", request, makeAuth(), mockEnv);
    expect(response.status).toBe(403);
    expect(mockDb.tenantMember.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/tenants/:id/members/:memberId
// ─────────────────────────────────────────────────────────────────────────────
describe("MemberHandler.handlePatchRole", () => {
  let handler: MemberHandler;
  beforeEach(() => {
    handler = new MemberHandler();
  });

  function patchRequest(role: string): Request {
    return new Request("https://api.example.com/api/tenants/tenant-id/members/m1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
  }

  it("changes MEMBER → ADMIN and invalidates the target user's cache", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue({
      id: "m1",
      userId: "u1",
      role: "MEMBER",
      status: "ACTIVE",
      user: { subject: "u1-sub" },
    });
    mockDb.tenantMember.update.mockResolvedValue({
      id: "m1",
      userId: "u1",
      role: "ADMIN",
      status: "ACTIVE",
    });

    const response = await handler.handlePatchRole("tenant-id", "m1", patchRequest("ADMIN"), makeAuth(), mockEnv);
    expect(response.status).toBe(200);
    expect(mockCacheInvalidate).toHaveBeenCalledWith("u1-sub");
  });

  it("returns 422 with remediation when promoting to OWNER", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue({
      id: "m1",
      userId: "u1",
      role: "MEMBER",
      status: "ACTIVE",
      user: { subject: "u1-sub" },
    });

    const response = await handler.handlePatchRole("tenant-id", "m1", patchRequest("OWNER"), makeAuth(), mockEnv);
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string; message: string; remediation: string };
    expect(body.error).toBe("UNPROCESSABLE");
    expect(body.remediation).toContain("transfer-ownership");
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
  });

  it("returns 422 when demoting an existing OWNER", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue({
      id: "owner-m",
      userId: "owner-u",
      role: "OWNER",
      status: "ACTIVE",
      user: { subject: "owner-sub" },
    });

    const response = await handler.handlePatchRole("tenant-id", "owner-m", patchRequest("ADMIN"), makeAuth(), mockEnv);
    expect(response.status).toBe(422);
    const body = await response.json() as { remediation: string };
    expect(body.remediation).toContain("transfer-ownership");
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
  });

  it("returns 422 when OWNER tries to self-demote", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue({
      id: "owner-m",
      userId: "owner-id",
      role: "OWNER",
      status: "ACTIVE",
      user: { subject: "owner-sub" },
    });

    const response = await handler.handlePatchRole("tenant-id", "owner-m", patchRequest("ADMIN"), makeAuth(), mockEnv);
    expect(response.status).toBe(422);
  });

  it("returns 403 when caller is MEMBER (lacks member.change_role)", async () => {
    const auth = makeAuth({ tenantRole: "MEMBER" as TenantRole });
    const response = await handler.handlePatchRole("tenant-id", "m1", patchRequest("ADMIN"), auth, mockEnv);
    expect(response.status).toBe(403);
    expect(mockDb.tenantMember.findFirst).not.toHaveBeenCalled();
  });

  it("returns 404 when member not found in this tenant", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue(null);
    const response = await handler.handlePatchRole("tenant-id", "missing", patchRequest("ADMIN"), makeAuth(), mockEnv);
    expect(response.status).toBe(404);
  });

  it("returns 200 with unchanged=true when role is already the target", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue({
      id: "m1",
      userId: "u1",
      role: "ADMIN",
      status: "ACTIVE",
      user: { subject: "u1-sub" },
    });
    const response = await handler.handlePatchRole("tenant-id", "m1", patchRequest("ADMIN"), makeAuth(), mockEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as { unchanged: boolean };
    expect(body.unchanged).toBe(true);
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
  });

  it("returns 400 for non-JSON body", async () => {
    const request = new Request("https://api.example.com/api/tenants/tenant-id/members/m1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const response = await handler.handlePatchRole("tenant-id", "m1", request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid role string (not OWNER)", async () => {
    const response = await handler.handlePatchRole("tenant-id", "m1", patchRequest("SUPER_USER"), makeAuth(), mockEnv);
    expect(response.status).toBe(400);
  });

  it("returns 403 cross-tenant: auth-A on tenant-B", async () => {
    const authA = makeAuth({ activeTenantId: "tenant-A" });
    const response = await handler.handlePatchRole("tenant-B", "m1", patchRequest("ADMIN"), authA, mockEnv);
    expect(response.status).toBe(403);
    expect(mockDb.tenantMember.findFirst).not.toHaveBeenCalled();
  });

  it("does not invalidate cache when DB update is not run", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue(null);
    await handler.handlePatchRole("tenant-id", "m1", patchRequest("ADMIN"), makeAuth(), mockEnv);
    expect(mockCacheInvalidate).not.toHaveBeenCalled();
  });

  it("continues if cache invalidation fails (best-effort)", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue({
      id: "m1",
      userId: "u1",
      role: "MEMBER",
      status: "ACTIVE",
      user: { subject: "u1-sub" },
    });
    mockDb.tenantMember.update.mockResolvedValue({
      id: "m1",
      userId: "u1",
      role: "ADMIN",
      status: "ACTIVE",
    });
    mockCacheInvalidate.mockRejectedValueOnce(new Error("DDB down"));
    const response = await handler.handlePatchRole("tenant-id", "m1", patchRequest("ADMIN"), makeAuth(), mockEnv);
    expect(response.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/tenants/:id/members/:memberId
// ─────────────────────────────────────────────────────────────────────────────
describe("MemberHandler.handleRemove", () => {
  let handler: MemberHandler;
  beforeEach(() => {
    handler = new MemberHandler();
  });

  it("soft-deletes the member, invalidates cache, and best-effort signs them out", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue({
      id: "m1",
      userId: "u1",
      role: "MEMBER",
      status: "ACTIVE",
      user: { subject: "u1-sub", email: "user1@test.example.com" },
    });
    mockDb.tenantMember.update.mockResolvedValue({});

    const response = await handler.handleRemove("tenant-id", "m1", makeAuth(), mockEnv);
    expect(response.status).toBe(200);
    expect(mockCacheInvalidate).toHaveBeenCalledWith("u1-sub");
    expect(mockCognitoSend).toHaveBeenCalled();
    expect(mockDb.tenantMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REMOVED" }) }),
    );
  });

  it("returns 200 with unchanged=true when member is already REMOVED", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue({
      id: "m1",
      userId: "u1",
      role: "MEMBER",
      status: "REMOVED",
      user: { subject: "u1-sub", email: "u1@test.example.com" },
    });

    const response = await handler.handleRemove("tenant-id", "m1", makeAuth(), mockEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as { unchanged: boolean };
    expect(body.unchanged).toBe(true);
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
  });

  it("returns 422 when target is OWNER", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue({
      id: "owner-m",
      userId: "owner-u",
      role: "OWNER",
      status: "ACTIVE",
      user: { subject: "owner-sub", email: "owner@test.example.com" },
    });

    const response = await handler.handleRemove("tenant-id", "owner-m", makeAuth(), mockEnv);
    expect(response.status).toBe(422);
    const body = await response.json() as { remediation: string };
    expect(body.remediation).toContain("transfer-ownership");
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
  });

  it("returns 422 when OWNER tries to remove themselves", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue({
      id: "owner-m",
      userId: "owner-id",
      role: "OWNER",
      status: "ACTIVE",
      user: { subject: "owner-sub", email: "owner@test.example.com" },
    });

    const response = await handler.handleRemove("tenant-id", "owner-m", makeAuth(), mockEnv);
    expect(response.status).toBe(422);
  });

  it("returns 404 when member missing", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue(null);
    const response = await handler.handleRemove("tenant-id", "missing", makeAuth(), mockEnv);
    expect(response.status).toBe(404);
  });

  it("returns 403 when caller lacks member.remove (MEMBER)", async () => {
    const auth = makeAuth({ tenantRole: "MEMBER" as TenantRole });
    const response = await handler.handleRemove("tenant-id", "m1", auth, mockEnv);
    expect(response.status).toBe(403);
    expect(mockDb.tenantMember.findFirst).not.toHaveBeenCalled();
  });

  it("succeeds when AdminUserGlobalSignOut throws (best-effort)", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue({
      id: "m1",
      userId: "u1",
      role: "MEMBER",
      status: "ACTIVE",
      user: { subject: "u1-sub", email: "u1@test.example.com" },
    });
    mockDb.tenantMember.update.mockResolvedValue({});
    mockCognitoSend.mockRejectedValueOnce(new Error("Cognito down"));

    const response = await handler.handleRemove("tenant-id", "m1", makeAuth(), mockEnv);
    expect(response.status).toBe(200);
  });

  it("skips Cognito sign-out when COGNITO_USER_POOL_ID is unset", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue({
      id: "m1",
      userId: "u1",
      role: "MEMBER",
      status: "ACTIVE",
      user: { subject: "u1-sub", email: "u1@test.example.com" },
    });
    mockDb.tenantMember.update.mockResolvedValue({});
    const env = { ...mockEnv, COGNITO_USER_POOL_ID: undefined } as unknown as Env;

    const response = await handler.handleRemove("tenant-id", "m1", makeAuth(), env);
    expect(response.status).toBe(200);
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it("returns 403 cross-tenant: auth-A on tenant-B", async () => {
    const authA = makeAuth({ activeTenantId: "tenant-A" });
    const response = await handler.handleRemove("tenant-B", "m1", authA, mockEnv);
    expect(response.status).toBe(403);
    expect(mockDb.tenantMember.findFirst).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tenants/:id/transfer-ownership
// ─────────────────────────────────────────────────────────────────────────────
describe("MemberHandler.handleTransferOwnership", () => {
  let handler: MemberHandler;
  beforeEach(() => {
    handler = new MemberHandler();
    mockDb.tenantMember.update.mockResolvedValue({});
  });

  function transferRequest(newOwnerUserId: string): Request {
    return new Request("https://api.example.com/api/tenants/tenant-id/transfer-ownership", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newOwnerUserId }),
    });
  }

  it("atomic swap: owner→ADMIN, candidate→OWNER, both caches invalidated", async () => {
    mockDb.tenantMember.findUnique
      .mockResolvedValueOnce({ status: "ACTIVE", user: { subject: "new-sub" } })
      .mockResolvedValueOnce({ role: "OWNER", user: { subject: "owner-sub" } });

    const response = await handler.handleTransferOwnership("tenant-id", transferRequest("new-owner"), makeAuth(), mockEnv);
    expect(response.status).toBe(200);
    expect(mockDb.tenantMember.update).toHaveBeenCalledTimes(2);
    expect(mockCacheInvalidate).toHaveBeenCalledWith("owner-sub");
    expect(mockCacheInvalidate).toHaveBeenCalledWith("new-sub");
  });

  it("returns 403 when caller is ADMIN (not OWNER)", async () => {
    const auth = makeAuth({ tenantRole: "ADMIN" as TenantRole });
    const response = await handler.handleTransferOwnership("tenant-id", transferRequest("new-owner"), auth, mockEnv);
    expect(response.status).toBe(403);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("SUPER_ADMIN can perform the transfer regardless of tenantRole", async () => {
    mockDb.tenantMember.findUnique
      .mockResolvedValueOnce({ status: "ACTIVE", user: { subject: "new-sub" } })
      .mockResolvedValueOnce({ role: "OWNER", user: { subject: "owner-sub" } });

    const auth = makeAuth({ tenantRole: "GUEST" as TenantRole, globalRole: "SUPER_ADMIN" as UserRole });
    const response = await handler.handleTransferOwnership("tenant-id", transferRequest("new-owner"), auth, mockEnv);
    expect(response.status).toBe(200);
  });

  it("returns 400 when newOwnerUserId === auth.userId", async () => {
    const response = await handler.handleTransferOwnership("tenant-id", transferRequest("owner-id"), makeAuth(), mockEnv);
    expect(response.status).toBe(400);
  });

  it("returns 404 when candidate is not a member", async () => {
    mockDb.tenantMember.findUnique.mockResolvedValueOnce(null);
    const response = await handler.handleTransferOwnership("tenant-id", transferRequest("ghost"), makeAuth(), mockEnv);
    expect(response.status).toBe(404);
  });

  it("returns 404 when candidate is INACTIVE", async () => {
    mockDb.tenantMember.findUnique.mockResolvedValueOnce({
      status: "SUSPENDED",
      user: { subject: "new-sub" },
    });
    const response = await handler.handleTransferOwnership("tenant-id", transferRequest("suspended"), makeAuth(), mockEnv);
    expect(response.status).toBe(404);
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

  it("returns 400 when newOwnerUserId missing", async () => {
    const request = new Request("https://api.example.com/api/tenants/tenant-id/transfer-ownership", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await handler.handleTransferOwnership("tenant-id", request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
  });

  it("simulated mid-transaction failure leaves no partial state", async () => {
    mockDb.tenantMember.findUnique
      .mockResolvedValueOnce({ status: "ACTIVE", user: { subject: "new-sub" } })
      .mockResolvedValueOnce({ role: "OWNER", user: { subject: "owner-sub" } });
    // First update (demote) fails before the second update (promote) runs:
    // the transaction wrapper rejects with the error, so cache invalidation
    // and audit emission must NOT run.
    const txError = new Error("Simulated mid-tx failure");
    mockDb.$transaction.mockImplementationOnce(async () => {
      throw txError;
    });

    await expect(
      handler.handleTransferOwnership("tenant-id", transferRequest("new-owner"), makeAuth(), mockEnv),
    ).rejects.toThrow("Simulated mid-tx failure");

    expect(mockCacheInvalidate).not.toHaveBeenCalled();
  });

  it("returns 403 cross-tenant: auth-A on tenant-B", async () => {
    const authA = makeAuth({ activeTenantId: "tenant-A" });
    const response = await handler.handleTransferOwnership("tenant-B", transferRequest("new-owner"), authA, mockEnv);
    expect(response.status).toBe(403);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});
