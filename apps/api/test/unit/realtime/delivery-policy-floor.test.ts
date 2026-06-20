/**
 * Track D — CalmDeliveryResolver floor enforcement (blocked-sender +
 * minor-protection), including the fail-loud mutation guards (spec §3).
 *
 * The floor is non-configurable: a blocked sender or a minor targeted by a
 * configured re-engagement type is HARD-DROPPED — no preference overrides it —
 * BUT critical-always types (SAFETY_ALERT / PARENTAL_LINK) still win, so safety
 * is never over-blocked.
 */

import { describe, expect, it } from "vitest";
import { CalmDeliveryResolver } from "../../../src/lib/realtime/index.js";
import type { DeliveryContext } from "../../../src/lib/realtime/index.js";
import type { NotificationType } from "@prisma/client";

// A SYNTHETIC re-engagement type to exercise the minor-protection drop. v1 ships
// the denylist EMPTY; we use a real enum member ("SENTIMENT_DIGEST") as the
// stand-in "manipulative re-engagement" type for the test only.
const REENGAGE: NotificationType = "SENTIMENT_DIGEST";

const OUTSIDE_QUIET = new Date(2026, 0, 1, 12, 0, 0);

function ctx(over: Partial<DeliveryContext>): DeliveryContext {
  return {
    type: "FOLLOW",
    recipientUserId: "user-a",
    tenantId: "tenant-a",
    now: OUTSIDE_QUIET,
    quietHours: null,
    ...over,
  } as DeliveryContext;
}

describe("floor — blocked sender", () => {
  const resolver = new CalmDeliveryResolver();

  it("drops with reason blocked_sender when senderUserId is present", () => {
    expect(resolver.decide(ctx({ senderUserId: "user-b" }))).toEqual({
      deliver: false,
      reason: "blocked_sender",
    });
  });

  it("delivers when no blocked sender signal is present", () => {
    expect(resolver.decide(ctx({}))).toEqual({ deliver: true });
  });

  it("critical-always types still deliver to a blocked sender (safety not over-blocked)", () => {
    for (const type of ["SAFETY_ALERT", "PARENTAL_LINK"] as const) {
      expect(
        resolver.decide(ctx({ type, senderUserId: "user-b" })),
      ).toEqual({ deliver: true });
    }
  });

  // FAIL-LOUD MUTATION GUARD: removing the isBlocked/senderUserId check in the
  // resolver turns this red. A "loosened" resolver that ignores senderUserId
  // delivers where the real one drops — the assertion distinguishes them.
  it("FAILS LOUDLY: a resolver that ignores senderUserId is detected", () => {
    const input = ctx({ senderUserId: "user-b" });
    const loosened = { decide: () => ({ deliver: true as const }) };
    expect(resolver.decide(input)).toEqual({
      deliver: false,
      reason: "blocked_sender",
    });
    expect(loosened.decide()).toEqual({ deliver: true });
    expect(loosened.decide()).not.toEqual(resolver.decide(input));
  });
});

describe("floor — minor protection", () => {
  const resolver = new CalmDeliveryResolver({
    reengagementTypes: new Set([REENGAGE]),
  });

  it("drops a re-engagement type to a CHILD recipient (reason floor)", () => {
    expect(
      resolver.decide(ctx({ type: REENGAGE, recipientAgeTier: "CHILD" })),
    ).toEqual({ deliver: false, reason: "floor" });
  });

  it("drops a re-engagement type to a TEEN recipient", () => {
    expect(
      resolver.decide(ctx({ type: REENGAGE, recipientAgeTier: "TEEN" })),
    ).toEqual({ deliver: false, reason: "floor" });
  });

  it("delivers a re-engagement type to an ADULT recipient", () => {
    expect(
      resolver.decide(ctx({ type: REENGAGE, recipientAgeTier: "ADULT" })),
    ).toEqual({ deliver: true });
  });

  it("delivers a NON-re-engagement type to a CHILD recipient", () => {
    expect(
      resolver.decide(ctx({ type: "FOLLOW", recipientAgeTier: "CHILD" })),
    ).toEqual({ deliver: true });
  });

  it("default (empty denylist) never minor-drops, even for a CHILD", () => {
    const empty = new CalmDeliveryResolver();
    expect(
      empty.decide(ctx({ type: REENGAGE, recipientAgeTier: "CHILD" })),
    ).toEqual({ deliver: true });
  });

  it("critical-always types still deliver to a minor (safety not over-blocked)", () => {
    for (const type of ["SAFETY_ALERT", "PARENTAL_LINK"] as const) {
      expect(
        resolver.decide(ctx({ type, recipientAgeTier: "CHILD" })),
      ).toEqual({ deliver: true });
    }
  });

  // FAIL-LOUD MUTATION GUARD: removing the minor branch turns this red.
  it("FAILS LOUDLY: a resolver missing the minor branch is detected", () => {
    const input = ctx({ type: REENGAGE, recipientAgeTier: "CHILD" });
    // A resolver WITHOUT the minor branch (empty denylist == branch never fires)
    // delivers where the configured one drops.
    const withoutMinorBranch = new CalmDeliveryResolver();
    expect(resolver.decide(input)).toEqual({ deliver: false, reason: "floor" });
    expect(withoutMinorBranch.decide(input)).toEqual({ deliver: true });
    expect(withoutMinorBranch.decide(input)).not.toEqual(
      resolver.decide(input),
    );
  });
});
