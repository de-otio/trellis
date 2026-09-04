/**
 * Unit tests: the `post.published` emission point (plan 034 lane E).
 *
 * Two things are asserted, and the second is the one the lane exists for:
 *
 *  1. a successful `DataRouter.createPost` commits exactly one outbox row,
 *     carrying ids and changed FIELD NAMES — never the post's text;
 *  2. when a later write in the SAME transaction fails, the outbox row is
 *     gone with the post.
 *
 * (2) is why the transaction double stages writes and commits them only when
 * the callback resolves. A `vi.fn()` spy would record `domainEvent.create` as
 * "called" for a transaction that aborted — a green test for the exact bug
 * this lane is meant to make impossible.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataRouterEnv } from "../../../src/lib/data-router.js";
import { DataRouter } from "../../../src/lib/data-router.js";

interface Written {
  table: string;
  data: Record<string, unknown>;
}

/** Rows that survived a transaction, across all calls in one test. */
let committed: Written[] = [];
/** When set, `postMedia.createMany` throws with this message. */
let postMediaFailure: string | null = null;
/** When set, the created post row comes back with this `dataRegion`. */
let postDataRegionOverride: string | null = null;

function createMockDatabase() {
  const stage = (staged: Written[], table: string) => ({
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: table === "post" ? "post-123" : `${table}-1`,
        ...data,
        ...(table === "post" && postDataRegionOverride
          ? { dataRegion: postDataRegionOverride }
          : {}),
      };
      staged.push({ table, data: row });
      return row;
    }),
    createMany: vi.fn(async ({ data }: { data: unknown }) => {
      if (table === "postMedia" && postMediaFailure) {
        throw new Error(postMediaFailure);
      }
      staged.push({ table, data: { rows: data } as Record<string, unknown> });
      return { count: Array.isArray(data) ? data.length : 0 };
    }),
    updateMany: vi.fn(async () => ({ count: 0 })),
  });

  return {
    tenantClassification: { findUnique: vi.fn(async () => null) },
    platformCategory: { findMany: vi.fn(async () => []) },
    post: stage([], "post"),
    // Real commit/rollback semantics: staged writes are published to
    // `committed` only if the callback resolves.
    $transaction: vi.fn(async (callback: any) => {
      const staged: Written[] = [];
      const tx = {
        post: stage(staged, "post"),
        postEntity: stage(staged, "postEntity"),
        postMedia: stage(staged, "postMedia"),
        mediaFile: stage(staged, "mediaFile"),
        domainEvent: stage(staged, "domainEvent"),
        entity: { findMany: vi.fn(async () => []) },
      };
      const result = await callback(tx);
      committed.push(...staged);
      return result;
    }),
  };
}

vi.mock("../../../src/db", () => ({
  createPrismaForRegion: vi.fn(() => createMockDatabase()),
}));

vi.mock("../../../src/lib/region-detection", () => {
  const mockIsValidRegion = vi.fn((region: string) =>
    ["US", "EU", "CN"].includes(region),
  );
  return {
    isValidRegion: mockIsValidRegion,
    RegionDetector: class {
      isValidRegion = mockIsValidRegion;
    },
  };
});

vi.mock("../../../src/lib/audit-composer", () => {
  class MockAuditLogger {
    logUserAction = vi.fn().mockResolvedValue(undefined);
    logDataAccess = vi.fn().mockResolvedValue(undefined);
    withRequestId() {
      return new MockAuditLogger();
    }
  }
  return { TrellisAuditLogger: MockAuditLogger };
});

vi.mock("../../../src/lib/ip-scrubber", () => ({
  getIPAddress: vi.fn(() => "127.0.0.1"),
}));

const env: DataRouterEnv = {
  DATABASE_URL: "postgres://test",
  DEFAULT_REGION: "US",
} as DataRouterEnv;

const SECRET_TEXT = "the post body that must never reach the outbox";

function postData(overrides: Record<string, unknown> = {}) {
  return {
    authorId: "user-123",
    text: SECRET_TEXT,
    tenantId: "tenant_alpha",
    ...overrides,
  };
}

const outboxRows = () => committed.filter((w) => w.table === "domainEvent");

describe("post.published emission point", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    committed = [];
    postMediaFailure = null;
    postDataRegionOverride = null;
  });

  it("commits one outbox row alongside the post", async () => {
    await DataRouter.createPost(postData(), "US", env);

    expect(outboxRows()).toHaveLength(1);
    expect(outboxRows()[0].data).toMatchObject({
      type: "post.published",
      tenantId: "tenant_alpha",
      subjectKind: "post",
      subjectId: "post-123",
    });
  });

  it("carries ids and changed field NAMES, never the post text", async () => {
    await DataRouter.createPost(
      postData({ entityRefs: ["entity-1"], media: [{ id: "media-1" }] }),
      "US",
      env,
    );

    const payload = outboxRows()[0].data.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      postId: "post-123",
      authorId: "user-123",
      entityIds: ["entity-1"],
      mediaIds: ["media-1"],
    });
    // `fields` names the columns the create set — "text" appears as a NAME.
    expect(payload.fields).toContain("text");
    // …and the value never does, anywhere in the row.
    expect(JSON.stringify(outboxRows()[0].data)).not.toContain(SECRET_TEXT);
  });

  it("leaves NO outbox row when a later write in the same transaction fails", async () => {
    postMediaFailure = "postMedia insert exploded";

    await expect(
      DataRouter.createPost(
        postData({ media: [{ id: "media-1" }] }),
        "US",
        env,
      ),
    ).rejects.toThrow("postMedia insert exploded");

    // The whole transaction rolled back: no post, and — the point — no event.
    expect(committed).toEqual([]);
    expect(outboxRows()).toEqual([]);
  });

  it("leaves NO outbox row when the data-region check aborts the transaction", async () => {
    // A pre-existing in-transaction throw, exercised for the same property
    // through a failure path the production code already had: the row comes
    // back stamped with a region that is not the one asked for.
    postDataRegionOverride = "CN";

    await expect(DataRouter.createPost(postData(), "US", env)).rejects.toThrow(
      /Data region mismatch/,
    );

    expect(outboxRows()).toEqual([]);
  });
});
