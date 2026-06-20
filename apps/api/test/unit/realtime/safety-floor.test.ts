/**
 * WS7 — the safety-floor "fails loudly" suite (ws-07 §5).
 *
 * The old global notification invariant survives as the non-configurable FLOOR
 * inside CalmDeliveryResolver. The floor fences EVERY transport equally, so
 * these tests run against the resolver and against the transports that embed it.
 *
 * "Fails loudly" contract: each guard, when run against a DELIBERATELY loosened
 * resolver that violates the invariant, must detect the violation — i.e. the
 * assertion the real resolver passes is exactly the one a loosened resolver
 * would fail. We make that explicit by asserting the loosened resolver diverges.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ALWAYS_DELIVER_TYPES,
  CalmDeliveryResolver,
  NoopRealtimeTransport,
  PollTransport,
  InMemorySettingStore,
} from "../../../src/lib/realtime/index.js";
import type {
  Channel,
  DeliveryContext,
  DeliveryDecision,
  DeliveryPolicyResolver,
  DeliveryTarget,
  QuietHoursConfig,
} from "../../../src/lib/realtime/index.js";

const resolver = new CalmDeliveryResolver();

const QUIET: QuietHoursConfig = { enabled: true, start: "1320", end: "420" };
const INSIDE_QUIET = new Date(2026, 0, 1, 23, 30, 0);
const OUTSIDE_QUIET = new Date(2026, 0, 1, 12, 0, 0);

function ctx(over: Partial<DeliveryContext>): DeliveryContext {
  return {
    type: "FOLLOW",
    recipientUserId: "u",
    tenantId: "t",
    now: OUTSIDE_QUIET,
    quietHours: null,
    ...over,
  };
}

describe("safety floor — critical types ALWAYS deliver", () => {
  it("the always-deliver set is exactly SAFETY_ALERT + PARENTAL_LINK", () => {
    expect([...ALWAYS_DELIVER_TYPES].sort()).toEqual([
      "PARENTAL_LINK",
      "SAFETY_ALERT",
    ]);
  });

  it("SAFETY_ALERT and PARENTAL_LINK bypass quiet hours (floor)", () => {
    for (const type of ALWAYS_DELIVER_TYPES) {
      const d = resolver.decide(
        ctx({ type, quietHours: QUIET, now: INSIDE_QUIET }),
      );
      expect(d).toEqual({ deliver: true });
    }
  });

  it("FAILS LOUDLY: a resolver that suppresses a critical type in quiet hours is detected", () => {
    // A loosened resolver that (wrongly) applies quiet hours to critical types.
    const loosened: DeliveryPolicyResolver = {
      decide: (c) =>
        c.now.getHours() === 23
          ? { deliver: false, reason: "quiet_hours" }
          : { deliver: true },
    };
    const input = ctx({
      type: "SAFETY_ALERT",
      quietHours: QUIET,
      now: INSIDE_QUIET,
    });
    // The REAL resolver delivers (floor); the loosened one suppresses.
    expect(resolver.decide(input)).toEqual({ deliver: true });
    expect(loosened.decide(input)).toEqual({
      deliver: false,
      reason: "quiet_hours",
    });
    // The guard distinguishes them — so a regression to the loosened behavior
    // flips this assertion and fails the build.
    expect(loosened.decide(input)).not.toEqual(resolver.decide(input));
  });
});

describe("safety floor — declined categories are dropped by the fence, not the transport", () => {
  it("a non-critical type inside quiet hours is deferred (declined by the fence)", () => {
    expect(
      resolver.decide(ctx({ type: "FOLLOW", quietHours: QUIET, now: INSIDE_QUIET })),
    ).toEqual({ deliver: false, reason: "quiet_hours" });
  });

  it("FAILS LOUDLY: a resolver that ignores quiet hours for declined categories is detected", () => {
    const loosened: DeliveryPolicyResolver = {
      decide: () => ({ deliver: true }), // ignores quiet hours entirely
    };
    const input = ctx({ type: "FOLLOW", quietHours: QUIET, now: INSIDE_QUIET });
    expect(resolver.decide(input)).toEqual({
      deliver: false,
      reason: "quiet_hours",
    });
    expect(loosened.decide(input)).toEqual({ deliver: true });
    expect(loosened.decide(input)).not.toEqual(resolver.decide(input));
  });
});

// ---------------------------------------------------------------------------
// The fence runs INSIDE every transport — a denied decision yields no send on
// poll AND noop, and a loosened resolver that flips deny->permit is detected by
// the result reason changing from policy_denied.
// ---------------------------------------------------------------------------
describe("safety floor — the fence gates every transport", () => {
  const target: DeliveryTarget = { userId: "u", tenantId: "t" };
  const wakeup: Channel = {
    kind: "wakeup",
    tenantId: "t",
    scopeType: "user",
    scopeId: "u",
  };

  for (const make of [
    {
      name: "PollTransport",
      build: (p: DeliveryPolicyResolver) =>
        new PollTransport(new InMemorySettingStore(), p),
    },
    {
      name: "NoopRealtimeTransport",
      build: (p: DeliveryPolicyResolver) => new NoopRealtimeTransport(p),
    },
  ]) {
    it(`${make.name}: a fenced-deny decision drops with policy_denied`, async () => {
      const deny = vi.fn(
        (): DeliveryDecision => ({ deliver: false, reason: "quiet_hours" }),
      );
      const t = make.build({ decide: deny });
      const r = await t.deliver(target, wakeup, new Uint8Array(0));
      expect(deny).toHaveBeenCalledTimes(1);
      expect(r).toEqual({ delivered: false, reason: "policy_denied" });
    });

    it(`${make.name}: FAILS LOUDLY — a loosened (always-permit) resolver changes the result away from policy_denied`, async () => {
      const fencedDeny = make.build({
        decide: (): DeliveryDecision => ({
          deliver: false,
          reason: "quiet_hours",
        }),
      });
      const loosened = make.build({
        decide: (): DeliveryDecision => ({ deliver: true }),
      });
      const denied = await fencedDeny.deliver(target, wakeup, new Uint8Array(0));
      const permitted = await loosened.deliver(
        target,
        wakeup,
        new Uint8Array(0),
      );
      expect(denied).toEqual({ delivered: false, reason: "policy_denied" });
      // Loosening the fence is observable at the transport boundary — the guard
      // catches the regression because the result reason changes.
      expect(permitted).not.toEqual(denied);
      if (!permitted.delivered) {
        expect(permitted.reason).not.toBe("policy_denied");
      }
    });
  }
});
