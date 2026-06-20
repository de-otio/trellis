/**
 * WS4 — createNotification content-free push hand-off (handler-level).
 *
 * Complements test/unit/realtime/notification-deliver.test.ts (the WS1 gate)
 * with the WS4-owned behavior:
 *
 *  - Floor-on-push: the push fires ONLY when the resolver decides deliver. A
 *    blocked_sender / preference / quiet_hours drop => no push. SAFETY_ALERT and
 *    PARENTAL_LINK ALWAYS push (and onto the floor "safety" channel). This is
 *    verified by injecting a resolver into the handler so floor OUTCOMES are
 *    exercised without reaching into WS1-owned floor logic.
 *  - DeliveryContext enrichment: recipientAgeTier (from User.ageTier) and
 *    senderUserId (from the notification payload's actor stamp) are passed to
 *    the resolver, so the floor has its minor-protection / blocked-sender inputs.
 *  - Content-free wire payload: the bytes the transport receives decode to a
 *    bare WakeupEnvelope — no title/body/data.
 *  - Best-effort: a transport throw never rolls back the persisted row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import type {
  Channel,
  DeliveryContext,
  DeliveryDecision,
  DeliveryPolicyResolver,
  RealtimeTransport,
} from "../../src/lib/realtime/index.js";
import { decodeWakeup } from "../../src/lib/realtime/index.js";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    notification: { create: vi.fn() },
    notificationPreference: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    // Track D: default block store delegate — not blocked unless overridden.
    blockedUser: { findUnique: vi.fn().mockResolvedValue(null) },
    release: vi.fn(),
  },
}));

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

import { NotificationHandler } from "../../src/lib/notification-handler.js";

const TENANT = "tenant-1";
const USER = "user-1";

/** A resolver whose decision is fixed, recording every context it saw. */
class StubResolver implements DeliveryPolicyResolver {
  readonly seen: DeliveryContext[] = [];
  constructor(private readonly decision: DeliveryDecision) {}
  decide(ctx: DeliveryContext): DeliveryDecision {
    this.seen.push(ctx);
    return this.decision;
  }
}

function makeTransport(impl?: () => Promise<unknown>): {
  transport: RealtimeTransport;
  deliver: ReturnType<typeof vi.fn>;
} {
  const deliver = vi.fn(impl ?? (async () => ({ delivered: true as const })));
  const transport = {
    kind: "appsync-events" as const,
    deliver,
    async getSetting() {
      return null;
    },
    async putSetting() {
      return { ok: false as const, reason: "not_found" as const, current: null };
    },
  };
  return { transport, deliver };
}

function makeEnv(transport: RealtimeTransport, push = true): Env {
  return {
    DATABASE_URL: "postgresql://t:t@localhost:5432/t",
    SESSION_SECRET: "test-secret-32-characters-long!!",
    features: { realtimeTransport: "appsync-events", realtimePush: push },
    realtimeTransport: transport,
  } as unknown as Env;
}

