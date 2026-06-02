/**
 * Unit Tests: Neo4j GraphService — Circle Resolution (P2.2)
 *
 * Tests for getCircleMembers, getVisiblePostIds, getGlanceItems,
 * getDepthPostIds, getCircleStatus, getCircleEntityStatus, and markCircleRead.
 *
 * The Neo4j driver is fully mocked — no database required.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Neo4jGraphService } from "../../../src/lib/graph/neo4j-graph-service.js";
import type {
  CircleTier,
  VisiblePostResult,
  GlanceItem,
  CircleTierStatus,
  CircleEntityStatus,
  CircleMember,
} from "../../../src/lib/graph/types.js";

// ---------------------------------------------------------------------------
// Hoist mocks before module loading
// ---------------------------------------------------------------------------

const { mockSessionRun, mockSessionClose, mockVerifyConnectivity } =
  vi.hoisted(() => ({
    mockSessionRun: vi.fn(),
    mockSessionClose: vi.fn().mockResolvedValue(undefined),
    mockVerifyConnectivity: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("neo4j-driver", () => {
  const mockSession = {
    run: (...args: unknown[]) => mockSessionRun(...args),
    close: () => mockSessionClose(),
  };
  const mockDriver = {
    session: () => mockSession,
    verifyConnectivity: () => mockVerifyConnectivity(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    default: {
      driver: vi.fn(() => mockDriver),
      auth: { basic: vi.fn(() => ({ scheme: "basic" })) },
      // Static SKIP/LIMIT params are passed via neo4j.int(n); identity suffices.
      int: (n: number) => n,
      integer: { toNumber: (v: unknown) => Number(v) },
    },
  };
});

vi.mock("../../../src/lib/graph/graph-schema-init", () => ({
  initGraphSchema: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a single Neo4j record mock from a key-value map */
function makeRecord(
  fields: Record<string, unknown>,
): { get: (key: string) => unknown } {
  return { get: (key: string) => fields[key] };
}

/** Build a query result from an array of field maps */
function makeResult(records: Array<Record<string, unknown>>) {
  return { records: records.map(makeRecord) };
}

const emptyResult = { records: [] };

// Timestamps for testing
const now = new Date("2026-04-11T12:00:00Z");
const oneHourAgo = new Date("2026-04-11T11:00:00Z");
const twoDaysAgo = new Date("2026-04-09T12:00:00Z");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let service: Neo4jGraphService;

beforeEach(async () => {
  vi.clearAllMocks();
  service = new Neo4jGraphService();

  mockVerifyConnectivity.mockResolvedValueOnce(undefined);
  mockSessionRun.mockResolvedValue(emptyResult);

  await service.connect({
    endpoint: "bolt://localhost:7687",
    auth: { type: "none" },
  });

  vi.clearAllMocks();
  mockSessionClose.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// getCircleTierBounds
// ---------------------------------------------------------------------------

describe("getCircleTierBounds", () => {
  it("returns correct bounds for tier 0 (inner)", () => {
    const bounds = service.getCircleTierBounds(0);
    expect(bounds).toEqual({ lower: 0.8, upper: Infinity });
  });

  it("returns correct bounds for tier 1 (closeFriends)", () => {
    const bounds = service.getCircleTierBounds(1);
    expect(bounds).toEqual({ lower: 0.5, upper: 0.8 });
  });

  it("returns correct bounds for tier 2 (community)", () => {
    const bounds = service.getCircleTierBounds(2);
    expect(bounds).toEqual({ lower: 0.2, upper: 0.5 });
  });

  it("returns correct bounds for tier 3 (ambient)", () => {
    const bounds = service.getCircleTierBounds(3);
    expect(bounds).toEqual({ lower: 0.001, upper: 0.2 });
  });

  it("supports custom thresholds", () => {
    const bounds = service.getCircleTierBounds(0, {
      innerThreshold: 0.9,
      closeFriendThreshold: 0.6,
      communityThreshold: 0.3,
    });
    expect(bounds).toEqual({ lower: 0.9, upper: Infinity });
  });
});

// ---------------------------------------------------------------------------
// getCircleMembers
// ---------------------------------------------------------------------------

describe("getCircleMembers", () => {
  it("returns entity and user members in the tier, sorted by score", async () => {
    mockSessionRun.mockResolvedValueOnce(
      makeResult([
        { id: "entity-1", type: "Entity", name: "Bunsen", score: 0.9 },
        { id: "user-2", type: "User", name: "Alice", score: 0.85 },
      ]),
    );

    const members = await service.getCircleMembers("viewer-1", 0);

    expect(members).toHaveLength(2);
    expect(members[0]).toEqual({
      id: "entity-1",
      type: "entity",
      name: "Bunsen",
      score: 0.9,
      tier: 0,
    });
    expect(members[1]).toEqual({
      id: "user-2",
      type: "user",
      name: "Alice",
      score: 0.85,
      tier: 0,
    });
  });

  it("returns empty array when no members in the tier", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);
    const members = await service.getCircleMembers("viewer-1", 3);
    expect(members).toEqual([]);
  });

  it("passes correct threshold parameters for tier 2", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);
    await service.getCircleMembers("viewer-1", 2);

    const [_query, params] = mockSessionRun.mock.calls[0];
    expect(params.lowerThreshold).toBe(0.2);
    expect(params.upperThreshold).toBe(0.5);
    expect(params.viewerId).toBe("viewer-1");
  });
});

