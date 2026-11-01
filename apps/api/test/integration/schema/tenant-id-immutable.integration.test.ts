/**
 * Schema-shape tests for the tenant_id immutability trigger
 * (prisma/migrations/20261101120000_tenant_id_immutable).
 *
 * 1. Coverage, from the catalog: every table in `public` with a `tenant_id`
 *    column has the enabled `tenant_id_immutable_bu` trigger. A new table
 *    whose migration forgets it fails here.
 * 2. Behaviour, on `events`: changing tenant_id is refused, through Prisma and
 *    raw SQL, even for a row with no children (which no FK would stop);
 *    writing back the same value and updating other columns still work.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB_URL } from "./_schema-helpers.js";

const RUN = `tidimm-${Date.now()}`;
const TENANT_A = `${RUN}-a`;
const TENANT_B = `${RUN}-b`;

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
  });
  await prisma.$connect();
  for (const id of [TENANT_A, TENANT_B]) {
    await prisma.tenant.create({
      data: { id, slug: id, displayName: id, type: "ORGANIZATION" },
    });
  }
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  await prisma.$disconnect();
});

describe("tenant_id immutability trigger: coverage", () => {
  it("is on every table with a tenant_id column, enabled", async () => {
    const rows = await prisma.$queryRawUnsafe<{ table: string; enabled: string | null }[]>(
      `SELECT c.relname AS table, t.tgenabled::text AS enabled
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid
         LEFT JOIN pg_trigger t
           ON t.tgrelid = c.oid AND t.tgname = 'tenant_id_immutable_bu' AND NOT t.tgisinternal
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND a.attname = 'tenant_id'
          AND NOT a.attisdropped
        ORDER BY c.relname`,
    );
    // Guards the query: an empty result would pass the next check vacuously.
    expect(rows.length).toBeGreaterThanOrEqual(45);
    const missing = rows.filter((r) => r.enabled !== "O").map((r) => r.table);
    expect(missing).toEqual([]);
  });
});

describe("tenant_id immutability trigger: behaviour (events)", () => {
  const eventIn = (tenantId: string, n: number) =>
    prisma.event.create({
      data: {
        id: `${RUN}-ev-${n}`,
        tenantId,
        creatorId: `${RUN}-creator`,
        title: "fixture",
        startsAt: new Date("2030-01-01T10:00:00Z"),
      },
    });

  it("refuses moving a row with no children to another tenant, through Prisma", async () => {
    const event = await eventIn(TENANT_A, 1);
    await expect(
      prisma.event.update({ where: { id: event.id }, data: { tenantId: TENANT_B } }),
    ).rejects.toThrow(/tenant_id of a row in events cannot change/);
    const after = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.tenantId).toBe(TENANT_A);
  });

  it("refuses it through raw SQL too", async () => {
    const event = await eventIn(TENANT_A, 2);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE events SET tenant_id = $1 WHERE id = $2`,
        TENANT_B,
        event.id,
      ),
    ).rejects.toThrow(/tenant_id of a row in events cannot change/);
  });

  it("allows writing back the same tenant_id, and updating other columns", async () => {
    const event = await eventIn(TENANT_A, 3);
    const same = await prisma.event.update({
      where: { id: event.id },
      data: { tenantId: TENANT_A, title: "renamed" },
    });
    expect(same).toMatchObject({ tenantId: TENANT_A, title: "renamed" });
  });
});
