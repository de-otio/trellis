/**
 * Unit Tests: TenantAuditEmitter (phase 1.C.2)
 *
 * The tenant/IdP audit emitter now writes through foundation's
 * `AuditLog` / `PostgresAuditStore`. The primary outcome we assert on
 * is the `auditEvent.create` call the store makes against the injected
 * Prisma client — NOT a mock of `@de-otio/*`. CloudWatch is gone
 * (foundation owns the sink).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantAuditEmitter } from "../../src/lib/audit-composer.js";
import { AuditEventType } from "../../src/lib/audit-actions.js";
import type { PrismaAuditClient } from "@de-otio/saas-foundation/audit/prisma";

// ── Prisma mock (structural PrismaAuditClient) ───────────────────────
type CreateArg = {
  data: {
    id: string;
    timestamp: Date;
    tenantId: string | null;
    actorKind: string;
    actorId: string;
    action: string;
    resourceKind: string | null;
    resourceId: string | null;
    outcome: string;
    failureReason: string | null;
    severity: string;
    requestId: string | null;
    traceId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    metadata: unknown;
    retentionUntil: Date;
  };
};

function makeDb(createImpl?: (arg: CreateArg) => Promise<unknown>): {
  client: PrismaAuditClient;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(createImpl ?? (() => Promise.resolve({ id: "row-1" })));
  return {
    client: { auditEvent: { create } } as unknown as PrismaAuditClient,
    create,
  };
}

const BASE_INPUT = {
  type: AuditEventType.TENANT_CREATED,
  tenantId: "tenant-a",
  actorUserId: "user-1",
  payload: { tenantId: "tenant-a", slug: "acme" },
};

describe("TenantAuditEmitter.emit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes an AuditEvent row via the store's auditEvent.create", async () => {
    const { client, create } = makeDb();
    const emitter = new TenantAuditEmitter();

    await emitter.emit(BASE_INPUT, client);

    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0]?.[0] as CreateArg).data;
    expect(data.action).toBe("tenant.created");
    expect(data.tenantId).toBe("tenant-a");
    expect(data.actorKind).toBe("user");
    expect(data.actorId).toBe("user-1");
    expect(data.outcome).toBe("success");
    expect(data.severity).toBe("info");
    expect(typeof data.id).toBe("string");
  });

  it("carries allowlisted payload fields into metadata", async () => {
    const { client, create } = makeDb();
    const emitter = new TenantAuditEmitter();

    await emitter.emit(BASE_INPUT, client);

    const data = (create.mock.calls[0]?.[0] as CreateArg).data;
    const metadata = data.metadata as Record<string, unknown>;
    expect(metadata.tenantId).toBe("tenant-a");
    expect(metadata.slug).toBe("acme");
    expect(metadata.actorUserId).toBe("user-1");
  });

  it("anonymises the source IP to /24 before storage (ipAddress column)", async () => {
    const { client, create } = makeDb();
    const emitter = new TenantAuditEmitter();

    await emitter.emit({ ...BASE_INPUT, sourceIp: "1.2.3.4" }, client);

    const data = (create.mock.calls[0]?.[0] as CreateArg).data;
    expect(data.ipAddress).toBe("1.2.3.0/24");
    const metadata = data.metadata as Record<string, unknown>;
    expect(metadata.sourceIp).toBe("1.2.3.0/24");
  });

  it("omits ipAddress when no source IP is provided", async () => {
    const { client, create } = makeDb();
    const emitter = new TenantAuditEmitter();

    await emitter.emit(BASE_INPUT, client);

    const data = (create.mock.calls[0]?.[0] as CreateArg).data;
    expect(data.ipAddress).toBeNull();
  });

  it("includes agentSessionId in metadata when provided", async () => {
    const { client, create } = makeDb();
    const emitter = new TenantAuditEmitter();

    await emitter.emit({ ...BASE_INPUT, agentSessionId: "agent-sess-42" }, client);

    const data = (create.mock.calls[0]?.[0] as CreateArg).data;
    const metadata = data.metadata as Record<string, unknown>;
    expect(metadata.agentSessionId).toBe("agent-sess-42");
  });

  it("does NOT throw to the caller when the store write fails", async () => {
    const { client } = makeDb(() => Promise.reject(new Error("DB down")));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const emitter = new TenantAuditEmitter();

    await expect(emitter.emit(BASE_INPUT, client)).resolves.toBeUndefined();

    const fallback = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((msg) => msg.includes("audit-fallback"));
    expect(fallback.length).toBeGreaterThan(0);
    consoleSpy.mockRestore();
  });

  it("redacts disallowed payload fields via the allowlist", async () => {
    const { client, create } = makeDb();
    const emitter = new TenantAuditEmitter();

    await emitter.emit(
      { ...BASE_INPUT, payload: { tenantId: "tenant-a", email: "alice@example.com" } },
      client,
    );

    const data = (create.mock.calls[0]?.[0] as CreateArg).data;
    const metadata = data.metadata as Record<string, unknown>;
    expect(metadata.email).toBe("<redacted>");
    expect(metadata.tenantId).toBe("tenant-a");
  });

  it("generates a unique id for each emission", async () => {
    const a = makeDb();
    const b = makeDb();
    const emitter = new TenantAuditEmitter();

    await emitter.emit(BASE_INPUT, a.client);
    await emitter.emit(BASE_INPUT, b.client);

    const idA = (a.create.mock.calls[0]?.[0] as CreateArg).data.id;
    const idB = (b.create.mock.calls[0]?.[0] as CreateArg).data.id;
    expect(idA).not.toBe(idB);
  });

  it.each([
    [AuditEventType.TENANT_CREATED, "tenant.created"],
    [AuditEventType.TENANT_UPDATED, "tenant.updated"],
    [AuditEventType.TENANT_OWNERSHIP_TRANSFERRED, "tenant.ownership_transferred"],
    [AuditEventType.TENANT_MEMBER_ROLE_CHANGED, "tenant.member.role_changed"],
    [AuditEventType.TENANT_MEMBER_REMOVED, "tenant.member.removed"],
    [AuditEventType.TENANT_MEMBER_INVITED, "tenant.member.invited"],
    [AuditEventType.TENANT_MEMBER_JOINED, "tenant.member.joined"],
    [AuditEventType.TENANT_DOMAIN_ADDED, "tenant.domain.added"],
    [AuditEventType.TENANT_DOMAIN_VERIFIED, "tenant.domain.verified"],
    [AuditEventType.TENANT_IDP_CONNECTED, "tenant.idp.connected"],
    [AuditEventType.TENANT_IDP_MODIFIED, "tenant.idp.modified"],
    [AuditEventType.TENANT_IDP_DISABLED, "tenant.idp.disabled"],
    [AuditEventType.TENANT_IDP_DELETED, "tenant.idp.deleted"],
    [AuditEventType.TENANT_ROLE_MAPPING_ADDED, "tenant.role_mapping.added"],
    [AuditEventType.TENANT_ROLE_MAPPING_REMOVED, "tenant.role_mapping.removed"],
    [AuditEventType.TENANT_FEDERATED_LOGIN_SUCCESS, "tenant.federated_login.success"],
    [AuditEventType.TENANT_FEDERATED_LOGIN_DENIED, "tenant.federated_login.denied"],
    [AuditEventType.TENANT_ROLE_REFRESHED_JIT, "tenant.role.refreshed_jit"],
  ])("maps event type %s to action %s", async (type, expected) => {
    const { client, create } = makeDb();
    const emitter = new TenantAuditEmitter();

    await emitter.emit({ ...BASE_INPUT, type }, client);

    const data = (create.mock.calls[0]?.[0] as CreateArg).data;
    expect(data.action).toBe(expected);
  });
});
