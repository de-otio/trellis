/**
 * Unit tests: emitClassificationAudit
 *
 * Covers:
 *   - actionFor switch: all four ClassificationAuditAction values map to the
 *     correct AuditAction string passed to TenantAuditEmitter.emit.
 *   - Payload forwarding: tenantId, actorUserId, targetId, and optional
 *     metadata are forwarded correctly to the emitter.
 *   - Fire-and-forget: the function returns void synchronously; the emitter
 *     call is not awaited by the caller, so a rejected emit does not surface
 *     as an unhandled rejection at the call site (the emitter swallows it).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock factory ──────────────────────────────────────────────────────

const { mockEmit } = vi.hoisted(() => ({
  mockEmit: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

// Mock TenantAuditEmitter so the module-level singleton uses our spy.
vi.mock("../../../src/lib/audit-composer.js", () => ({
  TenantAuditEmitter: class {
    emit = mockEmit;
  },
}));

// Import SUT after mocks are established.
import { emitClassificationAudit } from "../../../src/lib/tenant/classification-audit-emit.js";
import type { AuditPrismaClientLike } from "../../../src/lib/audit-composer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePrisma(): AuditPrismaClientLike {
  return { auditEvent: { create: vi.fn() } } as unknown as AuditPrismaClientLike;
}

const BASE = {
  tenantId: "tenant-abc",
  actorUserId: "user-xyz",
  targetId: "classification-1",
} as const;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("emitClassificationAudit — actionFor mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["classification.created", "tenant_classification.created"],
    ["classification.category_changed", "tenant_classification.category_changed"],
    ["classification.tag_added", "tenant_classification.tag_added"],
    ["classification.tag_removed", "tenant_classification.tag_removed"],
  ] as const)(
    "maps action %s to audit type %s",
    (action, expectedType) => {
      const db = makePrisma();
      emitClassificationAudit({ ...BASE, action }, db);

      expect(mockEmit).toHaveBeenCalledTimes(1);
      const [emitArg] = mockEmit.mock.calls[0]!;
      expect(emitArg.type).toBe(expectedType);
    },
  );
});

describe("emitClassificationAudit — payload forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards tenantId and actorUserId", () => {
    const db = makePrisma();
    emitClassificationAudit({ ...BASE, action: "classification.created" }, db);

    const [emitArg] = mockEmit.mock.calls[0]!;
    expect(emitArg.tenantId).toBe("tenant-abc");
    expect(emitArg.actorUserId).toBe("user-xyz");
  });

  it("includes targetId in the payload", () => {
    const db = makePrisma();
    emitClassificationAudit({ ...BASE, action: "classification.tag_added" }, db);

    const [emitArg] = mockEmit.mock.calls[0]!;
    expect(emitArg.payload.targetId).toBe("classification-1");
  });

  it("spreads optional metadata into the payload", () => {
    const db = makePrisma();
    emitClassificationAudit(
      { ...BASE, action: "classification.category_changed", metadata: { oldCategoryId: "cat-1", newCategoryId: "cat-2" } },
      db,
    );

    const [emitArg] = mockEmit.mock.calls[0]!;
    expect(emitArg.payload.oldCategoryId).toBe("cat-1");
    expect(emitArg.payload.newCategoryId).toBe("cat-2");
  });

  it("works correctly with no metadata (payload has only targetId)", () => {
    const db = makePrisma();
    emitClassificationAudit({ ...BASE, action: "classification.tag_removed" }, db);

    const [emitArg] = mockEmit.mock.calls[0]!;
    expect(Object.keys(emitArg.payload)).toEqual(["targetId"]);
  });

  it("passes the prisma client as the second argument to emitter.emit", () => {
    const db = makePrisma();
    emitClassificationAudit({ ...BASE, action: "classification.created" }, db);

    const [, prismaArg] = mockEmit.mock.calls[0]!;
    expect(prismaArg).toBe(db);
  });
});

describe("emitClassificationAudit — fire-and-forget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns void synchronously even when the emitter would reject", () => {
    mockEmit.mockRejectedValueOnce(new Error("DB down"));
    const db = makePrisma();
    // Must not throw synchronously.
    const result = emitClassificationAudit({ ...BASE, action: "classification.created" }, db);
    expect(result).toBeUndefined();
  });
});
