/**
 * Unit Tests: RoleMappingHandler
 *
 * Key security invariant tested: writes targeting tenantRole "OWNER" must be
 * rejected with 422 — the single-OWNER invariant. DB must never be called.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoleMappingHandler } from "../../../src/lib/tenant/role-mapping-handler.js";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import type { Env } from "../../../src/env.js";
import type { TenantRole, UserRole } from "@prisma/client";

// ── Hoisted mock factories ─────────────────────────────────────────────────────

const {
  mockRequireActiveTenant,
  mockRequireCapability,
  mockEmitTenantAudit,
  mockPrisma,
} = vi.hoisted(() => ({
  mockRequireActiveTenant: vi.fn<[], Response | null>(),
  mockRequireCapability: vi.fn<[], Response | null>(),
  mockEmitTenantAudit: vi.fn(),
  mockPrisma: {
    tenantRoleMapping: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock("../../../src/db", () => ({
  createPrisma: () => mockPrisma,
}));

vi.mock("../../../src/lib/auth/auth-middleware", async (orig) => ({
  ...(await orig<typeof import("../../../src/lib/auth/auth-middleware.js")>()),
  requireActiveTenant: mockRequireActiveTenant,
}));

// Preserve the REAL Capability export; only mock requireCapability.
vi.mock("../../../src/lib/auth/require", async (orig) => ({
  ...(await orig<typeof import("../../../src/lib/auth/require.js")>()),
  requireCapability: mockRequireCapability,
}));

vi.mock("../../../src/lib/tenant/audit-emit", () => ({
  emitTenantAudit: mockEmitTenantAudit,
}));

// ── Test helpers ───────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-abc-001";
const MAPPING_ID = "mapping-xyz-001";

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    cognitoSub: "cognito-sub-test",
    userId: "admin-1",
    globalRole: "END_USER" as UserRole,
    activeTenantId: TENANT_ID,
    tenantSlug: "example-org",
    tenantRole: "ADMIN" as TenantRole,
    handle: "testadmin",
    membershipsLoader: async () => [],
    ...overrides,
  };
}

const mockEnv = {} as any as Env;

function makeRequest(
  method: string,
  url: string,
  body?: unknown,
): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const SAMPLE_MAPPING_ROW = {
  id: MAPPING_ID,
  idpGroupName: "idp-engineers",
  tenantRole: "MEMBER" as TenantRole,
  priority: 10,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

// ── Shared setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: auth checks pass (return null = allowed)
  mockRequireActiveTenant.mockReturnValue(null);
  mockRequireCapability.mockReturnValue(null);
});

// ── handleList ─────────────────────────────────────────────────────────────────

describe("RoleMappingHandler.handleList", () => {
  let handler: RoleMappingHandler;

  beforeEach(() => {
    handler = new RoleMappingHandler();
  });

  it("returns 200 with { mappings } from findMany on happy path", async () => {
    mockPrisma.tenantRoleMapping.findMany.mockResolvedValue([SAMPLE_MAPPING_ROW]);

    const response = await handler.handleList(TENANT_ID, makeAuth(), mockEnv);

    expect(response.status).toBe(200);
    const body = await response.json() as { mappings: typeof SAMPLE_MAPPING_ROW[] };
    expect(body.mappings).toHaveLength(1);
    expect(body.mappings[0].id).toBe(MAPPING_ID);
    expect(body.mappings[0].idpGroupName).toBe("idp-engineers");
  });

  it("calls findMany with correct where and orderBy", async () => {
    mockPrisma.tenantRoleMapping.findMany.mockResolvedValue([]);

    await handler.handleList(TENANT_ID, makeAuth(), mockEnv);

    expect(mockPrisma.tenantRoleMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_ID },
        orderBy: [{ priority: "asc" }, { idpGroupName: "asc" }],
      }),
    );
  });

  it("returns empty mappings array when tenant has no mappings", async () => {
    mockPrisma.tenantRoleMapping.findMany.mockResolvedValue([]);

    const response = await handler.handleList(TENANT_ID, makeAuth(), mockEnv);

    expect(response.status).toBe(200);
    const body = await response.json() as { mappings: unknown[] };
    expect(body.mappings).toHaveLength(0);
  });

  it("AUTH DENY: requireActiveTenant returning 403 causes handleList to return it without calling DB", async () => {
    const forbidden = new Response(
      JSON.stringify({ error: "FORBIDDEN", message: "Active tenant does not match" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
    mockRequireActiveTenant.mockReturnValue(forbidden);

    const response = await handler.handleList(TENANT_ID, makeAuth(), mockEnv);

    expect(response.status).toBe(403);
    expect(mockPrisma.tenantRoleMapping.findMany).not.toHaveBeenCalled();
  });

  it("AUTH DENY: requireCapability returning 403 causes handleList to return it without calling DB", async () => {
    const forbidden = new Response(
      JSON.stringify({ error: "FORBIDDEN", message: "Requires capability role_mapping.edit" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
    mockRequireCapability.mockReturnValue(forbidden);

    const response = await handler.handleList(TENANT_ID, makeAuth(), mockEnv);

    expect(response.status).toBe(403);
    expect(mockPrisma.tenantRoleMapping.findMany).not.toHaveBeenCalled();
  });
});

// ── handleCreate ───────────────────────────────────────────────────────────────

describe("RoleMappingHandler.handleCreate", () => {
  let handler: RoleMappingHandler;

  beforeEach(() => {
    handler = new RoleMappingHandler();
  });

  it("happy path: creates mapping and returns 201 with created row", async () => {
    const created = {
      id: "new-mapping-001",
      idpGroupName: "idp-engineers",
      tenantRole: "MEMBER" as TenantRole,
      priority: 10,
    };
    mockPrisma.tenantRoleMapping.create.mockResolvedValue(created);

    const request = makeRequest(
      "POST",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings`,
      { idpGroupName: "idp-engineers", tenantRole: "MEMBER", priority: 10 },
    );

    const response = await handler.handleCreate(TENANT_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(201);
    const body = await response.json() as typeof created;
    expect(body.id).toBe("new-mapping-001");
    expect(body.idpGroupName).toBe("idp-engineers");
    expect(body.tenantRole).toBe("MEMBER");
  });

  it("happy path: emitTenantAudit is called with action 'role_mapping.create'", async () => {
    const created = {
      id: "new-mapping-001",
      idpGroupName: "idp-engineers",
      tenantRole: "MEMBER" as TenantRole,
      priority: 10,
    };
    mockPrisma.tenantRoleMapping.create.mockResolvedValue(created);

    const request = makeRequest(
      "POST",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings`,
      { idpGroupName: "idp-engineers", tenantRole: "MEMBER", priority: 10 },
    );

    await handler.handleCreate(TENANT_ID, request, makeAuth(), mockEnv);

    expect(mockEmitTenantAudit).toHaveBeenCalledOnce();
    expect(mockEmitTenantAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorUserId: "admin-1",
        action: "role_mapping.create",
        targetType: "role_mapping",
        targetId: "new-mapping-001",
      }),
      mockPrisma,
    );
  });

  it("OWNER REJECT (invariant): tenantRole 'OWNER' returns 422 and never calls DB", async () => {
    const request = makeRequest(
      "POST",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings`,
      { idpGroupName: "idp-owners", tenantRole: "OWNER", priority: 1 },
    );

    const response = await handler.handleCreate(TENANT_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(422);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("UNPROCESSABLE");
    expect(mockPrisma.tenantRoleMapping.create).not.toHaveBeenCalled();
  });

  it("OWNER REJECT: audit is NOT emitted on 422", async () => {
    const request = makeRequest(
      "POST",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings`,
      { idpGroupName: "idp-owners", tenantRole: "OWNER", priority: 1 },
    );

    await handler.handleCreate(TENANT_ID, request, makeAuth(), mockEnv);

    expect(mockEmitTenantAudit).not.toHaveBeenCalled();
  });

  it("invalid JSON body returns 400 INVALID_JSON", async () => {
    const request = new Request(
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-valid-json{{{",
      },
    );

    const response = await handler.handleCreate(TENANT_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("INVALID_JSON");
    expect(mockPrisma.tenantRoleMapping.create).not.toHaveBeenCalled();
  });

  it("validation error: missing idpGroupName returns 400 VALIDATION_ERROR", async () => {
    const request = makeRequest(
      "POST",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings`,
      { tenantRole: "MEMBER", priority: 10 },
    );

    const response = await handler.handleCreate(TENANT_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(mockPrisma.tenantRoleMapping.create).not.toHaveBeenCalled();
  });

  it("validation error: priority 0 (not positive int) returns 400 VALIDATION_ERROR", async () => {
    const request = makeRequest(
      "POST",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings`,
      { idpGroupName: "idp-engineers", tenantRole: "MEMBER", priority: 0 },
    );

    const response = await handler.handleCreate(TENANT_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(mockPrisma.tenantRoleMapping.create).not.toHaveBeenCalled();
  });

  it("validation error: unknown tenantRole 'SUPERUSER' returns 400 VALIDATION_ERROR", async () => {
    const request = makeRequest(
      "POST",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings`,
      { idpGroupName: "idp-engineers", tenantRole: "SUPERUSER", priority: 10 },
    );

    const response = await handler.handleCreate(TENANT_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(mockPrisma.tenantRoleMapping.create).not.toHaveBeenCalled();
  });

  it("DUPLICATE: Prisma P2002 error returns 409 DUPLICATE", async () => {
    const p2002 = Object.assign(new Error("Unique constraint violation"), { code: "P2002" });
    mockPrisma.tenantRoleMapping.create.mockRejectedValue(p2002);

    const request = makeRequest(
      "POST",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings`,
      { idpGroupName: "idp-engineers", tenantRole: "MEMBER", priority: 10 },
    );

    const response = await handler.handleCreate(TENANT_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("DUPLICATE");
  });

  it("non-P2002 DB error is re-thrown", async () => {
    mockPrisma.tenantRoleMapping.create.mockRejectedValue(new Error("DB connection lost"));

    const request = makeRequest(
      "POST",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings`,
      { idpGroupName: "idp-engineers", tenantRole: "MEMBER", priority: 10 },
    );

    await expect(
      handler.handleCreate(TENANT_ID, request, makeAuth(), mockEnv),
    ).rejects.toThrow("DB connection lost");
  });

  it("AUTH DENY: requireCapability returning 403 causes handleCreate to return it, DB untouched", async () => {
    const forbidden = new Response(
      JSON.stringify({ error: "FORBIDDEN", message: "Requires capability role_mapping.edit" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
    mockRequireCapability.mockReturnValue(forbidden);

    const request = makeRequest(
      "POST",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings`,
      { idpGroupName: "idp-engineers", tenantRole: "MEMBER", priority: 10 },
    );

    const response = await handler.handleCreate(TENANT_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(403);
    expect(mockPrisma.tenantRoleMapping.create).not.toHaveBeenCalled();
  });
});

// ── handleUpdate ───────────────────────────────────────────────────────────────

describe("RoleMappingHandler.handleUpdate", () => {
  let handler: RoleMappingHandler;

  const existingRow = {
    id: MAPPING_ID,
    idpGroupName: "idp-engineers",
    tenantRole: "MEMBER" as TenantRole,
    priority: 10,
  };

  beforeEach(() => {
    handler = new RoleMappingHandler();
  });

  it("happy path: updates tenantRole and returns 200", async () => {
    const updatedRow = { ...existingRow, tenantRole: "ADMIN" as TenantRole };
    mockPrisma.tenantRoleMapping.findFirst.mockResolvedValue(existingRow);
    mockPrisma.tenantRoleMapping.update.mockResolvedValue(updatedRow);

    const request = makeRequest(
      "PATCH",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings/${MAPPING_ID}`,
      { tenantRole: "ADMIN" },
    );

    const response = await handler.handleUpdate(TENANT_ID, MAPPING_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(200);
    const body = await response.json() as typeof updatedRow;
    expect(body.tenantRole).toBe("ADMIN");
  });

  it("happy path: updates priority and returns 200", async () => {
    const updatedRow = { ...existingRow, priority: 50 };
    mockPrisma.tenantRoleMapping.findFirst.mockResolvedValue(existingRow);
    mockPrisma.tenantRoleMapping.update.mockResolvedValue(updatedRow);

    const request = makeRequest(
      "PATCH",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings/${MAPPING_ID}`,
      { priority: 50 },
    );

    const response = await handler.handleUpdate(TENANT_ID, MAPPING_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(200);
    const body = await response.json() as typeof updatedRow;
    expect(body.priority).toBe(50);
  });

  it("happy path: emitTenantAudit called with action 'role_mapping.update'", async () => {
    const updatedRow = { ...existingRow, tenantRole: "ADMIN" as TenantRole };
    mockPrisma.tenantRoleMapping.findFirst.mockResolvedValue(existingRow);
    mockPrisma.tenantRoleMapping.update.mockResolvedValue(updatedRow);

    const request = makeRequest(
      "PATCH",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings/${MAPPING_ID}`,
      { tenantRole: "ADMIN" },
    );

    await handler.handleUpdate(TENANT_ID, MAPPING_ID, request, makeAuth(), mockEnv);

    expect(mockEmitTenantAudit).toHaveBeenCalledOnce();
    expect(mockEmitTenantAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorUserId: "admin-1",
        action: "role_mapping.update",
        targetType: "role_mapping",
        targetId: MAPPING_ID,
      }),
      mockPrisma,
    );
  });

  it("OWNER REJECT (invariant): tenantRole 'OWNER' returns 422 and never calls DB", async () => {
    const request = makeRequest(
      "PATCH",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings/${MAPPING_ID}`,
      { tenantRole: "OWNER" },
    );

    const response = await handler.handleUpdate(TENANT_ID, MAPPING_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(422);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("UNPROCESSABLE");
    expect(mockPrisma.tenantRoleMapping.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.tenantRoleMapping.update).not.toHaveBeenCalled();
  });

  it("OWNER REJECT: audit is NOT emitted on 422", async () => {
    const request = makeRequest(
      "PATCH",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings/${MAPPING_ID}`,
      { tenantRole: "OWNER" },
    );

    await handler.handleUpdate(TENANT_ID, MAPPING_ID, request, makeAuth(), mockEnv);

    expect(mockEmitTenantAudit).not.toHaveBeenCalled();
  });

  it("returns 404 when mapping does not exist (findFirst returns null)", async () => {
    mockPrisma.tenantRoleMapping.findFirst.mockResolvedValue(null);

    const request = makeRequest(
      "PATCH",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings/${MAPPING_ID}`,
      { tenantRole: "ADMIN" },
    );

    const response = await handler.handleUpdate(TENANT_ID, MAPPING_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("NOT_FOUND");
    expect(mockPrisma.tenantRoleMapping.update).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR when empty body (no tenantRole or priority)", async () => {
    const request = makeRequest(
      "PATCH",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings/${MAPPING_ID}`,
      {},
    );

    const response = await handler.handleUpdate(TENANT_ID, MAPPING_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(mockPrisma.tenantRoleMapping.findFirst).not.toHaveBeenCalled();
  });

  it("returns 400 INVALID_JSON for non-JSON body", async () => {
    const request = new Request(
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings/${MAPPING_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not-valid-json{{{",
      },
    );

    const response = await handler.handleUpdate(TENANT_ID, MAPPING_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("INVALID_JSON");
  });

  it("AUTH DENY: requireActiveTenant returning 403 causes handleUpdate to return it, DB untouched", async () => {
    const forbidden = new Response(
      JSON.stringify({ error: "FORBIDDEN", message: "Active tenant does not match" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
    mockRequireActiveTenant.mockReturnValue(forbidden);

    const request = makeRequest(
      "PATCH",
      `https://api.example.com/api/tenants/${TENANT_ID}/role-mappings/${MAPPING_ID}`,
      { tenantRole: "ADMIN" },
    );

    const response = await handler.handleUpdate(TENANT_ID, MAPPING_ID, request, makeAuth(), mockEnv);

    expect(response.status).toBe(403);
    expect(mockPrisma.tenantRoleMapping.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.tenantRoleMapping.update).not.toHaveBeenCalled();
  });
});

// ── handleDelete ───────────────────────────────────────────────────────────────

describe("RoleMappingHandler.handleDelete", () => {
  let handler: RoleMappingHandler;

  const existingRow = {
    id: MAPPING_ID,
    idpGroupName: "idp-engineers",
    tenantRole: "MEMBER" as TenantRole,
  };

  beforeEach(() => {
    handler = new RoleMappingHandler();
  });

  it("happy path: deletes mapping and returns 204 with empty body", async () => {
    mockPrisma.tenantRoleMapping.findFirst.mockResolvedValue(existingRow);
    mockPrisma.tenantRoleMapping.delete.mockResolvedValue(existingRow);

    const response = await handler.handleDelete(TENANT_ID, MAPPING_ID, makeAuth(), mockEnv);

    expect(response.status).toBe(204);
    // 204 must have no body
    const text = await response.text();
    expect(text).toBe("");
  });

  it("happy path: emitTenantAudit called with action 'role_mapping.delete'", async () => {
    mockPrisma.tenantRoleMapping.findFirst.mockResolvedValue(existingRow);
    mockPrisma.tenantRoleMapping.delete.mockResolvedValue(existingRow);

    await handler.handleDelete(TENANT_ID, MAPPING_ID, makeAuth(), mockEnv);

    expect(mockEmitTenantAudit).toHaveBeenCalledOnce();
    expect(mockEmitTenantAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorUserId: "admin-1",
        action: "role_mapping.delete",
        targetType: "role_mapping",
        targetId: MAPPING_ID,
      }),
      mockPrisma,
    );
  });

  it("returns 404 when mapping does not exist", async () => {
    mockPrisma.tenantRoleMapping.findFirst.mockResolvedValue(null);

    const response = await handler.handleDelete(TENANT_ID, MAPPING_ID, makeAuth(), mockEnv);

    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("NOT_FOUND");
    expect(mockPrisma.tenantRoleMapping.delete).not.toHaveBeenCalled();
  });

  it("404: audit is NOT emitted when mapping not found", async () => {
    mockPrisma.tenantRoleMapping.findFirst.mockResolvedValue(null);

    await handler.handleDelete(TENANT_ID, MAPPING_ID, makeAuth(), mockEnv);

    expect(mockEmitTenantAudit).not.toHaveBeenCalled();
  });

  it("AUTH DENY: requireCapability returning 403 causes handleDelete to return it, DB untouched", async () => {
    const forbidden = new Response(
      JSON.stringify({ error: "FORBIDDEN", message: "Requires capability role_mapping.edit" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
    mockRequireCapability.mockReturnValue(forbidden);

    const response = await handler.handleDelete(TENANT_ID, MAPPING_ID, makeAuth(), mockEnv);

    expect(response.status).toBe(403);
    expect(mockPrisma.tenantRoleMapping.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.tenantRoleMapping.delete).not.toHaveBeenCalled();
  });
});
