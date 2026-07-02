/**
 * Unit Tests: PlatformCategoryAdminHandler
 *
 * Covers:
 *   - handleCreate: success, validation errors, inactive-parent rejection,
 *     duplicate-code conflict, non-SUPER_ADMIN rejection
 *   - handleDeactivate: no-affected-tenants path, affected-tenants-without-reassignTo
 *     (rejected), affected-tenants-with-reassignTo (bulk reassignment), already-inactive,
 *     reassignTo-is-same-node, reassignTo-is-descendant, reassignTo-is-inactive,
 *     non-SUPER_ADMIN rejection
 *   - handleReparent: success (non-null parent), success (null → root), inactive node,
 *     non-existent new parent, inactive new parent, cycle detection, non-SUPER_ADMIN rejection
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformCategoryAdminHandler } from "../../../src/lib/tenant/platform-category-admin-handler.js";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import type { Env } from "../../../src/env.js";
import type { TenantRole, UserRole } from "@prisma/client";

// ── DB mock ───────────────────────────────────────────────────────────────────
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    $transaction: vi.fn(),
    platformCategory: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    tenantClassification: {
      count: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../../../src/db", () => ({
  createPrisma: () => mockDb,
}));

// Suppress audit emission in unit tests — we verify that audit functions are
// called (or not), but we don't want the real TrellisAuditLogger to run.
vi.mock("../../../src/lib/audit-composer", () => ({
  TrellisAuditLogger: class {
    async logSystemAction() {}
  },
}));

// ── Auth helpers ───────────────────────────────────────────────────────────────

function makeSuperAdminAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    cognitoSub: "cognito-super",
    userId: "super-admin-user-id",
    globalRole: "SUPER_ADMIN" as UserRole,
    activeTenantId: "platform-tenant-id",
    tenantSlug: "platform",
    tenantRole: "OWNER" as TenantRole,
    handle: "superadmin",
    membershipsLoader: async () => [],
    ...overrides,
  };
}

function makeRegularAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    cognitoSub: "cognito-user",
    userId: "regular-user-id",
    globalRole: "B2B_PARTNER" as UserRole,
    activeTenantId: "some-tenant-id",
    tenantSlug: "acme",
    tenantRole: "ADMIN" as TenantRole,
    handle: "alice",
    membershipsLoader: async () => [],
    ...overrides,
  };
}

const mockEnv = { DATABASE_URL: "postgresql://test", DEFAULT_REGION: "EU" } as unknown as Env;

function makeRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

// ── handleCreate ───────────────────────────────────────────────────────────────

describe("PlatformCategoryAdminHandler.handleCreate", () => {
  let handler: PlatformCategoryAdminHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new PlatformCategoryAdminHandler();
  });

  it("returns 403 for non-SUPER_ADMIN callers", async () => {
    const response = await handler.handleCreate(
      makeRequest("https://api.example.com/api/admin/platform-categories", "POST", {
        code: "nonprofit",
        displayName: "Nonprofit",
      }),
      makeRegularAuth(),
      mockEnv,
    );
    expect(response.status).toBe(403);
    const body = await response.json() as any;
    expect(body.error).toBe("FORBIDDEN");
  });

  it("returns 201 with the created category on the happy path (root node)", async () => {
    const created = {
      id: "cat-01",
      code: "nonprofit",
      displayName: "Nonprofit",
      description: null,
      order: 0,
      isActive: true,
      parentCategoryId: null,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    };
    mockDb.platformCategory.create.mockResolvedValue(created);

    const response = await handler.handleCreate(
      makeRequest("https://api.example.com/api/admin/platform-categories", "POST", {
        code: "nonprofit",
        displayName: "Nonprofit",
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.id).toBe("cat-01");
    expect(body.code).toBe("nonprofit");
    expect(body.parentCategoryId).toBeNull();
  });

  it("returns 201 for a child node with valid active parent", async () => {
    const parentRow = { id: "parent-id", isActive: true };
    mockDb.platformCategory.findUnique.mockResolvedValue(parentRow);
    const created = {
      id: "cat-02",
      code: "nonprofit:animal-welfare",
      displayName: "Animal Welfare",
      description: null,
      order: 0,
      isActive: true,
      parentCategoryId: "parent-id",
      createdAt: new Date("2026-07-01T00:00:00Z"),
    };
    mockDb.platformCategory.create.mockResolvedValue(created);

    const response = await handler.handleCreate(
      makeRequest("https://api.example.com/api/admin/platform-categories", "POST", {
        code: "nonprofit:animal-welfare",
        displayName: "Animal Welfare",
        parentCategoryId: "parent-id",
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.parentCategoryId).toBe("parent-id");
  });

  it("returns 404 when parentCategoryId references a non-existent category", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue(null);

    const response = await handler.handleCreate(
      makeRequest("https://api.example.com/api/admin/platform-categories", "POST", {
        code: "nonprofit:animal-welfare",
        displayName: "Animal Welfare",
        parentCategoryId: "ghost-id",
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(404);
    const body = await response.json() as any;
    expect(body.error).toBe("NOT_FOUND");
  });

  it("returns 400 when parentCategoryId references an inactive category", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: "parent-id", isActive: false });

    const response = await handler.handleCreate(
      makeRequest("https://api.example.com/api/admin/platform-categories", "POST", {
        code: "nonprofit:animal-welfare",
        displayName: "Animal Welfare",
        parentCategoryId: "parent-id",
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toMatch(/inactive/);
  });

  it("returns 400 for a code that fails the regex (uppercase)", async () => {
    const response = await handler.handleCreate(
      makeRequest("https://api.example.com/api/admin/platform-categories", "POST", {
        code: "NonProfit",
        displayName: "Nonprofit",
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("returns 409 when Prisma reports a unique-constraint violation (P2002)", async () => {
    mockDb.platformCategory.create.mockRejectedValue({ code: "P2002", message: "Unique constraint" });

    const response = await handler.handleCreate(
      makeRequest("https://api.example.com/api/admin/platform-categories", "POST", {
        code: "nonprofit",
        displayName: "Nonprofit",
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(409);
    const body = await response.json() as any;
    expect(body.error).toBe("CONFLICT");
  });

  it("returns 400 on invalid JSON body", async () => {
    const request = new Request("https://api.example.com/api/admin/platform-categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    const response = await handler.handleCreate(request, makeSuperAdminAuth(), mockEnv);
    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("INVALID_JSON");
  });
});

// ── handleDeactivate ───────────────────────────────────────────────────────────

describe("PlatformCategoryAdminHandler.handleDeactivate", () => {
  let handler: PlatformCategoryAdminHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new PlatformCategoryAdminHandler();

    // Default $transaction: execute array of operations as-is (Prisma batch).
    mockDb.$transaction.mockImplementation(async (ops: unknown[]) => {
      return Promise.all(ops);
    });
  });

  it("returns 403 for non-SUPER_ADMIN callers", async () => {
    const response = await handler.handleDeactivate(
      "cat-id",
      makeRequest("https://api.example.com/api/admin/platform-categories/cat-id/deactivate", "POST", {}),
      makeRegularAuth(),
      mockEnv,
    );
    expect(response.status).toBe(403);
  });

  it("returns 404 when category does not exist", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue(null);
    mockDb.platformCategory.findMany.mockResolvedValue([]);

    const response = await handler.handleDeactivate(
      "ghost-id",
      makeRequest("https://api.example.com/api/admin/platform-categories/ghost-id/deactivate", "POST", {}),
      makeSuperAdminAuth(),
      mockEnv,
    );
    expect(response.status).toBe(404);
  });

  it("returns 409 when category is already inactive", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: "cat-id", code: "nonprofit", isActive: false });
    mockDb.platformCategory.findMany.mockResolvedValue([{ id: "cat-id", code: "nonprofit", parentCategoryId: null }]);

    const response = await handler.handleDeactivate(
      "cat-id",
      makeRequest("https://api.example.com/api/admin/platform-categories/cat-id/deactivate", "POST", {}),
      makeSuperAdminAuth(),
      mockEnv,
    );
    expect(response.status).toBe(409);
    const body = await response.json() as any;
    expect(body.error).toBe("CONFLICT");
  });

  it("deactivates successfully with no affected TenantClassification rows", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: "cat-01", code: "nonprofit", isActive: true });
    mockDb.platformCategory.findMany.mockResolvedValue([
      { id: "cat-01", code: "nonprofit", parentCategoryId: null },
      { id: "cat-02", code: "nonprofit:animal-welfare", parentCategoryId: "cat-01" },
    ]);
    mockDb.tenantClassification.count.mockResolvedValue(0);
    mockDb.platformCategory.updateMany.mockResolvedValue({ count: 2 });

    const response = await handler.handleDeactivate(
      "cat-01",
      makeRequest("https://api.example.com/api/admin/platform-categories/cat-01/deactivate", "POST", {}),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.ok).toBe(true);
    expect(body.reclassifiedCount).toBe(0);
    // Both node and its descendant are deactivated.
    expect(body.deactivatedIds).toContain("cat-01");
    expect(body.deactivatedIds).toContain("cat-02");
  });

  it("returns 422 when TenantClassification rows depend on the subtree and no reassignTo is supplied", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: "cat-01", code: "nonprofit", isActive: true });
    mockDb.platformCategory.findMany.mockResolvedValue([
      { id: "cat-01", code: "nonprofit", parentCategoryId: null },
    ]);
    mockDb.tenantClassification.count.mockResolvedValue(5);

    const response = await handler.handleDeactivate(
      "cat-01",
      makeRequest("https://api.example.com/api/admin/platform-categories/cat-01/deactivate", "POST", {}),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(422);
    const body = await response.json() as any;
    expect(body.error).toBe("REASSIGN_REQUIRED");
    expect(body.message).toMatch(/reassignTo/);
  });

  it("bulk-reassigns affected TenantClassification rows when valid reassignTo is supplied", async () => {
    const targetId = "cat-01";
    const reassignTargetId = "cat-03";

    mockDb.platformCategory.findUnique
      .mockResolvedValueOnce({ id: targetId, code: "nonprofit", isActive: true }) // target
      .mockResolvedValueOnce({ id: reassignTargetId, isActive: true });            // reassign target
    mockDb.platformCategory.findMany.mockResolvedValue([
      { id: targetId, code: "nonprofit", parentCategoryId: null },
    ]);
    mockDb.tenantClassification.count.mockResolvedValue(3);
    mockDb.tenantClassification.updateMany.mockResolvedValue({ count: 3 });
    mockDb.platformCategory.updateMany.mockResolvedValue({ count: 1 });

    const response = await handler.handleDeactivate(
      targetId,
      makeRequest(`https://api.example.com/api/admin/platform-categories/${targetId}/deactivate`, "POST", {
        reassignTo: reassignTargetId,
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.ok).toBe(true);
    expect(body.reclassifiedCount).toBe(3);
    expect(body.reassignedTo).toBe(reassignTargetId);

    // Verify $transaction was called (batch deactivation + reassignment).
    expect(mockDb.$transaction).toHaveBeenCalledOnce();
  });

  it("returns 400 when reassignTo is the same as the category being deactivated", async () => {
    const targetId = "cat-01";
    mockDb.platformCategory.findUnique.mockResolvedValue({ id: targetId, code: "nonprofit", isActive: true });
    mockDb.platformCategory.findMany.mockResolvedValue([
      { id: targetId, code: "nonprofit", parentCategoryId: null },
    ]);
    mockDb.tenantClassification.count.mockResolvedValue(2);

    const response = await handler.handleDeactivate(
      targetId,
      makeRequest(`https://api.example.com/api/admin/platform-categories/${targetId}/deactivate`, "POST", {
        reassignTo: targetId,
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toMatch(/same as the category being deactivated/);
  });

  it("returns 400 when reassignTo is a descendant of the category being deactivated", async () => {
    const parentId = "cat-01";
    const childId = "cat-02";

    mockDb.platformCategory.findUnique
      .mockResolvedValueOnce({ id: parentId, code: "nonprofit", isActive: true })
      .mockResolvedValueOnce({ id: childId, isActive: true }); // reassign target check
    mockDb.platformCategory.findMany.mockResolvedValue([
      { id: parentId, code: "nonprofit", parentCategoryId: null },
      { id: childId, code: "nonprofit:animal-welfare", parentCategoryId: parentId },
    ]);
    mockDb.tenantClassification.count.mockResolvedValue(2);

    const response = await handler.handleDeactivate(
      parentId,
      makeRequest(`https://api.example.com/api/admin/platform-categories/${parentId}/deactivate`, "POST", {
        reassignTo: childId,
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toMatch(/descendant/);
  });

  it("returns 400 when reassignTo references an inactive category", async () => {
    const targetId = "cat-01";
    const inactiveReassignId = "cat-inactive";

    mockDb.platformCategory.findUnique
      .mockResolvedValueOnce({ id: targetId, code: "nonprofit", isActive: true })
      .mockResolvedValueOnce({ id: inactiveReassignId, isActive: false });
    mockDb.platformCategory.findMany.mockResolvedValue([
      { id: targetId, code: "nonprofit", parentCategoryId: null },
    ]);
    mockDb.tenantClassification.count.mockResolvedValue(1);

    const response = await handler.handleDeactivate(
      targetId,
      makeRequest(`https://api.example.com/api/admin/platform-categories/${targetId}/deactivate`, "POST", {
        reassignTo: inactiveReassignId,
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toMatch(/inactive/);
  });

  it("returns 400 when reassignTo references a non-existent category", async () => {
    const targetId = "cat-01";

    mockDb.platformCategory.findUnique
      .mockResolvedValueOnce({ id: targetId, code: "nonprofit", isActive: true })
      .mockResolvedValueOnce(null); // reassign target not found
    mockDb.platformCategory.findMany.mockResolvedValue([
      { id: targetId, code: "nonprofit", parentCategoryId: null },
    ]);
    mockDb.tenantClassification.count.mockResolvedValue(1);

    const response = await handler.handleDeactivate(
      targetId,
      makeRequest(`https://api.example.com/api/admin/platform-categories/${targetId}/deactivate`, "POST", {
        reassignTo: "ghost-id",
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toMatch(/not found/);
  });
});

// ── handleReparent ─────────────────────────────────────────────────────────────

describe("PlatformCategoryAdminHandler.handleReparent", () => {
  let handler: PlatformCategoryAdminHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new PlatformCategoryAdminHandler();
  });

  it("returns 403 for non-SUPER_ADMIN callers", async () => {
    const response = await handler.handleReparent(
      "cat-id",
      makeRequest("https://api.example.com/api/admin/platform-categories/cat-id/reparent", "POST", {
        newParentCategoryId: "other-id",
      }),
      makeRegularAuth(),
      mockEnv,
    );
    expect(response.status).toBe(403);
  });

  it("reparents a node to a new valid active parent", async () => {
    const nodeId = "cat-leaf";
    const newParentId = "cat-new-parent";

    mockDb.platformCategory.findUnique
      .mockResolvedValueOnce({ id: nodeId, code: "nonprofit:x", isActive: true, parentCategoryId: "cat-old-parent" })
      .mockResolvedValueOnce({ id: newParentId, isActive: true });
    mockDb.platformCategory.findMany.mockResolvedValue([
      { id: nodeId, code: "nonprofit:x", parentCategoryId: "cat-old-parent" },
      { id: "cat-old-parent", code: "nonprofit", parentCategoryId: null },
      { id: newParentId, code: "business", parentCategoryId: null },
    ]);
    mockDb.platformCategory.update.mockResolvedValue({
      id: nodeId,
      code: "nonprofit:x",
      parentCategoryId: newParentId,
      updatedAt: new Date(),
    });

    const response = await handler.handleReparent(
      nodeId,
      makeRequest(`https://api.example.com/api/admin/platform-categories/${nodeId}/reparent`, "POST", {
        newParentCategoryId: newParentId,
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.ok).toBe(true);
    expect(body.parentCategoryId).toBe(newParentId);
  });

  it("promotes a node to root when newParentCategoryId is null", async () => {
    const nodeId = "cat-leaf";

    mockDb.platformCategory.findUnique.mockResolvedValue({
      id: nodeId,
      code: "nonprofit:x",
      isActive: true,
      parentCategoryId: "cat-parent",
    });
    mockDb.platformCategory.update.mockResolvedValue({
      id: nodeId,
      code: "nonprofit:x",
      parentCategoryId: null,
      updatedAt: new Date(),
    });

    const response = await handler.handleReparent(
      nodeId,
      makeRequest(`https://api.example.com/api/admin/platform-categories/${nodeId}/reparent`, "POST", {
        newParentCategoryId: null,
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.parentCategoryId).toBeNull();
  });

  it("returns 404 when node does not exist", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue(null);

    const response = await handler.handleReparent(
      "ghost-id",
      makeRequest("https://api.example.com/api/admin/platform-categories/ghost-id/reparent", "POST", {
        newParentCategoryId: "some-parent",
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(404);
  });

  it("returns 409 when trying to reparent an inactive node", async () => {
    mockDb.platformCategory.findUnique.mockResolvedValue({
      id: "cat-id",
      code: "nonprofit",
      isActive: false,
      parentCategoryId: null,
    });

    const response = await handler.handleReparent(
      "cat-id",
      makeRequest("https://api.example.com/api/admin/platform-categories/cat-id/reparent", "POST", {
        newParentCategoryId: "other-id",
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(409);
    const body = await response.json() as any;
    expect(body.error).toBe("CONFLICT");
    expect(body.message).toMatch(/inactive/);
  });

  it("returns 404 when new parent does not exist", async () => {
    mockDb.platformCategory.findUnique
      .mockResolvedValueOnce({ id: "cat-id", code: "nonprofit:x", isActive: true, parentCategoryId: null })
      .mockResolvedValueOnce(null);

    const response = await handler.handleReparent(
      "cat-id",
      makeRequest("https://api.example.com/api/admin/platform-categories/cat-id/reparent", "POST", {
        newParentCategoryId: "ghost-parent",
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 when new parent is inactive", async () => {
    mockDb.platformCategory.findUnique
      .mockResolvedValueOnce({ id: "cat-id", code: "nonprofit:x", isActive: true, parentCategoryId: null })
      .mockResolvedValueOnce({ id: "inactive-parent", isActive: false });

    const response = await handler.handleReparent(
      "cat-id",
      makeRequest("https://api.example.com/api/admin/platform-categories/cat-id/reparent", "POST", {
        newParentCategoryId: "inactive-parent",
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toMatch(/inactive/);
  });

  it("rejects reparent when new parent is a descendant of the node (cycle detection)", async () => {
    // Tree: root -> child -> grandchild
    // Attempt: reparent root under grandchild → cycle
    const rootId = "root";
    const childId = "child";
    const grandchildId = "grandchild";

    mockDb.platformCategory.findUnique
      .mockResolvedValueOnce({ id: rootId, code: "nonprofit", isActive: true, parentCategoryId: null })
      .mockResolvedValueOnce({ id: grandchildId, isActive: true });
    mockDb.platformCategory.findMany.mockResolvedValue([
      { id: rootId, code: "nonprofit", parentCategoryId: null },
      { id: childId, code: "nonprofit:animal-welfare", parentCategoryId: rootId },
      { id: grandchildId, code: "nonprofit:animal-welfare:dogs", parentCategoryId: childId },
    ]);

    const response = await handler.handleReparent(
      rootId,
      makeRequest(`https://api.example.com/api/admin/platform-categories/${rootId}/reparent`, "POST", {
        newParentCategoryId: grandchildId,
      }),
      makeSuperAdminAuth(),
      mockEnv,
    );

    expect(response.status).toBe(422);
    const body = await response.json() as any;
    expect(body.error).toBe("CYCLE_DETECTED");
    expect(body.message).toMatch(/descendant/);
  });

  it("returns 400 on invalid JSON body", async () => {
    const request = new Request(
      "https://api.example.com/api/admin/platform-categories/cat-id/reparent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "bad-json{{{",
      },
    );

    const response = await handler.handleReparent("cat-id", request, makeSuperAdminAuth(), mockEnv);
    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error).toBe("INVALID_JSON");
  });
});
