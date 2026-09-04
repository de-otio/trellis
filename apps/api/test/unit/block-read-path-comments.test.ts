/**
 * Read-path proof (M2), comment side: a blocked account's COMMENTS disappear
 * from a thread in both directions and come back after unblock — and the write
 * guard refuses a comment, a reply and a reaction across a block.
 *
 * As in the feed test, the Prisma mock applies the `authorId NOT IN (…)`
 * conjunct rather than resolving canned rows, so the assertions can distinguish
 * a working exclusion from a missing one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommentHandler } from "../../src/lib/comment-handler.js";
import { ReactionHandler } from "../../src/lib/reaction-handler.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

const mockGetPost = vi.fn();
const mockGetDatabaseForRegion = vi.fn();
vi.mock("../../src/lib/data-router", () => ({
  DataRouter: {
    getPost: (...args: any[]) => mockGetPost(...args),
    getDatabaseForRegion: (...args: any[]) => mockGetDatabaseForRegion(...args),
  },
}));

const mockWithQueryTimeoutAndRetry = vi.fn();
const mockSharedDatabaseConnectionManager = { executeWithRetry: vi.fn() };
vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: mockSharedDatabaseConnectionManager,
  DatabaseConnectionManager: class {
    executeWithRetry = mockSharedDatabaseConnectionManager.executeWithRetry;
  },
}));
vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 3000, retryTimeoutMs: 2000 },
    BACKGROUND: { timeoutMs: 12000, retryTimeoutMs: 5000 },
    CRITICAL: { timeoutMs: 5000, retryTimeoutMs: 3000 },
    STANDARD: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// The post-level gate is exercised in its own tests; here it allows, so any
// disappearance below is the COMMENT-level exclusion and nothing else.
const mockCanReadPost = vi.fn();
vi.mock("../../src/lib/post-read-authorizer", () => ({
  canReadPost: (...args: any[]) => mockCanReadPost(...args),
}));

vi.mock("../../src/lib/database-wrapper-helper", () => ({
  getWrappedDatabase: () => ({
    linkCheck: { findMany: vi.fn().mockResolvedValue([]) },
  }),
}));

vi.mock("../../src/lib/validate-request", () => ({
  validateRequest: vi
    .fn()
    .mockResolvedValue({ success: true, data: { text: "hello" } }),
}));

const mockIsEnabled = vi.fn().mockResolvedValue(false);
vi.mock("../../src/lib/feature-toggle-service", () => ({
  FeatureToggleService: class {
    isEnabled = mockIsEnabled;
    isEnabledFailClosed = mockIsEnabled;
  },
}));

vi.mock("../../src/lib/link-security-handler", () => ({
  LinkSecurityHandler: class {
    extractUrls = vi.fn().mockReturnValue([]);
    validateUrlSync = vi.fn().mockReturnValue({ status: "safe" });
  },
  LinkStatus: { BLOCKED: "blocked", SUSPICIOUS: "suspicious", SAFE: "safe" },
}));

vi.mock("../../src/lib/feed-handler", () => ({
  FeedHandler: { invalidateFeedCache: vi.fn() },
}));

const mockCreatePrisma = vi.fn();
vi.mock("../../src/db", () => ({
  createPrisma: (...args: any[]) => mockCreatePrisma(...args),
}));

vi.mock("../../src/lib/provenance/posture-gate", () => ({
  gateDeclarationOrRespond: vi.fn().mockResolvedValue(null),
}));

const TENANT = "tenant-1";
const ALICE = "user-alice";
const BOB = "user-bob";
const CARL = "user-carl";
const POST_ID = "post-carl";

/** A thread under CARL's post, with one comment from each of the three. */
const COMMENTS = [
  {
    id: "c-carl",
    authorId: CARL,
    text: "carl says",
    postUri: null,
    createdAt: new Date("2026-09-03T12:00:00Z"),
  },
  {
    id: "c-bob",
    authorId: BOB,
    text: "bob says",
    postUri: null,
    createdAt: new Date("2026-09-02T12:00:00Z"),
  },
  {
    id: "c-alice",
    authorId: ALICE,
    text: "alice says",
    postUri: null,
    createdAt: new Date("2026-09-01T12:00:00Z"),
  },
];

function sessionFor(userId: string): Session {
  return {
    userId,
    email: `${userId}@example.com`,
    expiresAt: Date.now() + 3_600_000,
  } as unknown as Session;
}

