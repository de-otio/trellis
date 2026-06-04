/**
 * Unit tests for InteractionEvent capture (Surveillance-hardening Phase 0, P2).
 * Covers the volume guard, fail-open dual-write, retention/config resolution,
 * and the batched prune circuit breaker. Fully mocked (no DB).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// getCurrentTenantId is read inside record(); stub it per-test.
const { mockGetTenant } = vi.hoisted(() => ({ mockGetTenant: vi.fn() }));
vi.mock("@de-otio/saas-foundation/tenant", () => ({
  getCurrentTenantId: mockGetTenant,
}));

import {
  InteractionEventOps,
  batchedPruneExpired,
  resolveInteractionEventConfig,
  DEFAULT_INTERACTION_EVENT_CONFIG,
} from "../../src/lib/graph/postgres/interaction-events.js";

function makePrisma() {
  return {
    interactionEvent: {
      create: vi.fn().mockResolvedValue({ id: "ie-1" }),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

const baseInput = {
  userId: "u1",
  targetType: "user" as const,
  targetId: "t1",
  interactionType: "comment" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTenant.mockReturnValue("tenant-1");
});

describe("resolveInteractionEventConfig", () => {
  it("uses conservative defaults when env is empty", () => {
    expect(resolveInteractionEventConfig({})).toEqual(DEFAULT_INTERACTION_EVENT_CONFIG);
    expect(DEFAULT_INTERACTION_EVENT_CONFIG.retentionDays).toBe(120);
    expect(DEFAULT_INTERACTION_EVENT_CONFIG.viewSampleRate).toBe(0);
  });

  it("parses overrides and disables only on literal 'false'", () => {
    const cfg = resolveInteractionEventConfig({
      INTERACTION_EVENTS_ENABLED: "false",
      INTERACTION_EVENT_RETENTION_DAYS: "200",
      INTERACTION_EVENT_VIEW_SAMPLE_RATE: "0.25",
      INTERACTION_EVENT_PRUNE_BATCH_SIZE: "500",
      INTERACTION_EVENT_PRUNE_MAX_ITERATIONS: "10",
    });
    expect(cfg).toEqual({
      enabled: false,
      retentionDays: 200,
      viewSampleRate: 0.25,
      pruneBatchSize: 500,
      pruneMaxIterations: 10,
    });
  });

  it("clamps an out-of-range sample rate to 0", () => {
    expect(resolveInteractionEventConfig({ INTERACTION_EVENT_VIEW_SAMPLE_RATE: "5" }).viewSampleRate).toBe(0);
    expect(resolveInteractionEventConfig({ INTERACTION_EVENT_VIEW_SAMPLE_RATE: "-1" }).viewSampleRate).toBe(0);
  });
});

describe("InteractionEventOps.record — dual-write", () => {
  it("writes a high-signal event with actor/target/type/tenant/expiresAt", async () => {
    const prisma = makePrisma();
    const ops = new InteractionEventOps(prisma as never, {
      ...DEFAULT_INTERACTION_EVENT_CONFIG,
      retentionDays: 120,
    });

    const res = await ops.record(baseInput);

    expect(res).toEqual({ written: true, skipped: false });
    expect(prisma.interactionEvent.create).toHaveBeenCalledTimes(1);
    const data = prisma.interactionEvent.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      actorUserId: "u1",
      targetType: "user",
      targetId: "t1",
      interactionType: "comment",
      tenantId: "tenant-1",
    });
    // ~120 days out (allow scheduling slack)
    const deltaDays = (data.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(deltaDays).toBeGreaterThan(119);
    expect(deltaDays).toBeLessThan(121);
  });

  it("records a null tenant when there is no tenant context", async () => {
    const prisma = makePrisma();
    mockGetTenant.mockReturnValue(undefined);
    const ops = new InteractionEventOps(prisma as never);

    await ops.record(baseInput);

    expect(prisma.interactionEvent.create.mock.calls[0]![0].data.tenantId).toBeNull();
  });

  it("skips entirely when disabled", async () => {
    const prisma = makePrisma();
    const ops = new InteractionEventOps(prisma as never, {
      ...DEFAULT_INTERACTION_EVENT_CONFIG,
      enabled: false,
    });

    const res = await ops.record(baseInput);

    expect(res).toEqual({ written: false, skipped: false });
    expect(prisma.interactionEvent.create).not.toHaveBeenCalled();
  });

  it("is fail-open: a rejected insert returns written:false and does not throw", async () => {
    const prisma = makePrisma();
    prisma.interactionEvent.create.mockRejectedValue(new Error("boom"));
    const ops = new InteractionEventOps(prisma as never);

    const res = await ops.record(baseInput);

    expect(res).toEqual({ written: false, skipped: false });
  });
});

describe("InteractionEventOps.record — volume guard", () => {
  it("skips a `view` when viewSampleRate is 0", async () => {
    const prisma = makePrisma();
    const ops = new InteractionEventOps(prisma as never); // default rate 0

    const res = await ops.record({ ...baseInput, interactionType: "view" });

    expect(res).toEqual({ written: false, skipped: true });
    expect(prisma.interactionEvent.create).not.toHaveBeenCalled();
  });

  it("records a `view` when the RNG falls under the sample rate", async () => {
    const prisma = makePrisma();
    const ops = new InteractionEventOps(
      prisma as never,
      { ...DEFAULT_INTERACTION_EVENT_CONFIG, viewSampleRate: 0.5 },
      () => 0.1, // < 0.5 → record
    );

    const res = await ops.record({ ...baseInput, interactionType: "view" });

    expect(res.written).toBe(true);
    expect(prisma.interactionEvent.create).toHaveBeenCalledTimes(1);
  });

  it("drops a `view` when the RNG is above the sample rate", async () => {
    const prisma = makePrisma();
    const ops = new InteractionEventOps(
      prisma as never,
      { ...DEFAULT_INTERACTION_EVENT_CONFIG, viewSampleRate: 0.5 },
      () => 0.9, // > 0.5 → skip
    );

    const res = await ops.record({ ...baseInput, interactionType: "view" });

    expect(res.skipped).toBe(true);
    expect(prisma.interactionEvent.create).not.toHaveBeenCalled();
  });

  it.each(["react", "comment", "share", "profile_visit", "depth_mode", "content_creation"])(
    "always records high-signal type %s regardless of sample rate",
    async (interactionType) => {
      const prisma = makePrisma();
      const ops = new InteractionEventOps(
        prisma as never,
        { ...DEFAULT_INTERACTION_EVENT_CONFIG, viewSampleRate: 0 },
        () => 0.99,
      );

      const res = await ops.record({ ...baseInput, interactionType } as never);

      expect(res.written).toBe(true);
    },
  );
});

describe("InteractionEventOps.prune — batched with circuit breaker", () => {
  it("deletes only expired rows and stops when a short batch arrives", async () => {
    const prisma = makePrisma();
    // First batch full (2), second batch short (1) → stop.
    prisma.interactionEvent.findMany
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
      .mockResolvedValueOnce([{ id: "c" }]);
    prisma.interactionEvent.deleteMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });

    const ops = new InteractionEventOps(prisma as never, {
      ...DEFAULT_INTERACTION_EVENT_CONFIG,
      pruneBatchSize: 2,
      pruneMaxIterations: 100,
    });

    const res = await ops.prune(new Date());

    expect(res.deleted).toBe(3);
    expect(res.circuitBreakerTripped).toBe(false);
    // Each findMany filters expiresAt < now
    const where = prisma.interactionEvent.findMany.mock.calls[0]![0].where;
    expect(where.expiresAt.lt).toBeInstanceOf(Date);
  });

  it("trips the circuit breaker when every batch stays full (degenerate case)", async () => {
    const prisma = makePrisma();
    // Always returns a full batch → never drains.
    prisma.interactionEvent.findMany.mockResolvedValue([{ id: "x" }, { id: "y" }]);
    prisma.interactionEvent.deleteMany.mockResolvedValue({ count: 2 });

    const ops = new InteractionEventOps(prisma as never, {
      ...DEFAULT_INTERACTION_EVENT_CONFIG,
      pruneBatchSize: 2,
      pruneMaxIterations: 3,
    });

    const res = await ops.prune(new Date());

    expect(res.circuitBreakerTripped).toBe(true);
    expect(res.iterations).toBe(3);
    expect(prisma.interactionEvent.findMany).toHaveBeenCalledTimes(3);
  });

  it("returns cleanly when nothing is expired", async () => {
    const prisma = makePrisma();
    prisma.interactionEvent.findMany.mockResolvedValue([]);

    const ops = new InteractionEventOps(prisma as never);
    const res = await ops.prune(new Date());

    expect(res).toEqual({ deleted: 0, iterations: 0, circuitBreakerTripped: false });
    expect(prisma.interactionEvent.deleteMany).not.toHaveBeenCalled();
  });
});

describe("batchedPruneExpired (shared helper)", () => {
  it("drives find/delete callbacks until a short batch", async () => {
    const findExpiredIds = vi
      .fn()
      .mockResolvedValueOnce(["a", "b"])
      .mockResolvedValueOnce([]);
    const deleteByIds = vi.fn().mockResolvedValue(2);

    const res = await batchedPruneExpired({
      findExpiredIds,
      deleteByIds,
      batchSize: 2,
      maxIterations: 10,
    });

    expect(res).toEqual({ deleted: 2, iterations: 1, circuitBreakerTripped: false });
  });
});