// ---------------------------------------------------------------------------
// getVisiblePostIds
// ---------------------------------------------------------------------------

describe("getVisiblePostIds", () => {
  it("returns visible posts with resolved tiers", async () => {
    mockSessionRun.mockResolvedValueOnce(
      makeResult([
        { postId: "post-1", createdAt: now.toISOString(), resolvedTier: 0 },
        {
          postId: "post-2",
          createdAt: oneHourAgo.toISOString(),
          resolvedTier: 0,
        },
      ]),
    );

    const result = await service.getVisiblePostIds(
      "viewer-1",
      0,
      twoDaysAgo,
      { limit: 10 },
    );

    expect(result.items).toHaveLength(2);
    expect(result.items[0].postId).toBe("post-1");
    expect(result.items[0].resolvedTier).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });

  it("returns hasMore and cursor when there are more results", async () => {
    // Return limit+1 records to trigger hasMore
    mockSessionRun.mockResolvedValueOnce(
      makeResult([
        { postId: "post-1", createdAt: now.toISOString(), resolvedTier: 1 },
        {
          postId: "post-2",
          createdAt: oneHourAgo.toISOString(),
          resolvedTier: 1,
        },
        {
          postId: "post-3",
          createdAt: twoDaysAgo.toISOString(),
          resolvedTier: 1,
        },
      ]),
    );

    const result = await service.getVisiblePostIds(
      "viewer-1",
      1,
      twoDaysAgo,
      { limit: 2 },
    );

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBeTruthy();

    // Cursor should decode to the last item
    const decoded = JSON.parse(
      Buffer.from(result.cursor!, "base64").toString("utf8"),
    );
    expect(decoded.postId).toBe("post-2");
  });

  it("returns empty result when no posts are visible", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    const result = await service.getVisiblePostIds(
      "viewer-1",
      0,
      twoDaysAgo,
      { limit: 10 },
    );

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });

  it("passes all required parameters including thresholds", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    await service.getVisiblePostIds("viewer-1", 0, twoDaysAgo, { limit: 10 });

    const [_query, params] = mockSessionRun.mock.calls[0];
    expect(params.viewerId).toBe("viewer-1");
    expect(params.lowerThreshold).toBe(0.8);
    expect(params.tierInt).toBe(0);
    expect(params.innerThreshold).toBe(0.8);
    expect(params.closeFriendThreshold).toBe(0.5);
    expect(params.communityThreshold).toBe(0.2);
    expect(params.limit).toBe(11); // limit+1 to detect hasMore
    expect(params.since).toBe(twoDaysAgo.toISOString());
  });

  it("passes cursor parameters when cursor is provided", async () => {
    const cursor = service.encodeCircleCursor(now.toISOString(), "post-1");
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    await service.getVisiblePostIds("viewer-1", 0, twoDaysAgo, {
      limit: 10,
      cursor,
    });

    const [_query, params] = mockSessionRun.mock.calls[0];
    expect(params.cursorCreatedAt).toBe(now.toISOString());
    expect(params.cursorPostId).toBe("post-1");
  });

  it("does not pass cursor params when cursor is absent", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    await service.getVisiblePostIds("viewer-1", 0, twoDaysAgo, { limit: 10 });

    const [_query, params] = mockSessionRun.mock.calls[0];
    expect(params.cursorCreatedAt).toBeUndefined();
    expect(params.cursorPostId).toBeUndefined();
  });

  it("runs two UNION-less branch queries (entity-about + author) — Neptune has no CALL{}/UNION", async () => {
    mockSessionRun.mockResolvedValue(emptyResult);

    await service.getVisiblePostIds("viewer-1", 0, twoDaysAgo, { limit: 10 });

    // C2b: the entity-branch ∪ author-branch UNION (with a single CALL{}-scoped
    // ORDER BY/LIMIT) is replaced by two separate queries merged app-side.
    expect(mockSessionRun).toHaveBeenCalledTimes(2);
    const queries = mockSessionRun.mock.calls.map((c) => c[0] as string);
    for (const q of queries) {
      expect(q).not.toContain("UNION");
      expect(q).not.toContain("CALL {");
    }
    expect(queries.some((q) => q.includes("entity:Entity"))).toBe(true);
    expect(queries.some((q) => q.includes("author:User"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getGlanceItems
// ---------------------------------------------------------------------------

describe("getGlanceItems", () => {
  it("returns glance items sorted by recency", async () => {
    // Step 1: members query
    mockSessionRun.mockResolvedValueOnce(
      makeResult([
        {
          targetId: "entity-1",
          targetType: "Entity",
          targetName: "Bunsen",
          score: 0.9,
        },
        {
          targetId: "entity-2",
          targetType: "Entity",
          targetName: "Beaker",
          score: 0.85,
        },
      ]),
    );

    // Step 2a: entity posts query
    mockSessionRun.mockResolvedValueOnce(
      makeResult([
        {
          targetId: "entity-1",
          postId: "post-old",
          postCreatedAt: oneHourAgo.toISOString(),
        },
        {
          targetId: "entity-2",
          postId: "post-new",
          postCreatedAt: now.toISOString(),
        },
      ]),
    );
    // Step 2b: no users
    // (no userIds, so no user query is made)

    const items = await service.getGlanceItems("viewer-1", 0, 10);

    expect(items).toHaveLength(2);
    // Sorted by recency: entity-2 first (now), entity-1 second (1h ago)
    expect(items[0].targetId).toBe("entity-2");
    expect(items[0].postId).toBe("post-new");
    expect(items[1].targetId).toBe("entity-1");
    expect(items[1].postId).toBe("post-old");
  });

  it("respects the limit parameter", async () => {
    // Members: 3 entities
    mockSessionRun.mockResolvedValueOnce(
      makeResult([
        {
          targetId: "e-1",
          targetType: "Entity",
          targetName: "A",
          score: 0.9,
        },
        {
          targetId: "e-2",
          targetType: "Entity",
          targetName: "B",
          score: 0.85,
        },
        {
          targetId: "e-3",
          targetType: "Entity",
          targetName: "C",
          score: 0.82,
        },
      ]),
    );
    // Posts for all 3
    mockSessionRun.mockResolvedValueOnce(
      makeResult([
        { targetId: "e-1", postId: "p-1", postCreatedAt: now.toISOString() },
        {
          targetId: "e-2",
          postId: "p-2",
          postCreatedAt: oneHourAgo.toISOString(),
        },
        {
          targetId: "e-3",
          postId: "p-3",
          postCreatedAt: twoDaysAgo.toISOString(),
        },
      ]),
    );

    const items = await service.getGlanceItems("viewer-1", 0, 2);
    expect(items).toHaveLength(2);
    expect(items[0].targetId).toBe("e-1");
    expect(items[1].targetId).toBe("e-2");
  });

  it("returns empty array when no members in tier", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);
    const items = await service.getGlanceItems("viewer-1", 3, 10);
    expect(items).toEqual([]);
  });

  it("includes both entity and user glance items", async () => {
    // Members: one entity, one user
    mockSessionRun.mockResolvedValueOnce(
      makeResult([
        {
          targetId: "entity-1",
          targetType: "Entity",
          targetName: "Bunsen",
          score: 0.9,
        },
        {
          targetId: "user-1",
          targetType: "User",
          targetName: "Alice",
          score: 0.85,
        },
      ]),
    );
    // Entity posts
    mockSessionRun.mockResolvedValueOnce(
      makeResult([
        {
          targetId: "entity-1",
          postId: "ep-1",
          postCreatedAt: oneHourAgo.toISOString(),
        },
      ]),
    );
    // User posts
    mockSessionRun.mockResolvedValueOnce(
      makeResult([
        {
          targetId: "user-1",
          postId: "up-1",
          postCreatedAt: now.toISOString(),
        },
      ]),
    );

    const items = await service.getGlanceItems("viewer-1", 0, 10);

    expect(items).toHaveLength(2);
    // User post is more recent
    expect(items[0].targetType).toBe("user");
    expect(items[0].postId).toBe("up-1");
    expect(items[1].targetType).toBe("entity");
    expect(items[1].postId).toBe("ep-1");
  });
});

// ---------------------------------------------------------------------------
// getDepthPostIds
// ---------------------------------------------------------------------------

describe("getDepthPostIds", () => {
  it("returns post IDs for an entity target", async () => {
    mockSessionRun.mockResolvedValueOnce(
      makeResult([{ postId: "post-1" }, { postId: "post-2" }]),
    );

    const ids = await service.getDepthPostIds(
      "viewer-1",
      "entity",
      "entity-1",
      twoDaysAgo,
      10,
    );

    expect(ids).toEqual(["post-1", "post-2"]);
  });

  it("returns post IDs for a user target", async () => {
    mockSessionRun.mockResolvedValueOnce(
      makeResult([{ postId: "post-a" }]),
    );

    const ids = await service.getDepthPostIds(
      "viewer-1",
      "user",
      "user-2",
      twoDaysAgo,
      10,
    );

    expect(ids).toEqual(["post-a"]);
  });

  it("returns empty array when no posts exist", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    const ids = await service.getDepthPostIds(
      "viewer-1",
      "entity",
      "entity-1",
      twoDaysAgo,
      10,
    );

    expect(ids).toEqual([]);
  });

  it("passes threshold params for inline CASE expression", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    await service.getDepthPostIds(
      "viewer-1",
      "entity",
      "entity-1",
      twoDaysAgo,
      50,
    );

    const [query, params] = mockSessionRun.mock.calls[0];
    expect(params.innerThreshold).toBe(0.8);
    expect(params.closeFriendThreshold).toBe(0.5);
    expect(params.communityThreshold).toBe(0.2);
    expect(params.limit).toBe(50);
    expect(query).toContain("CASE");
    expect(query).toContain("Entity");
  });

  it("uses ABOUT edge for entity target and authorId for user target", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);
    await service.getDepthPostIds("v", "entity", "e1", twoDaysAgo, 10);
    const [entityQuery] = mockSessionRun.mock.calls[0];
    expect(entityQuery).toContain("ABOUT");
    expect(entityQuery).toContain("entity:Entity");

    mockSessionRun.mockResolvedValueOnce(emptyResult);
    await service.getDepthPostIds("v", "user", "u1", twoDaysAgo, 10);
    const [userQuery] = mockSessionRun.mock.calls[1];
    expect(userQuery).toContain("authorId");
    expect(userQuery).toContain("author:User");
  });
});

