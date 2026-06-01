/**
 * Unit tests: MemberHandler
 *
 * Covers all four public methods:
 *   handleList           — GET  /api/tenants/:id/members
 *   handlePatchRole      — PATCH /api/tenants/:id/members/:memberId
 *   handleRemove         — DELETE /api/tenants/:id/members/:memberId
 *   handleTransferOwnership — POST /api/tenants/:id/transfer-ownership
 *
 * Locked invariants:
 *   - Cross-tenant: every Prisma query is scoped to `tenantId` matching path.
 *   - Single-OWNER: PATCH cannot promote anyone to OWNER (422).
 *   - Cannot demote an existing OWNER row via PATCH (422).
 *   - OWNER self-demotion is blocked in PATCH (422).
 *   - OWNER cannot be removed via DELETE (422).
 *   - OWNER self-remove is blocked in DELETE (422).
 *   - requireActiveTenant / requireCapability denials short-circuit before any DB call.
 *   - emitTenantAudit is called on every successful mutation.
 *   - transfer-ownership: only OWNER or SUPER_ADMIN may execute it (403 otherwise).
 *   - transfer-ownership self-target → 400.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import type { Env } from "../../../src/env.js";
import type { TenantRole, UserRole } from "@prisma/client";

// ── Hoisted mock factories ────────────────────────────────────────────────────

const {
  requireActiveTenantMock,
  requireCapabilityMock,
  emitTenantAuditMock,
  mockDb,
  mockCacheInvalidate,
  transferOwnershipMock,
} = vi.hoisted(() => ({
  requireActiveTenantMock: vi.fn<() => Response | null>().mockReturnValue(null),
  requireCapabilityMock: vi.fn<() => Response | null>().mockReturnValue(null),
  emitTenantAuditMock: vi.fn<() => void>(),
  mockDb: {
    tenantMember: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockCacheInvalidate: vi.fn().mockResolvedValue(undefined),
  transferOwnershipMock: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../../src/db", () => ({
  createPrisma: () => mockDb,
}));

vi.mock("../../../src/lib/auth/auth-middleware", async (orig) => ({
  ...(await orig<typeof import("../../../src/lib/auth/auth-middleware.js")>()),
  requireActiveTenant: requireActiveTenantMock,
}));

vi.mock("../../../src/lib/auth/require", async (orig) => ({
  ...(await orig<typeof import("../../../src/lib/auth/require.js")>()),
  requireCapability: requireCapabilityMock,
}));

vi.mock("../../../src/lib/tenant/audit-emit", () => ({
  emitTenantAudit: emitTenantAuditMock,
}));

// claims-cache is called inside `invalidateCache`; mock it to avoid real DDB.
vi.mock("../../../src/lib/auth/claims-cache", () => ({
  createClaimsCacheFromEnv: () => ({
    invalidate: mockCacheInvalidate,
  }),
}));

// transferOwnership is called only in handleTransferOwnership.
vi.mock("../../../src/lib/tenant/transfer-ownership", () => ({
  transferOwnership: transferOwnershipMock,
}));

// Cognito client is constructed inside `bestEffortGlobalSignOut`.
// Mock it so no real network calls occur.
vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: class {
    send = vi.fn().mockResolvedValue({});
  },
  AdminUserGlobalSignOutCommand: class {
    constructor(public input: unknown) {}
  },
}));

// ── Import SUT (after mocks) ──────────────────────────────────────────────────

import { MemberHandler } from "../../../src/lib/tenant/member-handler.js";

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

/** A realistic TenantMember stub for findFirst responses. */
function makeMemberRow(overrides: {
  id?: string;
  userId?: string;
  role?: TenantRole;
  status?: string;
  cognitoSub?: string;
  email?: string;
} = {}) {
  return {
    id: overrides.id ?? "member-id-1",
    userId: overrides.userId ?? "target-user-id",
    role: overrides.role ?? ("MEMBER" as TenantRole),
    status: overrides.status ?? "ACTIVE",
    user: {
      cognitoSub: overrides.cognitoSub ?? "cognito-sub-target",
      email: overrides.email ?? "target@example.com",
    },
  };
}

// ── handleList ────────────────────────────────────────────────────────────────

