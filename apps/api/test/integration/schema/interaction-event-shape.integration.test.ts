/**
 * Schema-shape tests for the InteractionEvent table (Surveillance-hardening
 * Phase 0, P1 / E1). Runs against a real Postgres (Docker Compose).
 *
 * Asserts the data-minimization invariants the security review blocks on:
 *   - columns present, no free-text/content column (useless as a content archive)
 *   - `expires_at` NON-NULLABLE (no unbounded behavioral log)
 *   - append-only: no `updated_at`
 *   - the three indexes (actor, reverse-target, pruning)
 *   - `actor_user_id` FK cascades on user delete
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

describe("interaction_events table shape", () => {
  it("table exists", async () => {
    expect(await tableExists(prisma, "interaction_events")).toBe(true);
  });

  it.each([
    ["id", "NO"],
    ["actor_user_id", "NO"],
    ["target_type", "NO"],
    ["target_id", "NO"],
    ["interaction_type", "NO"],
    ["created_at", "NO"],
  ])("column %s exists, non-nullable", async (col, nullable) => {
    const c = await describeColumn(prisma, "interaction_events", col);
    expect(c).not.toBeNull();
    expect(c!.is_nullable).toBe(nullable);
  });

  it("tenant_id is nullable (single-tenant deployments)", async () => {
    const c = await describeColumn(prisma, "interaction_events", "tenant_id");
    expect(c).not.toBeNull();
    expect(c!.is_nullable).toBe("YES");
  });

  it("expires_at is NON-NULLABLE (retention is not optional)", async () => {
    const c = await describeColumn(prisma, "interaction_events", "expires_at");
    expect(c).not.toBeNull();
    expect(c!.is_nullable).toBe("NO");
  });

  it("has NO content/free-text column (not a content archive)", async () => {
    for (const banned of ["content", "body", "text", "payload", "metadata", "details"]) {
      expect(await describeColumn(prisma, "interaction_events", banned)).toBeNull();
    }
  });

  it("is append-only: no updated_at column", async () => {
    expect(await describeColumn(prisma, "interaction_events", "updated_at")).toBeNull();
  });
});

describe("interaction_events indexes", () => {
  it("indexes (actor_user_id, created_at)", async () => {
    expect(
      await hasIndexMatching(prisma, "interaction_events", ["actor_user_id", "created_at"]),
    ).toBe(true);
  });

  it("indexes (target_type, target_id, created_at) for reverse lookup", async () => {
    expect(
      await hasIndexMatching(prisma, "interaction_events", [
        "target_type",
        "target_id",
        "created_at",
      ]),
    ).toBe(true);
  });

  it("indexes expires_at for pruning", async () => {
    expect(await hasIndexMatching(prisma, "interaction_events", ["expires_at"])).toBe(true);
  });
});

describe("interaction_events erasure", () => {
  it("actor_user_id FK cascades on user delete", async () => {
    expect(await fkDeleteAction(prisma, "interaction_events", "actor_user_id")).toBe("CASCADE");
  });

  it("deleting the actor user removes their events", async () => {
    const user = await prisma.user.create({
      data: { email: `ie-cascade-${Date.now()}@test.example.com`, handle: `ie-cascade-${Date.now()}`, role: "END_USER" },
    });
    await prisma.interactionEvent.create({
      data: {
        actorUserId: user.id,
        targetType: "user",
        targetId: "some-other-user",
        interactionType: "profile_visit",
        expiresAt: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000),
      },
    });

    await prisma.user.delete({ where: { id: user.id } });

    const after = await prisma.interactionEvent.findMany({
      where: { actorUserId: user.id },
    });
    expect(after).toHaveLength(0);
  });

  it("rejects an event whose actor user does not exist (FK integrity)", async () => {
    await expect(
      prisma.interactionEvent.create({
        data: {
          actorUserId: "definitely-not-a-real-user-id",
          targetType: "user",
          targetId: "x",
          interactionType: "react",
          expiresAt: new Date(Date.now() + 1000),
        },
      }),
    ).rejects.toThrow();
  });
});
