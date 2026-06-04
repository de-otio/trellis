/**
 * Unit tests for globalScopedFeatureToggleClient (Surveillance-hardening
 * Phase 0, P1). The adapter scopes foundation's bare-key operations to GLOBAL
 * rows (tenant_id IS NULL) now that `key` is no longer standalone-unique.
 *
 * These assert the translation contract:
 *   - findUnique(where:{key})  -> findFirst(where:{key, tenantId:null})
 *   - findMany(orderBy)        -> findMany(where:{tenantId:null}, orderBy)
 *   - upsert(where:{key})      -> findFirst(id) then update OR create(tenantId:null)
 *   - delete(where:{key})      -> deleteMany(where:{key, tenantId:null})
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { globalScopedFeatureToggleClient } from "../../src/lib/feature-toggle-global-client.js";

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

describe("globalScopedFeatureToggleClient", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;

  beforeEach(() => {
    prisma = makeMockPrisma();
  });

  it("findUnique scopes to the global row (tenant_id IS NULL)", async () => {
    prisma.featureToggle.findFirst.mockResolvedValue({ key: "k", enabled: true });
    const client = globalScopedFeatureToggleClient(prisma as any);

    await client.featureToggle.findUnique({ where: { key: "k" } } as any);

    expect(prisma.featureToggle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "k", tenantId: null } }),
    );
  });

  it("findMany scopes to global rows and preserves orderBy", async () => {
    prisma.featureToggle.findMany.mockResolvedValue([]);
    const client = globalScopedFeatureToggleClient(prisma as any);

    await client.featureToggle.findMany({ orderBy: { key: "asc" } } as any);

    expect(prisma.featureToggle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: null },
        orderBy: { key: "asc" },
      }),
    );
  });

  it("upsert updates the existing global row when present", async () => {
    prisma.featureToggle.findFirst.mockResolvedValue({ id: "ft_1" });
    prisma.featureToggle.update.mockResolvedValue({ key: "k", enabled: false });
    const client = globalScopedFeatureToggleClient(prisma as any);

    await client.featureToggle.upsert({
      where: { key: "k" },
      update: { enabled: false, changedBy: "a@example.com" },
      create: { key: "k", enabled: false, changedBy: "a@example.com" },
    } as any);

    expect(prisma.featureToggle.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ft_1" } }),
    );
    expect(prisma.featureToggle.create).not.toHaveBeenCalled();
  });

  it("upsert creates a global row (tenant_id null) when absent", async () => {
    prisma.featureToggle.findFirst.mockResolvedValue(null);
    prisma.featureToggle.create.mockResolvedValue({ key: "k", enabled: true });
    const client = globalScopedFeatureToggleClient(prisma as any);

    await client.featureToggle.upsert({
      where: { key: "k" },
      update: { enabled: true, changedBy: "a@example.com" },
      create: { key: "k", enabled: true, changedBy: "a@example.com" },
    } as any);

    expect(prisma.featureToggle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ key: "k", tenantId: null }),
      }),
    );
    expect(prisma.featureToggle.update).not.toHaveBeenCalled();
  });

  it("delete removes only the global row and never throws on absence", async () => {
    prisma.featureToggle.deleteMany.mockResolvedValue({ count: 0 });
    const client = globalScopedFeatureToggleClient(prisma as any);

    await expect(
      client.featureToggle.delete({ where: { key: "missing" } } as any),
    ).resolves.toBeDefined();

    expect(prisma.featureToggle.deleteMany).toHaveBeenCalledWith({
      where: { key: "missing", tenantId: null },
    });
  });
});
