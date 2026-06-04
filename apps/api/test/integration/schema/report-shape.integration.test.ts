/**
 * Schema-shape tests for the generalized Report table (Surveillance-hardening
 * Phase 0, P1 / E3). Runs against a real Postgres (Docker Compose).
 *
 * Asserts:
 *   - discriminator (report_type enum) + polymorphic fields (resource_type,
 *     resource_id) present
 *   - queue-ready fields (assignee, resolved_at, resolution) nullable + unused
 *   - resource_id has NO FK (opaque; reported resource may be deleted)
 *   - reporter_user_id FK cascades on reporter delete
 *   - the three indexes
 *
 * Reference: plans/surveillance-hardening-phase0/01-schema-enablers.md
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  describeColumn,
  fkDeleteAction,
  hasIndexMatching,
  tableExists,
  TEST_DB_URL,
} from "./_schema-helpers";

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

describe("reports table shape", () => {
  it("table exists", async () => {
    expect(await tableExists(prisma, "reports")).toBe(true);
  });

  it.each(["report_type", "resource_type", "resource_id", "reporter_user_id", "status", "created_at"])(
    "column %s exists, non-nullable",
    async (col) => {
      const c = await describeColumn(prisma, "reports", col);
      expect(c).not.toBeNull();
      expect(c!.is_nullable).toBe("NO");
    },
  );

  it("report_type is the ReportType enum", async () => {
    const c = await describeColumn(prisma, "reports", "report_type");
    expect(c!.data_type).toBe("USER-DEFINED");
  });

  it.each(["reason", "assignee_user_id", "resolved_at", "resolution"])(
    "queue/optional field %s is nullable",
    async (col) => {
      const c = await describeColumn(prisma, "reports", col);
      expect(c).not.toBeNull();
      expect(c!.is_nullable).toBe("YES");
    },
  );
});

describe("reports indexes", () => {
  it("indexes (report_type, status)", async () => {
    expect(await hasIndexMatching(prisma, "reports", ["report_type", "status"])).toBe(true);
  });
  it("indexes (resource_type, resource_id)", async () => {
    expect(await hasIndexMatching(prisma, "reports", ["resource_type", "resource_id"])).toBe(true);
  });
  it("indexes (reporter_user_id)", async () => {
    expect(await hasIndexMatching(prisma, "reports", ["reporter_user_id"])).toBe(true);
  });
});

describe("reports erasure", () => {
  it("reporter_user_id FK cascades on reporter delete", async () => {
    expect(await fkDeleteAction(prisma, "reports", "reporter_user_id")).toBe("CASCADE");
  });

  it("resource_id has NO foreign key (opaque, reported resource may be deleted)", async () => {
    // assignee_user_id and resource_id must both be FK-free.
    expect(await fkDeleteAction(prisma, "reports", "resource_id")).toBeNull();
    expect(await fkDeleteAction(prisma, "reports", "assignee_user_id")).toBeNull();
  });

  it("deleting the reporter removes their reports (cascade)", async () => {
    const user = await prisma.user.create({
      data: { email: `rep-cascade-${Date.now()}@test.example.com`, role: "END_USER" },
    });
    await prisma.report.create({
      data: {
        reportType: "LINK",
        resourceType: "url",
        resourceId: "https://example.com/bad",
        reporterUserId: user.id,
      },
    });

    await prisma.user.delete({ where: { id: user.id } });

    const after = await prisma.report.findMany({ where: { reporterUserId: user.id } });
    expect(after).toHaveLength(0);
  });

  it("rejects a report whose reporter does not exist (FK integrity)", async () => {
    await expect(
      prisma.report.create({
        data: {
          reportType: "ACCOUNT",
          resourceType: "user",
          resourceId: "pseudonymized-x",
          reporterUserId: "definitely-not-a-real-user-id",
        },
      }),
    ).rejects.toThrow();
  });
});