describe("block read path — comments", () => {
  let handler: CommentHandler;
  let reactions: ReactionHandler;
  let mockDb: any;
  let blockRows: Array<{ blockerId: string; blockedId: string }>;
  let mockEnv: any;
  let requestContext: TrellisRequestContext;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CommentHandler();
    reactions = new ReactionHandler();
    blockRows = [];
    mockCanReadPost.mockResolvedValue(true);

    mockDb = {
      post: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ deletedAt: null, tenantId: TENANT }),
      },
      postComment: {
        findMany: vi.fn(async (args: any) => {
          const notIn: string[] = args.where?.authorId?.notIn ?? [];
          return COMMENTS.filter((c) => !notIn.includes(c.authorId));
        }),
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "new-comment",
          createdAt: new Date(),
          text: "hello",
        }),
      },
      postSentiment: { upsert: vi.fn().mockResolvedValue({}) },
      commentSentiment: {
        groupBy: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
      },
      linkCheck: { findMany: vi.fn().mockResolvedValue([]) },
      blockedUser: {
        findUnique: vi.fn(async (args: any) => {
          const { blockerId, blockedId } =
            args.where.tenantId_blockerId_blockedId;
          return blockRows.some(
            (r) => r.blockerId === blockerId && r.blockedId === blockedId,
          )
            ? { id: "block-row" }
            : null;
        }),
        findMany: vi.fn(async (args: any) => {
          const viewer = args.where.OR[0].blockerId;
          return blockRows.filter(
            (r) => r.blockerId === viewer || r.blockedId === viewer,
          );
        }),
      },
    };

    mockCreatePrisma.mockReturnValue(mockDb);
    mockGetDatabaseForRegion.mockReturnValue(mockDb);
    mockGetPost.mockResolvedValue({
      id: POST_ID,
      authorId: CARL,
      tenantId: TENANT,
      uri: null,
      dataRegion: "US",
    });
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (
        _manager: any,
        _region: string,
        _env: any,
        queryFn: (db: any) => Promise<any>,
      ) => queryFn(mockDb),
    );

    mockEnv = { DATABASE_URL: "postgres://test", DEFAULT_REGION: "US" };
    requestContext = { region: "US" } as unknown as TrellisRequestContext;
  });

  async function threadAuthorsFor(userId: string): Promise<string[]> {
    const response = await handler.getComments(
      POST_ID,
      new Request(`https://api.example.com/api/posts/${POST_ID}/comments`),
      sessionFor(userId),
      {},
      mockEnv,
      requestContext,
      TENANT,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      comments: Array<{ authorId: string }>;
    };
    return body.comments.map((c) => c.authorId);
  }

  it("shows the whole thread when nothing is blocked", async () => {
    expect(await threadAuthorsFor(ALICE)).toEqual([CARL, BOB, ALICE]);
  });

  it("hides the blocked account's comment from the blocker's view of the thread", async () => {
    blockRows.push({ blockerId: ALICE, blockedId: BOB });
    const authors = await threadAuthorsFor(ALICE);
    expect(authors).not.toContain(BOB);
    expect(authors).toEqual([CARL, ALICE]);
  });

  it("hides the blocker's comment from the blocked account's view too", async () => {
    blockRows.push({ blockerId: ALICE, blockedId: BOB });
    const authors = await threadAuthorsFor(BOB);
    expect(authors).not.toContain(ALICE);
    expect(authors).toEqual([CARL, BOB]);
  });

  it("restores the thread for both after unblock", async () => {
    blockRows.push({ blockerId: ALICE, blockedId: BOB });
    expect(await threadAuthorsFor(ALICE)).not.toContain(BOB);

    blockRows.length = 0;

    expect(await threadAuthorsFor(ALICE)).toEqual([CARL, BOB, ALICE]);
    expect(await threadAuthorsFor(BOB)).toEqual([CARL, BOB, ALICE]);
  });

  it("applies the exclusion in the paginating query, keeping the cursor exact", async () => {
    blockRows.push({ blockerId: ALICE, blockedId: BOB });
    await threadAuthorsFor(ALICE);

    const args = mockDb.postComment.findMany.mock.calls[0][0];
    expect(args.where.authorId).toEqual({ notIn: [BOB] });
    expect(args.take).toBeGreaterThan(0);
  });

  it("adds no predicate at all when the viewer has no blocks", async () => {
    await threadAuthorsFor(ALICE);
    expect(
      mockDb.postComment.findMany.mock.calls[0][0].where.authorId,
    ).toBeUndefined();
  });
});

