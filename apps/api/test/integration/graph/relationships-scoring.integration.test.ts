/**
 * Integration Tests: PostgresGraphService — RelationshipOps + ScoringOps
 *
 * The unit suites mock Prisma, so the SQL these adapters emit (the
 * set-based `UPDATE … FROM unnest` score sweep, the per-user edge-cap count,
 * the reciprocity transaction) is only proven here, against a live Postgres.
 * AR8 additions covered: composite (score, targetId) keyset pagination over
 * tied scores, the per-user edge cap, and end-state equality of the unnest
 * score write with the scoring engine's math.
 *
 * Opt-in: set DATABASE_URL (or TEST_DB_URL via the graph-lane config) to a
 * Postgres database carrying the trellis schema. Skipped otherwise so the
 * default unit run needs no database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runWithTenantContext, tenantId } from "@de-otio/saas-foundation/tenant";
import {
  RelationshipOps,
} from "../../../src/lib/graph/postgres/relationships.js";
import { ScoringOps } from "../../../src/lib/graph/postgres/scoring.js";
import { GraphConflictError } from "../../../src/lib/graph/errors.js";
import {
  computeScore,
  scoreToTier,
} from "../../../src/lib/graph/scoring-engine.js";

const TEST_DB_URL = process.env.DATABASE_URL ?? process.env.TEST_DB_URL;
const suite = TEST_DB_URL ? describe : describe.skip;

const TENANT = "t-relscore-itest";
const VIEWER = "rs-viewer";
const CAP_USER = "rs-cap-user";
const FRIEND = "rs-friend";

suite("RelationshipOps + ScoringOps (live Postgres)", () => {
  let prisma: PrismaClient;
  let ops: RelationshipOps;
  let scoring: ScoringOps;

  async function wipe() {
    await prisma.interactionEvent.deleteMany({
      where: { actorUserId: { in: [VIEWER, CAP_USER, FRIEND] } },
    });
    await prisma.relationship.deleteMany({ where: { tenantId: TENANT } });
    await prisma.entityOwnership.deleteMany({ where: { tenantId: TENANT } });
    await prisma.entity.deleteMany({ where: { tenantId: TENANT } });
    await prisma.user.deleteMany({
      where: { id: { in: [VIEWER, CAP_USER, FRIEND] } },
    });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DB_URL! }),
    });
    ops = new RelationshipOps(prisma);
    scoring = new ScoringOps(prisma);

    await wipe();
    await prisma.tenant.create({
      data: { id: TENANT, slug: TENANT, displayName: TENANT, type: "ORGANIZATION" },
    });
    for (const id of [VIEWER, CAP_USER, FRIEND]) {
      await prisma.user.create({
        data: { id, email: `${id}@example.com`, handle: id },
      });
    }
    // Entities the viewer will relate to / own.
    for (const e of ["rs-e1", "rs-e2", "rs-e3", "rs-e4", "rs-e5", "rs-owned"]) {
      await prisma.entity.create({
        data: { id: e, tenantId: TENANT, name: e, entityType: "dog" },
      });
    }
    await prisma.entityOwnership.create({
      data: {
        tenantId: TENANT,
        entityId: "rs-owned",
        userId: VIEWER,
        role: "PRIMARY_OWNER",
        addedByUserId: VIEWER,
        status: "ACTIVE",
      },
    });
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  const run = <T,>(fn: () => Promise<T>) =>
    runWithTenantContext(tenantId(TENANT), fn);

  it("createRelationship: initial score by method, reciprocity flips both edges, idempotent re-create", async () => {
    const fwd = await run(() =>
      ops.createRelationship({
        userId: VIEWER,
        targetType: "user",
        targetId: FRIEND,
        connectionMethod: "code",
      }),
    );
    expect(fwd.score).toBe(0.7); // code bonus
    expect(fwd.reciprocated).toBe(false);

    const rev = await run(() =>
      ops.createRelationship({
        userId: FRIEND,
        targetType: "user",
        targetId: VIEWER,
        connectionMethod: "code",
      }),
    );
    expect(rev.reciprocated).toBe(true);
    // The forward edge was flipped too (read back from the DB).
    const fwdAfter = await run(() =>
      ops.getRelationship(VIEWER, "user", FRIEND),
    );
    expect(fwdAfter?.reciprocated).toBe(true);

    // Idempotent: re-creating returns the existing edge unchanged.
    const again = await run(() =>
      ops.createRelationship({
        userId: VIEWER,
        targetType: "user",
        targetId: FRIEND,
        connectionMethod: "discovery", // different method must NOT overwrite
      }),
    );
    expect(again.connectionMethod).toBe("code");
    expect(again.score).toBe(0.7);
  });

  it("enforces the per-user edge cap with GraphConflictError (409 path), existing edges still readable", async () => {
    const capped = new RelationshipOps(prisma, 2); // tiny cap for the test
    await run(() =>
      capped.createRelationship({
        userId: CAP_USER,
        targetType: "entity",
        targetId: "rs-e1",
      }),
    );
    await run(() =>
      capped.createRelationship({
        userId: CAP_USER,
        targetType: "entity",
        targetId: "rs-e2",
      }),
    );
    await expect(
      run(() =>
        capped.createRelationship({
          userId: CAP_USER,
          targetType: "entity",
          targetId: "rs-e3",
        }),
      ),
    ).rejects.toThrow(GraphConflictError);
    // Idempotent read-back of an existing edge is exempt from the cap.
    const existing = await run(() =>
      capped.createRelationship({
        userId: CAP_USER,
        targetType: "entity",
        targetId: "rs-e1",
      }),
    );
    expect(existing.targetId).toBe("rs-e1");
    // Exactly 2 edges persisted.
    const count = await prisma.relationship.count({
      where: { tenantId: TENANT, userId: CAP_USER },
    });
    expect(count).toBe(2);
  });

  it("getRelationships: composite keyset cursor enumerates tied scores completely", async () => {
    // Five tied edges (discovery → 0.3) for the viewer + the 0.7 friend edge.
    for (const e of ["rs-e1", "rs-e2", "rs-e3", "rs-e4", "rs-e5"]) {
      await run(() =>
        ops.createRelationship({
          userId: VIEWER,
          targetType: "entity",
          targetId: e,
        }),
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await run(() =>
        ops.getRelationships(VIEWER, {
          pagination: { limit: 2, cursor },
        }),
      );
      seen.push(...page.items.map((i) => i.targetId));
      cursor = page.cursor ?? undefined;
      pages++;
      expect(pages).toBeLessThan(10); // circuit breaker
    } while (cursor);

    // All 6 edges enumerated exactly once, score-desc, ties broken by id.
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect(seen[0]).toBe(FRIEND); // 0.7 first
    expect(seen.slice(1)).toEqual(["rs-e1", "rs-e2", "rs-e3", "rs-e4", "rs-e5"]);
  });

  it("recordInteraction bumps counters; recomputeScores writes engine math via one set-based UPDATE", async () => {
    await run(() =>
      scoring.recordInteraction({
        userId: VIEWER,
        targetType: "user",
        targetId: FRIEND,
        interactionType: "comment",
      }),
    );
    const bumped = await prisma.relationship.findFirstOrThrow({
      where: { tenantId: TENANT, userId: VIEWER, targetId: FRIEND },
    });
    expect(bumped.interactionCount).toBe(1);
    expect(bumped.lastInteractionAt).not.toBeNull();
    expect((bumped.signals as Record<string, number>).comment).toBe(1);

    const before = await prisma.relationship.findMany({
      where: { tenantId: TENANT, userId: VIEWER },
    });
    const now = new Date();
    await run(() => scoring.recomputeScores(VIEWER));
    const after = await prisma.relationship.findMany({
      where: { tenantId: TENANT, userId: VIEWER },
    });

    // Every row's persisted (computed_score, tier) matches the engine, and
    // updated_at was bumped by the unnest write (matches @updatedAt).
    expect(after).toHaveLength(before.length);
    for (const row of after) {
      const prev = before.find((r) => r.id === row.id)!;
      const expected = computeScore({
        targetType: row.targetType as "user" | "entity",
        connectionMethod: (row.connectionMethod ?? "discovery") as never,
        interactionCount: row.interactionCount,
        interactionsByType: {
          view: 0,
          react: 0,
          comment: (row.signals as Record<string, number> | null)?.comment ?? 0,
          share: 0,
          depth_mode: 0,
          profile_visit: 0,
          content_creation: 0,
        },
        lastInteractionAt: row.lastInteractionAt,
        reciprocated: row.targetType === "user" ? row.reciprocated : false,
        createdAt: row.createdAt,
        manualScore: row.manualScore,
        isOwned: false, // none of the related targets is owned by VIEWER
        ownerScore: null,
        now,
      });
      // The engine's decay factor uses `now` twice (test vs adapter call) —
      // sub-second drift; scores must agree to a fine tolerance.
      expect(Math.abs(row.computedScore - expected)).toBeLessThan(1e-6);
      expect(row.tier).toBe(scoreToTier(row.manualScore ?? row.computedScore));
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(
        prev.updatedAt.getTime(),
      );
    }
  });

  it("recordInteraction is a no-op without a relationship row or tenant context", async () => {
    // No relationship VIEWER→rs-owned exists: nothing to bump, no throw.
    await run(() =>
      scoring.recordInteraction({
        userId: VIEWER,
        targetType: "entity",
        targetId: "rs-owned",
        interactionType: "react",
      }),
    );
    expect(
      await prisma.relationship.findFirst({
        where: { tenantId: TENANT, userId: VIEWER, targetId: "rs-owned" },
      }),
    ).toBeNull();

    // No tenant context: returns without touching relationships.
    await scoring.recordInteraction({
      userId: VIEWER,
      targetType: "user",
      targetId: FRIEND,
      interactionType: "react",
    });
    const friendEdge = await prisma.relationship.findFirstOrThrow({
      where: { tenantId: TENANT, userId: VIEWER, targetId: FRIEND },
    });
    expect((friendEdge.signals as Record<string, number> | null)?.react ?? 0).toBe(0);
  });

  it("recompute folds owner-proximity in for entities owned by a related user", async () => {
    // FRIEND becomes an active owner of rs-e2; the viewer relates to both
    // rs-e2 and FRIEND, so the owner-proximity averaging path runs.
    await prisma.entityOwnership.create({
      data: {
        tenantId: TENANT,
        entityId: "rs-e2",
        userId: FRIEND,
        role: "PRIMARY_OWNER",
        addedByUserId: FRIEND,
        status: "ACTIVE",
      },
    });

    const friendEdge = await prisma.relationship.findFirstOrThrow({
      where: { tenantId: TENANT, userId: VIEWER, targetType: "user", targetId: FRIEND },
    });
    const e2Before = await prisma.relationship.findFirstOrThrow({
      where: { tenantId: TENANT, userId: VIEWER, targetId: "rs-e2" },
    });

    const now = new Date();
    await run(() => scoring.recomputeScores(VIEWER));

    const e2After = await prisma.relationship.findFirstOrThrow({
      where: { tenantId: TENANT, userId: VIEWER, targetId: "rs-e2" },
    });
    const expected = computeScore({
      targetType: "entity",
      connectionMethod: (e2Before.connectionMethod ?? "discovery") as never,
      interactionCount: e2Before.interactionCount,
      interactionsByType: {
        view: 0,
        react: 0,
        comment: 0,
        share: 0,
        depth_mode: 0,
        profile_visit: 0,
        content_creation: 0,
      },
      lastInteractionAt: e2Before.lastInteractionAt,
      reciprocated: false,
      createdAt: e2Before.createdAt,
      manualScore: e2Before.manualScore,
      isOwned: false,
      ownerScore: friendEdge.computedScore, // single other owner → its score
      now,
    });
    expect(Math.abs(e2After.computedScore - expected)).toBeLessThan(1e-6);
  });

  it("applyDecay decays stale edges and reports tier drops; edges without interactions are skipped", async () => {
    // Age the friend edge's lastInteractionAt far into the past and raise its
    // score so decay visibly drops the tier.
    await prisma.relationship.updateMany({
      where: { tenantId: TENANT, userId: VIEWER, targetId: FRIEND },
      data: {
        computedScore: 0.9,
        tier: 0,
        lastInteractionAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
      },
    });

    // rs-e1 has lastInteractionAt = null → must not be touched by decay
    // (its score reflects the earlier recompute sweep, so snapshot it).
    const e1Before = await prisma.relationship.findFirstOrThrow({
      where: { tenantId: TENANT, userId: VIEWER, targetId: "rs-e1" },
    });

    const updates = await run(() => scoring.applyDecay(VIEWER));
    const friendUpdate = updates.find((u) => u.targetId === FRIEND);
    expect(friendUpdate).toBeDefined();
    expect(friendUpdate!.newScore).toBeLessThan(0.9);
    expect(friendUpdate!.newTier).toBeGreaterThan(0);

    // Edges with lastInteractionAt = null were not touched.
    const e1After = await prisma.relationship.findFirstOrThrow({
      where: { tenantId: TENANT, userId: VIEWER, targetId: "rs-e1" },
    });
    expect(e1After.computedScore).toBe(e1Before.computedScore);
    expect(e1After.updatedAt).toEqual(e1Before.updatedAt);
  });

  it("updateRelationshipScore sets/clears the manual override; removeRelationship clears reciprocity", async () => {
    const overridden = await run(() =>
      ops.updateRelationshipScore({
        userId: VIEWER,
        targetType: "entity",
        targetId: "rs-e1",
        manualScore: 0.95,
      }),
    );
    expect(overridden.manualScore).toBe(0.95);
    expect(overridden.score).toBe(0.95);
    expect(overridden.tier).toBe(0);

    const cleared = await run(() =>
      ops.updateRelationshipScore({
        userId: VIEWER,
        targetType: "entity",
        targetId: "rs-e1",
        manualScore: null,
      }),
    );
    expect(cleared.manualScore).toBeNull();

    // Removing the reciprocated user edge clears the reverse flag.
    await run(() => ops.removeRelationship(VIEWER, "user", FRIEND));
    const reverse = await prisma.relationship.findFirstOrThrow({
      where: { tenantId: TENANT, userId: FRIEND, targetId: VIEWER },
    });
    expect(reverse.reciprocated).toBe(false);
    expect(await run(() => ops.getRelationship(VIEWER, "user", FRIEND))).toBeNull();
  });

  it("getRelationshipGraph coarsens closeness and never exposes raw scores", async () => {
    const graph = await run(() => ops.getRelationshipGraph(VIEWER));
    expect(graph.nodes.length).toBeGreaterThan(0);
    for (const node of graph.nodes) {
      expect(node.closeness % 10).toBe(0); // bucketed to the nearest 10
      expect(node).not.toHaveProperty("score");
    }
    const tierSum =
      graph.tiers.inner.count +
      graph.tiers.closeFriends.count +
      graph.tiers.community.count +
      graph.tiers.ambient.count;
    expect(tierSum).toBe(graph.nodes.length);
  });
});
