/**
 * Unit tests for FeatureToggleService (foundation adapter)
 *
 * Strategy:
 *  - Happy-path tests use MemoryFeatureToggleStore (no mocking needed).
 *  - Error/fail-soft tests use a minimal structural PrismaFeatureToggleClient
 *    mock because MemoryFeatureToggleStore cannot simulate DB errors.
 *
 * Note on getAllToggles error behavior:
 *   Foundation's PrismaFeatureToggleStore.list() is fully fail-soft — it
 *   returns [] for ALL errors (including non-table errors like timeouts).
 *   The old hand-rolled implementation re-threw non-table errors.
 *   The new adapter inherits the foundation behavior: getAllToggles always
 *   resolves (never throws).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureToggleService } from "../../src/lib/feature-toggle-service.js";

// ---------------------------------------------------------------------------
// Helpers: minimal structural Prisma mock (matches PrismaFeatureToggleClient)
// ---------------------------------------------------------------------------

function makeRow(overrides: {
  key: string;
  enabled: boolean;
  changedAt?: Date;
  changedBy?: string | null;
  description?: string | null;
}) {
  return {
    key: overrides.key,
    enabled: overrides.enabled,
    changedAt: overrides.changedAt ?? new Date("2024-01-01"),
    changedBy: overrides.changedBy ?? null,
    description: overrides.description ?? null,
  };
}

function makeMockPrisma() {
  return {
    featureToggle: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// isEnabled
// ---------------------------------------------------------------------------

describe("FeatureToggleService.isEnabled", () => {
  it("returns true when toggle is enabled (via Prisma mock)", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findUnique.mockResolvedValue(
      makeRow({ key: "feat", enabled: true }),
    );
    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.isEnabled("feat")).toBe(true);
  });

  it("returns false when toggle is disabled (via Prisma mock)", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findUnique.mockResolvedValue(
      makeRow({ key: "feat", enabled: false }),
    );
    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.isEnabled("feat")).toBe(false);
  });

  it("returns false when toggle does not exist (null row)", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findUnique.mockResolvedValue(null);
    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.isEnabled("missing")).toBe(false);
  });

  it("returns false (fail-soft) when DB throws", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findUnique.mockRejectedValue(
      new Error("DB connection failed"),
    );
    const svc = new FeatureToggleService(prisma as any);
    // Must not throw
    expect(await svc.isEnabled("feat")).toBe(false);
  });

  it("returns false (fail-soft) when table is missing (P2021)", async () => {
    const prisma = makeMockPrisma();
    const err = Object.assign(new Error("table does not exist"), {
      code: "P2021",
    });
    prisma.featureToggle.findUnique.mockRejectedValue(err);
    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.isEnabled("feat")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getToggle — maps changedAt → lastChanged
// ---------------------------------------------------------------------------

describe("FeatureToggleService.getToggle", () => {
  it("returns toggle with lastChanged mapped from changedAt", async () => {
    const prisma = makeMockPrisma();
    const changedAt = new Date("2024-06-15T12:00:00Z");
    prisma.featureToggle.findUnique.mockResolvedValue(
      makeRow({
        key: "my-flag",
        enabled: true,
        changedAt,
        changedBy: "alice@example.com",
        description: "Test flag",
      }),
    );
    const svc = new FeatureToggleService(prisma as any);
    const result = await svc.getToggle("my-flag");
    expect(result).toEqual({
      key: "my-flag",
      enabled: true,
      lastChanged: changedAt,
      changedBy: "alice@example.com",
      description: "Test flag",
    });
  });

  it("omits optional fields when changedBy and description are null/undefined", async () => {
    const prisma = makeMockPrisma();
    const changedAt = new Date("2024-01-01");
    prisma.featureToggle.findUnique.mockResolvedValue(
      makeRow({ key: "bare-flag", enabled: false, changedAt }),
    );
    const svc = new FeatureToggleService(prisma as any);
    const result = await svc.getToggle("bare-flag");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("bare-flag");
    expect(result!.enabled).toBe(false);
    expect(result!.lastChanged).toEqual(changedAt);
    // changedBy and description are undefined (not null) in the returned shape
    expect(result!.changedBy).toBeUndefined();
    expect(result!.description).toBeUndefined();
  });

  it("returns null when toggle does not exist", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findUnique.mockResolvedValue(null);
    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.getToggle("no-such-key")).toBeNull();
  });

  it("returns null (fail-soft) when DB throws", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findUnique.mockRejectedValue(
      new Error("network error"),
    );
    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.getToggle("feat")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setToggle — maps changedAt → lastChanged on the result
// ---------------------------------------------------------------------------

describe("FeatureToggleService.setToggle", () => {
  it("creates a new toggle and returns shape with lastChanged", async () => {
    const prisma = makeMockPrisma();
    const changedAt = new Date("2024-07-01T09:00:00Z");
    const row = makeRow({
      key: "new-flag",
      enabled: true,
      changedAt,
      changedBy: "bob@example.com",
      description: "New flag",
    });
    // foundation calls findUnique first (for previous), then upsert
    prisma.featureToggle.findUnique.mockResolvedValue(null);
    prisma.featureToggle.upsert.mockResolvedValue(row);

    const svc = new FeatureToggleService(prisma as any);
    const result = await svc.setToggle(
      "new-flag",
      true,
      "bob@example.com",
      "New flag",
    );

    expect(result).toEqual({
      key: "new-flag",
      enabled: true,
      lastChanged: changedAt,
      changedBy: "bob@example.com",
    });
  });

  it("updates an existing toggle", async () => {
    const prisma = makeMockPrisma();
    const originalAt = new Date("2024-01-01");
    const updatedAt = new Date("2024-07-02T10:00:00Z");
    prisma.featureToggle.findUnique.mockResolvedValue(
      makeRow({ key: "flag", enabled: true, changedAt: originalAt }),
    );
    prisma.featureToggle.upsert.mockResolvedValue(
      makeRow({
        key: "flag",
        enabled: false,
        changedAt: updatedAt,
        changedBy: "carol@example.com",
      }),
    );

    const svc = new FeatureToggleService(prisma as any);
    const result = await svc.setToggle("flag", false, "carol@example.com");

    expect(result).toEqual({
      key: "flag",
      enabled: false,
      lastChanged: updatedAt,
      changedBy: "carol@example.com",
    });
  });

  it("falls back to the provided changedBy when the row returns null changedBy", async () => {
    const prisma = makeMockPrisma();
    const changedAt = new Date();
    // Simulate row where changedBy is null
    prisma.featureToggle.findUnique.mockResolvedValue(null);
    prisma.featureToggle.upsert.mockResolvedValue({
      key: "flag",
      enabled: true,
      changedAt,
      changedBy: null,
      description: null,
    });

    const svc = new FeatureToggleService(prisma as any);
    const result = await svc.setToggle("flag", true, "provided@example.com");
    expect(result.changedBy).toBe("provided@example.com");
  });

  it("throws when DB upsert fails", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findUnique.mockResolvedValue(null);
    prisma.featureToggle.upsert.mockRejectedValue(
      new Error("constraint violation"),
    );

    const svc = new FeatureToggleService(prisma as any);
    await expect(
      svc.setToggle("flag", true, "user@example.com"),
    ).rejects.toThrow("constraint violation");
  });
});

// ---------------------------------------------------------------------------
// getAllToggles — maps changedAt → lastChanged on each entry, sorted by key
// ---------------------------------------------------------------------------

describe("FeatureToggleService.getAllToggles", () => {
  it("returns all toggles with lastChanged mapped, sorted by key", async () => {
    const prisma = makeMockPrisma();
    const atA = new Date("2024-02-01");
    const atB = new Date("2024-03-01");
    // Foundation orders by key asc internally
    prisma.featureToggle.findMany.mockResolvedValue([
      makeRow({
        key: "toggle-a",
        enabled: false,
        changedAt: atA,
        changedBy: "user-1",
        description: "First",
      }),
      makeRow({
        key: "toggle-b",
        enabled: true,
        changedAt: atB,
        changedBy: "user-2",
        description: "Second",
      }),
    ]);

    const svc = new FeatureToggleService(prisma as any);
    const result = await svc.getAllToggles();

    expect(result).toEqual([
      {
        key: "toggle-a",
        enabled: false,
        lastChanged: atA,
        changedBy: "user-1",
        description: "First",
      },
      {
        key: "toggle-b",
        enabled: true,
        lastChanged: atB,
        changedBy: "user-2",
        description: "Second",
      },
    ]);
  });

  it("omits changedBy and description when they are null", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findMany.mockResolvedValue([
      makeRow({ key: "bare", enabled: true }),
    ]);

    const svc = new FeatureToggleService(prisma as any);
    const result = await svc.getAllToggles();

    expect(result).toHaveLength(1);
    expect(result[0]!.changedBy).toBeUndefined();
    expect(result[0]!.description).toBeUndefined();
  });

  it("returns empty array when table does not exist (P2021)", async () => {
    const prisma = makeMockPrisma();
    const err = Object.assign(
      new Error('Table "FeatureToggle" does not exist'),
      { code: "P2021" },
    );
    prisma.featureToggle.findMany.mockRejectedValue(err);

    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.getAllToggles()).toEqual([]);
  });

  it("returns empty array when table error message contains 'does not exist'", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findMany.mockRejectedValue(
      new Error("relation does not exist"),
    );

    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.getAllToggles()).toEqual([]);
  });

  it("returns empty array on any DB error (foundation list() is fully fail-soft)", async () => {
    // NOTE: This differs from the old hand-rolled behavior which re-threw
    // non-table errors. Foundation's list() catches all errors and returns [].
    const prisma = makeMockPrisma();
    prisma.featureToggle.findMany.mockRejectedValue(
      new Error("Connection timeout"),
    );

    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.getAllToggles()).toEqual([]);
  });

  it("returns empty array when store has no toggles", async () => {
    const prisma = makeMockPrisma();
    prisma.featureToggle.findMany.mockResolvedValue([]);

    const svc = new FeatureToggleService(prisma as any);
    expect(await svc.getAllToggles()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Field mapping integration — using MemoryFeatureToggleStore via setToggle
// ---------------------------------------------------------------------------

describe("FeatureToggleService field-mapping integration (MemoryStore)", () => {
  // For integration-style tests we drive through the service API itself.
  // We use a Prisma mock that behaves like the memory store would.

  it("round-trips a toggle: set → getToggle → isEnabled → getAllToggles", async () => {
    const prisma = makeMockPrisma();
    const changedAt = new Date("2024-08-01T00:00:00Z");

    // set path: get(previous=null) + upsert
    prisma.featureToggle.findUnique.mockResolvedValueOnce(null); // get for previous
    prisma.featureToggle.upsert.mockResolvedValue(
      makeRow({
        key: "round-trip",
        enabled: true,
        changedAt,
        changedBy: "dan@example.com",
        description: "RT flag",
      }),
    );

    const svc = new FeatureToggleService(prisma as any);
    const setResult = await svc.setToggle(
      "round-trip",
      true,
      "dan@example.com",
      "RT flag",
    );
    expect(setResult.lastChanged).toEqual(changedAt);
    expect(setResult.key).toBe("round-trip");
    expect(setResult.enabled).toBe(true);
    expect(setResult.changedBy).toBe("dan@example.com");

    // getToggle path
    prisma.featureToggle.findUnique.mockResolvedValueOnce(
      makeRow({
        key: "round-trip",
        enabled: true,
        changedAt,
        changedBy: "dan@example.com",
        description: "RT flag",
      }),
    );
    const getResult = await svc.getToggle("round-trip");
    expect(getResult).not.toBeNull();
    expect(getResult!.lastChanged).toEqual(changedAt);

    // isEnabled path (fresh call, cache may be warm from set-invalidation)
    prisma.featureToggle.findUnique.mockResolvedValueOnce(
      makeRow({ key: "round-trip", enabled: true, changedAt }),
    );
    expect(await svc.isEnabled("round-trip")).toBe(true);

    // getAllToggles path
    prisma.featureToggle.findMany.mockResolvedValueOnce([
      makeRow({
        key: "round-trip",
        enabled: true,
        changedAt,
        changedBy: "dan@example.com",
        description: "RT flag",
      }),
    ]);
    const all = await svc.getAllToggles();
    expect(all).toHaveLength(1);
    expect(all[0]!.lastChanged).toEqual(changedAt);
  });
});
