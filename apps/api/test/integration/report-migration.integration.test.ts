/**
 * Integration tests for the LinkReport → Report fold-in (Surveillance-hardening
 * Phase 0, P4) against a real Postgres (Docker Compose).
 *
 * Verifies the table swap, that the domain-count query DomainReputationService
 * uses for the auto-block threshold works on the new model, and GDPR erasure
 * (reporter cascade + ACCOUNT-report pseudonymization).
 *
 * Runs via `npm run test:integration:ci` (curated Phase-0 lane, CI job from P1).
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteUserData } from "../../src/lib/services/user-data-deletion.js";

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

let prisma: PrismaClient;

async function makeUser(tag: string): Promise<string> {
  const u = await prisma.user.create({
    data: { email: `report-itest-${tag}-${Date.now()}-${Math.random()}@test.example.com`, handle: `report-itest-${tag}-${Date.now()}-${Math.random()}`, role: "END_USER" },
  });
  return u.id;
}

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
  });
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("LinkReport fold-in schema", () => {
  it("dropped the link_reports table", async () => {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM information_schema.tables
        WHERE table_schema='public' AND table_name='link_reports'`,
    );
    expect(rows[0]!.count).toBe(0n);
  });

  it("reports.domain exists and is indexed", async () => {
    const col = await prisma.$queryRawUnsafe<{ is_nullable: string }[]>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='reports' AND column_name='domain'`,
    );
    expect(col[0]!.is_nullable).toBe("YES");
    const idx = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM pg_indexes
        WHERE tablename='reports' AND indexdef ILIKE '%domain%'`,
    );
    expect(idx[0]!.count).toBeGreaterThan(0n);
  });
});

describe("LINK report auto-block counting (real Postgres)", () => {
  it("counts pending/reviewed LINK reports by domain (the shouldAutoBlock query)", async () => {
    const reporter = await makeUser("counter");
    const domain = `bad-${Date.now()}.example`;

    await prisma.report.createMany({
      data: [
        { reportType: "LINK", resourceType: "url", resourceId: `https://${domain}/a`, reporterUserId: reporter, domain, status: "pending" },
        { reportType: "LINK", resourceType: "url", resourceId: `https://${domain}/b`, reporterUserId: reporter, domain, status: "reviewed" },
        { reportType: "LINK", resourceType: "url", resourceId: `https://${domain}/c`, reporterUserId: reporter, domain, status: "approved" },
      ],
    });

    const count = await prisma.report.count({
      where: { reportType: "LINK", domain, status: { in: ["pending", "reviewed"] } },
    });
    expect(count).toBe(2);

    await prisma.report.deleteMany({ where: { domain } });
    await prisma.user.delete({ where: { id: reporter } });
  });
});

describe("Report erasure (GDPR Art. 17, P4)", () => {
  it("cascades reports filed BY a deleted user and pseudonymizes ACCOUNT reports ABOUT them", async () => {
    const subject = await makeUser("subject");
    const reporter = await makeUser("reporter");

    // A report FILED BY the subject (cascades on user.delete).
    await prisma.report.create({
      data: { reportType: "LINK", resourceType: "url", resourceId: "https://x.example", reporterUserId: subject, domain: "x.example", status: "pending" },
    });
    // An ACCOUNT report ABOUT the subject (resourceId must be pseudonymized).
    await prisma.report.create({
      data: { reportType: "ACCOUNT", resourceType: "user", resourceId: subject, reporterUserId: reporter, status: "pending" },
    });

    const result = await deleteUserData(prisma, subject);
    expect(result.accountReportsPseudonymized).toBe(1);

    // Filed-by-subject reports are gone (reporter cascade).
    const filedBySubject = await prisma.report.count({ where: { reporterUserId: subject } });
    expect(filedBySubject).toBe(0);

    // The ACCOUNT report survives but no longer carries the plaintext id —
    // it now holds a keyed tombstone (the key is resolved at runtime).
    const plaintext = await prisma.report.count({ where: { resourceId: subject } });
    expect(plaintext).toBe(0);
    const tombstoned = await prisma.report.count({
      where: { reportType: "ACCOUNT", resourceId: { startsWith: "deleted:" } },
    });
    expect(tombstoned).toBe(1);

    // cleanup
    await prisma.report.deleteMany({ where: { reporterUserId: reporter } });
    await prisma.user.delete({ where: { id: reporter } });
  });
});
