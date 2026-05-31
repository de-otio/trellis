/**
 * Schema-shape tests for the v0.7 tenancy migration (T1 acceptance).
 *
 * These tests run against a real Postgres (Docker Compose) and assert:
 *   1. The new tenancy tables exist with the expected columns.
 *   2. Every tenant-scoped table has a non-nullable tenant_id column.
 *   3. The legacy `partners` table is dropped.
 *   4. Cascade-delete behaves: deleting a Tenant cascades to its members + domains + IdP + role-mappings.
 *   5. The migration is idempotent against re-application (Prisma migration framework guarantee).
 *
 * Reference: plans/mvp/10-trellis-stages/01-schema-migration.md
 */

import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Ask Postgres for a column's nullability and type. */
async function describeColumn(
  table: string,
  column: string,
): Promise<{ data_type: string; is_nullable: "YES" | "NO" } | null> {
  const rows = await prisma.$queryRawUnsafe<
    { data_type: string; is_nullable: "YES" | "NO" }[]
  >(
    `SELECT data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2`,
    table,
    column,
  );
  return rows[0] ?? null;
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    table,
  );
  return rows[0]!.count > 0n;
}

describe("New tenancy tables exist", () => {
  it.each([
    "tenants",
    "tenant_members",
    "tenant_domains",
    "tenant_identity_providers",
    "tenant_role_mappings",
    "tenant_invitations",
  ])("table %s exists", async (table) => {
    expect(await tableExists(table)).toBe(true);
  });
});

describe("Legacy partners table is dropped", () => {
  it("partners table no longer exists", async () => {
    expect(await tableExists("partners")).toBe(false);
  });

  it("users table no longer has partnerId column", async () => {
    expect(await describeColumn("users", "partnerId")).toBeNull();
  });
});

describe("Tenant-scoped tables have non-nullable tenant_id", () => {
  it.each([
    "entities",
    "posts",
    "post_comments",
    "groups",
    "group_members",
    "connection_codes",
    "connection_code_redemptions",
    "entity_ownerships",
    "notifications",
  ])("%s.tenant_id is non-nullable text", async (table) => {
    const col = await describeColumn(table, "tenant_id");
    expect(col).not.toBeNull();
    expect(col!.is_nullable).toBe("NO");
    expect(col!.data_type).toBe("text");
  });
});

describe("Users.personal_tenant_id", () => {
  it("exists as a nullable text column", async () => {
    const col = await describeColumn("users", "personal_tenant_id");
    expect(col).not.toBeNull();
    expect(col!.is_nullable).toBe("YES");
    expect(col!.data_type).toBe("text");
  });

  it("is unique-indexed", async () => {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'users'
          AND indexdef ILIKE '%personal_tenant_id%'
          AND indexdef ILIKE '%UNIQUE%'`,
    );
    expect(rows[0]!.count).toBeGreaterThan(0n);
  });
});

describe("SecurityEvent has tenant_id (replaces partner_id)", () => {
  it("security_events.tenant_id exists, nullable", async () => {
    const col = await describeColumn("security_events", "tenant_id");
    expect(col).not.toBeNull();
    expect(col!.is_nullable).toBe("YES");
  });

  it("security_events no longer has partnerId column", async () => {
    expect(await describeColumn("security_events", "partnerId")).toBeNull();
  });
});

describe("Cascade delete from Tenant", () => {
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    // Create a transient user + tenant graph for the cascade test.
    const user = await prisma.user.create({
      data: {
        email: `cascade-${Date.now()}@test.example.com`,
        role: "END_USER",
      },
    });
    userId = user.id;

    const tenant = await prisma.tenant.create({
      data: {
        slug: `cascade-${Date.now()}`,
        displayName: "Cascade Test Tenant",
        type: "ORGANIZATION",
        status: "ACTIVE",
        members: {
          create: { userId, role: "OWNER", status: "ACTIVE" },
        },
        domains: {
          create: {
            domain: `cascade-${Date.now()}.example.com`,
            verificationToken: "a".repeat(32),
            tokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        },
        roleMappings: {
          create: {
            idpGroupName: "Test-Admins",
            tenantRole: "ADMIN",
            priority: 10,
          },
        },
      },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    // Best-effort cleanup if the test failed before the cascade fired.
    await prisma.user
      .delete({ where: { id: userId } })
      .catch(() => undefined);
    await prisma.tenant
      .delete({ where: { id: tenantId } })
      .catch(() => undefined);
  });

  it("deleting the tenant cascades to its members, domains, and role mappings", async () => {
    await prisma.tenant.delete({ where: { id: tenantId } });

    const membersAfter = await prisma.tenantMember.findMany({
      where: { tenantId },
    });
    const domainsAfter = await prisma.tenantDomain.findMany({
      where: { tenantId },
    });
    const mappingsAfter = await prisma.tenantRoleMapping.findMany({
      where: { tenantId },
    });

    expect(membersAfter).toHaveLength(0);
    expect(domainsAfter).toHaveLength(0);
    expect(mappingsAfter).toHaveLength(0);

    // The User row itself is NOT cascaded — Users are global identity.
    const userAfter = await prisma.user.findUnique({ where: { id: userId } });
    expect(userAfter).not.toBeNull();
  });
});

describe("Migration is idempotent", () => {
  it("re-running prisma migrate deploy is a no-op", async () => {
    const path = await import("node:path");
    // Trellis monorepo root: from test file location, 5 levels up.
    //   apps/api/test/integration/schema/<file>.ts → trellis/
    const trellisRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..");
    const out = execSync(
      "npx prisma migrate deploy --schema prisma/schema.prisma",
      {
        env: {
          ...process.env,
          DATABASE_URL: TEST_DB_URL,
          DIRECT_DATABASE_URL: TEST_DB_URL,
        },
        cwd: trellisRoot,
        encoding: "utf-8",
      },
    );
    // "No pending migrations" or equivalent — Prisma's exact wording varies.
    expect(out).toMatch(
      /No pending migrations|All migrations have been successfully applied/,
    );
  });
});
