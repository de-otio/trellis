/**
 * Unit tests for the Postgres ScoringOps adapter (Phase 1 · B5).
 *
 * Prisma is mocked; the scoring-engine functions are NOT mocked — the tests
 * assert that ScoringOps wires real engine math (computeScore / scoreToTier /
 * computeDecay) to the `relationships` table correctly. Tenant scope is set
 * with the real ALS via runWithTenantContext.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithTenantContext } from "@de-otio/saas-foundation/tenant";
import type { TenantId } from "@de-otio/saas-foundation/tenant";
import { ScoringOps } from "../../../../src/lib/graph/postgres/scoring.js";
import {
  computeScore,
  scoreToTier,
} from "../../../../src/lib/graph/scoring-engine.js";
import type { RecordInteractionInput } from "../../../../src/lib/graph/types.js";

const TENANT = "tenant-1" as TenantId;
const USER = "user-1";

function withTenant<T>(fn: () => T): T {
  return runWithTenantContext(TENANT, fn);
}

/** Minimal Prisma relationship row factory. */
function rel(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rel-1",
    tenantId: TENANT,
    userId: USER,
    targetType: "user",
    targetId: "target-1",
    computedScore: 0,
    manualScore: null,
    tier: 3,
    interactionCount: 0,
    lastInteractionAt: null,
    connectionMethod: "discovery",
    reciprocated: false,
    signals: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makePrisma() {
  return {
    relationship: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn((args: unknown) => args),
    },
    entityOwnership: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Surveillance-hardening Phase 0 (P2): the InteractionEvent dual-write.
    interactionEvent: {
      create: vi.fn().mockResolvedValue({ id: "ie-1" }),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
    // Set-based score write (UPDATE … FROM unnest). Tagged-template mock:
    // calls receive (templateStrings, ids[], scores[], tiers[]).
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
}

/** Extract the (ids, scores, tiers) arrays from the unnest $executeRaw call. */
function executeRawArrays(prisma: ReturnType<typeof makePrisma>) {
  const call = prisma.$executeRaw.mock.calls[0];
  return {
    ids: call[1] as string[],
    scores: call[2] as number[],
    tiers: call[3] as number[],
  };
}

describe("ScoringOps", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let ops: ScoringOps;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    ops = new ScoringOps(prisma as never);
  });

  // -------------------------------------------------------------------------
  describe("recordInteraction", () => {
    const input: RecordInteractionInput = {
      userId: USER,
      targetType: "user",
      targetId: "target-1",
      interactionType: "comment",
    };

    it("bumps interactionCount, lastInteractionAt, and the typed signal", async () => {
      prisma.relationship.findUnique.mockResolvedValue({
        id: "rel-1",
        tenantId: TENANT,
        signals: { view: 2, comment: 1 },
      });

      await withTenant(() => ops.recordInteraction(input));

      expect(prisma.relationship.update).toHaveBeenCalledTimes(1);
      const arg = prisma.relationship.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: "rel-1" });
      expect(arg.data.interactionCount).toEqual({ increment: 1 });
      expect(arg.data.lastInteractionAt).toBeInstanceOf(Date);
      // signals carries the full counter set, comment incremented to 2,
      // pre-existing view preserved, untouched types zeroed.
      expect(arg.data.signals).toEqual({
        view: 2,
        react: 0,
        comment: 2,
        share: 0,
        depth_mode: 0,
        profile_visit: 0,
        content_creation: 0,
      });
    });

    it("initializes signals from null on first interaction", async () => {
      prisma.relationship.findUnique.mockResolvedValue({
        id: "rel-1",
        tenantId: TENANT,
        signals: null,
      });

      await withTenant(() =>
        ops.recordInteraction({ ...input, interactionType: "view" }),
      );

      const arg = prisma.relationship.update.mock.calls[0][0];
      expect(arg.data.signals.view).toBe(1);
      expect(arg.data.signals.comment).toBe(0);
    });

    it("is a no-op for AGGREGATION when no relationship exists", async () => {
      prisma.relationship.findUnique.mockResolvedValue(null);

      await withTenant(() => ops.recordInteraction(input));

      expect(prisma.relationship.update).not.toHaveBeenCalled();
    });

    it("dual-writes an InteractionEvent even when no relationship exists (P2)", async () => {
      // The temporal signal must be captured regardless of whether a
      // Relationship row exists to aggregate into.
      prisma.relationship.findUnique.mockResolvedValue(null);

      await withTenant(() => ops.recordInteraction(input));

      expect(prisma.interactionEvent.create).toHaveBeenCalledTimes(1);
      const arg = prisma.interactionEvent.create.mock.calls[0][0];
      expect(arg.data).toMatchObject({
        actorUserId: USER,
        targetType: "user",
        targetId: "target-1",
        interactionType: "comment",
      });
      expect(arg.data.expiresAt).toBeInstanceOf(Date);
    });

    it("does not let an InteractionEvent write failure fail the interaction (fail-open)", async () => {
      prisma.relationship.findUnique.mockResolvedValue({
        id: "rel-1",
        tenantId: TENANT,
        signals: null,
      });
      prisma.interactionEvent.create.mockRejectedValue(new Error("insert boom"));

      // Must not throw, and aggregation must still proceed.
      await withTenant(() => ops.recordInteraction(input));

      expect(prisma.relationship.update).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when the relationship belongs to another tenant", async () => {
      prisma.relationship.findUnique.mockResolvedValue({
        id: "rel-1",
        tenantId: "other-tenant",
        signals: null,
      });

      await withTenant(() => ops.recordInteraction(input));

      expect(prisma.relationship.update).not.toHaveBeenCalled();
    });

    it("is a no-op with no tenant in context", async () => {
      await ops.recordInteraction(input);
      expect(prisma.relationship.findUnique).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("recomputeScores", () => {
    it("returns ScoreUpdate[] only for relationships whose tier changed", async () => {
      // A heavily-interacted, reciprocated user edge currently at the lowest
      // tier (3) — recompute should lift it to a higher tier.
      const changing = rel({
        id: "rel-changing",
        targetType: "user",
        targetId: "friend",
        reciprocated: true,
        connectionMethod: "code",
        interactionCount: 100,
        lastInteractionAt: new Date(),
        signals: { comment: 50, share: 20 },
        computedScore: 0,
        tier: 3,
      });

      // Expected engine result for the changing edge.
      const expectedScore = computeScore({
        targetType: "user",
        connectionMethod: "code",
        interactionCount: 100,
        interactionsByType: {
          view: 0,
          react: 0,
          comment: 50,
          share: 20,
          depth_mode: 0,
          profile_visit: 0,
          content_creation: 0,
        },
        lastInteractionAt: changing.lastInteractionAt as Date,
        reciprocated: true,
        createdAt: changing.createdAt as Date,
        manualScore: null,
        isOwned: false,
        ownerScore: null,
        now: new Date(),
      });
      const expectedTier = scoreToTier(expectedScore);
      expect(expectedTier).not.toBe(3); // sanity: this edge must move

      // A stale edge whose recompute keeps it at tier 3 (no change).
      const stable = rel({
        id: "rel-stable",
        targetType: "user",
        targetId: "acquaintance",
        reciprocated: false,
        connectionMethod: "discovery",
        interactionCount: 0,
        lastInteractionAt: null,
        signals: null,
        computedScore: 0,
        tier: 3,
      });

      prisma.relationship.findMany.mockResolvedValue([changing, stable]);

      const updates = await withTenant(() => ops.recomputeScores(USER));

      // Only the changing edge is returned.
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        userId: USER,
        targetType: "user",
        targetId: "friend",
        previousTier: 3,
        newTier: expectedTier,
      });

      // Both edges are written (computedScore + tier) in ONE set-based
      // statement (UPDATE … FROM unnest) — not per-row updates.
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const { ids } = executeRawArrays(prisma);
      expect(ids).toEqual(["rel-changing", "rel-stable"]);
    });

    it("pins owned entities to tier 0 (score 1.0) via the OWNS exemption", async () => {
      const ownedEntity = rel({
        id: "rel-owned",
        targetType: "entity",
        targetId: "ent-owned",
        connectionMethod: "discovery",
        interactionCount: 0,
        signals: null,
        tier: 3,
      });
      prisma.relationship.findMany.mockResolvedValue([ownedEntity]);
      prisma.entityOwnership.findMany.mockResolvedValue([
        { entityId: "ent-owned", userId: USER },
      ]);

      const updates = await withTenant(() => ops.recomputeScores(USER));

      // Owned → effective 1.0 → tier 0, a change from tier 3.
      expect(updates).toHaveLength(1);
      expect(updates[0].newTier).toBe(0);
      const { scores, tiers } = executeRawArrays(prisma);
      expect(scores[0]).toBe(1.0);
      expect(tiers[0]).toBe(0);
    });

    it("returns [] and skips writes with no tenant", async () => {
      const updates = await ops.recomputeScores(USER);
      expect(updates).toEqual([]);
      expect(prisma.relationship.findMany).not.toHaveBeenCalled();
    });

    it("returns [] when the user has no relationships", async () => {
      prisma.relationship.findMany.mockResolvedValue([]);
      const updates = await withTenant(() => ops.recomputeScores(USER));
      expect(updates).toEqual([]);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("applyDecay", () => {
    it("decays a stale high-score edge and reports the tier drop", async () => {
      const old = new Date();
      old.setDate(old.getDate() - 180); // 3 user-half-lives → heavy decay

      const stale = rel({
        id: "rel-stale",
        targetType: "user",
        targetId: "old-friend",
        computedScore: 0.8, // tier 0
        tier: 0,
        lastInteractionAt: old,
      });
      prisma.relationship.findMany.mockResolvedValue([stale]);

      const updates = await withTenant(() => ops.applyDecay(USER));

      expect(updates).toHaveLength(1);
      expect(updates[0].previousTier).toBe(0);
      expect(updates[0].newTier).toBeGreaterThan(0); // dropped down
      expect(updates[0].newScore).toBeLessThan(0.8);

      const { scores } = executeRawArrays(prisma);
      expect(scores[0]).toBeLessThan(0.8);
    });

    it("exempts owned entities from decay", async () => {
      const old = new Date();
      old.setDate(old.getDate() - 365);

      const ownedEntity = rel({
        id: "rel-owned",
        targetType: "entity",
        targetId: "ent-owned",
        computedScore: 1.0,
        tier: 0,
        lastInteractionAt: old,
      });
      prisma.relationship.findMany.mockResolvedValue([ownedEntity]);
      prisma.entityOwnership.findMany.mockResolvedValue([
        { entityId: "ent-owned", userId: USER },
      ]);

      const updates = await withTenant(() => ops.applyDecay(USER));

      // Owned entity skipped entirely — no tier change, no write.
      expect(updates).toEqual([]);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it("only considers edges with a lastInteractionAt (filter passed to prisma)", async () => {
      prisma.relationship.findMany.mockResolvedValue([]);

      await withTenant(() => ops.applyDecay(USER));

      const where = prisma.relationship.findMany.mock.calls[0][0].where;
      expect(where.lastInteractionAt).toEqual({ not: null });
      expect(where.tenantId).toBe(TENANT);
      expect(where.userId).toBe(USER);
    });

    it("returns [] with no tenant", async () => {
      const updates = await ops.applyDecay(USER);
      expect(updates).toEqual([]);
      expect(prisma.relationship.findMany).not.toHaveBeenCalled();
    });
  });
});
