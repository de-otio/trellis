/**
 * Read-path proof (M2): a blocked account's POSTS disappear from the feed and
 * from the single-post read, in BOTH directions, and come back after unblock.
 *
 * The Prisma mock here is not a rubber stamp: `post.findMany` / `post.findUnique`
 * actually apply the `authorId NOT IN (…)` conjunct the handler builds. A test
 * that resolved canned posts regardless of the `where` could not tell a working
 * block from a missing one, which is the whole thing being asserted.
 */

import { PostRadius } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeedHandler } from "../../src/lib/feed-handler.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

const mockGetDatabaseForRegion = vi.fn();
vi.mock("../../src/lib/data-router", () => ({
  DataRouter: {
    getDatabaseForRegion: (...args: any[]) => mockGetDatabaseForRegion(...args),
    getPost: vi.fn(),
  },
}));

const mockExecuteWithRetry = vi.fn();
const mockSharedInstance = {
  createClient: vi.fn(),
  clearPools: vi.fn(),
  getPoolStatus: vi.fn().mockReturnValue([]),
  executeWithRetry: mockExecuteWithRetry,
};
vi.mock("../../src/lib/database-connection-manager", () => ({
  DatabaseConnectionManager: class {
    executeWithRetry = mockSharedInstance.executeWithRetry;
  },
  sharedDatabaseConnectionManager: mockSharedInstance,
}));

const mockGetFriendUserIds = vi.fn();
vi.mock("../../src/lib/friend-ids", () => ({
  FRIEND_TIER_MAX: 1,
  getFriendUserIds: (...args: unknown[]) => mockGetFriendUserIds(...args),
}));

vi.mock("../../src/lib/reaction-handler", () => ({
  ReactionHandler: vi.fn().mockImplementation(() => ({})),
}));

const TENANT = "tenant-1";
const ALICE = "user-alice";
const BOB = "user-bob";
const CARL = "user-carl";

/** Public posts by each of the three, all readable absent a block. */
const POSTS = [
  {
    id: "post-carl",
    authorId: CARL,
    text: "from carl",
    radius: PostRadius.SHOUT,
    createdAt: new Date("2026-09-03T12:00:00Z"),
    tenantId: TENANT,
    author: { id: CARL, email: "carl@example.com" },
    subjectEntities: [],
    media: [],
  },
  {
    id: "post-bob",
    authorId: BOB,
    text: "from bob",
    radius: PostRadius.SHOUT,
    createdAt: new Date("2026-09-02T12:00:00Z"),
    tenantId: TENANT,
    author: { id: BOB, email: "bob@example.com" },
    subjectEntities: [],
    media: [],
  },
  {
    id: "post-alice",
    authorId: ALICE,
    text: "from alice",
    radius: PostRadius.SHOUT,
    createdAt: new Date("2026-09-01T12:00:00Z"),
    tenantId: TENANT,
    author: { id: ALICE, email: "alice@example.com" },
    subjectEntities: [],
    media: [],
  },
];

/**
 * Pull the `authorId NOT IN` list out of whatever shape the caller built —
 * `getHomeFeed` nests the audience filter inside an `AND` array,
 * `getPost` spreads it at the top level.
 */
function extractNotIn(where: any): string[] {
  const candidates = [where, ...(Array.isArray(where?.AND) ? where.AND : [])];
  for (const c of candidates) {
    const notIn = c?.authorId?.notIn;
    if (Array.isArray(notIn)) return notIn;
  }
  return [];
}

function applyBlockFilter(where: any, posts: typeof POSTS) {
  const notIn = extractNotIn(where);
  return posts.filter((p) => !notIn.includes(p.authorId));
}

