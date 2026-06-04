/**
 * Unit tests for the signup-metadata choke point
 * (Surveillance-hardening Phase 0, E2 / P3).
 *
 * Fully mocked — no real DB. Asserts, per user-creation path:
 *   - the User signup-metadata fields (signupMethod + invitationId)
 *   - exactly one `signup` SecurityEvent emitted, carrying IP/UA only where a
 *     request context exists (Cognito triggers carry neither)
 *   - the redeemed invitation FK flows into both the User fields and the event
 *   - fail-open: a SecurityEvent insert rejection does NOT throw / block signup
 *   - retentionUntil honors config (default 180d, override, invalid fallback)
 *
 * Reference: plans/surveillance-hardening-phase0/03-signup-metadata-capture.md
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIGNUP_EVENT_RETENTION_DAYS,
  computeSignupRetentionUntil,
  emitSignupSecurityEvent,
  resolveSignupRetentionDays,
  signupUserData,
} from "../../src/lib/signup-metadata";

const FIXED_NOW = new Date("2026-06-04T00:00:00.000Z");

function makeDb() {
  const create = vi.fn().mockResolvedValue({ id: "se-1" });
  return { db: { securityEvent: { create } }, create };
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

describe("signupUserData (User-row field assembly)", () => {
  it("COGNITO signup: method set, no invitation FK", () => {
    expect(signupUserData({ method: "COGNITO" })).toEqual({
      signupMethod: "COGNITO",
      invitationId: null,
    });
  });

  it("MAGIC_LINK signup: method set, no invitation FK", () => {
    expect(signupUserData({ method: "MAGIC_LINK" })).toEqual({
      signupMethod: "MAGIC_LINK",
      invitationId: null,
    });
  });

  it("INVITE signup: method + redeemed invitation FK", () => {
    expect(
      signupUserData({ method: "INVITE", invitationId: "inv-abc" }),
    ).toEqual({ signupMethod: "INVITE", invitationId: "inv-abc" });
  });

  it("never fabricates an invitation FK for non-INVITE methods", () => {
    // Even if an invitationId is mistakenly supplied, a COGNITO signup must not
    // carry it — only INVITE signups link an invitation.
    expect(
      signupUserData({ method: "COGNITO", invitationId: "inv-leak" }),
    ).toEqual({ signupMethod: "COGNITO", invitationId: null });
  });

  it("INVITE with no id resolves to null FK (still a valid signup)", () => {
    expect(signupUserData({ method: "INVITE" })).toEqual({
      signupMethod: "INVITE",
      invitationId: null,
    });
  });
});

describe("emitSignupSecurityEvent — per-path emission", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Cognito trigger path: one `signup` event, NO fabricated IP/UA", async () => {
    const { db, create } = makeDb();

    const ok = await emitSignupSecurityEvent({
      db,
      userId: "user-cognito",
      method: "COGNITO",
      tenantId: "tenant-personal",
      // No `signals` — a Cognito PostConfirmation Lambda has no client IP/UA.
      config: undefined,
      now: FIXED_NOW,
    });

    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data.type).toBe("signup");
    expect(data.severity).toBe("low");
    expect(data.userId).toBe("user-cognito");
    expect(data.tenantId).toBe("tenant-personal");
    // CRITICAL: no fabricated client signals.
    expect(data.ipAddress).toBeNull();
    expect(data.userAgent).toBeNull();
    expect(JSON.parse(data.details)).toEqual({
      signupMethod: "COGNITO",
      invitationId: null,
    });
    expect(data.retentionUntil).toBeInstanceOf(Date);
  });

  it("invitation redemption path: carries invitation FK + client signals", async () => {
    const { db, create } = makeDb();

    await emitSignupSecurityEvent({
      db,
      userId: "user-invited",
      method: "INVITE",
      invitationId: "inv-xyz",
      tenantId: "tenant-personal",
      signals: { ipAddress: "203.0.113.7", userAgent: "Mozilla/5.0 test" },
      config: undefined,
      now: FIXED_NOW,
    });

    const data = create.mock.calls[0][0].data;
    expect(data.type).toBe("signup");
    expect(data.userId).toBe("user-invited");
    expect(data.ipAddress).toBe("203.0.113.7");
    expect(data.userAgent).toBe("Mozilla/5.0 test");
    expect(JSON.parse(data.details)).toEqual({
      signupMethod: "INVITE",
      invitationId: "inv-xyz",
    });
  });

  it("magic-link path: one `signup` event with MAGIC_LINK method", async () => {
    const { db, create } = makeDb();

    await emitSignupSecurityEvent({
      db,
      userId: "user-magic",
      method: "MAGIC_LINK",
      tenantId: null,
      signals: { ipAddress: "198.51.100.4", userAgent: "cli/1.0" },
      config: undefined,
      now: FIXED_NOW,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data.userId).toBe("user-magic");
    expect(data.tenantId).toBeNull();
    expect(JSON.parse(data.details).signupMethod).toBe("MAGIC_LINK");
  });

  it("seed/no-context path: method recorded, no fabricated IP/UA", async () => {
    const { db, create } = makeDb();

    await emitSignupSecurityEvent({
      db,
      userId: "user-seed",
      method: "COGNITO",
      // No tenant, no signals — a seed script.
      config: undefined,
      now: FIXED_NOW,
    });

    const data = create.mock.calls[0][0].data;
    expect(data.ipAddress).toBeNull();
    expect(data.userAgent).toBeNull();
    expect(data.tenantId).toBeNull();
  });
});

describe("emitSignupSecurityEvent — FK integrity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("the event's invitationId matches the redeemed invitation", async () => {
    const { db, create } = makeDb();
    const redeemed = "inv-the-one-redeemed";

    const fields = signupUserData({ method: "INVITE", invitationId: redeemed });
    await emitSignupSecurityEvent({
      db,
      userId: "user-fk",
      method: fields.signupMethod,
      invitationId: fields.invitationId,
      config: undefined,
      now: FIXED_NOW,
    });

    // The User-row FK and the event's recorded invitation are the SAME id.
    expect(fields.invitationId).toBe(redeemed);
    expect(JSON.parse(create.mock.calls[0][0].data.details).invitationId).toBe(
      redeemed,
    );
  });
});

describe("emitSignupSecurityEvent — fail-open", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does NOT throw and returns false when the insert rejects", async () => {
    const create = vi.fn().mockRejectedValue(new Error("DB down"));
    const db = { securityEvent: { create } };
    const warn = vi.fn();

    let result: boolean | undefined;
    await expect(
      (async () => {
        result = await emitSignupSecurityEvent({
          db,
          userId: "user-fail-open",
          method: "COGNITO",
          config: undefined,
          logger: { warn },
          now: FIXED_NOW,
        });
      })(),
    ).resolves.toBeUndefined(); // signup is never blocked by telemetry

    expect(result).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    // The failure is logged (fail-open is observable), not silent.
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("retention bound (config-driven, never unbounded)", () => {
  it("defaults to 180 days when unset", () => {
    expect(resolveSignupRetentionDays(undefined)).toBe(
      DEFAULT_SIGNUP_EVENT_RETENTION_DAYS,
    );
    expect(DEFAULT_SIGNUP_EVENT_RETENTION_DAYS).toBe(180);
  });

  it("honors a configured override (string or number)", () => {
    expect(
      resolveSignupRetentionDays({ SIGNUP_EVENT_RETENTION_DAYS: "30" }),
    ).toBe(30);
    expect(
      resolveSignupRetentionDays({ SIGNUP_EVENT_RETENTION_DAYS: 45 }),
    ).toBe(45);
  });

  it("falls back to the default for invalid / non-positive values", () => {
    for (const bad of ["", "abc", "0", "-5", undefined]) {
      expect(
        resolveSignupRetentionDays({ SIGNUP_EVENT_RETENTION_DAYS: bad as any }),
      ).toBe(DEFAULT_SIGNUP_EVENT_RETENTION_DAYS);
    }
  });

  it("computeSignupRetentionUntil = now + configured days", () => {
    const until = computeSignupRetentionUntil(
      { SIGNUP_EVENT_RETENTION_DAYS: "90" },
      FIXED_NOW,
    );
    expect(daysBetween(FIXED_NOW, until)).toBe(90);
  });

  it("emitted event's retentionUntil honors config", async () => {
    const { db, create } = makeDb();
    await emitSignupSecurityEvent({
      db,
      userId: "user-ret",
      method: "COGNITO",
      config: { SIGNUP_EVENT_RETENTION_DAYS: "200" },
      now: FIXED_NOW,
    });
    const until: Date = create.mock.calls[0][0].data.retentionUntil;
    expect(daysBetween(FIXED_NOW, until)).toBe(200);
  });

  it("emitted event defaults to 180d when no config provided", async () => {
    const { db, create } = makeDb();
    await emitSignupSecurityEvent({
      db,
      userId: "user-ret-default",
      method: "INVITE",
      invitationId: "inv-1",
      config: undefined,
      now: FIXED_NOW,
    });
    const until: Date = create.mock.calls[0][0].data.retentionUntil;
    expect(daysBetween(FIXED_NOW, until)).toBe(180);
  });
});
