/**
 * Unit tests: EventNotificationProducer (R1, P1-E).
 *
 * Mocks Prisma (createPrisma) and injects the DeliveryPolicyResolver, per the
 * class's constructor DI. Covers: fan-out to GOING attendees only, preference
 * (eventEnabled) suppression, and debounce suppression of rapid repeats —
 * plus quiet-hours deliveredAt mapping, cancelled-path copy, batching, and the
 * bounded-pagination ceiling for the 80/80/80/80 gate.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    rsvp: {
      findMany: vi.fn(),
    },
    notificationPreference: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    notification: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    release: vi.fn(),
  },
}));

vi.mock("../../../src/db.js", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

import { EventNotificationProducer } from "../../../src/lib/events/event-notifications.js";
import type {
  EventNotificationContext,
  EventUpdatedNotification,
} from "../../../src/lib/events/seams.js";

const TENANT_ID = "tenant-1";
const EVENT_ID = "event-1";

function buildEnv(updateNotifyCooldownSeconds = 3600): Env {
  return {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REALTIME_REENGAGEMENT_TYPES: new Set(),
    event: {
      maxPerTenant: 500,
      maxShiftsPerEvent: 50,
      maxGuestsPerRsvp: 10,
      rsvpRatePerHour: 60,
      updateRatePerHour: 20,
      updateNotifyCooldownSeconds,
      listPageMax: 50,
    },
  } as unknown as Env;
}

function rsvp(userId: string, id = `rsvp-${userId}`) {
  return { id, userId };
}

function noQuietHoursUser() {
  return {
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    ageTier: "ADULT" as const,
  };
}

const UPDATED_INPUT: EventUpdatedNotification = {
  eventId: EVENT_ID,
  tenantId: TENANT_ID,
  title: "Community Picnic",
  startsAt: "2026-08-01T12:00:00.000Z",
  changedFields: ["startsAt"],
};

const CANCELLED_INPUT: EventNotificationContext = {
  eventId: EVENT_ID,
  tenantId: TENANT_ID,
  title: "Community Picnic",
  startsAt: "2026-08-01T12:00:00.000Z",
};

describe("EventNotificationProducer", () => {
  let producer: EventNotificationProducer;
  let now: Date;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.release.mockResolvedValue(undefined);
    mockPrisma.notification.findFirst.mockResolvedValue(null);
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue(noQuietHoursUser());
    mockPrisma.notification.create.mockResolvedValue({ id: "notif-1" });
    now = new Date("2026-07-10T12:00:00.000Z");
    producer = new EventNotificationProducer(null, () => now);
  });

  describe("notifyEventUpdated — fan-out", () => {
    it("notifies only the GOING attendees returned by the rsvp query and batches them", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([
        rsvp("user-a"),
        rsvp("user-b"),
      ]);

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv());

      expect(mockPrisma.rsvp.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId: EVENT_ID, tenantId: TENANT_ID, status: "GOING" },
        }),
      );
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(2);

      const calls = mockPrisma.notification.create.mock.calls.map(
        (args: any[]) => args[0].data,
      );
      expect(calls.map((d: any) => d.userId).sort()).toEqual([
        "user-a",
        "user-b",
      ]);
      // All rows in one round share one batchId, prefixed for the debounce lookup.
      const batchIds = new Set(calls.map((d: any) => d.batchId));
      expect(batchIds.size).toBe(1);
      expect([...batchIds][0]).toMatch(/^evt-updated-event-1-\d+$/);
      for (const data of calls) {
        expect(data.type).toBe("EVENT_UPDATED");
        expect(data.tenantId).toBe(TENANT_ID);
        expect(data.deliveredAt).toEqual(now);
      }
    });

    it("stops paging once a short page is returned (bounded fan-out)", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([rsvp("user-a")]);

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv());

      expect(mockPrisma.rsvp.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    });

    it("does nothing when there are no GOING attendees", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([]);

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv());

      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });
  });

  describe("preference suppression", () => {
    it("skips a recipient whose NotificationPreference.eventEnabled is false", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([
        rsvp("user-a"),
        rsvp("user-b"),
      ]);
      mockPrisma.notificationPreference.findUnique.mockImplementation(
        async ({ where: { userId } }: any) =>
          userId === "user-a"
            ? { userId, eventEnabled: false }
            : null,
      );

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv());

      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
      const data = mockPrisma.notification.create.mock.calls[0][0].data;
      expect(data.userId).toBe("user-b");
    });

    it("notifies when no preference row exists (default-on, matches NotificationHandler)", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([rsvp("user-a")]);
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv());

      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("delivery floor (quiet hours)", () => {
    it("creates the row with deliveredAt null when the recipient is in quiet hours", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([rsvp("user-a")]);
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      mockPrisma.user.findUnique.mockResolvedValue({
        quietHoursEnabled: true,
        quietHoursStart: (currentMinutes - 30 + 1440) % 1440,
        quietHoursEnd: (currentMinutes + 30) % 1440,
        ageTier: "ADULT",
      });

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv());

      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.create.mock.calls[0][0].data.deliveredAt).toBeNull();
    });
  });

  describe("debounce", () => {
    it("suppresses a repeat EVENT_UPDATED round within the cooldown window", async () => {
      // No rsvp.findMany mock queued here — debounce must short-circuit
      // BEFORE the attendee query runs, so nothing should ever consume it.
      mockPrisma.notification.findFirst.mockResolvedValueOnce({
        createdAt: new Date(now.getTime() - 60_000), // 1 minute ago
      });

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv(3600));

      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      expect(mockPrisma.rsvp.findMany).not.toHaveBeenCalled();
    });

    it("allows a new round once the cooldown has elapsed", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([rsvp("user-a")]);
      mockPrisma.notification.findFirst.mockResolvedValueOnce({
        createdAt: new Date(now.getTime() - 7200_000), // 2 hours ago
      });

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv(3600));

      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    });

    it("checks debounce scoped to this event+kind's batchId prefix", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([rsvp("user-a")]);

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv(3600));

      expect(mockPrisma.notification.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            type: "EVENT_UPDATED",
            batchId: { startsWith: "evt-updated-event-1-" },
          },
        }),
      );
    });

    it("does not debounce when the cooldown is configured to 0", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([rsvp("user-a")]);

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv(0));

      expect(mockPrisma.notification.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("notifyEventCancelled", () => {
    it("fans out EVENT_CANCELLED with cancellation copy, under its own batch prefix", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([rsvp("user-a")]);

      await producer.notifyEventCancelled(CANCELLED_INPUT, buildEnv());

      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
      const data = mockPrisma.notification.create.mock.calls[0][0].data;
      expect(data.type).toBe("EVENT_CANCELLED");
      expect(data.title).toContain("cancelled");
      expect(data.batchId).toMatch(/^evt-cancelled-event-1-\d+$/);
    });
  });

  describe("best-effort error handling", () => {
    it("never throws when the rsvp query fails", async () => {
      mockPrisma.rsvp.findMany.mockRejectedValueOnce(new Error("db down"));

      await expect(
        producer.notifyEventUpdated(UPDATED_INPUT, buildEnv()),
      ).resolves.toBeUndefined();
    });

    it("continues notifying remaining attendees when one recipient errors", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([
        rsvp("user-a"),
        rsvp("user-b"),
      ]);
      mockPrisma.notificationPreference.findUnique
        .mockRejectedValueOnce(new Error("pref lookup failed"))
        .mockResolvedValueOnce(null);

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv());

      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.create.mock.calls[0][0].data.userId).toBe(
        "user-b",
      );
    });

    it("always releases the prisma client", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([]);

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv());

      expect(mockPrisma.release).toHaveBeenCalled();
    });
  });

  describe("changed-field copy", () => {
    it("describes multiple changed fields in the body", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([rsvp("user-a")]);

      await producer.notifyEventUpdated(
        { ...UPDATED_INPUT, changedFields: ["startsAt", "endsAt", "location"] },
        buildEnv(),
      );

      const data = mockPrisma.notification.create.mock.calls[0][0].data;
      expect(data.body).toContain("The start time, the end time and the location");
    });

    it("falls back to generic copy when changedFields is empty", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([rsvp("user-a")]);

      await producer.notifyEventUpdated(
        { ...UPDATED_INPUT, changedFields: [] },
        buildEnv(),
      );

      const data = mockPrisma.notification.create.mock.calls[0][0].data;
      expect(data.body).toContain("Details changed");
    });
  });

  describe("default constructor args", () => {
    it("works with the default (real) clock when no args are injected", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([]);
      const defaultProducer = new EventNotificationProducer();

      await expect(
        defaultProducer.notifyEventUpdated(UPDATED_INPUT, buildEnv()),
      ).resolves.toBeUndefined();
    });
  });

  describe("injected delivery resolver", () => {
    it("uses the injected resolver instead of building the default", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([rsvp("user-a")]);
      const injected = { decide: vi.fn(() => ({ deliver: true as const })) };
      const producerWithResolver = new EventNotificationProducer(injected, () => now);

      await producerWithResolver.notifyEventUpdated(UPDATED_INPUT, buildEnv());

      expect(injected.decide).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    });

    it("creates no row when the resolver hard-drops via the floor", async () => {
      mockPrisma.rsvp.findMany.mockResolvedValueOnce([rsvp("user-a")]);
      const injected = {
        decide: vi.fn(() => ({ deliver: false as const, reason: "floor" as const })),
      };
      const producerWithResolver = new EventNotificationProducer(injected, () => now);

      await producerWithResolver.notifyEventUpdated(UPDATED_INPUT, buildEnv());

      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });
  });

  describe("bounded pagination", () => {
    it("pages across multiple full pages and stops at the hard bound", async () => {
      const fullPage = Array.from({ length: 100 }, (_, i) => rsvp(`user-${i}`, `id-${i}`));
      mockPrisma.rsvp.findMany.mockResolvedValue(fullPage);

      await producer.notifyEventUpdated(UPDATED_INPUT, buildEnv());

      // 10 pages x 100 = 1000, the hard MAX_FANOUT_RECIPIENTS ceiling.
      expect(mockPrisma.rsvp.findMany).toHaveBeenCalledTimes(10);
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1000);
      // Second and later pages pass a cursor built from the previous page's
      // last row id.
      expect(mockPrisma.rsvp.findMany.mock.calls[1][0]).toEqual(
        expect.objectContaining({ cursor: { id: "id-99" }, skip: 1 }),
      );
    });
  });
});