describe("block read path — posts", () => {
  let handler: FeedHandler;
  let mockDb: any;
  let blockRows: Array<{ blockerId: string; blockedId: string }>;
  let mockEnv: any;
  let requestContext: TrellisRequestContext;

  function sessionFor(userId: string): Session {
    return {
      userId,
      email: `${userId}@example.com`,
      expiresAt: Date.now() + 3_600_000,
    } as unknown as Session;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new FeedHandler();
    blockRows = [];

    mockDb = {
      post: {
        findMany: vi.fn(async (args: any) =>
          applyBlockFilter(args.where, POSTS),
        ),
        findUnique: vi.fn(async (args: any) => {
          const survivors = applyBlockFilter(args.where, POSTS);
          return survivors.find((p) => p.id === args.where.id) ?? null;
        }),
      },
      postSentiment: { groupBy: vi.fn().mockResolvedValue([]) },
      postComment: { groupBy: vi.fn().mockResolvedValue([]) },
      linkCheck: { findMany: vi.fn().mockResolvedValue([]) },
      blockedUser: {
        findUnique: vi.fn().mockResolvedValue(null),
        // The real bidirectional predicate, evaluated against `blockRows`.
        findMany: vi.fn(async (args: any) => {
          const viewer = args.where.OR[0].blockerId;
          return blockRows.filter(
            (r) => r.blockerId === viewer || r.blockedId === viewer,
          );
        }),
      },
    };

    mockGetDatabaseForRegion.mockReturnValue(mockDb);
    mockGetFriendUserIds.mockResolvedValue([]);
    mockExecuteWithRetry.mockImplementation(
      async (_region: string, _env: any, queryFn: (db: any) => Promise<any>) =>
        queryFn(mockDb),
    );
    // Enrichment is orthogonal; keep the post rows recognisable.
    (handler as any).enrichPosts = vi.fn(async (posts: any[]) => posts);

    mockEnv = {
      DATABASE_URL: "postgres://test",
      DEFAULT_REGION: "US",
      // No FEED_CACHE_KV: every call recomputes, so a difference between two
      // calls in one test is the predicate changing, never a cache hit.
    };

    requestContext = {
      region: "US",
      config: {
        features: { performance: { aggressiveCaching: false } },
        featureFlags: { performance: { aggressiveCaching: false } },
      },
    } as unknown as TrellisRequestContext;
  });

  async function feedAuthorsFor(userId: string): Promise<string[]> {
    const response = await handler.getHomeFeed(
      sessionFor(userId),
      new Request("https://api.example.com/api/feeds/home"),
      mockEnv,
      {},
      requestContext,
      TENANT,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { posts: Array<{ authorId: string }> };
    return body.posts.map((p) => p.authorId);
  }

  it("shows everyone's posts when nothing is blocked", async () => {
    expect(await feedAuthorsFor(ALICE)).toEqual([CARL, BOB, ALICE]);
    expect(await feedAuthorsFor(BOB)).toEqual([CARL, BOB, ALICE]);
  });

  it("hides the blocked author's posts from the BLOCKER's feed", async () => {
    blockRows.push({ blockerId: ALICE, blockedId: BOB });

    const authors = await feedAuthorsFor(ALICE);
    expect(authors).not.toContain(BOB);
    // Only Bob goes — an unrelated third party is untouched.
    expect(authors).toEqual([CARL, ALICE]);
  });

  it("hides the blocker's posts from the BLOCKED account's feed too", async () => {
    // Only Alice blocked Bob. Bob must still lose sight of Alice: a one-way
    // hide leaves the blocked account watching the person who blocked them.
    blockRows.push({ blockerId: ALICE, blockedId: BOB });

    const authors = await feedAuthorsFor(BOB);
    expect(authors).not.toContain(ALICE);
    expect(authors).toEqual([CARL, BOB]);
  });

  it("restores both feeds after the block is removed", async () => {
    blockRows.push({ blockerId: ALICE, blockedId: BOB });
    expect(await feedAuthorsFor(ALICE)).not.toContain(BOB);

    blockRows.length = 0; // unblock

    expect(await feedAuthorsFor(ALICE)).toEqual([CARL, BOB, ALICE]);
    expect(await feedAuthorsFor(BOB)).toEqual([CARL, BOB, ALICE]);
  });

  it("resolves the block set with ONE query per feed request", async () => {
    blockRows.push({ blockerId: ALICE, blockedId: BOB });
    await feedAuthorsFor(ALICE);
    expect(mockDb.blockedUser.findMany).toHaveBeenCalledTimes(1);
  });

  it("keeps the exclusion inside the paginating query, not after it", async () => {
    blockRows.push({ blockerId: ALICE, blockedId: BOB });
    await feedAuthorsFor(ALICE);

    const where = mockDb.post.findMany.mock.calls[0][0].where;
    expect(extractNotIn(where)).toEqual([BOB]);
    // `take: limit + 1` is how `hasMore` is decided; the filter must be in the
    // same statement or the count and the rows disagree.
    expect(mockDb.post.findMany.mock.calls[0][0].take).toBeGreaterThan(0);
  });

  it("hides a blocked author's single post by id, in both directions", async () => {
    blockRows.push({ blockerId: ALICE, blockedId: BOB });

    const aliceReadingBob = await handler.getPost(
      "post-bob",
      sessionFor(ALICE),
      mockEnv,
      requestContext,
      TENANT,
    );
    const bobReadingAlice = await handler.getPost(
      "post-alice",
      sessionFor(BOB),
      mockEnv,
      requestContext,
      TENANT,
    );
    const aliceReadingCarl = await handler.getPost(
      "post-carl",
      sessionFor(ALICE),
      mockEnv,
      requestContext,
      TENANT,
    );

    // Indistinguishable from "no such post" — the refusal must not confirm it.
    expect(aliceReadingBob).toBeNull();
    expect(bobReadingAlice).toBeNull();
    expect(aliceReadingCarl).not.toBeNull();
  });

  it("returns the post again once unblocked", async () => {
    blockRows.push({ blockerId: ALICE, blockedId: BOB });
    expect(
      await handler.getPost(
        "post-bob",
        sessionFor(ALICE),
        mockEnv,
        requestContext,
        TENANT,
      ),
    ).toBeNull();

    blockRows.length = 0;

    expect(
      await handler.getPost(
        "post-bob",
        sessionFor(ALICE),
        mockEnv,
        requestContext,
        TENANT,
      ),
    ).not.toBeNull();
  });
});
