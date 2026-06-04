/**
 * Schema-shape tests for per-tenant FeatureToggle scoping (Surveillance-
 * hardening Phase 0, P1 / E4). Runs against a real Postgres (Docker Compose).
 *
 * The load-bearing behavior is the PARTIAL unique index that the @@unique
 * alone cannot provide (Postgres treats NULLs as distinct):
 *   1. two GLOBAL rows (tenant_id NULL) with the same key  -> rejected
 *   2. the same key under two different tenants            -> allowed
 *   3. one global + one tenant row for the same key        -> allowed
 *
 * Reference: plans/surveillance-hardening-phase0/01-schema-enablers.md
 */

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { describeColumn, hasIndexMatching, TEST_DB_URL } from "./_schema-helpers";

let prisma: PrismaClient;
const KEY = "phase0_scope_test_key";

beforeAll(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.featureToggle.deleteMany({ where: { key: KEY } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.featureToggle.deleteMany({ where: { key: KEY } });
});

describe("feature_toggles column + indexes", () => {
  it("tenant_id is a nullable text column", async () => {
    const c = await describeColumn(prisma, "feature_toggles", "tenant_id");
    expect(c).not.toBeNull();
    expect(c!.is_nullable).toBe("YES");
    expect(c!.data_type).toBe("text");
  });

  it("has the composite (key, tenant_id) unique index", async () => {
    expect(
      await hasIndexMatching(prisma, "feature_toggles", ["UNIQUE", "key", "tenant_id"]),
    ).toBe(true);
  });

  it("has the PARTIAL global-unique index (key WHERE tenant_id IS NULL)", async () => {
    expect(
      await hasIndexMatching(prisma, "feature_toggles", ["UNIQUE", "tenant_id IS NULL"]),
    ).toBe(true);
  });
});

describe("feature_toggles uniqueness behavior", () => {
  it("rejects a second GLOBAL row for the same key", async () => {
    await prisma.featureToggle.create({ data: { key: KEY, enabled: false } });
    await expect(
      prisma.featureToggle.create({ data: { key: KEY, enabled: true } }),
    ).rejects.toThrow();
  });

  it("allows the same key under two different tenants", async () => {
    await prisma.featureToggle.create({ data: { key: KEY, enabled: false, tenantId: "tenantA" } });
    await prisma.featureToggle.create({ data: { key: KEY, enabled: true, tenantId: "tenantB" } });
    const rows = await prisma.featureToggle.findMany({ where: { key: KEY } });
    expect(rows).toHaveLength(2);
  });

  it("allows one global row plus a tenant override for the same key", async () => {
    await prisma.featureToggle.create({ data: { key: KEY, enabled: false } });
    await prisma.featureToggle.create({ data: { key: KEY, enabled: true, tenantId: "tenantA" } });
    const rows = await prisma.featureToggle.findMany({ where: { key: KEY } });
    expect(rows).toHaveLength(2);
  });

  it("rejects a duplicate row for the same (key, tenant) pair", async () => {
    await prisma.featureToggle.create({ data: { key: KEY, enabled: false, tenantId: "tenantA" } });
    await expect(
      prisma.featureToggle.create({ data: { key: KEY, enabled: true, tenantId: "tenantA" } }),
    ).rejects.toThrow();
  });
});
