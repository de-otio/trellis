/**
 * Unit tests for P5 — tenant-scoped feature toggle resolution.
 *
 * Surveillance-hardening Phase 0, E4. Verifies:
 *   1. Resolution order: tenant override → global row → coded default (null),
 *      via a SINGLE query (`(tenant_id = ? OR tenant_id IS NULL)`).
 *   2. Cross-tenant isolation: tenant A never observes tenant B's row — for
 *      reads (getToggle/isEnabled) AND the list path (getAllToggles), where even
 *      the key name of a foreign override must not leak.
 *   3. Cache key includes tenantId: the tenant path bypasses foundation's
 *      key-only per-instance cache, so tenant A's value can never be served to
 *      tenant B.
 *   4. Authorization on tenant-scoped writes (`canWriteTenantToggle`).
 *
 * Fully mocked — the Prisma client is a structural stub; no DB.
 *
 * The service routes the GLOBAL path (no tenantId) through foundation's
 * PrismaFeatureToggleStore (which we let run against the mock), and the TENANT
 * path directly against the mocked Prisma client. These assertions target the
 * raw featureToggle call surface in both cases.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FeatureToggleService,
  canWriteTenantToggle,
} from "../../src/lib/feature-toggle-service.js";

// ---------------------------------------------------------------------------
// Structural Prisma mock
// ---------------------------------------------------------------------------

function makeRow(overrides: {
  key: string;
  enabled: boolean;
  tenantId?: string | null;
  changedAt?: Date;
  changedBy?: string | null;
  description?: string | null;
  id?: string;
}) {
  return {
    id: overrides.id ?? `ft_${overrides.key}_${overrides.tenantId ?? "global"}`,
    key: overrides.key,
    enabled: overrides.enabled,
    tenantId: overrides.tenantId ?? null,
    changedAt: overrides.changedAt ?? new Date("2024-01-01"),
    changedBy: overrides.changedBy ?? null,
    description: overrides.description ?? null,
  };
}

function makeMockPrisma() {
  return {
    featureToggle: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

const TENANT_A = "tenant_aaaaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "tenant_bbbbbbbbbbbbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// Resolution order: tenant → global → default (single query)
// ---------------------------------------------------------------------------

describe("getToggle(key, tenantId) — resolution order", () => {
  it("uses a single OR-query ordered tenant-first (NULLS LAST)", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findFirst.mockResolvedValue(
      makeRow({ key: "feat", enabled: true, tenantId: TENANT_A }),
    );
    const svc = new FeatureToggleService(prisma as any);

    await svc.getToggle("feat", TENANT_A);

    expect(prisma.featureToggle.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.featureToggle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "feat", OR: [{ tenantId: TENANT_A }, { tenantId: null }] },
        orderBy: { tenantId: { sort: "desc", nulls: "last" } },
      }),
    );
  });

  it("tenant override beats the global row", async () => {
    const prisma = makeMockPrisma();
    // The ordered query returns the tenant row first; the service takes row 1.
    prisma.featureToggle.findFirst.mockResolvedValue(
      makeRow({ key: "feat", enabled: true, tenantId: TENANT_A }),
    );
    const svc = new FeatureToggleService(prisma as any);

    const result = await svc.getToggle("feat", TENANT_A);
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
  });

  it("falls back to the global row when no tenant row exists", async () => {
    const prisma = makeMockPrisma();
    // No tenant row → ordered query returns the global row.
    prisma.featureToggle.findFirst.mockResolvedValue(
      makeRow({ key: "feat", enabled: false, tenantId: null }),
    );
    const svc = new FeatureToggleService(prisma as any);

    const result = await svc.getToggle("feat", TENANT_A);
    expect(result!.enabled).toBe(false);
  });

  it("yields the coded default (null) when neither tenant nor global row exists", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findFirst.mockResolvedValue(null);
    const svc = new FeatureToggleService(prisma as any);

    expect(await svc.getToggle("feat", TENANT_A)).toBeNull();
  });

  it("is fail-soft (null) on DB error", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findFirst.mockRejectedValue(new Error("db down"));
    const svc = new FeatureToggleService(prisma as any);

    expect(await svc.getToggle("feat", TENANT_A)).toBeNull();
  });

  it("isEnabled(key, tenantId) mirrors the resolved value", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findFirst.mockResolvedValue(
      makeRow({ key: "feat", enabled: true, tenantId: TENANT_A }),
    );
    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.isEnabled("feat", TENANT_A)).toBe(true);
  });

  it("isEnabled(key, tenantId) is false when nothing resolves", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findFirst.mockResolvedValue(null);
    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.isEnabled("feat", TENANT_A)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Global path preserved exactly (no tenantId)
// ---------------------------------------------------------------------------

describe("getToggle(key) — global path unchanged", () => {
  it("scopes to global rows (tenant_id IS NULL) via findFirst, no OR clause", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findFirst.mockResolvedValue(
      makeRow({ key: "feat", enabled: true, tenantId: null }),
    );
    const svc = new FeatureToggleService(prisma as any);

    await svc.getToggle("feat");

    // Goes through the global-scoped adapter: where {key, tenantId: null}.
    expect(prisma.featureToggle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "feat", tenantId: null } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant isolation (reads)
// ---------------------------------------------------------------------------

describe("cross-tenant isolation — reads", () => {
  it("tenant A's query filter never includes tenant B", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findFirst.mockResolvedValue(null);
    const svc = new FeatureToggleService(prisma as any);

    await svc.getToggle("feat", TENANT_A);

    const callArgs = prisma.featureToggle.findFirst.mock.calls[0]![0];
    const serialized = JSON.stringify(callArgs);
    expect(serialized).toContain(TENANT_A);
    expect(serialized).not.toContain(TENANT_B);
  });

  it("tenant B resolving the same key gets tenant B's filter (its own row)", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findFirst.mockResolvedValue(
      makeRow({ key: "feat", enabled: false, tenantId: TENANT_B }),
    );
    const svc = new FeatureToggleService(prisma as any);

    await svc.getToggle("feat", TENANT_B);

    const callArgs = prisma.featureToggle.findFirst.mock.calls[0]![0];
    expect(JSON.stringify(callArgs)).toContain(TENANT_B);
    expect(JSON.stringify(callArgs)).not.toContain(TENANT_A);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant isolation — getAllToggles (list/enumerate path)
// ---------------------------------------------------------------------------

describe("getAllToggles(tenantId) — list isolation", () => {
  it("queries only global + caller-tenant rows at the DB (foreign tenant excluded)", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findMany.mockResolvedValue([]);
    const svc = new FeatureToggleService(prisma as any);

    await svc.getAllToggles(TENANT_A);

    expect(prisma.featureToggle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ tenantId: TENANT_A }, { tenantId: null }] },
      }),
    );
    const serialized = JSON.stringify(
      prisma.featureToggle.findMany.mock.calls[0]![0],
    );
    expect(serialized).not.toContain(TENANT_B);
  });

  it("tenant override replaces the global row for the same key (effective config)", async () => {
    const prisma = makeMockPrisma();
    // DB returns global + tenant rows for the same key; service de-dups to the
    // tenant override.
    prisma.featureToggle.findMany.mockResolvedValue([
      makeRow({ key: "feat", enabled: false, tenantId: null }),
      makeRow({ key: "feat", enabled: true, tenantId: TENANT_A }),
      makeRow({ key: "other", enabled: true, tenantId: null }),
    ]);
    const svc = new FeatureToggleService(prisma as any);

    const result = await svc.getAllToggles(TENANT_A);

    const feat = result.find((t) => t.key === "feat");
    const other = result.find((t) => t.key === "other");
    expect(feat!.enabled).toBe(true); // tenant override won
    expect(other!.enabled).toBe(true); // global passthrough
    expect(result).toHaveLength(2); // de-duped by key
  });

  it("does not leak a foreign tenant's key names (DB filter, not post-filter)", async () => {
    const prisma = makeMockPrisma();
    // Simulate the DB honoring the where-filter: only global + tenant-A rows
    // come back. A tenant-B-only key must never appear in the result.
    prisma.featureToggle.findMany.mockResolvedValue([
      makeRow({ key: "shared", enabled: true, tenantId: null }),
      makeRow({ key: "a_only", enabled: true, tenantId: TENANT_A }),
    ]);
    const svc = new FeatureToggleService(prisma as any);

    const result = await svc.getAllToggles(TENANT_A);
    const keys = result.map((t) => t.key);
    expect(keys).toContain("shared");
    expect(keys).toContain("a_only");
    expect(keys).not.toContain("b_only");
  });

  it("global getAllToggles() (no tenantId) returns global rows only, unchanged", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findMany.mockResolvedValue([
      makeRow({ key: "g", enabled: true, tenantId: null }),
    ]);
    const svc = new FeatureToggleService(prisma as any);

    await svc.getAllToggles();

    // Global path goes through the global-scoped adapter: where {tenantId:null}.
    expect(prisma.featureToggle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: null } }),
    );
  });

  it("is fail-soft ([]) on DB error in the tenant path", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findMany.mockRejectedValue(new Error("db down"));
    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.getAllToggles(TENANT_A)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cache-key isolation: tenant path is uncached (foundation cache keys by `key`)
// ---------------------------------------------------------------------------

describe("cache isolation — tenant path must not reuse the global key-only cache", () => {
  it("tenant A then tenant B for the same key each hit the DB (no cross-tenant cache hit)", async () => {
    const prisma = makeMockPrisma();
    const svc = new FeatureToggleService(prisma as any);

    prisma.featureToggle.findFirst.mockResolvedValueOnce(
      makeRow({ key: "feat", enabled: true, tenantId: TENANT_A }),
    );
    expect(await svc.isEnabled("feat", TENANT_A)).toBe(true);

    // If the tenant path wrongly used foundation's key-only cache, tenant B
    // would get tenant A's cached `true` WITHOUT a second query. It must query.
    prisma.featureToggle.findFirst.mockResolvedValueOnce(
      makeRow({ key: "feat", enabled: false, tenantId: TENANT_B }),
    );
    expect(await svc.isEnabled("feat", TENANT_B)).toBe(false);

    expect(prisma.featureToggle.findFirst).toHaveBeenCalledTimes(2);
    const secondCall = JSON.stringify(
      prisma.featureToggle.findFirst.mock.calls[1]![0],
    );
    expect(secondCall).toContain(TENANT_B);
  });
});

// ---------------------------------------------------------------------------
// Tenant-scoped writes
// ---------------------------------------------------------------------------

describe("setToggle(..., tenantId) — tenant-scoped write", () => {
  it("creates a NEW tenant override row (tenant_id stamped), leaving global untouched", async () => {
    const prisma = makeMockPrisma();
    // _setScoped existence-check finds nothing → create path.
    prisma.featureToggle.findFirst.mockResolvedValue(null);
    prisma.featureToggle.create.mockResolvedValue(
      makeRow({ key: "feat", enabled: true, tenantId: TENANT_A }),
    );
    const svc = new FeatureToggleService(prisma as any);

    const result = await svc.setToggle(
      "feat",
      true,
      "admin@example.com",
      "desc",
      undefined,
      TENANT_A,
    );

    expect(prisma.featureToggle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ key: "feat", tenantId: TENANT_A }),
      }),
    );
    expect(prisma.featureToggle.create.mock.calls[0]![0].data.tenantId).toBe(
      TENANT_A,
    );
    expect(result.enabled).toBe(true);
  });

  it("updates an EXISTING tenant override row by id", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findFirst.mockResolvedValue(
      makeRow({ key: "feat", enabled: false, tenantId: TENANT_A, id: "ft_x" }),
    );
    prisma.featureToggle.update.mockResolvedValue(
      makeRow({ key: "feat", enabled: true, tenantId: TENANT_A }),
    );
    const svc = new FeatureToggleService(prisma as any);

    await svc.setToggle("feat", true, "admin@example.com", undefined, undefined, TENANT_A);

    expect(prisma.featureToggle.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ft_x" } }),
    );
    expect(prisma.featureToggle.create).not.toHaveBeenCalled();
  });

  it("the existence-check filters by [key, tenantId] (never another tenant)", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findFirst.mockResolvedValue(null);
    prisma.featureToggle.create.mockResolvedValue(
      makeRow({ key: "feat", enabled: true, tenantId: TENANT_A }),
    );
    const svc = new FeatureToggleService(prisma as any);

    await svc.setToggle("feat", true, "admin@example.com", undefined, undefined, TENANT_A);

    expect(prisma.featureToggle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "feat", tenantId: TENANT_A },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Authorization on tenant-scoped writes
// ---------------------------------------------------------------------------

describe("canWriteTenantToggle — authorization", () => {
  it("SUPER_ADMIN may write any tenant's override", () => {
    expect(
      canWriteTenantToggle({
        role: "SUPER_ADMIN",
        callerTenantId: undefined,
        targetTenantId: TENANT_A,
      }),
    ).toBe(true);
    expect(
      canWriteTenantToggle({
        role: "SUPER_ADMIN",
        callerTenantId: TENANT_B,
        targetTenantId: TENANT_A,
      }),
    ).toBe(true);
  });

  it("a tenant admin may write ONLY their own tenant's override", () => {
    expect(
      canWriteTenantToggle({
        role: "ADMIN",
        callerTenantId: TENANT_A,
        targetTenantId: TENANT_A,
      }),
    ).toBe(true);
  });

  it("DENIES a cross-tenant write by a non-super-admin", () => {
    expect(
      canWriteTenantToggle({
        role: "ADMIN",
        callerTenantId: TENANT_A,
        targetTenantId: TENANT_B,
      }),
    ).toBe(false);
  });

  it("DENIES a non-super-admin with no active tenant", () => {
    expect(
      canWriteTenantToggle({
        role: "END_USER",
        callerTenantId: undefined,
        targetTenantId: TENANT_A,
      }),
    ).toBe(false);
  });

  it("DENIES an undefined role with no tenant (fail-closed)", () => {
    expect(
      canWriteTenantToggle({
        role: undefined,
        callerTenantId: undefined,
        targetTenantId: TENANT_A,
      }),
    ).toBe(false);
  });
});