// ---------------------------------------------------------------------------
// getCircleStatus
// ---------------------------------------------------------------------------

describe("getCircleStatus", () => {
  it("returns status for all four tiers", async () => {
    // Four parallel queries, one per tier
    mockSessionRun.mockResolvedValueOnce(
      makeResult([{ unseenCount: 3 }]),
    );
    mockSessionRun.mockResolvedValueOnce(
      makeResult([{ unseenCount: 0 }]),
    );
    mockSessionRun.mockResolvedValueOnce(
      makeResult([{ unseenCount: 7 }]),
    );
    mockSessionRun.mockResolvedValueOnce(
      makeResult([{ unseenCount: 0 }]),
    );

    const lastReadAt = new Date("2026-04-10T12:00:00Z");
    const status = await service.getCircleStatus("viewer-1", {
      0: lastReadAt,
      1: lastReadAt,
      2: lastReadAt,
      3: lastReadAt,
    });

    expect(status).toHaveLength(4);
    expect(status[0]).toMatchObject({
      tier: 0,
      name: "inner",
      caughtUp: false,
      unseenCount: 3,
      lastReadAt,
    });
    expect(status[1]).toMatchObject({
      tier: 1,
      name: "closeFriends",
      caughtUp: true,
      unseenCount: 0,
      lastReadAt,
    });
    expect(status[2]).toMatchObject({
      tier: 2,
      name: "community",
      caughtUp: false,
      unseenCount: 7,
    });
    expect(status[3]).toMatchObject({
      tier: 3,
      name: "ambient",
      caughtUp: true,
      unseenCount: 0,
    });
  });

  it("uses epoch as default lastReadAt when timestamps not provided", async () => {
    mockSessionRun.mockResolvedValue(makeResult([{ unseenCount: 0 }]));

    const status = await service.getCircleStatus("viewer-1");

    // All tiers should have lastReadAt = null (no provided timestamps)
    for (const s of status) {
      expect(s.lastReadAt).toBeNull();
    }

    // Should have been called 4 times (one per tier)
    expect(mockSessionRun).toHaveBeenCalledTimes(4);
  });

  it("uses a per-tier query with no EXISTS{}/UNION (Neptune F3/F4)", async () => {
    mockSessionRun.mockResolvedValue(makeResult([{ unseenCount: 0 }]));

    await service.getCircleStatus("viewer-1");

    // C2a: the EXISTS { } subquery is gone — visibility is an inline OR-branch
    // (target:Entity AND (post)-[:ABOUT]->(target)) OR (target:User AND …).
    const [query] = mockSessionRun.mock.calls[0];
    expect(query).not.toContain("EXISTS {");
    expect(query).not.toContain("UNION");
    expect(query).toContain("COUNT(DISTINCT post.id)");
  });
});

