/**
 * Unit tests — RoleMappingHandler.
 *
 * Covers GET / POST / PATCH / DELETE, OWNER rejection, validation, and
 * cross-tenant isolation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantRole, UserRole } from "@prisma/client";
import { RoleMappingHandler } from "../../src/lib/tenant/role-mapping-handler.js";
import type { AuthContext } from "../../src/lib/auth/auth-context.js";
import type { Env } from "../../src/env.js";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    tenantRoleMapping: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("../../src/db", () => ({
  createPrisma: () => mockDb,
}));

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

const mockEnv = { DATABASE_URL: "postgresql://test" } as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────
describe("RoleMappingHandler.handleList", () => {
  let handler: RoleMappingHandler;
  beforeEach(() => {
    handler = new RoleMappingHandler();
  });

  it("returns mappings ordered by priority", async () => {
    mockDb.tenantRoleMapping.findMany.mockResolvedValue([
      { id: "m1", idpGroupName: "admins", tenantRole: "ADMIN", priority: 10, createdAt: new Date(), updatedAt: new Date() },
      { id: "m2", idpGroupName: "all-employees", tenantRole: "MEMBER", priority: 100, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const response = await handler.handleList("tenant-id", makeAuth(), mockEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as { mappings: unknown[] };
    expect(body.mappings).toHaveLength(2);
  });

  it("returns 403 when caller lacks role_mapping.edit (MEMBER)", async () => {
    const auth = makeAuth({ tenantRole: "MEMBER" as TenantRole });
    const response = await handler.handleList("tenant-id", auth, mockEnv);
    expect(response.status).toBe(403);
  });

  it("returns 403 cross-tenant", async () => {
    const auth = makeAuth({ activeTenantId: "tenant-A" });
    const response = await handler.handleList("tenant-B", auth, mockEnv);
    expect(response.status).toBe(403);
    expect(mockDb.tenantRoleMapping.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────────────────────────────────────
describe("RoleMappingHandler.handleCreate", () => {
  let handler: RoleMappingHandler;
  beforeEach(() => {
    handler = new RoleMappingHandler();
  });

  function createRequest(body: unknown): Request {
    return new Request("https://api.example.com/api/tenants/tenant-id/role-mappings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("creates a mapping with valid input", async () => {
    mockDb.tenantRoleMapping.create.mockResolvedValue({
      id: "new-id",
      idpGroupName: "admins",
      tenantRole: "ADMIN",
      priority: 10,
    });
    const response = await handler.handleCreate(
      "tenant-id",
      createRequest({ idpGroupName: "admins", tenantRole: "ADMIN", priority: 10 }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string };
    expect(body.id).toBe("new-id");
  });

  it("returns 422 with remediation when tenantRole=OWNER", async () => {
    const response = await handler.handleCreate(
      "tenant-id",
      createRequest({ idpGroupName: "owners", tenantRole: "OWNER", priority: 1 }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(422);
    const body = await response.json() as { remediation: string };
    expect(body.remediation).toContain("transfer-ownership");
    expect(mockDb.tenantRoleMapping.create).not.toHaveBeenCalled();
  });

  it("returns 400 when priority is zero", async () => {
    const response = await handler.handleCreate(
      "tenant-id",
      createRequest({ idpGroupName: "g", tenantRole: "MEMBER", priority: 0 }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when priority is negative", async () => {
    const response = await handler.handleCreate(
      "tenant-id",
      createRequest({ idpGroupName: "g", tenantRole: "MEMBER", priority: -5 }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when priority is non-integer", async () => {
    const response = await handler.handleCreate(
      "tenant-id",
      createRequest({ idpGroupName: "g", tenantRole: "MEMBER", priority: 1.5 }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when idpGroupName is empty", async () => {
    const response = await handler.handleCreate(
      "tenant-id",
      createRequest({ idpGroupName: "", tenantRole: "MEMBER", priority: 10 }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when tenantRole is missing", async () => {
    const response = await handler.handleCreate(
      "tenant-id",
      createRequest({ idpGroupName: "g", priority: 10 }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 for non-JSON body", async () => {
    const response = await handler.handleCreate(
      "tenant-id",
      createRequest("not json"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 409 on Prisma P2002 unique constraint", async () => {
    const conflict = Object.assign(new Error("Unique"), { code: "P2002" });
    mockDb.tenantRoleMapping.create.mockRejectedValue(conflict);
    const response = await handler.handleCreate(
      "tenant-id",
      createRequest({ idpGroupName: "dup", tenantRole: "MEMBER", priority: 10 }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(409);
  });

  it("re-throws non-P2002 db errors", async () => {
    mockDb.tenantRoleMapping.create.mockRejectedValue(new Error("boom"));
    await expect(
      handler.handleCreate(
        "tenant-id",
        createRequest({ idpGroupName: "g", tenantRole: "MEMBER", priority: 10 }),
        makeAuth(),
        mockEnv,
      ),
    ).rejects.toThrow("boom");
  });

  it("returns 403 when caller lacks role_mapping.edit (MEMBER)", async () => {
    const auth = makeAuth({ tenantRole: "MEMBER" as TenantRole });
    const response = await handler.handleCreate(
      "tenant-id",
      createRequest({ idpGroupName: "g", tenantRole: "MEMBER", priority: 10 }),
      auth,
      mockEnv,
    );
    expect(response.status).toBe(403);
  });

  it("returns 403 cross-tenant", async () => {
    const auth = makeAuth({ activeTenantId: "tenant-A" });
    const response = await handler.handleCreate(
      "tenant-B",
      createRequest({ idpGroupName: "g", tenantRole: "MEMBER", priority: 10 }),
      auth,
      mockEnv,
    );
    expect(response.status).toBe(403);
    expect(mockDb.tenantRoleMapping.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────────
describe("RoleMappingHandler.handleUpdate", () => {
  let handler: RoleMappingHandler;
  beforeEach(() => {
    handler = new RoleMappingHandler();
  });

  function patchRequest(body: unknown): Request {
    return new Request("https://api.example.com/api/tenants/tenant-id/role-mappings/m1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("updates tenantRole and priority", async () => {
    mockDb.tenantRoleMapping.findFirst.mockResolvedValue({
      id: "m1",
      idpGroupName: "g",
      tenantRole: "MEMBER",
      priority: 100,
    });
    mockDb.tenantRoleMapping.update.mockResolvedValue({
      id: "m1",
      idpGroupName: "g",
      tenantRole: "ADMIN",
      priority: 10,
    });

    const response = await handler.handleUpdate(
      "tenant-id",
      "m1",
      patchRequest({ tenantRole: "ADMIN", priority: 10 }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(200);
  });

  it("updates priority alone", async () => {
    mockDb.tenantRoleMapping.findFirst.mockResolvedValue({
      id: "m1",
      idpGroupName: "g",
      tenantRole: "MEMBER",
      priority: 100,
    });
    mockDb.tenantRoleMapping.update.mockResolvedValue({
      id: "m1",
      idpGroupName: "g",
      tenantRole: "MEMBER",
      priority: 5,
    });

    const response = await handler.handleUpdate(
      "tenant-id",
      "m1",
      patchRequest({ priority: 5 }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(200);
  });

  it("returns 422 when tenantRole=OWNER", async () => {
    const response = await handler.handleUpdate(
      "tenant-id",
      "m1",
      patchRequest({ tenantRole: "OWNER" }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(422);
    expect(mockDb.tenantRoleMapping.update).not.toHaveBeenCalled();
  });

  it("returns 400 when no fields supplied", async () => {
    const response = await handler.handleUpdate(
      "tenant-id",
      "m1",
      patchRequest({}),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 for non-JSON body", async () => {
    const response = await handler.handleUpdate(
      "tenant-id",
      "m1",
      patchRequest("not json"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 when mapping not found", async () => {
    mockDb.tenantRoleMapping.findFirst.mockResolvedValue(null);
    const response = await handler.handleUpdate(
      "tenant-id",
      "missing",
      patchRequest({ priority: 10 }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(404);
  });

  it("returns 403 cross-tenant", async () => {
    const auth = makeAuth({ activeTenantId: "tenant-A" });
    const response = await handler.handleUpdate(
      "tenant-B",
      "m1",
      patchRequest({ priority: 10 }),
      auth,
      mockEnv,
    );
    expect(response.status).toBe(403);
    expect(mockDb.tenantRoleMapping.findFirst).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────
describe("RoleMappingHandler.handleDelete", () => {
  let handler: RoleMappingHandler;
  beforeEach(() => {
    handler = new RoleMappingHandler();
  });

  it("returns 204 on success", async () => {
    mockDb.tenantRoleMapping.findFirst.mockResolvedValue({
      id: "m1",
      idpGroupName: "g",
      tenantRole: "ADMIN",
    });
    mockDb.tenantRoleMapping.delete.mockResolvedValue({});

    const response = await handler.handleDelete("tenant-id", "m1", makeAuth(), mockEnv);
    expect(response.status).toBe(204);
  });

  it("returns 404 when mapping missing", async () => {
    mockDb.tenantRoleMapping.findFirst.mockResolvedValue(null);
    const response = await handler.handleDelete("tenant-id", "missing", makeAuth(), mockEnv);
    expect(response.status).toBe(404);
  });

  it("returns 403 cross-tenant", async () => {
    const auth = makeAuth({ activeTenantId: "tenant-A" });
    const response = await handler.handleDelete("tenant-B", "m1", auth, mockEnv);
    expect(response.status).toBe(403);
    expect(mockDb.tenantRoleMapping.delete).not.toHaveBeenCalled();
  });

  it("returns 403 when caller lacks role_mapping.edit (MEMBER)", async () => {
    const auth = makeAuth({ tenantRole: "MEMBER" as TenantRole });
    const response = await handler.handleDelete("tenant-id", "m1", auth, mockEnv);
    expect(response.status).toBe(403);
    expect(mockDb.tenantRoleMapping.findFirst).not.toHaveBeenCalled();
  });
});