describe("WS4 content-free push hand-off", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.release.mockResolvedValue(undefined);
    mockPrisma.notification.create.mockResolvedValue({ id: "notif-1" });
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
    mockPrisma.blockedUser.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({
      quietHoursEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
      ageTier: "ADULT",
    });
  });

  describe("floor-on-push", () => {
    it("blocked_sender => HARD DROP: no row, no push, id ''", async () => {
      // Track D: a blocked_sender decision is a floor drop, not a deferral —
      // the notification is suppressed entirely (no row), so it can never be
      // read back via polling. (Pre-Track-D this persisted a deliveredAt=null
      // row; the floor now enforces.)
      const resolver = new StubResolver({
        deliver: false,
        reason: "blocked_sender",
      });
      const handler = new NotificationHandler(resolver);
      const { transport, deliver } = makeTransport();

      const r = await handler.createNotification(
        USER,
        "DIRECT_MESSAGE",
        "t",
        "b",
        { senderUserId: "blocked-bob" },
        makeEnv(transport),
        TENANT,
      );

      expect(r.id).toBe(""); // suppressed
      expect(mockPrisma.notification.create).not.toHaveBeenCalled(); // no row
      expect(deliver).not.toHaveBeenCalled(); // no push
    });

    it("SAFETY_ALERT ALWAYS pushes onto the safety channel (bypasses resolver drop)", async () => {
      // Even a resolver that would drop everything cannot suppress ALWAYS_DELIVER:
      // the handler bypasses the resolver for SAFETY_ALERT/PARENTAL_LINK and the
      // decision delivers. (The WS1 CalmDeliveryResolver returns deliver:true for
      // these; here we confirm the handler routes to "safety" regardless.)
      const handler = new NotificationHandler(); // real WS1 floor
      const { transport, deliver } = makeTransport();

      await handler.createNotification(
        USER,
        "SAFETY_ALERT",
        "t",
        "b",
        {},
        makeEnv(transport),
        TENANT,
      );

      expect(deliver).toHaveBeenCalledTimes(1);
      const channel = deliver.mock.calls[0][1] as Channel;
      expect(channel.kind).toBe("safety");
    });

    it("PARENTAL_LINK ALWAYS pushes onto the safety channel", async () => {
      const handler = new NotificationHandler();
      const { transport, deliver } = makeTransport();

      await handler.createNotification(
        USER,
        "PARENTAL_LINK",
        "t",
        "b",
        {},
        makeEnv(transport),
        TENANT,
      );

      expect(deliver).toHaveBeenCalledTimes(1);
      expect((deliver.mock.calls[0][1] as Channel).kind).toBe("safety");
    });

    it("quiet_hours deferral => row persisted, NO push", async () => {
      const resolver = new StubResolver({
        deliver: false,
        reason: "quiet_hours",
      });
      const handler = new NotificationHandler(resolver);
      const { transport, deliver } = makeTransport();

      const r = await handler.createNotification(
        USER,
        "FOLLOW",
        "t",
        "b",
        {},
        makeEnv(transport),
        TENANT,
      );

      expect(r.id).toBe("notif-1");
      expect(deliver).not.toHaveBeenCalled();
    });

    it("deliver decision => exactly one wakeup push", async () => {
      const resolver = new StubResolver({ deliver: true });
      const handler = new NotificationHandler(resolver);
      const { transport, deliver } = makeTransport();

      await handler.createNotification(
        USER,
        "FOLLOW",
        "t",
        "b",
        {},
        makeEnv(transport),
        TENANT,
      );

      expect(deliver).toHaveBeenCalledTimes(1);
      expect((deliver.mock.calls[0][1] as Channel).kind).toBe("wakeup");
    });
  });

  describe("DeliveryContext enrichment", () => {
    it("passes recipientAgeTier (minor-protection floor input) to the resolver", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        quietHoursEnabled: false,
        quietHoursStart: null,
        quietHoursEnd: null,
        ageTier: "CHILD",
      });
      const resolver = new StubResolver({ deliver: true });
      const handler = new NotificationHandler(resolver);
      const { transport } = makeTransport();

      await handler.createNotification(
        USER,
        "FOLLOW",
        "t",
        "b",
        {},
        makeEnv(transport),
        TENANT,
      );

      expect(resolver.seen).toHaveLength(1);
      expect(resolver.seen[0].recipientAgeTier).toBe("CHILD");
    });

    it("passes senderUserId to the resolver ONLY when the recipient has blocked that sender", async () => {
      // Track D: the async block-set lookup happens caller-side; the resolver
      // sees `senderUserId` only when blocked (presence == deny signal).
      mockPrisma.blockedUser.findUnique.mockResolvedValue({ id: "block-1" });
      const resolver = new StubResolver({ deliver: true });
      const handler = new NotificationHandler(resolver);
      const { transport } = makeTransport();

      await handler.createNotification(
        USER,
        "DIRECT_MESSAGE",
        "t",
        "b",
        { actorId: "carol-the-sender" },
        makeEnv(transport),
        TENANT,
      );

      expect(resolver.seen[0].senderUserId).toBe("carol-the-sender");
      expect(mockPrisma.blockedUser.findUnique).toHaveBeenCalledWith({
        where: {
          tenantId_blockerId_blockedId: {
            tenantId: TENANT,
            blockerId: USER,
            blockedId: "carol-the-sender",
          },
        },
        select: { id: true },
      });
    });

    it("does NOT pass senderUserId when the sender is NOT blocked (stamp present but unblocked)", async () => {
      mockPrisma.blockedUser.findUnique.mockResolvedValue(null); // not blocked
      const resolver = new StubResolver({ deliver: true });
      const handler = new NotificationHandler(resolver);
      const { transport } = makeTransport();

      await handler.createNotification(
        USER,
        "DIRECT_MESSAGE",
        "t",
        "b",
        { actorId: "carol-the-sender" },
        makeEnv(transport),
        TENANT,
      );

      expect(resolver.seen[0].senderUserId).toBeUndefined();
    });

    it("omits senderUserId when the payload has no actor stamp (no block lookup)", async () => {
      const resolver = new StubResolver({ deliver: true });
      const handler = new NotificationHandler(resolver);
      const { transport } = makeTransport();

      await handler.createNotification(
        USER,
        "FOLLOW",
        "t",
        "b",
        { unrelated: 42 },
        makeEnv(transport),
        TENANT,
      );

      expect(resolver.seen[0].senderUserId).toBeUndefined();
      expect(mockPrisma.blockedUser.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("content-free wire payload", () => {
    it("the bytes the transport receives decode to a bare WakeupEnvelope", async () => {
      const resolver = new StubResolver({ deliver: true });
      const handler = new NotificationHandler(resolver);
      const { transport, deliver } = makeTransport();

      await handler.createNotification(
        USER,
        "FOLLOW",
        "Secret Title",
        "Secret Body Content",
        { secret: "payload-data" },
        makeEnv(transport),
        TENANT,
      );

      const payload = deliver.mock.calls[0][2] as Uint8Array;
      expect(decodeWakeup(payload)).toEqual({ v: 1, kind: "wakeup" });
      // The sensitive title/body/data never appear on the wire.
      const wire = new TextDecoder().decode(payload);
      expect(wire).not.toContain("Secret Title");
      expect(wire).not.toContain("Secret Body Content");
      expect(wire).not.toContain("payload-data");
    });
  });

  describe("best-effort", () => {
    it("a transport throw never rolls back the persisted row", async () => {
      const resolver = new StubResolver({ deliver: true });
      const handler = new NotificationHandler(resolver);
      const { transport, deliver } = makeTransport(async () => {
        throw new Error("socket boom");
      });

      const r = await handler.createNotification(
        USER,
        "FOLLOW",
        "t",
        "b",
        {},
        makeEnv(transport),
        TENANT,
      );

      expect(r.id).toBe("notif-1");
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    });

    it("no push at all when features.realtimePush is off (default-safe)", async () => {
      const resolver = new StubResolver({ deliver: true });
      const handler = new NotificationHandler(resolver);
      const { transport, deliver } = makeTransport();

      await handler.createNotification(
        USER,
        "FOLLOW",
        "t",
        "b",
        {},
        makeEnv(transport, /* push */ false),
        TENANT,
      );

      expect(deliver).not.toHaveBeenCalled();
    });
  });
});
