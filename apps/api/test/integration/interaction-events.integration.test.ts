/**
 * Integration tests for InteractionEvent capture (Surveillance-hardening
 * Phase 0, P2) against a real Postgres (Docker Compose). Exercises the dual-
 * write through the helper, the batched prune, and target-side GDPR erasure.
 *
 * Runs via `npm run test:integration:ci` (curated Phase-0 lane, CI job from P1).
 */

import { PrismaClient } from "@prisma/client";
import { runWithTenantContext, type TenantId } from "@de-otio/saas-foundation/tenant";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InteractionEventOps,
  DEFAULT_INTERACTION_EVENT_CONFIG,
} from "../../src/lib/graph/postgres/interaction-events.js";
import { deleteUserData } from "../../src/lib/services/user-data-deletion.js";

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";
const TENANT = "tenant-ie-itest" as TenantId;

let prisma: PrismaClient;

async function makeUser(tag: string): Promise<string> {
  const u = await prisma.user.create({
    data: { email: `ie-itest-${tag}-${Date.now()}-${Math.random()}@test.example.com`, role: "END_USER" },
  });
  return u.id;
}

beforeAll(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("InteractionEvent dual-write (real Postgres)", () => {
  it("persists a row with the actor, target, type, tenant and a bounded expiresAt", async () => {
    const actor = await makeUser("actor");
    const ops = new InteractionEventOps(prisma, DEFAULT_INTERACTION_EVENT_CONFIG);

    await runWithTenantContext(TENANT, () =>
      ops.record({ userId: actor, targetType: "user", targetId: "tgt-1", interactionType: "comment" }),
    );

    const rows = await prisma.interactionEvent.findMany({ where: { actorUserId: actor } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.interactionType).toBe("comment");
    expect(rows[0]!.tenantId).toBe(TENANT);
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await prisma.interactionEvent.deleteMany({ where: { actorUserId: actor } });
    await prisma.user.delete({ where: { id: actor } });
  });

  it("skips an unsampled `view` (volume guard) — no row", async () => {
    const actor = await makeUser("view");
    const ops = new InteractionEventOps(prisma, { ...DEFAULT_INTERACTION_EVENT_CONFIG, viewSampleRate: 0 });

    await runWithTenantContext(TENANT, () =>
      ops.record({ userId: actor, targetType: "user", targetId: "tgt-1", interactionType: "view" }),
    );

    expect(await prisma.interactionEvent.count({ where: { actorUserId: actor } })).toBe(0);
    await prisma.user.delete({ where: { id: actor } });
  });
});

describe("InteractionEvent prune (real Postgres)", () => {
  it("deletes expired rows in batches and leaves unexpired rows", async () => {
    const actor = await makeUser("prune");
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    // Two expired, one live.
    await prisma.interactionEvent.createMany({
      data: [
        { actorUserId: actor, targetType: "user", targetId: "x", interactionType: "react", expiresAt: past },
        { actorUserId: actor, targetType: "user", targetId: "y", interactionType: "share", expiresAt: past },
        { actorUserId: actor, targetType: "user", targetId: "z", interactionType: "comment", expiresAt: future },
      ],
    });

    const ops = new InteractionEventOps(prisma, {
      ...DEFAULT_INTERACTION_EVENT_CONFIG,
      pruneBatchSize: 1, // force multiple batches
      pruneMaxIterations: 100,
    });
    const res = await ops.prune(new Date());

    expect(res.deleted).toBe(2);
    expect(res.circuitBreakerTripped).toBe(false);
    const remaining = await prisma.interactionEvent.findMany({ where: { actorUserId: actor } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.targetId).toBe("z");

    await prisma.interactionEvent.deleteMany({ where: { actorUserId: actor } });
    await prisma.user.delete({ where: { id: actor } });
  });
});

describe("InteractionEvent erasure (GDPR Art. 17, P2)", () => {
  it("after deleteUserData, no row references the user as actor OR target", async () => {
    const subject = await makeUser("subject");
    const other = await makeUser("other");
    const expiresAt = new Date(Date.now() + 86_400_000);

    await prisma.interactionEvent.createMany({
      data: [
        // subject as ACTOR (cascades on user.delete)
        { actorUserId: subject, targetType: "user", targetId: other, interactionType: "react", expiresAt },
        // subject as TARGET (no FK — needs explicit deleteMany)
        { actorUserId: other, targetType: "user", targetId: subject, interactionType: "profile_visit", expiresAt },
      ],
    });

    const result = await deleteUserData(prisma, subject);
    expect(result.interactionEventsAsTarget).toBe(1);

    const asActor = await prisma.interactionEvent.count({ where: { actorUserId: subject } });
    const asTarget = await prisma.interactionEvent.count({ where: { targetType: "user", targetId: subject } });
    expect(asActor).toBe(0);
    expect(asTarget).toBe(0);

    // cleanup
    await prisma.interactionEvent.deleteMany({ where: { OR: [{ actorUserId: other }, { targetId: other }] } });
    await prisma.user.delete({ where: { id: other } });
  });
});
