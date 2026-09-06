/**
 * Shared introspection helpers for the surveillance-hardening Phase 0 (P1)
 * schema-shape tests. Run against a real Postgres (Docker Compose). The vitest
 * schema config's include glob is `**\/*.test.ts`, so this non-`.test.ts`
 * module is not collected as a suite.
 */

import type { PrismaClient } from "@prisma/client";

export const TEST_DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

/** Ask Postgres for a column's nullability, type, and default expression. */
export async function describeColumn(
  prisma: PrismaClient,
  table: string,
  column: string,
): Promise<{
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
} | null> {
  const rows = await prisma.$queryRawUnsafe<
    { data_type: string; is_nullable: "YES" | "NO"; column_default: string | null }[]
  >(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2`,
    table,
    column,
  );
  return rows[0] ?? null;
}

export async function tableExists(
  prisma: PrismaClient,
  table: string,
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    table,
  );
  return rows[0]!.count > 0n;
}

/** True if at least one index on `table` matches every ILIKE fragment. */
export async function hasIndexMatching(
  prisma: PrismaClient,
  table: string,
  fragments: string[],
): Promise<boolean> {
  const clauses = fragments.map((_, i) => `indexdef ILIKE $${i + 2}`).join(" AND ");
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count
       FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1 AND ${clauses}`,
    table,
    ...fragments.map((f) => `%${f}%`),
  );
  return rows[0]!.count > 0n;
}

/** Resolve the ON DELETE action for a single-column FK. */
export async function fkDeleteAction(
  prisma: PrismaClient,
  table: string,
  column: string,
): Promise<string | null> {
  // confdeltype is Postgres's internal single-byte "char" type. The Prisma 7
  // PrismaPg (pg) driver adapter cannot deserialize that type, so cast it to
  // text — the value is still a single character (a/r/c/n/d).
  const rows = await prisma.$queryRawUnsafe<{ confdeltype: string }[]>(
    `SELECT c.confdeltype::text AS confdeltype
       FROM pg_constraint c
       JOIN pg_class t   ON t.oid = c.conrelid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f'
        AND t.relname = $1
        AND a.attname = $2`,
    table,
    column,
  );
  // confdeltype: a=NO ACTION, r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT
  const map: Record<string, string> = {
    a: "NO ACTION",
    r: "RESTRICT",
    c: "CASCADE",
    n: "SET NULL",
    d: "SET DEFAULT",
  };
  const code = rows[0]?.confdeltype;
  return code ? (map[code] ?? code) : null;
}
