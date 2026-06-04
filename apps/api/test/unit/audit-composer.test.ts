/**
 * Unit Tests: TrellisAuditLogger (audit-composer, phase 1.C.2)
 *
 * The composer writes through foundation's `AuditLog` /
 * `PostgresAuditStore`. The DB side effect we assert on is the
 * `auditEvent.create` call against the Prisma client returned by
 * `createPrismaForRegion` — NO mock of `@de-otio/*`. Region validation,
 * severity->tier collapse, retention, and the allowlist scrub are all
 * verified through that single observable.
 *
 * The operator-facing "[Audit] <action> ..." log line is asserted via
 * `createTestLogCapture` (foundation logger), as before.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestLogCapture,
  type LogRecord,
} from "@de-otio/saas-foundation/logger";
import {
  TrellisAuditLogger,
  createAuditLogger,
  type TrellisAuditLoggerEnv,
} from "../../src/lib/audit-composer.js";

// ── Prisma mock: createPrismaForRegion returns a structural client ────
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

const { auditEventCreate } = vi.hoisted(() => ({
  auditEventCreate: vi.fn(),
}));

vi.mock("../../src/db", () => ({
  createPrismaForRegion: vi.fn(() => ({
    auditEvent: { create: auditEventCreate },
  })),
}));

vi.mock("../../src/lib/region-detection", () => {
  const isValidRegion = vi.fn((region: string) => ["US", "EU", "CN"].includes(region));
  return { isValidRegion };
});

function lastCreate(): CreateArg["data"] {
  const call = auditEventCreate.mock.calls.at(-1);
  return (call?.[0] as CreateArg).data;
}

describe("TrellisAuditLogger", () => {
  let capture: ReturnType<typeof createTestLogCapture>;

  const env = (): TrellisAuditLoggerEnv => ({
    DATABASE_URL: "postgres://test",
    DEFAULT_REGION: "US",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    auditEventCreate.mockResolvedValue({ id: "row-1" });
    capture = createTestLogCapture();
    capture.installAsRoot();
  });

  afterEach(() => {
    capture.restore();
  });

  describe("data access", () => {
    it("writes an audit_event row for a data-access event", async () => {
      const logger = new TrellisAuditLogger(env());
      await logger.logDataAccess(
        {
          action: "user_accessed",
          resource: "user",
          resourceId: "user-123",
          userId: "user-456",
          region: "US",
          dataRegion: "US",
          success: true,
        },
        env(),
      );

      expect(auditEventCreate).toHaveBeenCalledTimes(1);
      const data = lastCreate();
      expect(data.action).toBe("data.read");
      expect(data.actorKind).toBe("user");
      expect(data.actorId).toBe("user-456");
      expect(data.outcome).toBe("success");
      expect(data.resourceKind).toBe("user");
      expect(data.resourceId).toBe("user-123");
    });

    it("anonymous actor when no userId is supplied", async () => {
      const logger = new TrellisAuditLogger(env());
      await logger.logDataAccess(
        { action: "post_accessed", resource: "post", region: "CN", success: true },
        env(),
      );
      const data = lastCreate();
      expect(data.actorKind).toBe("anonymous");
    });

    it("drops events with an invalid region (no DB write)", async () => {
      const logger = new TrellisAuditLogger(env());
      await logger.logDataAccess(
        { action: "user_accessed", resource: "user", region: "INVALID" as never, success: true },
        env(),
      );
      expect(auditEventCreate).not.toHaveBeenCalled();
    });
  });

  describe("severity -> foundation-tier collapse", () => {
    it.each([
      ["low", "info"],
      ["medium", "info"],
      ["high", "warning"],
      ["critical", "error"],
    ] as const)("maps trellis %s to foundation %s", async (sev, tier) => {
      const logger = new TrellisAuditLogger(env());
      await logger.logDataAccess(
        { action: "x", resource: "user", region: "US", severity: sev, success: true },
        env(),
      );
      expect(lastCreate().severity).toBe(tier);
    });
  });

  describe("retention tiers (info 30 / warning 90 / error 365)", () => {
    it.each([
      ["low", 30],
      ["high", 90],
      ["critical", 365],
    ] as const)("severity %s -> ~%d days retentionUntil", async (sev, days) => {
      const logger = new TrellisAuditLogger(env());
      await logger.logDataAccess(
        { action: "x", resource: "user", region: "US", severity: sev, success: true },
        env(),
      );
      const data = lastCreate();
      const daysFromNow = Math.round(
        (data.retentionUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      expect(daysFromNow).toBeGreaterThanOrEqual(days - 1);
      expect(daysFromNow).toBeLessThanOrEqual(days + 1);
    });
  });

  describe("failed events", () => {
    it("sets outcome=failure and a warning severity for failed authz", async () => {
      const logger = new TrellisAuditLogger(env());
      await logger.logAuthorization(
        { action: "access_denied", resource: "post", region: "US", success: false },
        env(),
      );
      const data = lastCreate();
      expect(data.outcome).toBe("failure");
      expect(data.severity).toBe("warning"); // high -> warning
    });

    it("carries an error string into failureReason", async () => {
      const logger = new TrellisAuditLogger(env());
      await logger.logDataAccess(
        {
          action: "user_accessed",
          resource: "user",
          region: "US",
          success: false,
          metadata: { error: "Access denied" },
        },
        env(),
      );
      expect(lastCreate().failureReason).toBe("Access denied");
    });
  });

  describe("allowlist PII scrub on metadata", () => {
    it("keeps region codes (allowlisted) and redacts non-allowlisted keys", async () => {
      const logger = new TrellisAuditLogger(env());
      await logger.logUserAction(
        {
          action: "user_updated",
          resource: "user",
          userId: "u1",
          region: "US",
          dataRegion: "EU",
          metadata: { updatedFields: ["email"], secretClaim: "value" },
          success: true,
        },
        env(),
      );
      const metadata = lastCreate().metadata as Record<string, unknown>;
      expect(metadata.region).toBe("US");
      expect(metadata.dataRegion).toBe("EU");
      // not on the allowlist -> redacted
      expect(metadata.updatedFields).toBe("<redacted>");
      expect(metadata.secretClaim).toBe("<redacted>");
    });

    it("anonymises ipAddress to /24 on the dedicated column", async () => {
      const logger = new TrellisAuditLogger(env());
      await logger.logDataAccess(
        {
          action: "user_accessed",
          resource: "user",
          region: "US",
          ipAddress: "203.0.113.55",
          success: true,
        },
        env(),
      );
      expect(lastCreate().ipAddress).toBe("203.0.113.0/24");
    });
  });

  describe("best-effort", () => {
    it("does not throw when the store write fails", async () => {
      auditEventCreate.mockRejectedValueOnce(new Error("DB error"));
      const logger = new TrellisAuditLogger(env());
      await expect(
        logger.logDataAccess(
          { action: "user_accessed", resource: "user", region: "US", success: true },
          env(),
        ),
      ).resolves.not.toThrow();
    });
  });

  describe("operator-facing audit log line", () => {
    it("emits an info-level [Audit] record for success", async () => {
      const logger = new TrellisAuditLogger(env());
      await logger.logDataAccess(
        { action: "user_accessed", resource: "user", region: "US", success: true },
        env(),
      );
      const records = capture.entries().filter((e: LogRecord) => /\[Audit\]/.test(e.msg));
      expect(records).toContainEqual(
        expect.objectContaining({
          level: "info",
          action: "user_accessed",
          resource: "user",
          region: "US",
        }),
      );
    });

    it("emits a warn-level [Audit] record for failure", async () => {
      const logger = new TrellisAuditLogger(env());
      await logger.logDataAccess(
        {
          action: "user_accessed",
          resource: "user",
          region: "US",
          success: false,
          metadata: { error: "denied" },
        },
        env(),
      );
      const records = capture.entries().filter((e: LogRecord) => /\[Audit\]/.test(e.msg));
      expect(records.some((e: LogRecord) => e.level === "warn")).toBe(true);
    });
  });

  describe("factory + withRequestId", () => {
    it("createAuditLogger returns a TrellisAuditLogger", () => {
      expect(createAuditLogger(env())).toBeInstanceOf(TrellisAuditLogger);
    });

    it("withRequestId returns a new instance and stamps requestId", async () => {
      const base = new TrellisAuditLogger(env());
      const withId = base.withRequestId("req-9");
      expect(withId).toBeInstanceOf(TrellisAuditLogger);
      expect(withId).not.toBe(base);

      await withId.logDataAccess(
        { action: "x", resource: "user", region: "US", success: true },
        env(),
      );
      expect(lastCreate().requestId).toBe("req-9");
    });
  });

  describe("event-type -> action mapping", () => {
    it.each([
      ["data_create", "data.create"],
      ["data_update", "data.update"],
      ["data_delete", "data.delete"],
      ["region_change", "system.region_change"],
      ["authentication", "auth.login"],
    ] as const)("maps %s to %s", async (type, action) => {
      const logger = new TrellisAuditLogger(env());
      await logger.log(
        { type: type as never, action: "act", resource: "user", region: "US", success: true },
        env(),
      );
      expect(lastCreate().action).toBe(action);
    });
  });
});