// ---------------------------------------------------------------------------
// getCircleEntityStatus
// ---------------------------------------------------------------------------

describe("getCircleEntityStatus", () => {
  it("returns per-entity unseen counts", async () => {
    mockSessionRun.mockResolvedValueOnce(
      makeResult([
        {
          entityId: "entity-1",
          entityName: "Bunsen",
          caughtUp: false,
          unseenCount: 5,
          latestPostAt: now.toISOString(),
        },
        {
          entityId: "entity-2",
          entityName: "Beaker",
          caughtUp: true,
          unseenCount: 0,
          latestPostAt: null,
        },
      ]),
    );

    const statuses = await service.getCircleEntityStatus(
      "viewer-1",
      0,
      twoDaysAgo,
    );

    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({
      entityId: "entity-1",
      entityName: "Bunsen",
      caughtUp: false,
      unseenCount: 5,
    });
    expect(statuses[0].latestPostAt).toBeInstanceOf(Date);
    expect(statuses[1]).toMatchObject({
      entityId: "entity-2",
      entityName: "Beaker",
      caughtUp: true,
      unseenCount: 0,
      latestPostAt: null,
    });
  });

  it("uses epoch when lastReadAt is not provided", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    await service.getCircleEntityStatus("viewer-1", 0);

    const [_query, params] = mockSessionRun.mock.calls[0];
    expect(params.lastReadAt).toBe(new Date(0).toISOString());
  });

  it("passes correct tier bounds", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    await service.getCircleEntityStatus("viewer-1", 2, twoDaysAgo);

    const [_query, params] = mockSessionRun.mock.calls[0];
    expect(params.lowerThreshold).toBe(0.2);
    expect(params.upperThreshold).toBe(0.5);
    expect(params.tierInt).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// markCircleRead
// ---------------------------------------------------------------------------

describe("markCircleRead", () => {
  it("sets the lastReadTier property on the User node", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    await service.markCircleRead("viewer-1", 0, now);

    expect(mockSessionRun).toHaveBeenCalledTimes(1);
    const [query, params] = mockSessionRun.mock.calls[0];
    expect(query).toContain("lastReadTier0");
    expect(params.userId).toBe("viewer-1");
    expect(params.readAt).toBe(now.toISOString());
  });

  it("uses current time when readAt is not provided", async () => {
    mockSessionRun.mockResolvedValueOnce(emptyResult);

    await service.markCircleRead("viewer-1", 2);

    const [query, params] = mockSessionRun.mock.calls[0];
    expect(query).toContain("lastReadTier2");
    // readAt should be a recent ISO timestamp
    expect(new Date(params.readAt as string).getTime()).toBeGreaterThan(
      Date.now() - 5000,
    );
  });

  it("handles all tier values in property name", async () => {
    for (const tier of [0, 1, 2, 3] as CircleTier[]) {
      mockSessionRun.mockResolvedValueOnce(emptyResult);
      await service.markCircleRead("v", tier, now);
      const [query] = mockSessionRun.mock.calls[
        mockSessionRun.mock.calls.length - 1
      ];
      expect(query).toContain(`lastReadTier${tier}`);
    }
  });
});

// ---------------------------------------------------------------------------
// encodeCircleCursor / decodeCircleCursor (round-trip)
// ---------------------------------------------------------------------------

describe("cursor encoding", () => {
  it("round-trips the cursor: page 2 decodes page 1's encoded cursor into query params", async () => {
    const ts = now.toISOString();
    // Page 1 (limit=1): two posts at the same ts arrive on the entity branch →
    // hasMore, a cursor is emitted. getVisiblePostIds runs two branch queries,
    // so page 1 consumes calls 0 (entity) + 1 (author).
    mockSessionRun
      .mockResolvedValueOnce(
        makeResult([
          { postId: "post-1", createdAt: ts, resolvedTier: 0 },
          { postId: "post-2", createdAt: ts, resolvedTier: 0 },
        ]),
      )
      .mockResolvedValueOnce(emptyResult);

    const page1 = await service.getVisiblePostIds("v", 0, twoDaysAgo, { limit: 1 });
    expect(page1.cursor).toBeTruthy();
    // DESC tiebreak on (createdAt, postId) → page 1 keeps the larger id; the
    // cursor points at it so page 2 fetches post.id < it.
    const lastId = page1.items[0].postId;

    // Page 2 with the cursor — both branch queries (calls 2 + 3) get the decoded cursor.
    mockSessionRun.mockResolvedValue(emptyResult);
    await service.getVisiblePostIds("v", 0, twoDaysAgo, { limit: 1, cursor: page1.cursor! });

    const [, params] = mockSessionRun.mock.calls[2];
    expect(params.cursorCreatedAt).toBe(ts);
    expect(params.cursorPostId).toBe(lastId);
  });
});

// ---------------------------------------------------------------------------
// Security: parameterization
// ---------------------------------------------------------------------------

describe("security: parameterization", () => {
  it("never interpolates user-supplied values into queries", async () => {
    // Attempt with a malicious-looking userId
    mockSessionRun.mockResolvedValue(emptyResult);

    const maliciousId = "'; DROP TABLE users; --";
    await service.getCircleMembers(maliciousId, 0);

    const [query, params] = mockSessionRun.mock.calls[0];
    // The malicious string should NOT appear in the query text
    expect(query).not.toContain(maliciousId);
    // It should only appear as a parameter value
    expect(params.viewerId).toBe(maliciousId);
  });
});
