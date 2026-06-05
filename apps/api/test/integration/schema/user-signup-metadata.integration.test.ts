/**
 * Schema-shape tests for User signup-metadata columns + the SecurityEvent
 * retention tightening (Surveillance-hardening Phase 0, P1 / E2 + E-retention).
 * Runs against a real Postgres (Docker Compose).
 *
 * Asserts:
 *   - users.signup_method (nullable enum) and users.invitation_id (nullable)
 *   - NO ip/ua columns on users (client signals go to SecurityEvent only)
 *   - invitation_id FK resolves to a real invitation
 *   - security_events.retention_until is NON-NULLABLE after this migration
 *
 * Reference: plans/surveillance-hardening-phase0/01-schema-enablers.md
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeColumn, fkDeleteAction, TEST_DB_URL } from "./_schema-helpers";

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

describe("users signup-metadata columns", () => {
  it("signup_method exists, nullable, enum-typed", async () => {
    const c = await describeColumn(prisma, "users", "signup_method");
    expect(c).not.toBeNull();
    expect(c!.is_nullable).toBe("YES");
    expect(c!.data_type).toBe("USER-DEFINED");
  });

  it("invitation_id exists, nullable text", async () => {
    const c = await describeColumn(prisma, "users", "invitation_id");
    expect(c).not.toBeNull();
    expect(c!.is_nullable).toBe("YES");
    expect(c!.data_type).toBe("text");
  });

  it("has NO raw ip/ua columns (client signals belong on SecurityEvent)", async () => {
    for (const banned of ["ip_address", "user_agent", "ip", "ua"]) {
      expect(await describeColumn(prisma, "users", banned)).toBeNull();
    }
  });

  it("invitation_id FK is SET NULL on invitation delete (account survives)", async () => {
    expect(await fkDeleteAction(prisma, "users", "invitation_id")).toBe("SET NULL");
  });
});

describe("users.invitation_id FK integrity", () => {
  it("links a user to the invitation they redeemed", async () => {
    const inviter = await prisma.user.create({
      data: { email: `inviter-${Date.now()}@test.example.com`, role: "END_USER" },
    });
    const invitation = await prisma.invitation.create({
      data: { code: `code-${Date.now()}`, createdBy: inviter.id },
    });
    const invitee = await prisma.user.create({
      data: {
        email: `invitee-${Date.now()}@test.example.com`,
        role: "END_USER",
        signupMethod: "INVITE",
        invitationId: invitation.id,
      },
    });

    const loaded = await prisma.user.findUnique({
      where: { id: invitee.id },
      include: { signupInvitation: true },
    });
    expect(loaded!.signupMethod).toBe("INVITE");
    expect(loaded!.signupInvitation!.id).toBe(invitation.id);

    await prisma.user.delete({ where: { id: invitee.id } });
    await prisma.invitation.delete({ where: { id: invitation.id } });
    await prisma.user.delete({ where: { id: inviter.id } });
  });

  it("rejects a non-existent invitation_id (FK integrity)", async () => {
    await expect(
      prisma.user.create({
        data: {
          email: `bad-inv-${Date.now()}@test.example.com`,
          role: "END_USER",
          invitationId: "definitely-not-a-real-invitation",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("security_events.retention_until tightening", () => {
  it("is NON-NULLABLE (no row may escape hourly-cron pruning)", async () => {
    const c = await describeColumn(prisma, "security_events", "retention_until");
    expect(c).not.toBeNull();
    expect(c!.is_nullable).toBe("NO");
  });

  it("rejects an insert that omits retention_until", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO security_events (id, type, severity, details, timestamp)
         VALUES ('se-no-ret-${Date.now()}', 'test', 'low', '{}', now())`,
      ),
    ).rejects.toThrow();
  });
});