describe("MemberHandler.handleList", () => {
  let handler: MemberHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    requireActiveTenantMock.mockReturnValue(null);
    requireCapabilityMock.mockReturnValue(null);
    handler = new MemberHandler();
  });

  it("returns 200 with members payload and nextCursor=null when results ≤ limit", async () => {
    const rows = [
      {
        id: "m1",
        userId: "u1",
        role: "MEMBER",
        status: "ACTIVE",
        joinedAt: null,
        invitedAt: null,
        lastActiveAt: null,
        user: { id: "u1", email: "a@example.com", handle: "alice" },
      },
    ];
    mockDb.tenantMember.findMany.mockResolvedValue(rows);

    const request = new Request("https://api.example.com/api/tenants/tenant-abc/members");
    const response = await handler.handleList("tenant-abc", request, makeAuth(), mockEnv);

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.members).toHaveLength(1);
    expect(body.members[0].id).toBe("m1");
    expect(body.nextCursor).toBeNull();
  });

  it("scopes the Prisma query to the tenantId from the path", async () => {
    mockDb.tenantMember.findMany.mockResolvedValue([]);

    const request = new Request("https://api.example.com/api/tenants/tenant-abc/members");
    await handler.handleList("tenant-abc", request, makeAuth(), mockEnv);

    expect(mockDb.tenantMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-abc" } }),
    );
  });

  it("returns nextCursor when results exceed limit (pagination)", async () => {
    // Default limit is 50; supply 51 rows so the handler detects hasMore.
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `m${i}`,
      userId: `u${i}`,
      role: "MEMBER",
      status: "ACTIVE",
      joinedAt: null,
      invitedAt: null,
      lastActiveAt: null,
      user: { id: `u${i}`, email: `u${i}@example.com`, handle: `u${i}` },
    }));
    mockDb.tenantMember.findMany.mockResolvedValue(rows);

    const request = new Request("https://api.example.com/api/tenants/tenant-abc/members");
    const response = await handler.handleList("tenant-abc", request, makeAuth(), mockEnv);

    const body = await response.json() as any;
    expect(body.members).toHaveLength(50);       // trimmed to limit
    expect(body.nextCursor).toBe("m49");         // last item of page
  });

  it("respects the ?limit query param (capped at 200)", async () => {
    mockDb.tenantMember.findMany.mockResolvedValue([]);

    const request = new Request("https://api.example.com/api/tenants/tenant-abc/members?limit=999");
    await handler.handleList("tenant-abc", request, makeAuth(), mockEnv);

    const call = mockDb.tenantMember.findMany.mock.calls[0][0] as any;
    // take = limit + 1 → 200 + 1 = 201
    expect(call.take).toBe(201);
  });

  it("applies cursor and skip when ?cursor is provided", async () => {
    mockDb.tenantMember.findMany.mockResolvedValue([]);

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members?cursor=cursor-id",
    );
    await handler.handleList("tenant-abc", request, makeAuth(), mockEnv);

    const call = mockDb.tenantMember.findMany.mock.calls[0][0] as any;
    expect(call.cursor).toEqual({ id: "cursor-id" });
    expect(call.skip).toBe(1);
  });

  it("returns the guard Response and does not query the DB when requireActiveTenant denies", async () => {
    const deny = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
    requireActiveTenantMock.mockReturnValueOnce(deny);

    const request = new Request("https://api.example.com/api/tenants/tenant-abc/members");
    const response = await handler.handleList("tenant-abc", request, makeAuth(), mockEnv);

    expect(response.status).toBe(403);
    expect(mockDb.tenantMember.findMany).not.toHaveBeenCalled();
  });

  it("returns the guard Response and does not query the DB when requireCapability denies", async () => {
    const deny = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
    requireCapabilityMock.mockReturnValueOnce(deny);

    const request = new Request("https://api.example.com/api/tenants/tenant-abc/members");
    const response = await handler.handleList("tenant-abc", request, makeAuth(), mockEnv);

    expect(response.status).toBe(403);
    expect(mockDb.tenantMember.findMany).not.toHaveBeenCalled();
  });
});

// ── handlePatchRole ───────────────────────────────────────────────────────────

