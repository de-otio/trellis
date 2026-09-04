/**
 * GOLDEN characterization test for the notification delivery FLOOR.
 *
 * Captures the EXACT current behavior of `createNotification` BEFORE the WS1
 * refactor that moves the floor into `CalmDeliveryResolver`, across:
 *   {every NotificationType} × {in / out of quiet hours} × {preference on / off}
 *
 * The observable behavior pinned here:
 *   - ALWAYS_DELIVER_TYPES (SAFETY_ALERT, PARENTAL_LINK): a row is ALWAYS
 *     created with deliveredAt = now (never suppressed, never deferred),
 *     regardless of preference or quiet hours.
 *   - Other types, preference disabled for the type: NO row is created;
 *     createNotification returns { id: "" }.
 *   - Other types, preference enabled, inside quiet hours: a row is created
 *     with deliveredAt = null (deferred).
 *   - Other types, preference enabled, outside quiet hours: a row is created
 *     with deliveredAt = now.
 *
 * The clock is frozen so the quiet-hours arithmetic is deterministic. After the
 * refactor this test MUST stay green byte-identical.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import type { NotificationType } from "@prisma/client";
import {
  InMemoryBlockStore,
  type BlockStore,
} from "../../src/lib/realtime/block-store.js";
import { CalmDeliveryResolver } from "../../src/lib/realtime/index.js";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    notification: { create: vi.fn() },
    notificationPreference: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    release: vi.fn(),
  },
}));

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

import { NotificationHandler } from "../../src/lib/notification-handler.js";

const TENANT = "tenant-golden";
const USER = "user-golden";

// Every NotificationType in the Prisma enum.
const ALL_TYPES: NotificationType[] = [
  "DIRECT_MESSAGE",
  "SAFETY_ALERT",
  "PARENTAL_LINK",
  "FOLLOW",
  "SENTIMENT_DIGEST",
  "SYSTEM",
  "RELATIONSHIP_CREATED",
  "RELATIONSHIP_RECIPROCATED",
  "TIER_CHANGED",
  "ENTITY_RELATIONSHIP_PROPOSED",
  "ENTITY_RELATIONSHIP_CONFIRMED",
  "CONNECTION_CODE_REDEEMED",
];

const ALWAYS_DELIVER: NotificationType[] = ["SAFETY_ALERT", "PARENTAL_LINK"];

// All-enabled preference row (so non-bypass types pass the preference gate).
const PREFS_ALL_ON = {
  userId: USER,
  dmEnabled: true,
  followEnabled: true,
  digestEnabled: true,
  systemEnabled: true,
  relationshipEnabled: true,
};
// All-disabled preference row.
const PREFS_ALL_OFF = {
  userId: USER,
  dmEnabled: false,
  followEnabled: false,
  digestEnabled: false,
  systemEnabled: false,
  relationshipEnabled: false,
};

// Quiet hours 22:00 (1320) -> 07:00 (420), overnight.
const QUIET_USER = {
  quietHoursEnabled: true,
  quietHoursStart: 1320,
  quietHoursEnd: 420,
};
const NO_QUIET_USER = {
  quietHoursEnabled: false,
  quietHoursStart: null,
  quietHoursEnd: null,
};

// Pin the clock to 23:30 local — INSIDE the overnight quiet window.
const INSIDE_QUIET = new Date(2026, 0, 15, 23, 30, 0);
// Pin the clock to 12:00 local — OUTSIDE the overnight quiet window.
const OUTSIDE_QUIET = new Date(2026, 0, 15, 12, 0, 0);

function mockEnv(): Env {
  return {
    DATABASE_URL: "postgresql://t:t@localhost:5432/t",
    SESSION_SECRET: "test-secret-32-characters-long!!",
  } as unknown as Env;
}

describe("notification floor — golden behavior", () => {
  let handler: NotificationHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new NotificationHandler();
    mockPrisma.release.mockResolvedValue(undefined);
    mockPrisma.notification.create.mockImplementation(
      async ({ data }: { data: { deliveredAt: Date | null } }) => ({
        id: "notif-created",
        deliveredAt: data.deliveredAt,
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive one case and report whether a row was created + its deliveredAt. */
  async function run(
    type: NotificationType,
    opts: {
      prefs: typeof PREFS_ALL_ON | typeof PREFS_ALL_OFF | null;
      quiet: boolean;
      clock: Date;
    },
  ): Promise<{ created: boolean; deliveredAtNull: boolean | null; id: string }> {
    vi.useFakeTimers();
    vi.setSystemTime(opts.clock);

    mockPrisma.notificationPreference.findUnique.mockResolvedValue(opts.prefs);
    mockPrisma.user.findUnique.mockResolvedValue(
      opts.quiet ? QUIET_USER : NO_QUIET_USER,
    );

    const result = await handler.createNotification(
      USER,
      type,
      "title",
      "body",
      {},
      mockEnv(),
      TENANT,
    );

    const created = mockPrisma.notification.create.mock.calls.length > 0;
    let deliveredAtNull: boolean | null = null;
    if (created) {
      const data = mockPrisma.notification.create.mock.calls[0][0].data;
      deliveredAtNull = data.deliveredAt === null;
    }
    return { created, deliveredAtNull, id: result.id };
  }

  describe("ALWAYS_DELIVER types bypass preference + quiet hours", () => {
    for (const type of ALWAYS_DELIVER) {
      it(`${type}: prefs OFF + inside quiet -> row created, deliveredAt set`, async () => {
        const r = await run(type, {
          prefs: PREFS_ALL_OFF,
          quiet: true,
          clock: INSIDE_QUIET,
        });
        expect(r.created).toBe(true);
        expect(r.deliveredAtNull).toBe(false);
        expect(r.id).toBe("notif-created");
      });
    }
  });

  describe("non-bypass types honor preference", () => {
    for (const type of ALL_TYPES.filter((t) => !ALWAYS_DELIVER.includes(t))) {
      it(`${type}: preference OFF -> no row, id ""`, async () => {
        const r = await run(type, {
          prefs: PREFS_ALL_OFF,
          quiet: false,
          clock: OUTSIDE_QUIET,
        });
        // SYSTEM/relationship/dm/follow/digest are all gated; types not in the
        // switch (none here) would default-enable. All listed map to a flag.
        expect(r.created).toBe(false);
        expect(r.id).toBe("");
      });
    }
  });

  describe("non-bypass types honor quiet hours when preference is on", () => {
    for (const type of ALL_TYPES.filter((t) => !ALWAYS_DELIVER.includes(t))) {
      it(`${type}: pref ON + inside quiet -> row created, deliveredAt null`, async () => {
        const r = await run(type, {
          prefs: PREFS_ALL_ON,
          quiet: true,
          clock: INSIDE_QUIET,
        });
        expect(r.created).toBe(true);
        expect(r.deliveredAtNull).toBe(true);
      });

      it(`${type}: pref ON + outside quiet -> row created, deliveredAt set`, async () => {
        const r = await run(type, {
          prefs: PREFS_ALL_ON,
          quiet: false,
          clock: OUTSIDE_QUIET,
        });
        expect(r.created).toBe(true);
        expect(r.deliveredAtNull).toBe(false);
      });
    }
  });

  describe("no preference row => treated as enabled", () => {
    it("FOLLOW: prefs null + outside quiet -> row created, deliveredAt set", async () => {
      const r = await run("FOLLOW", {
        prefs: null,
        quiet: false,
        clock: OUTSIDE_QUIET,
      });
      expect(r.created).toBe(true);
      expect(r.deliveredAtNull).toBe(false);
    });

    it("FOLLOW: prefs null + inside quiet -> row created, deliveredAt null", async () => {
      const r = await run("FOLLOW", {
        prefs: null,
        quiet: true,
        clock: INSIDE_QUIET,
      });
      expect(r.created).toBe(true);
      expect(r.deliveredAtNull).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Track D — the floor now ENFORCES (blocked-sender + minor protection). These
  // rows EXTEND the golden table; the cases above stay byte-identical because
  // they carry no sender stamp and no re-engagement type.
  // -------------------------------------------------------------------------

  const SENDER = "user-blocked-sender";
  const REENGAGE: NotificationType = "SENTIMENT_DIGEST";

  /**
   * Drive one floor case with an injected block store + re-engagement resolver,
   * a sender stamp in `data`, and a recipient ageTier.
   */
  async function runFloor(
    type: NotificationType,
    opts: {
      blockStore?: BlockStore;
      reengageTypes?: NotificationType[];
      ageTier?: "CHILD" | "TEEN" | "ADULT";
      senderInPayload?: boolean;
    },
  ): Promise<{ created: boolean; id: string }> {
    vi.useFakeTimers();
    vi.setSystemTime(OUTSIDE_QUIET);

    mockPrisma.notificationPreference.findUnique.mockResolvedValue(PREFS_ALL_ON);
    mockPrisma.user.findUnique.mockResolvedValue({
      ...NO_QUIET_USER,
      ageTier: opts.ageTier ?? "ADULT",
    });

    const resolver = new CalmDeliveryResolver({
      reengagementTypes: new Set(opts.reengageTypes ?? []),
    });
    const h = new NotificationHandler(resolver, opts.blockStore ?? null);

    const result = await h.createNotification(
      USER,
      type,
      "title",
      "body",
      opts.senderInPayload ? { senderUserId: SENDER } : {},
      mockEnv(),
      TENANT,
    );

    const created = mockPrisma.notification.create.mock.calls.length > 0;
    return { created, id: result.id };
  }

  describe("Track D floor — blocked sender", () => {
    it("blocked sender -> NO row, id '' (hard drop, not a deferral)", async () => {
      const blocks = new InMemoryBlockStore();
      blocks.block(TENANT, USER, SENDER); // recipient USER has blocked SENDER
      const r = await runFloor("FOLLOW", {
        blockStore: blocks,
        senderInPayload: true,
      });
      expect(r.created).toBe(false);
      expect(r.id).toBe("");
    });

    it("non-blocked sender -> row created (floor does not fire)", async () => {
      const blocks = new InMemoryBlockStore(); // empty
      const r = await runFloor("FOLLOW", {
        blockStore: blocks,
        senderInPayload: true,
      });
      expect(r.created).toBe(true);
    });

    it("SAFETY_ALERT from a blocked sender STILL delivers (critical-always wins)", async () => {
      const blocks = new InMemoryBlockStore();
      blocks.block(TENANT, USER, SENDER);
      const r = await runFloor("SAFETY_ALERT", {
        blockStore: blocks,
        senderInPayload: true,
      });
      expect(r.created).toBe(true);
    });

    // FAIL-LOUD: a handler whose block store always returns false (the check
    // removed) creates a row where the real path drops it.
    it("FAILS LOUDLY: a no-op block store delivers where the real one drops", async () => {
      const noopStore: BlockStore = {
        isBlocked: async () => false,
        listMutualBlockIds: async () => [],
      };
      const real = new InMemoryBlockStore();
      real.block(TENANT, USER, SENDER);

      const dropped = await runFloor("FOLLOW", {
        blockStore: real,
        senderInPayload: true,
      });
      vi.clearAllMocks();
      mockPrisma.notification.create.mockImplementation(
        async ({ data }: { data: { deliveredAt: Date | null } }) => ({
          id: "notif-created",
          deliveredAt: data.deliveredAt,
        }),
      );
      const delivered = await runFloor("FOLLOW", {
        blockStore: noopStore,
        senderInPayload: true,
      });
      expect(dropped.created).toBe(false);
      expect(delivered.created).toBe(true);
    });
  });

  describe("Track D floor — minor protection", () => {
    it("re-engagement type to a CHILD -> NO row, id ''", async () => {
      const r = await runFloor(REENGAGE, {
        reengageTypes: [REENGAGE],
        ageTier: "CHILD",
      });
      expect(r.created).toBe(false);
      expect(r.id).toBe("");
    });

    it("re-engagement type to an ADULT -> row created", async () => {
      const r = await runFloor(REENGAGE, {
        reengageTypes: [REENGAGE],
        ageTier: "ADULT",
      });
      expect(r.created).toBe(true);
    });

    it("empty denylist -> CHILD still gets the type (default off)", async () => {
      const r = await runFloor(REENGAGE, {
        reengageTypes: [],
        ageTier: "CHILD",
      });
      expect(r.created).toBe(true);
    });

    // FAIL-LOUD: removing the minor branch (empty denylist) delivers where the
    // configured denylist drops.
    it("FAILS LOUDLY: empty denylist delivers to a CHILD where the configured one drops", async () => {
      const dropped = await runFloor(REENGAGE, {
        reengageTypes: [REENGAGE],
        ageTier: "CHILD",
      });
      vi.clearAllMocks();
      mockPrisma.notification.create.mockImplementation(
        async ({ data }: { data: { deliveredAt: Date | null } }) => ({
          id: "notif-created",
          deliveredAt: data.deliveredAt,
        }),
      );
      const delivered = await runFloor(REENGAGE, {
        reengageTypes: [],
        ageTier: "CHILD",
      });
      expect(dropped.created).toBe(false);
      expect(delivered.created).toBe(true);
    });
  });
});
