/**
 * Cross-Tenant Isolation Tests — Tenant Routes
 *
 * Every tenant-scoped endpoint must have at least one test confirming:
 *   - auth-as-A querying B returns 403/404 (no existence leak)
 *   - nonexistent tenantId returns 404
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantHandler } from "../../src/lib/tenant/tenant-handler.js";
import { buildTwoTenantFixture } from "../_helpers/multi-tenant-fixture.js";
import type { Env } from "../../src/env.js";

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
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../../src/db", () => ({
  createPrisma: () => mockDb,
}));

vi.mock("../../src/lib/auth/claims-cache", () => ({
  createClaimsCacheFromEnv: () => ({ invalidate: vi.fn() }),
}));

const mockEnv = { DATABASE_URL: "postgresql://test" } as unknown as Env;

describe("Cross-tenant isolation: GET /api/tenants/:id", () => {
  let handler: TenantHandler;
  const { tenantA, tenantB, authA, authB } = buildTwoTenantFixture();

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TenantHandler();
  });

  it("auth-A can read tenant-A", async () => {
    mockDb.tenant.findUnique.mockResolvedValue({
      id: tenantA.id,
      slug: tenantA.slug,
      displayName: tenantA.displayName,
      type: "ORGANIZATION",
      status: "ACTIVE",
      createdAt: new Date(),
    });

    const response = await handler.handleGet(tenantA.id, authA, mockEnv);
    expect(response.status).toBe(200);
  });

  it("auth-A requesting tenant-B returns 404 — no existence leak", async () => {
    const response = await handler.handleGet(tenantB.id, authA, mockEnv);
    expect(response.status).toBe(404);
    // Must not expose whether tenant-B exists
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain(tenantB.id);
  });

  it("auth-B requesting tenant-A returns 404", async () => {
    const response = await handler.handleGet(tenantA.id, authB, mockEnv);
    expect(response.status).toBe(404);
  });

  it("nonexistent tenant returns 404 (not 403 — no existence leak)", async () => {
    mockDb.tenant.findUnique.mockResolvedValue(null);
    const response = await handler.handleGet(tenantA.id, authA, mockEnv);
    expect(response.status).toBe(404);
  });
});

describe("Cross-tenant isolation: PATCH /api/tenants/:id", () => {
  let handler: TenantHandler;
  const { tenantA, tenantB, authA } = buildTwoTenantFixture();

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TenantHandler();
  });

  it("auth-A requesting tenant-B update returns 403", async () => {
    const request = new Request("https://api.example.com/api/tenants/tenant-b-id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Hacked" }),
    });
    const response = await handler.handleUpdate(tenantB.id, request, authA, mockEnv);
    expect(response.status).toBe(403);
    expect(mockDb.tenant.update).not.toHaveBeenCalled();
  });
});

describe("Cross-tenant isolation: POST /api/tenants/:id/transfer-ownership", () => {
  let handler: TenantHandler;
  const { tenantB, authA } = buildTwoTenantFixture();

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TenantHandler();
  });

  it("auth-A requesting transfer in tenant-B returns 403", async () => {
    const request = new Request(
      "https://api.example.com/api/tenants/tenant-b-id/transfer-ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: "any-user" }),
      },
    );
    const response = await handler.handleTransferOwnership(tenantB.id, request, authA, mockEnv);
    expect(response.status).toBe(403);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.tenantMember.update).not.toHaveBeenCalled();
  });
});

describe("Cross-tenant isolation: POST /api/auth/switch-tenant", () => {
  let handler: TenantHandler;
  const { authA } = buildTwoTenantFixture();

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TenantHandler();
  });

  it("switch to a tenant where user is not a member returns 403", async () => {
    mockDb.tenantMember.findUnique.mockResolvedValue(null);

    const request = new Request("https://api.example.com/api/auth/switch-tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-b-id" }),
    });

    const response = await handler.handleSwitchTenant(request, authA, mockEnv);
    expect(response.status).toBe(403);
  });
});
