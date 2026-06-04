/**
 * Unit tests: FeatureToggleService — audit emission on setToggle
 *
 * Verifies that setToggle:
 *   1. Emits a `feature_toggle.changed` audit event (via TrellisAuditLogger.logSystemAction)
 *      when auditCtx is provided.
 *   2. Does NOT block the toggle write on audit failure (best-effort).
 *   3. Passes the correct metadata: { key, oldEnabled, newEnabled, changedBy: userId }
 *      — changedBy is the USER ID, not the email passed as `changedBy` to the DB.
 *   4. Does NOT emit when auditCtx is omitted (backwards compat).
 *
 * The foundation store and audit-composer are mocked so this test runs
 * without a DB or AWS dependency.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrellisAuditLoggerEnv } from "../../src/lib/audit-composer.js";

// ── Hoist mocks ──────────────────────────────────────────────────────────────

const { mockStoreSet, mockLogSystemAction } = vi.hoisted(() => ({
  mockStoreSet: vi.fn(),
  mockLogSystemAction: vi.fn(),
}));

// Mock foundation's PrismaFeatureToggleStore (a `class` so `new …()` works)
vi.mock("@de-otio/saas-foundation/feature-toggles/prisma", () => ({
  PrismaFeatureToggleStore: class {
    set = mockStoreSet;
    get = vi.fn().mockResolvedValue(null);
    isEnabled = vi.fn().mockResolvedValue(false);
    list = vi.fn().mockResolvedValue([]);
  },
}));

// Mock audit-composer so we can assert on logSystemAction calls without DB
vi.mock("../../src/lib/audit-composer.js", () => ({
  TrellisAuditLogger: class {
    logSystemAction = mockLogSystemAction;
  },
}));

// Mock audit-actions so FEATURE_TOGGLE_CHANGED is a plain string
vi.mock("../../src/lib/audit-actions.js", () => ({
  FEATURE_TOGGLE_CHANGED: "feature_toggle.changed",
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(
  key: string,
  enabled: boolean,
  changedBy: string = "admin@example.com",
) {
  return {
    key,
    enabled,
    changedAt: new Date("2025-01-01T10:00:00Z"),
    changedBy,
    description: null,
  };
}

function makePrisma() {
  return {
    featureToggle: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
  };
}

const testEnv: TrellisAuditLoggerEnv = {
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  DEFAULT_REGION: "EU",
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("FeatureToggleService.setToggle — audit emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogSystemAction.mockResolvedValue(undefined);
  });

  it("emits feature_toggle.changed with correct metadata when auditCtx is provided", async () => {
    const { FeatureToggleService } = await import(
      "../../src/lib/feature-toggle-service.js"
    );

    const previousRow = makeRow("my_toggle", true);
    const currentRow = makeRow("my_toggle", false);

    // store.set returns { previous, current }
    mockStoreSet.mockResolvedValue({
      previous: previousRow,
      current: currentRow,
    });

    const svc = new FeatureToggleService(makePrisma() as any);
    await svc.setToggle("my_toggle", false, "admin@example.com", undefined, {
      userId: "user-id-123",
      env: testEnv,
      region: "EU",
    });

    // Allow microtasks to flush (audit is fire-and-forget)
    await vi.waitFor(() => expect(mockLogSystemAction).toHaveBeenCalled());

    expect(mockLogSystemAction).toHaveBeenCalledWith(
      "feature_toggle.changed",
      expect.objectContaining({
        resource: "feature_toggle",
        resourceId: "my_toggle",
        userId: "user-id-123",
        region: "EU",
        success: true,
        metadata: {
          key: "my_toggle",
          oldEnabled: true,     // previous.enabled
          newEnabled: false,    // the new value
          changedBy: "user-id-123",  // userId — NOT email
        },
      }),
      testEnv,
    );
  });

  it("uses oldEnabled=false when previous is null (new toggle)", async () => {
    const { FeatureToggleService } = await import(
      "../../src/lib/feature-toggle-service.js"
    );

    mockStoreSet.mockResolvedValue({
      previous: null,
      current: makeRow("new_toggle", true),
    });

    const svc = new FeatureToggleService(makePrisma() as any);
    await svc.setToggle("new_toggle", true, "admin@example.com", undefined, {
      userId: "user-abc",
      env: testEnv,
    });

    await vi.waitFor(() => expect(mockLogSystemAction).toHaveBeenCalled());

    const [, eventArg] = mockLogSystemAction.mock.calls[0]!;
    expect((eventArg as any).metadata.oldEnabled).toBe(false);
    expect((eventArg as any).metadata.newEnabled).toBe(true);
  });

  it("falls back to env.DEFAULT_REGION when auditCtx.region is omitted", async () => {
    const { FeatureToggleService } = await import(
      "../../src/lib/feature-toggle-service.js"
    );

    mockStoreSet.mockResolvedValue({
      previous: null,
      current: makeRow("toggle_x", true),
    });

    const svc = new FeatureToggleService(makePrisma() as any);
    await svc.setToggle("toggle_x", true, "admin@example.com", undefined, {
      userId: "user-xyz",
      env: { ...testEnv, DEFAULT_REGION: "US" },
      // region intentionally omitted
    });

    await vi.waitFor(() => expect(mockLogSystemAction).toHaveBeenCalled());

    const [, eventArg] = mockLogSystemAction.mock.calls[0]!;
    expect((eventArg as any).region).toBe("US");
  });

  it("does NOT emit when auditCtx is omitted (backwards compat)", async () => {
    const { FeatureToggleService } = await import(
      "../../src/lib/feature-toggle-service.js"
    );

    mockStoreSet.mockResolvedValue({
      previous: null,
      current: makeRow("bare_toggle", true),
    });

    const svc = new FeatureToggleService(makePrisma() as any);
    // No auditCtx argument
    await svc.setToggle("bare_toggle", true, "admin@example.com");

    // Give microtasks a chance to flush
    await Promise.resolve();

    expect(mockLogSystemAction).not.toHaveBeenCalled();
  });

  it("does NOT block the toggle write when audit emission fails", async () => {
    const { FeatureToggleService } = await import(
      "../../src/lib/feature-toggle-service.js"
    );

    const currentRow = makeRow("flaky_toggle", true);
    mockStoreSet.mockResolvedValue({ previous: null, current: currentRow });

    // Simulate audit failure
    mockLogSystemAction.mockRejectedValue(new Error("audit store unreachable"));

    const svc = new FeatureToggleService(makePrisma() as any);
    // Must not throw
    const result = await svc.setToggle(
      "flaky_toggle",
      true,
      "admin@example.com",
      undefined,
      { userId: "user-1", env: testEnv, region: "EU" },
    );

    // Toggle write result is correct despite audit failure
    expect(result.key).toBe("flaky_toggle");
    expect(result.enabled).toBe(true);

    // Let the fire-and-forget emission settle inside THIS test so its
    // (rejected) call can't bleed into the next test's mock.calls.
    await vi.waitFor(() => expect(mockLogSystemAction).toHaveBeenCalled());
  });

  it("changedBy in audit metadata is userId — not the email passed to DB", async () => {
    const { FeatureToggleService } = await import(
      "../../src/lib/feature-toggle-service.js"
    );

    mockStoreSet.mockResolvedValue({
      previous: makeRow("t", false),
      current: makeRow("t", true, "not-the-user@example.com"),
    });

    const svc = new FeatureToggleService(makePrisma() as any);
    await svc.setToggle(
      "t",
      true,
      "not-the-user@example.com", // goes to DB changedBy column
      undefined,
      {
        userId: "actual-user-id", // goes to audit metadata changedBy
        env: testEnv,
        region: "EU",
      },
    );

    await vi.waitFor(() => expect(mockLogSystemAction).toHaveBeenCalled());

    const [, eventArg] = mockLogSystemAction.mock.calls.at(-1)!;
    expect((eventArg as any).metadata.changedBy).toBe("actual-user-id");
    // userId on the event itself is also the ID
    expect((eventArg as any).userId).toBe("actual-user-id");
  });
});
