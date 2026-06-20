/**
 * CalmDeliveryResolver decisions + the policy fence on every transport.
 *
 * Mirrors the floor the golden test pins, at the resolver level:
 *   - ALWAYS_DELIVER types bypass quiet hours.
 *   - quiet hours defer non-bypass types.
 *   - NoopRealtimeTransport ALSO runs the fence (drops on deny).
 */

import { describe, expect, it, vi } from "vitest";
import {
  CalmDeliveryResolver,
  ALWAYS_DELIVER_TYPES,
  NoopRealtimeTransport,
} from "../../../src/lib/realtime/index.js";
import type {
  DeliveryContext,
  QuietHoursConfig,
} from "../../../src/lib/realtime/index.js";

const resolver = new CalmDeliveryResolver();

// Overnight quiet window 22:00 (1320) -> 07:00 (420).
const QUIET: QuietHoursConfig = { enabled: true, start: "1320", end: "420" };
const INSIDE = new Date(2026, 0, 1, 23, 30, 0); // 23:30 local
const OUTSIDE = new Date(2026, 0, 1, 12, 0, 0); // 12:00 local

function ctx(over: Partial<DeliveryContext>): DeliveryContext {
  return {
    type: "FOLLOW",
    recipientUserId: "u",
    tenantId: "t",
    now: OUTSIDE,
    quietHours: null,
    ...over,
  };
}

describe("CalmDeliveryResolver", () => {
  it("ALWAYS_DELIVER_TYPES is exactly SAFETY_ALERT + PARENTAL_LINK", () => {
    expect([...ALWAYS_DELIVER_TYPES].sort()).toEqual([
      "PARENTAL_LINK",
      "SAFETY_ALERT",
    ]);
  });

  it("bypasses quiet hours for SAFETY_ALERT", () => {
    const d = resolver.decide(
      ctx({ type: "SAFETY_ALERT", quietHours: QUIET, now: INSIDE }),
    );
    expect(d).toEqual({ deliver: true });
  });

  it("bypasses quiet hours for PARENTAL_LINK", () => {
    const d = resolver.decide(
      ctx({ type: "PARENTAL_LINK", quietHours: QUIET, now: INSIDE }),
    );
    expect(d).toEqual({ deliver: true });
  });

  it("defers a non-bypass type inside quiet hours", () => {
    const d = resolver.decide(ctx({ quietHours: QUIET, now: INSIDE }));
    expect(d).toEqual({ deliver: false, reason: "quiet_hours" });
  });

  it("delivers a non-bypass type outside quiet hours", () => {
    const d = resolver.decide(ctx({ quietHours: QUIET, now: OUTSIDE }));
    expect(d).toEqual({ deliver: true });
  });

  it("delivers when quiet hours are disabled", () => {
    const d = resolver.decide(
      ctx({ quietHours: { enabled: false, start: "0", end: "0" }, now: INSIDE }),
    );
    expect(d).toEqual({ deliver: true });
  });

  it("delivers when quiet hours are null", () => {
    expect(resolver.decide(ctx({ quietHours: null, now: INSIDE }))).toEqual({
      deliver: true,
    });
  });

  it("handles a same-day quiet window (13:00->15:00)", () => {
    const sameDay: QuietHoursConfig = { enabled: true, start: "780", end: "900" };
    const at1400 = new Date(2026, 0, 1, 14, 0, 0);
    const at1600 = new Date(2026, 0, 1, 16, 0, 0);
    expect(resolver.decide(ctx({ quietHours: sameDay, now: at1400 }))).toEqual({
      deliver: false,
      reason: "quiet_hours",
    });
    expect(resolver.decide(ctx({ quietHours: sameDay, now: at1600 }))).toEqual({
      deliver: true,
    });
  });
});

describe("policy fence runs on NoopRealtimeTransport too", () => {
  it("noop deliver invokes the resolver and drops on deny", async () => {
    const decide = vi.fn(() => ({
      deliver: false as const,
      reason: "quiet_hours" as const,
    }));
    const t = new NoopRealtimeTransport({ decide });
    const r = await t.deliver(
      { userId: "u", tenantId: "t" },
      { kind: "wakeup", tenantId: "t", scopeType: "user", scopeId: "u" },
      new Uint8Array(0),
    );
    expect(decide).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ delivered: false, reason: "policy_denied" });
  });

  it("noop deliver returns no_transport when allowed", async () => {
    const t = new NoopRealtimeTransport({ decide: () => ({ deliver: true }) });
    const r = await t.deliver(
      { userId: "u", tenantId: "t" },
      { kind: "safety", tenantId: "t", scopeType: "user", scopeId: "u" },
      new Uint8Array(0),
    );
    expect(r).toEqual({ delivered: false, reason: "no_transport" });
  });

  it("noop getSetting/putSetting are inert", async () => {
    const t = new NoopRealtimeTransport({ decide: () => ({ deliver: true }) });
    expect(await t.getSetting("u", "ns")).toBeNull();
    expect(await t.putSetting("u", "ns", { ciphertext: "c", version: 0, updatedAt: "" }, 0)).toEqual(
      { ok: false, reason: "not_found", current: null },
    );
  });
});
