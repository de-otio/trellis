/**
 * Unit tests: emitDirectoryProfileAudit
 *
 * Covers:
 *   - actionFor switch: all three DirectoryProfileAuditActionKey values map
 *     to the correct AuditAction string passed to TenantAuditEmitter.emit.
 *   - Payload forwarding: tenantId, actorUserId, targetId, targetType, and
 *     optional metadata are forwarded correctly.
 *   - Fire-and-forget: the function returns void synchronously.
 *
 * Security note: `discoverable_changed` and `precision_changed` events are
 * specifically high-value from the audit perspective (they INCREASE what is
 * exposed about a tenant). The mapping tests confirm these action strings are
 * correctly wired so they appear in the audit log with distinct, queryable
 * action strings.
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
import { emitDirectoryProfileAudit } from "../../../src/lib/tenant/directory-profile-audit-emit.js";
import type { AuditPrismaClientLike } from "../../../src/lib/audit-composer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePrisma(): AuditPrismaClientLike {
  return { auditEvent: { create: vi.fn() } } as unknown as AuditPrismaClientLike;
}

const BASE = {
  tenantId: "tenant-abc",
  actorUserId: "user-xyz",
  targetId: "profile-1",
} as const;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("emitDirectoryProfileAudit — actionFor mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["directory_profile.created", "tenant_directory_profile.created"],
    ["directory_profile.discoverable_changed", "tenant_directory_profile.discoverable_changed"],
    ["directory_profile.precision_changed", "tenant_directory_profile.precision_changed"],
  ] as const)(
    "maps action %s to audit type %s",
    (action, expectedType) => {
      const db = makePrisma();
      emitDirectoryProfileAudit({ ...BASE, action }, db);

      expect(mockEmit).toHaveBeenCalledTimes(1);
      const [emitArg] = mockEmit.mock.calls[0]!;
      expect(emitArg.type).toBe(expectedType);
    },
  );
});

describe("emitDirectoryProfileAudit — payload forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards tenantId and actorUserId", () => {
    const db = makePrisma();
    emitDirectoryProfileAudit({ ...BASE, action: "directory_profile.created" }, db);

    const [emitArg] = mockEmit.mock.calls[0]!;
    expect(emitArg.tenantId).toBe("tenant-abc");
    expect(emitArg.actorUserId).toBe("user-xyz");
  });

  it("includes targetType=directory_profile and targetId in the payload", () => {
    const db = makePrisma();
    emitDirectoryProfileAudit({ ...BASE, action: "directory_profile.created" }, db);

    const [emitArg] = mockEmit.mock.calls[0]!;
    expect(emitArg.payload.targetType).toBe("directory_profile");
    expect(emitArg.payload.targetId).toBe("profile-1");
  });

  it("spreads optional metadata into the payload", () => {
    const db = makePrisma();
    emitDirectoryProfileAudit(
      {
        ...BASE,
        action: "directory_profile.discoverable_changed",
        metadata: { oldValue: false, newValue: true },
      },
      db,
    );

    const [emitArg] = mockEmit.mock.calls[0]!;
    expect(emitArg.payload.oldValue).toBe(false);
    expect(emitArg.payload.newValue).toBe(true);
  });

  it("works correctly with no metadata (payload has targetType and targetId only)", () => {
    const db = makePrisma();
    emitDirectoryProfileAudit({ ...BASE, action: "directory_profile.precision_changed" }, db);

    const [emitArg] = mockEmit.mock.calls[0]!;
    expect(Object.keys(emitArg.payload).sort()).toEqual(["targetId", "targetType"]);
  });

  it("passes the prisma client as the second argument to emitter.emit", () => {
    const db = makePrisma();
    emitDirectoryProfileAudit({ ...BASE, action: "directory_profile.created" }, db);

    const [, prismaArg] = mockEmit.mock.calls[0]!;
    expect(prismaArg).toBe(db);
  });
});

describe("emitDirectoryProfileAudit — fire-and-forget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns void synchronously even when the emitter would reject", () => {
    mockEmit.mockRejectedValueOnce(new Error("DB down"));
    const db = makePrisma();
    // Must not throw synchronously.
    const result = emitDirectoryProfileAudit({ ...BASE, action: "directory_profile.created" }, db);
    expect(result).toBeUndefined();
  });
});
