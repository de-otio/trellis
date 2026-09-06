/**
 * Schema-shape tests for the three tables added by the compliance plan 08
 * Phase 1/2 hand-rewritten migrations (alpha.15 wave):
 *
 *   - `report_categories`    (20260904090000_compliance_report_categories)
 *   - `statements_of_reasons` (20260904090100_compliance_enforcement_sor_authority)
 *   - `authority_reports`     (20260904090100_compliance_enforcement_sor_authority)
 *
 * Both migrations were hand-pruned of the spurious GiST/GIN/trgm DROP INDEXes
 * `prisma migrate dev` emits and rewritten for squawk (see the migrations'
 * own headers). `report-shape.integration.test.ts` pins the pre-existing
 * `reports` table against the same drift; this is its sibling for the new
 * tables, closing the alpha.15 quality-sweep A5 finding: without a shape
 * test here, a hand-edit that drifts from `prisma/schema.prisma` (a missing
 * NOT NULL, a missing index, a wrong default) has no safety net.
 *
 * Runs against a real Postgres (Docker Compose) — see `report-shape.
 * integration.test.ts` for the same setup.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeColumn, hasIndexMatching, tableExists, TEST_DB_URL } from "./_schema-helpers";

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
  });
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("report_categories table shape", () => {
  it("table exists", async () => {
    expect(await tableExists(prisma, "report_categories")).toBe(true);
  });

  it.each(["key", "routing_class", "labels", "active", "sort_order", "created_at", "updated_at"])(
    "column %s exists, non-nullable",
    async (col) => {
      const c = await describeColumn(prisma, "report_categories", col);
      expect(c).not.toBeNull();
      expect(c!.is_nullable).toBe("NO");
    },
  );

  it("routing_class is the RoutingClass enum", async () => {
    const c = await describeColumn(prisma, "report_categories", "routing_class");
    expect(c!.data_type).toBe("USER-DEFINED");
  });

  it("active defaults to true", async () => {
    const c = await describeColumn(prisma, "report_categories", "active");
    expect(c!.column_default).toMatch(/^true$/);
  });

  it("sort_order defaults to 0", async () => {
    const c = await describeColumn(prisma, "report_categories", "sort_order");
    expect(c!.column_default).toMatch(/^0$/);
  });

  // The picker query in `handleListCategories` orders on `(sortOrder, key)`
  // after filtering `active=true` — losing this index is a hot-path
  // regression the migration's own comment calls out as the reason it isn't
  // CONCURRENTLY (created inside the same transaction as the table, so
  // nothing else can be blocking it yet).
  it("indexes (active, sort_order)", async () => {
    expect(await hasIndexMatching(prisma, "report_categories", ["active", "sort_order"])).toBe(
      true,
    );
  });
});

describe("statements_of_reasons table shape", () => {
  it("table exists", async () => {
    expect(await tableExists(prisma, "statements_of_reasons")).toBe(true);
  });

  it.each([
    "id",
    "affected_user_id",
    "resource_type",
    "resource_id",
    "restriction",
    "template_key",
    "created_at",
  ])("column %s exists, non-nullable", async (col) => {
    const c = await describeColumn(prisma, "statements_of_reasons", col);
    expect(c).not.toBeNull();
    expect(c!.is_nullable).toBe("NO");
  });

  it.each(["params", "suppress_reason"])("optional field %s is nullable", async (col) => {
    const c = await describeColumn(prisma, "statements_of_reasons", col);
    expect(c).not.toBeNull();
    expect(c!.is_nullable).toBe("YES");
  });

  // `suppressed` is the non-tip-off carve-out flag (written, not delivered).
  // Prisma maps it with `@map("suppressed")` — the column name IS the
  // contract; a rename (e.g. to `is_suppressed`) would compile in
  // schema.prisma and fail only at runtime.
  it("suppressed column exists (matches the Prisma @map), non-nullable, defaults to false", async () => {
    const c = await describeColumn(prisma, "statements_of_reasons", "suppressed");
    expect(c).not.toBeNull();
    expect(c!.is_nullable).toBe("NO");
    expect(c!.column_default).toMatch(/^false$/);
  });

  it("indexes (affected_user_id)", async () => {
    expect(await hasIndexMatching(prisma, "statements_of_reasons", ["affected_user_id"])).toBe(
      true,
    );
  });
});

describe("authority_reports table shape", () => {
  it("table exists", async () => {
    expect(await tableExists(prisma, "authority_reports")).toBe(true);
  });

  it.each(["id", "jurisdiction", "status", "bundle", "created_at"])(
    "column %s exists, non-nullable",
    async (col) => {
      const c = await describeColumn(prisma, "authority_reports", col);
      expect(c).not.toBeNull();
      expect(c!.is_nullable).toBe("NO");
    },
  );

  it.each(["channel_mode", "evidence_id", "submitted_at", "closed_at"])(
    "optional field %s is nullable",
    async (col) => {
      const c = await describeColumn(prisma, "authority_reports", col);
      expect(c).not.toBeNull();
      expect(c!.is_nullable).toBe("YES");
    },
  );

  // The whole point of this table is that a report is created `pending` and
  // is NEVER auto-submitted — an operator confirms and files (see
  // `markAuthorityReportSubmitted`, compliance plan 08 §2.6 / M3). A DEFAULT
  // accidentally re-typed as `'submitted'` would let the human-gate be
  // silently bypassed at row birth, with every existing test (which supplies
  // `status` explicitly on create) staying green.
  it("status defaults to 'pending', never to a submitted/closed state", async () => {
    const c = await describeColumn(prisma, "authority_reports", "status");
    expect(c!.column_default).toMatch(/^'pending'::text$/);
  });

  it("indexes (status)", async () => {
    expect(await hasIndexMatching(prisma, "authority_reports", ["status"])).toBe(true);
  });
});