describe("MemberHandler.handlePatchRole", () => {
  let handler: MemberHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    requireActiveTenantMock.mockReturnValue(null);
    requireCapabilityMock.mockReturnValue(null);
    mockCacheInvalidate.mockResolvedValue(undefined);
    handler = new MemberHandler();
  });

  it("returns 200 with updated member and emits audit on successful role change", async () => {
    const target = makeMemberRow({ role: "MEMBER" as TenantRole });
    const updated = { id: "member-id-1", userId: "target-user-id", role: "ADMIN", status: "ACTIVE" };
    mockDb.tenantMember.findFirst.mockResolvedValue(target);
    mockDb.tenantMember.update.mockResolvedValue(updated);

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members/member-id-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "ADMIN" }),
      },
    );

    const response = await handler.handlePatchRole(
      "tenant-abc",
      "member-id-1",
      request,
      makeAuth({ tenantRole: "ADMIN" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.role).toBe("ADMIN");
    expect(mockDb.tenantMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: "ADMIN" } }),
    );
    expect(emitTenantAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.change_role",
        tenantId: "tenant-abc",
        targetId: "member-id-1",
        metadata: expect.objectContaining({ previousRole: "MEMBER", newRole: "ADMIN" }),
      }),
      expect.anything(),
    );
  });

  it("returns 200 with unchanged:true when role is already the requested value", async () => {
    const target = makeMemberRow({ role: "ADMIN" as TenantRole });
    mockDb.tenantMember.findFirst.mockResolvedValue(target);

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members/member-id-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "ADMIN" }),
      },
    );

    const response = await handler.handlePatchRole(
      "tenant-abc",
      "member-id-1",
      request,
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.unchanged).toBe(true);
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  it("scopes the member lookup to the tenantId from the path", async () => {
    const target = makeMemberRow({ role: "MEMBER" as TenantRole });
    mockDb.tenantMember.findFirst.mockResolvedValue(target);
    mockDb.tenantMember.update.mockResolvedValue({ ...target, role: "ADMIN" });

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members/member-id-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "ADMIN" }),
      },
    );

    await handler.handlePatchRole("tenant-abc", "member-id-1", request, makeAuth(), mockEnv);

    expect(mockDb.tenantMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-abc" }) }),
    );
  });

  it("returns 404 when member does not belong to this tenant", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue(null);

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members/nonexistent",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "MEMBER" }),
      },
    );

    const response = await handler.handlePatchRole(
      "tenant-abc",
      "nonexistent",
      request,
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(404);
    const body = await response.json() as any;
    expect(body.error).toBe("NOT_FOUND");
  });

  // ── OWNER invariants ──────────────────────────────────────────────────────

  it("[INVARIANT] returns 422 when trying to set role to OWNER via PATCH", async () => {
    // OWNER cannot be assigned via PATCH — only via transfer-ownership.
    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members/member-id-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "OWNER" }),
      },
    );

    const response = await handler.handlePatchRole(
      "tenant-abc",
      "member-id-1",
      request,
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(422);
    const body = await response.json() as any;
    expect(body.error).toBe("UNPROCESSABLE");
    // No DB lookup should have occurred; we reject before hitting Prisma.
    expect(mockDb.tenantMember.findFirst).not.toHaveBeenCalled();
  });

  it("[INVARIANT] returns 422 when the target member is already OWNER (cannot demote via PATCH)", async () => {
    // The target row has role=OWNER. PATCH must reject to protect the single-OWNER invariant.
    const target = makeMemberRow({ role: "OWNER" as TenantRole });
    mockDb.tenantMember.findFirst.mockResolvedValue(target);

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members/member-id-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "ADMIN" }),
      },
    );

    const response = await handler.handlePatchRole(
      "tenant-abc",
      "member-id-1",
      request,
      makeAuth({ tenantRole: "ADMIN" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(422);
    const body = await response.json() as any;
    expect(body.error).toBe("UNPROCESSABLE");
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  it("[INVARIANT] returns 422 when the OWNER tries to self-demote via PATCH", async () => {
    // The caller IS the OWNER and the target member row is their own record.
    const auth = makeAuth({ userId: "owner-user-id", tenantRole: "OWNER" as TenantRole });
    const target = makeMemberRow({ userId: "owner-user-id", role: "MEMBER" as TenantRole });
    mockDb.tenantMember.findFirst.mockResolvedValue(target);

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members/member-id-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "MEMBER" }),
      },
    );

    const response = await handler.handlePatchRole(
      "tenant-abc",
      "member-id-1",
      request,
      auth,
      mockEnv,
    );

    expect(response.status).toBe(422);
    const body = await response.json() as any;
    expect(body.error).toBe("UNPROCESSABLE");
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it("returns 400 for invalid role values", async () => {
    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members/member-id-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "SUPER_VILLAIN" }),
      },
    );

    const response = await handler.handlePatchRole(
      "tenant-abc",
      "member-id-1",
      request,
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when role field is missing from body", async () => {
    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members/member-id-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    const response = await handler.handlePatchRole(
      "tenant-abc",
      "member-id-1",
      request,
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for non-JSON body", async () => {
    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members/member-id-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not json {{",
      },
    );

    const response = await handler.handlePatchRole(
      "tenant-abc",
      "member-id-1",
      request,
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("INVALID_JSON");
  });

  // ── Auth gating ───────────────────────────────────────────────────────────

  it("returns the guard Response without hitting DB when requireActiveTenant denies", async () => {
    const deny = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
    requireActiveTenantMock.mockReturnValueOnce(deny);

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members/member-id-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "MEMBER" }),
      },
    );

    const response = await handler.handlePatchRole(
      "tenant-abc",
      "member-id-1",
      request,
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(403);
    expect(mockDb.tenantMember.findFirst).not.toHaveBeenCalled();
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  it("returns the guard Response without hitting DB when requireCapability denies", async () => {
    const deny = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
    requireCapabilityMock.mockReturnValueOnce(deny);

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/members/member-id-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "MEMBER" }),
      },
    );

    const response = await handler.handlePatchRole(
      "tenant-abc",
      "member-id-1",
      request,
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(403);
    expect(mockDb.tenantMember.findFirst).not.toHaveBeenCalled();
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
  });
});