describe("block write guard", () => {
  let handler: CommentHandler;
  let reactions: ReactionHandler;
  let mockDb: any;
  let blockRows: Array<{ blockerId: string; blockedId: string }>;
  let mockEnv: any;
  let requestContext: TrellisRequestContext;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CommentHandler();
    reactions = new ReactionHandler();
    blockRows = [{ blockerId: CARL, blockedId: BOB }]; // Carl blocked Bob

    mockDb = {
      post: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ deletedAt: null, tenantId: TENANT }),
      },
      postComment: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue({
          postId: POST_ID,
          deletedAt: null,
          authorId: CARL,
        }),
        findUnique: vi.fn().mockResolvedValue({
          id: "c-carl",
          authorId: CARL,
          tenantId: TENANT,
          postUri: null,
          post: { authorId: CARL, dataRegion: "US" },
        }),
        create: vi.fn().mockResolvedValue({
          id: "new-comment",
          createdAt: new Date(),
          text: "hello",
        }),
      },
      postSentiment: { upsert: vi.fn().mockResolvedValue({}) },
      commentSentiment: { upsert: vi.fn().mockResolvedValue({}) },
      linkCheck: { findMany: vi.fn().mockResolvedValue([]) },
      blockedUser: {
        findUnique: vi.fn(async (args: any) => {
          const { blockerId, blockedId } =
            args.where.tenantId_blockerId_blockedId;
          return blockRows.some(
            (r) => r.blockerId === blockerId && r.blockedId === blockedId,
          )
            ? { id: "block-row" }
            : null;
        }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    mockCreatePrisma.mockReturnValue(mockDb);
    mockGetDatabaseForRegion.mockReturnValue(mockDb);
    mockGetPost.mockResolvedValue({
      id: POST_ID,
      authorId: CARL,
      tenantId: TENANT,
      uri: null,
      dataRegion: "US",
    });
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (
        _manager: any,
        _region: string,
        _env: any,
        queryFn: (db: any) => Promise<any>,
      ) => queryFn(mockDb),
    );

    mockEnv = { DATABASE_URL: "postgres://test", DEFAULT_REGION: "US" };
    requestContext = { region: "US" } as unknown as TrellisRequestContext;
  });

  function commentRequest(): Request {
    return new Request(
      `https://api.example.com/api/posts/${POST_ID}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      },
    );
  }

  it("refuses a comment from the blocked account with 403 + remediation", async () => {
    const response = await handler.createComment(
      POST_ID,
      commentRequest(),
      sessionFor(BOB),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("BLOCKED");
    expect(body.remediation).toContain("/api/blocks");
    expect(mockDb.postComment.create).not.toHaveBeenCalled();
  });

  it("refuses a comment from the BLOCKER on the blocked account's post too", async () => {
    // Carl (the blocker) commenting under Bob's post: the block is symmetric,
    // so this is refused as well. Asymmetry here would let a blocker keep
    // posting at someone who can no longer answer.
    mockGetPost.mockResolvedValue({
      id: "post-bob",
      authorId: BOB,
      tenantId: TENANT,
      uri: null,
      dataRegion: "US",
    });

    const response = await handler.createComment(
      "post-bob",
      commentRequest(),
      sessionFor(CARL),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(403);
    expect(mockDb.postComment.create).not.toHaveBeenCalled();
  });

  it("lets an unrelated third party comment normally", async () => {
    const response = await handler.createComment(
      POST_ID,
      commentRequest(),
      sessionFor(ALICE),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).not.toBe(403);
  });

  it("refuses a reply to the blocked counterparty's comment", async () => {
    const response = await handler.createReply(
      "c-carl",
      commentRequest(),
      sessionFor(BOB),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("BLOCKED");
  });

  it("refuses a reaction to the blocked counterparty's post", async () => {
    const response = await reactions.addPostSentiment(
      POST_ID,
      "joy",
      sessionFor(BOB),
      mockEnv,
      requestContext,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("BLOCKED");
    expect(mockDb.postSentiment.upsert).not.toHaveBeenCalled();
  });

  it("refuses a reaction to the blocked counterparty's comment", async () => {
    const response = await reactions.addCommentSentiment(
      "c-carl",
      "joy",
      sessionFor(BOB),
      mockEnv,
      requestContext,
    );

    expect(response.status).toBe(403);
    expect(mockDb.commentSentiment.upsert).not.toHaveBeenCalled();
  });

  it("allows a reaction once the block is lifted", async () => {
    blockRows.length = 0;

    const response = await reactions.addPostSentiment(
      POST_ID,
      "joy",
      sessionFor(BOB),
      mockEnv,
      requestContext,
    );

    expect(response.status).toBe(200);
    expect(mockDb.postSentiment.upsert).toHaveBeenCalled();
  });
});
