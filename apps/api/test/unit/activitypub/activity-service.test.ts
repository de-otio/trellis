/**
 * Unit Tests: Activity Service
 *
 * Tests for ActivityPub activity storage and retrieval.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityService } from "../../../src/lib/activitypub/activity-service.js";
import type { PrismaClient, Activity } from "@prisma/client";

/** Collapse the template's indentation so `toContain` reads on one line. */
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

/**
 * The audience-gate clause, lifted out of whichever statement carries it, so
 * the list's and the count's copies can be compared directly.
 */
const gateOf = (sql: string) => {
  const s = normalize(sql);
  const start = s.indexOf("WHERE ");
  const end = s.indexOf(" ORDER BY ");
  return end === -1 ? s.slice(start) : s.slice(start, end);
};

describe("ActivityService", () => {
  let mockPrisma: Partial<PrismaClient>;

  beforeEach(() => {
    mockPrisma = {
      activity: {
        create: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
      },
      $queryRaw: vi.fn(),
    } as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("storeInboxActivity", () => {
    it("should store activity in inbox with all fields", async () => {
      const mockActivity: Activity = {
        id: "activity-1",
        actorUri: "https://example.com/users/alice",
        type: "Create",
        objectId: "https://example.com/posts/123",
        targetId: null,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: null,
        bto: null,
        bcc: null,
        published: new Date("2024-01-01T00:00:00Z"),
        receivedAt: new Date("2024-01-01T00:00:01Z"),
        inboxActorUri: "https://example.com/users/bob",
        outboxActorUri: null,
      };

      (mockPrisma.activity.create as any).mockResolvedValue(mockActivity);

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/posts/123",
          type: "Note",
        },
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: "2024-01-01T00:00:00Z",
      };

      const result = await ActivityService.storeInboxActivity(
        mockPrisma as PrismaClient,
        "https://example.com/users/bob",
        activity,
      );

      expect(mockPrisma.activity.create).toHaveBeenCalledWith({
        data: {
          actorUri: "https://example.com/users/alice",
          type: "Create",
          objectId: "https://example.com/posts/123",
          targetId: undefined,
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: undefined,
          bto: undefined,
          bcc: undefined,
          published: expect.any(Date),
          inboxActorUri: "https://example.com/users/bob",
          receivedAt: expect.any(Date),
        },
      });

      expect(result).toEqual(mockActivity);
    });

    it("should handle activity with string actor and object", async () => {
      const mockActivity: Activity = {
        id: "activity-2",
        actorUri: "https://example.com/users/alice",
        type: "Follow",
        objectId: "https://example.com/users/bob",
        targetId: null,
        to: null,
        cc: null,
        bto: null,
        bcc: null,
        published: new Date(),
        receivedAt: new Date(),
        inboxActorUri: "https://example.com/users/bob",
        outboxActorUri: null,
      };

      (mockPrisma.activity.create as any).mockResolvedValue(mockActivity);

      const activity = {
        type: "Follow",
        actor: "https://example.com/users/alice",
        object: "https://example.com/users/bob",
      };

      await ActivityService.storeInboxActivity(
        mockPrisma as PrismaClient,
        "https://example.com/users/bob",
        activity,
      );

      expect(mockPrisma.activity.create).toHaveBeenCalledWith({
        data: {
          actorUri: "https://example.com/users/alice",
          type: "Follow",
          objectId: "https://example.com/users/bob",
          targetId: undefined,
          to: undefined,
          cc: undefined,
          bto: undefined,
          bcc: undefined,
          published: expect.any(Date),
          inboxActorUri: "https://example.com/users/bob",
          receivedAt: expect.any(Date),
        },
      });
    });

    it("should handle array audience fields", async () => {
      const mockActivity: Activity = {
        id: "activity-3",
        actorUri: "https://example.com/users/alice",
        type: "Create",
        objectId: null,
        targetId: null,
        to: [
          "https://www.w3.org/ns/activitystreams#Public",
          "https://example.com/users/bob",
        ],
        cc: ["https://example.com/users/charlie"],
        bto: ["https://example.com/users/dave"],
        bcc: ["https://example.com/users/eve"],
        published: new Date(),
        receivedAt: new Date(),
        inboxActorUri: "https://example.com/users/bob",
        outboxActorUri: null,
      };

      (mockPrisma.activity.create as any).mockResolvedValue(mockActivity);

      const activity = {
        type: "Create",
        actor: "https://example.com/users/alice",
        to: [
          "https://www.w3.org/ns/activitystreams#Public",
          "https://example.com/users/bob",
        ],
        cc: ["https://example.com/users/charlie"],
        bto: ["https://example.com/users/dave"],
        bcc: ["https://example.com/users/eve"],
      };

      await ActivityService.storeInboxActivity(
        mockPrisma as PrismaClient,
        "https://example.com/users/bob",
        activity,
      );

      expect(mockPrisma.activity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          to: [
            "https://www.w3.org/ns/activitystreams#Public",
            "https://example.com/users/bob",
          ],
          cc: ["https://example.com/users/charlie"],
          bto: ["https://example.com/users/dave"],
          bcc: ["https://example.com/users/eve"],
        }),
      });
    });
  });

  describe("storeOutboxActivity", () => {
    it("should store activity in outbox", async () => {
      const mockActivity: Activity = {
        id: "activity-4",
        actorUri: "https://example.com/users/alice",
        type: "Create",
        objectId: "https://example.com/posts/123",
        targetId: null,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: null,
        bto: null,
        bcc: null,
        published: new Date("2024-01-01T00:00:00Z"),
        receivedAt: new Date(),
        inboxActorUri: null,
        outboxActorUri: "https://example.com/users/alice",
      };

      (mockPrisma.activity.create as any).mockResolvedValue(mockActivity);

      const activity = {
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/posts/123",
        },
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: "2024-01-01T00:00:00Z",
      };

      const result = await ActivityService.storeOutboxActivity(
        mockPrisma as PrismaClient,
        "https://example.com/users/alice",
        activity,
      );

      expect(mockPrisma.activity.create).toHaveBeenCalledWith({
        data: {
          actorUri: "https://example.com/users/alice",
          type: "Create",
          objectId: "https://example.com/posts/123",
          targetId: undefined,
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: undefined,
          bto: undefined,
          bcc: undefined,
          published: expect.any(Date),
          outboxActorUri: "https://example.com/users/alice",
        },
      });

      expect(result).toEqual(mockActivity);
    });
  });

  /**
   * H2 — the outbox audience gate.
   *
   * SCOPE OF THIS LANE, stated plainly: `$queryRaw` is mocked, so it resolves
   * whatever these tests hand it regardless of the statement. That means the
   * assertions below can only check the predicate's TEXT and the lockstep
   * between the list and the count — they cannot check whether a row actually
   * comes back. The outcome assertions (narrowed/deleted/hidden withheld,
   * public served, Follow/Accept untouched, count == list length) live in
   * `test/integration/outbox-audience-gate.integration.test.ts`, where a real
   * Postgres evaluates the real clause. Both lanes fail if the gate is removed;
   * only the integration lane fails if the gate is silently weakened into a
   * clause that matches everything.
   */
  describe("getOutboxActivities", () => {
    const ACTOR = "https://example.com/users/alice";

    const mockActivities: Activity[] = [
      {
        id: "activity-1",
        actorUri: ACTOR,
        type: "Create",
        objectId: "https://example.com/posts/123",
        targetId: null,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: null,
        bto: null,
        bcc: null,
        published: new Date("2024-01-01T00:00:00Z"),
        receivedAt: new Date(),
        inboxActorUri: null,
        outboxActorUri: ACTOR,
      },
    ];

    it("hydrates exactly the ids the gated statement selected", async () => {
      (mockPrisma.$queryRaw as any).mockResolvedValue([{ id: "activity-1" }]);
      (mockPrisma.activity.findMany as any).mockResolvedValue(mockActivities);

      const result = await ActivityService.getOutboxActivities(
        mockPrisma as PrismaClient,
        ACTOR,
        1,
        20,
      );

      // The gate decides membership; findMany only fetches the rows it named.
      // Re-deriving the set here (a second `where` on outboxActorUri) would
      // bypass the gate entirely, so the id list must be the ONLY predicate.
      expect(mockPrisma.activity.findMany).toHaveBeenCalledWith({
        where: { id: { in: ["activity-1"] } },
        orderBy: [{ published: "desc" }, { id: "desc" }],
      });
      expect(result).toEqual(mockActivities);
    });

    it("applies the mayFederatePost conditions in the statement", async () => {
      (mockPrisma.$queryRaw as any).mockResolvedValue([]);

      await ActivityService.getOutboxActivities(
        mockPrisma as PrismaClient,
        ACTOR,
        1,
        20,
      );

      const sql = normalize((mockPrisma.$queryRaw as any).mock.calls[0][0].sql);

      // Each condition of `mayFederatePost`, transcribed. Delete any one of
      // these from activity-service.ts and this assertion fails.
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain("FROM posts p");
      expect(sql).toContain("p.object_id = a.object_id");
      expect(sql).toContain("p.radius = 'SHOUT'");
      expect(sql).toContain("p.deleted_at IS NULL");
      expect(sql).toContain("p.hidden_by_author = false");
    });

    it("withholds blind-recipient-only rows in the SAME statement (DP-4)", async () => {
      (mockPrisma.$queryRaw as any).mockResolvedValue([]);

      await ActivityService.getOutboxActivities(
        mockPrisma as PrismaClient,
        ACTOR,
        1,
        20,
      );

      const sql = normalize((mockPrisma.$queryRaw as any).mock.calls[0][0].sql);

      // A DM is a Create with `bto` and no `to`/`cc`, and no `posts` row — the
      // object-identity clause alone passes it through. The second clause must
      // be present, and it must key on the ABSENCE of a public audience, not
      // on the activity type.
      expect(sql).toContain("a.bto IS NOT NULL OR a.bcc IS NOT NULL");
      expect(sql).toContain("a.to IS NULL");
      expect(sql).toContain("a.cc IS NULL");
    });

    it("cuts the page after the gate, not before", async () => {
      (mockPrisma.$queryRaw as any).mockResolvedValue([]);

      await ActivityService.getOutboxActivities(
        mockPrisma as PrismaClient,
        ACTOR,
        2,
        10,
      );

      const call = (mockPrisma.$queryRaw as any).mock.calls[0][0];
      const sql = normalize(call.sql);

      // LIMIT/OFFSET sit in the SAME statement as the NOT EXISTS, so the page
      // is filled with rows that survived the gate. A gate applied after a
      // page cut would return short pages whose length leaks how many rows
      // were withheld.
      expect(sql.indexOf("NOT EXISTS")).toBeLessThan(sql.indexOf("LIMIT"));
      expect(call.values).toEqual([ACTOR, 10, 10]);
    });

    it("does not query for rows when the gated page is empty", async () => {
      (mockPrisma.$queryRaw as any).mockResolvedValue([]);

      const result = await ActivityService.getOutboxActivities(
        mockPrisma as PrismaClient,
        ACTOR,
        1,
        20,
      );

      expect(result).toEqual([]);
      expect(mockPrisma.activity.findMany).not.toHaveBeenCalled();
    });

    it("orders by published desc", async () => {
      (mockPrisma.$queryRaw as any).mockResolvedValue([]);

      await ActivityService.getOutboxActivities(
        mockPrisma as PrismaClient,
        ACTOR,
        1,
        20,
      );

      expect(
        normalize((mockPrisma.$queryRaw as any).mock.calls[0][0].sql),
      ).toContain("ORDER BY a.published DESC");
    });
  });

  describe("getOutboxCount", () => {
    const ACTOR = "https://example.com/users/alice";

    it("counts over the gated set, not the raw table", async () => {
      (mockPrisma.$queryRaw as any).mockResolvedValue([{ count: 42n }]);

      const result = await ActivityService.getOutboxCount(
        mockPrisma as PrismaClient,
        ACTOR,
      );

      const call = (mockPrisma.$queryRaw as any).mock.calls[0][0];
      expect(normalize(call.sql)).toContain("NOT EXISTS");
      expect(call.values).toEqual([ACTOR]);

      // COUNT(*) arrives as a bigint; `totalItems` must serialize as a number.
      expect(result).toBe(42);

      // The ungated `activity.count` must be gone. Leaving it would publish a
      // totalItems for rows the collection refuses to show — the same
      // existence oracle, done with arithmetic.
      expect(mockPrisma.activity.count).not.toHaveBeenCalled();
    });

    it("returns 0 rather than NaN when the statement yields no row", async () => {
      (mockPrisma.$queryRaw as any).mockResolvedValue([]);

      expect(
        await ActivityService.getOutboxCount(mockPrisma as PrismaClient, ACTOR),
      ).toBe(0);
    });

    /**
     * The one drift the code CAN enforce mechanically, so it is asserted here
     * rather than left to review: the list and the count must be filtered by
     * byte-identical SQL. If they diverge, pagination discloses a total the
     * pages withhold.
     */
    it("filters by SQL byte-identical to getOutboxActivities'", async () => {
      (mockPrisma.$queryRaw as any).mockResolvedValue([]);
      await ActivityService.getOutboxActivities(
        mockPrisma as PrismaClient,
        ACTOR,
        1,
        20,
      );
      (mockPrisma.$queryRaw as any).mockResolvedValue([{ count: 0n }]);
      await ActivityService.getOutboxCount(mockPrisma as PrismaClient, ACTOR);

      const [listCall, countCall] = (mockPrisma.$queryRaw as any).mock.calls;
      expect(gateOf(listCall[0].sql)).toBe(gateOf(countCall[0].sql));
      expect(gateOf(listCall[0].sql)).toContain("NOT EXISTS");
    });
  });

  describe("getInboxActivities", () => {
    it("should retrieve paginated inbox activities", async () => {
      const mockActivities: Activity[] = [
        {
          id: "activity-1",
          actorUri: "https://example.com/users/bob",
          type: "Create",
          objectId: "https://example.com/posts/456",
          targetId: null,
          to: null,
          cc: null,
          bto: null,
          bcc: null,
          published: new Date("2024-01-01T00:00:00Z"),
          receivedAt: new Date("2024-01-01T00:00:01Z"),
          inboxActorUri: "https://example.com/users/alice",
          outboxActorUri: null,
        },
      ];

      (mockPrisma.activity.findMany as any).mockResolvedValue(mockActivities);

      const result = await ActivityService.getInboxActivities(
        mockPrisma as PrismaClient,
        "https://example.com/users/alice",
        1,
        20,
      );

      expect(mockPrisma.activity.findMany).toHaveBeenCalledWith({
        where: {
          inboxActorUri: "https://example.com/users/alice",
        },
        orderBy: {
          receivedAt: "desc",
        },
        skip: 0,
        take: 20,
      });

      expect(result).toEqual(mockActivities);
    });
  });

  describe("getInboxCount", () => {
    it("should return total inbox count", async () => {
      (mockPrisma.activity.count as any).mockResolvedValue(15);

      const result = await ActivityService.getInboxCount(
        mockPrisma as PrismaClient,
        "https://example.com/users/alice",
      );

      expect(mockPrisma.activity.count).toHaveBeenCalledWith({
        where: {
          inboxActorUri: "https://example.com/users/alice",
        },
      });

      expect(result).toBe(15);
    });
  });
});
