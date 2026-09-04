/**
 * Unit tests: BlockHandler (M2 write path).
 *
 * The block is the user-side remedy on a platform with no standing human
 * moderator, so these cover the cases where a half-working block is worse than
 * none: a self-block, a repeat block that must not 409, a block that must take
 * the relationship edges with it, and an unblock that must succeed whether or
 * not the row was there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    tenantMember: { findFirst: vi.fn() },
    blockedUser: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    relationship: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../../src/db.js", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

import { BlockHandler } from "../../src/lib/block-handler.js";

const TENANT = "tenant-1";
const VIEWER = "user-viewer";
const TARGET = "user-target";

const mockEnv = {
  DATABASE_URL: "postgresql://test:test@localhost/test",
  // No FEED_CACHE_KV — invalidateFeedCache short-circuits, which is also the
  // deployment shape when the KV binding is absent.
} as unknown as Env;

const requestContext = {} as TrellisRequestContext;

function makeSession(): Session {
  return {
    userId: VIEWER,
    email: "viewer@example.com",
    role: "END_USER",
    expiresAt: Date.now() + 3_600_000,
  } as unknown as Session;
}

function blockRequest(body: unknown): Request {
  return new Request("https://api.example.com/api/blocks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("BlockHandler.handleBlockUser", () => {
  let handler: BlockHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new BlockHandler();
    mockPrisma.tenantMember.findFirst.mockResolvedValue({ id: "member-1" });
    mockPrisma.blockedUser.findUnique.mockResolvedValue(null);
    mockPrisma.$transaction.mockResolvedValue([
      { createdAt: new Date("2026-09-04T10:00:00.000Z") },
      { count: 0 },
    ]);
  });

  it("rejects a self-block with 400", async () => {
    const response = await handler.handleBlockUser(
      blockRequest({ userId: VIEWER }),
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "VALIDATION_ERROR",
      message: "Cannot block yourself",
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a body with unknown fields (strict schema)", async () => {
    const response = await handler.handleBlockUser(
      blockRequest({ userId: TARGET, tenantId: "other-tenant" }),
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("404s when the target is not a member of the caller's tenant", async () => {
    mockPrisma.tenantMember.findFirst.mockResolvedValue(null);

    const response = await handler.handleBlockUser(
      blockRequest({ userId: TARGET }),
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("NOT_FOUND");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates the block and removes BOTH relationship edges in one transaction", async () => {
    mockPrisma.$transaction.mockResolvedValue([
      { createdAt: new Date("2026-09-04T10:00:00.000Z") },
      { count: 2 },
    ]);

    const response = await handler.handleBlockUser(
      blockRequest({ userId: TARGET }),
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      blockedUserId: TARGET,
      createdAt: "2026-09-04T10:00:00.000Z",
      alreadyBlocked: false,
      relationshipsRemoved: 2,
    });

    expect(mockPrisma.blockedUser.create).toHaveBeenCalledWith({
      data: { tenantId: TENANT, blockerId: VIEWER, blockedId: TARGET },
      select: { createdAt: true },
    });
    // Both directions, tenant-scoped, user targets only.
    expect(mockPrisma.relationship.deleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        targetType: "user",
        OR: [
          { userId: VIEWER, targetId: TARGET },
          { userId: TARGET, targetId: VIEWER },
        ],
      },
    });
    // One transaction, both statements in it.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it("is idempotent: a repeat block is 200 alreadyBlocked, not 409", async () => {
    mockPrisma.blockedUser.findUnique.mockResolvedValue({
      id: "block-1",
      createdAt: new Date("2026-09-01T08:00:00.000Z"),
    });

    const response = await handler.handleBlockUser(
      blockRequest({ userId: TARGET }),
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      blockedUserId: TARGET,
      createdAt: "2026-09-01T08:00:00.000Z",
      alreadyBlocked: true,
      relationshipsRemoved: 0,
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("treats a lost unique-key race (P2002) as the same idempotent success", async () => {
    const conflict: any = new Error("Unique constraint failed");
    conflict.code = "P2002";
    mockPrisma.$transaction.mockRejectedValue(conflict);

    const response = await handler.handleBlockUser(
      blockRequest({ userId: TARGET }),
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).alreadyBlocked).toBe(true);
  });

  it("500s on an unexpected database failure rather than reporting success", async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error("connection reset"));

    const response = await handler.handleBlockUser(
      blockRequest({ userId: TARGET }),
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("INTERNAL_ERROR");
  });

  it("400s on a malformed JSON body", async () => {
    const request = new Request("https://api.example.com/api/blocks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    const response = await handler.handleBlockUser(
      request,
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
  });
});

describe("BlockHandler.handleUnblockUser", () => {
  let handler: BlockHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new BlockHandler();
    mockPrisma.blockedUser.deleteMany.mockResolvedValue({ count: 1 });
  });

  const request = new Request(
    `https://api.example.com/api/blocks/${TARGET}`,
    { method: "DELETE" },
  );

  it("deletes only the caller's own outgoing edge and returns 204", async () => {
    const response = await handler.handleUnblockUser(
      TARGET,
      request,
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(204);
    expect(mockPrisma.blockedUser.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, blockerId: VIEWER, blockedId: TARGET },
    });
  });

  it("is idempotent: unblocking someone who was not blocked is still 204", async () => {
    mockPrisma.blockedUser.deleteMany.mockResolvedValue({ count: 0 });

    const response = await handler.handleUnblockUser(
      TARGET,
      request,
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(204);
  });

  it("400s on a missing path parameter", async () => {
    const response = await handler.handleUnblockUser(
      "",
      request,
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(400);
    expect(mockPrisma.blockedUser.deleteMany).not.toHaveBeenCalled();
  });
});

describe("BlockHandler.handleListBlocks", () => {
  let handler: BlockHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new BlockHandler();
  });

  function listRequest(query = ""): Request {
    return new Request(`https://api.example.com/api/blocks${query}`, {
      method: "GET",
    });
  }

  it("returns the caller's OUTGOING blocks only, newest first", async () => {
    mockPrisma.blockedUser.findMany.mockResolvedValue([
      {
        id: "b2",
        blockedId: "user-b",
        createdAt: new Date("2026-09-02T00:00:00.000Z"),
      },
      {
        id: "b1",
        blockedId: "user-a",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    ]);

    const response = await handler.handleListBlocks(
      listRequest(),
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      blocks: [
        { userId: "user-b", createdAt: "2026-09-02T00:00:00.000Z" },
        { userId: "user-a", createdAt: "2026-09-01T00:00:00.000Z" },
      ],
      hasMore: false,
    });

    const args = mockPrisma.blockedUser.findMany.mock.calls[0][0];
    // Outgoing only: `blockerId` is the caller. Never a `blockedId: caller`
    // arm — "who blocked me" is not the caller's information.
    expect(args.where).toMatchObject({ tenantId: TENANT, blockerId: VIEWER });
    expect(JSON.stringify(args.where)).not.toContain("blockedId");
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("emits a keyset cursor that round-trips into the next page's predicate", async () => {
    const boundary = new Date("2026-09-01T00:00:00.000Z");
    // limit+1 rows => hasMore
    mockPrisma.blockedUser.findMany.mockResolvedValue([
      { id: "b2", blockedId: "user-b", createdAt: boundary },
      { id: "b1", blockedId: "user-a", createdAt: boundary },
    ]);

    const first = await handler.handleListBlocks(
      listRequest("?limit=1"),
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );
    const firstBody = (await first.json()) as {
      blocks: unknown[];
      cursor: string;
      hasMore: boolean;
    };

    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.blocks).toHaveLength(1);
    expect(typeof firstBody.cursor).toBe("string");

    mockPrisma.blockedUser.findMany.mockResolvedValue([]);
    await handler.handleListBlocks(
      listRequest(`?limit=1&cursor=${encodeURIComponent(firstBody.cursor)}`),
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    // The tie on createdAt is why the cursor carries the id: a bare
    // `createdAt <` predicate would drop the second row entirely.
    const nextWhere =
      mockPrisma.blockedUser.findMany.mock.calls[1][0].where;
    expect(nextWhere.OR).toEqual([
      { createdAt: { lt: boundary } },
      { createdAt: boundary, id: { lt: "b2" } },
    ]);
  });

  it("caps the page size at 100", async () => {
    mockPrisma.blockedUser.findMany.mockResolvedValue([]);

    await handler.handleListBlocks(
      listRequest("?limit=5000"),
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(mockPrisma.blockedUser.findMany.mock.calls[0][0].take).toBe(101);
  });

  it("ignores a cursor it did not issue rather than 500ing", async () => {
    mockPrisma.blockedUser.findMany.mockResolvedValue([]);

    const response = await handler.handleListBlocks(
      listRequest("?cursor=not-a-real-cursor"),
      makeSession(),
      mockEnv,
      requestContext,
      TENANT,
    );

    expect(response.status).toBe(200);
    expect(
      mockPrisma.blockedUser.findMany.mock.calls[0][0].where.OR,
    ).toBeUndefined();
  });
});