// ── handleRemove ──────────────────────────────────────────────────────────────

describe("MemberHandler.handleRemove", () => {
  let handler: MemberHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    requireActiveTenantMock.mockReturnValue(null);
    requireCapabilityMock.mockReturnValue(null);
    mockCacheInvalidate.mockResolvedValue(undefined);
    handler = new MemberHandler();
  });

  it("returns 200 with { id, status:'REMOVED' } on successful removal", async () => {
    const target = makeMemberRow({ role: "MEMBER" as TenantRole });
    mockDb.tenantMember.findFirst.mockResolvedValue(target);
    mockDb.tenantMember.update.mockResolvedValue({});

    const response = await handler.handleRemove(
      "tenant-abc",
      "member-id-1",
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.id).toBe("member-id-1");
    expect(body.status).toBe("REMOVED");
  });

  it("soft-deletes by updating status=REMOVED (not a hard delete)", async () => {
    const target = makeMemberRow({ role: "MEMBER" as TenantRole });
    mockDb.tenantMember.findFirst.mockResolvedValue(target);
    mockDb.tenantMember.update.mockResolvedValue({});

    await handler.handleRemove("tenant-abc", "member-id-1", makeAuth(), mockEnv);

    expect(mockDb.tenantMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REMOVED" }),
      }),
    );
  });

  it("scopes the member lookup to the tenantId from the path", async () => {
    const target = makeMemberRow();
    mockDb.tenantMember.findFirst.mockResolvedValue(target);
    mockDb.tenantMember.update.mockResolvedValue({});

    await handler.handleRemove("tenant-abc", "member-id-1", makeAuth(), mockEnv);

    expect(mockDb.tenantMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-abc" }) }),
    );
  });

  it("emits audit event on successful removal", async () => {
    const target = makeMemberRow({ role: "MEMBER" as TenantRole });
    mockDb.tenantMember.findFirst.mockResolvedValue(target);
    mockDb.tenantMember.update.mockResolvedValue({});

    await handler.handleRemove("tenant-abc", "member-id-1", makeAuth(), mockEnv);

    expect(emitTenantAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.remove",
        tenantId: "tenant-abc",
        targetId: "member-id-1",
      }),
      expect.anything(),
    );
  });

  it("returns 404 when member does not belong to this tenant", async () => {
    mockDb.tenantMember.findFirst.mockResolvedValue(null);

    const response = await handler.handleRemove(
      "tenant-abc",
      "nonexistent",
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(404);
    const body = await response.json() as any;
    expect(body.error).toBe("NOT_FOUND");
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  it("returns 200 with unchanged:true when member is already REMOVED", async () => {
    const target = makeMemberRow({ role: "MEMBER" as TenantRole, status: "REMOVED" });
    mockDb.tenantMember.findFirst.mockResolvedValue(target);

    const response = await handler.handleRemove(
      "tenant-abc",
      "member-id-1",
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.unchanged).toBe(true);
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  // ── OWNER invariants ──────────────────────────────────────────────────────

  it("[INVARIANT] returns 422 when the target member is the OWNER", async () => {
    const target = makeMemberRow({ role: "OWNER" as TenantRole });
    mockDb.tenantMember.findFirst.mockResolvedValue(target);

    const response = await handler.handleRemove(
      "tenant-abc",
      "member-id-1",
      makeAuth({ tenantRole: "ADMIN" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(422);
    const body = await response.json() as any;
    expect(body.error).toBe("UNPROCESSABLE");
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  it("[INVARIANT] returns 422 when the OWNER tries to remove themselves", async () => {
    const auth = makeAuth({ userId: "owner-user-id", tenantRole: "OWNER" as TenantRole });
    // The target row's userId matches the caller's userId; role is not OWNER
    // on the row itself — the handler checks `target.userId === auth.userId && auth.tenantRole === "OWNER"`.
    const target = makeMemberRow({ userId: "owner-user-id", role: "MEMBER" as TenantRole });
    mockDb.tenantMember.findFirst.mockResolvedValue(target);

    const response = await handler.handleRemove("tenant-abc", "member-id-1", auth, mockEnv);

    expect(response.status).toBe(422);
    const body = await response.json() as any;
    expect(body.error).toBe("UNPROCESSABLE");
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  // ── Auth gating ───────────────────────────────────────────────────────────

  it("returns the guard Response without hitting DB when requireActiveTenant denies", async () => {
    const deny = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
    requireActiveTenantMock.mockReturnValueOnce(deny);

    const response = await handler.handleRemove(
      "tenant-abc",
      "member-id-1",
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(403);
    expect(mockDb.tenantMember.findFirst).not.toHaveBeenCalled();
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  it("returns the guard Response without hitting DB when requireCapability denies", async () => {
    const deny = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
    requireCapabilityMock.mockReturnValueOnce(deny);

    const response = await handler.handleRemove(
      "tenant-abc",
      "member-id-1",
      makeAuth(),
      mockEnv,
    );

    expect(response.status).toBe(403);
    expect(mockDb.tenantMember.findFirst).not.toHaveBeenCalled();
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
  });
});

// ── handleTransferOwnership ───────────────────────────────────────────────────

describe("MemberHandler.handleTransferOwnership", () => {
  let handler: MemberHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    requireActiveTenantMock.mockReturnValue(null);
    requireCapabilityMock.mockReturnValue(null);
    mockCacheInvalidate.mockResolvedValue(undefined);
    handler = new MemberHandler();
  });

  it("returns 200 and emits audit on successful transfer", async () => {
    transferOwnershipMock.mockResolvedValue({
      ok: true,
      oldOwnerCognitoSub: "old-sub",
      newOwnerCognitoSub: "new-sub",
    });

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: "new-owner-id" }),
      },
    );

    const response = await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ tenantRole: "OWNER" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.ok).toBe(true);
    expect(body.newOwnerId).toBe("new-owner-id");
    expect(emitTenantAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tenant.transfer_ownership",
        tenantId: "tenant-abc",
        targetId: "tenant-abc",
      }),
      expect.anything(),
    );
  });

  it("invalidates both old and new owner's caches on success", async () => {
    transferOwnershipMock.mockResolvedValue({
      ok: true,
      oldOwnerCognitoSub: "old-sub",
      newOwnerCognitoSub: "new-sub",
    });

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: "new-owner-id" }),
      },
    );

    await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ tenantRole: "OWNER" as TenantRole }),
      mockEnv,
    );

    expect(mockCacheInvalidate).toHaveBeenCalledWith("old-sub");
    expect(mockCacheInvalidate).toHaveBeenCalledWith("new-sub");
  });

  // ── Role guard ────────────────────────────────────────────────────────────

  it("[INVARIANT] returns 403 when caller is not OWNER and not SUPER_ADMIN", async () => {
    // Only OWNER or SUPER_ADMIN may invoke transfer-ownership.
    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: "new-owner-id" }),
      },
    );

    const response = await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ tenantRole: "ADMIN" as TenantRole, globalRole: "END_USER" as UserRole }),
      mockEnv,
    );

    expect(response.status).toBe(403);
    const body = await response.json() as any;
    expect(body.error).toBe("FORBIDDEN");
    expect(transferOwnershipMock).not.toHaveBeenCalled();
  });

  it("allows SUPER_ADMIN to transfer ownership regardless of tenantRole", async () => {
    transferOwnershipMock.mockResolvedValue({
      ok: true,
      oldOwnerCognitoSub: "old-sub",
      newOwnerCognitoSub: "new-sub",
    });

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: "new-owner-id" }),
      },
    );

    const response = await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ tenantRole: "MEMBER" as TenantRole, globalRole: "SUPER_ADMIN" as UserRole }),
      mockEnv,
    );

    expect(response.status).toBe(200);
  });

  it("returns 403 when requireActiveTenant denies (before role check)", async () => {
    const deny = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
    requireActiveTenantMock.mockReturnValueOnce(deny);

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: "new-owner-id" }),
      },
    );

    const response = await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ tenantRole: "OWNER" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(403);
    expect(transferOwnershipMock).not.toHaveBeenCalled();
  });

  // ── Self-transfer guard ───────────────────────────────────────────────────

  it("[INVARIANT] returns 400 when newOwnerUserId equals the caller's own userId", async () => {
    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: "caller-user-id" }),
      },
    );

    const response = await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ userId: "caller-user-id", tenantRole: "OWNER" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(transferOwnershipMock).not.toHaveBeenCalled();
  });

  // ── transferOwnership result codes ────────────────────────────────────────

  it("returns 404 when transferOwnership reports NOT_MEMBER", async () => {
    transferOwnershipMock.mockResolvedValue({ ok: false, code: "NOT_MEMBER" });

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: "new-owner-id" }),
      },
    );

    const response = await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ tenantRole: "OWNER" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(404);
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  it("returns 404 when transferOwnership reports INACTIVE", async () => {
    transferOwnershipMock.mockResolvedValue({ ok: false, code: "INACTIVE" });

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: "new-owner-id" }),
      },
    );

    const response = await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ tenantRole: "OWNER" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(404);
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  it("returns 400 when transferOwnership reports ALREADY_OWNER", async () => {
    transferOwnershipMock.mockResolvedValue({ ok: false, code: "ALREADY_OWNER" });

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: "new-owner-id" }),
      },
    );

    const response = await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ tenantRole: "OWNER" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(400);
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  it("returns 409 when transferOwnership reports OWNER_NOT_FOUND", async () => {
    transferOwnershipMock.mockResolvedValue({ ok: false, code: "OWNER_NOT_FOUND" });

    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: "new-owner-id" }),
      },
    );

    const response = await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ tenantRole: "OWNER" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(409);
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it("returns 400 for non-JSON body", async () => {
    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      },
    );

    const response = await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ tenantRole: "OWNER" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("INVALID_JSON");
    expect(transferOwnershipMock).not.toHaveBeenCalled();
  });

  it("returns 400 when newOwnerUserId is missing from body", async () => {
    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    const response = await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ tenantRole: "OWNER" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(transferOwnershipMock).not.toHaveBeenCalled();
  });

  it("returns 400 when newOwnerUserId is an empty string", async () => {
    const request = new Request(
      "https://api.example.com/api/tenants/tenant-abc/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: "" }),
      },
    );

    const response = await handler.handleTransferOwnership(
      "tenant-abc",
      request,
      makeAuth({ tenantRole: "OWNER" as TenantRole }),
      mockEnv,
    );

    expect(response.status).toBe(400);
    expect(transferOwnershipMock).not.toHaveBeenCalled();
  });
});
