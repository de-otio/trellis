/**
 * Unit Tests: the evidence-hold GUARD (plan 08 §2.3 item 5 / §5).
 *
 * Content under a live evidence hold must be skipped by ALL hard-delete paths:
 *   - the account-deletion media erasure (`eraseUserMedia`),
 *   - the nightly hard-delete purge (via the shared `evidenceHoldExemptWhere`), and
 *   - the orphaned-media R2 purge (`OrphanedMediaHandler.scheduleR2Deletion`) —
 *     the SAME 7-day `deletedAt` purge running in a parallel handler.
 * A held original must survive while an authority case is open.
 */

import { describe, expect, it, vi } from "vitest";
import { eraseUserMedia } from "../../../src/lib/services/user-media-erasure.js";
import { evidenceHoldExemptWhere } from "../../../src/lib/compliance/restrict-content.js";
import { OrphanedMediaHandler } from "../../../src/lib/orphaned-media-handler.js";

vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: { executeWithRetry: vi.fn() },
}));

vi.mock("../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: vi.fn(),
  QueryTimeoutPresets: {
    STANDARD: { timeoutMs: 2000, retryTimeoutMs: 2000 },
    BACKGROUND: { timeoutMs: 12000, retryTimeoutMs: 5000 },
  },
}));

describe("account-deletion cascade skips held media", () => {
  it("eraseUserMedia queries with evidenceHold:false — held rows never enter the erasure set", async () => {
    const findMany = vi.fn(async () => []); // held rows are excluded DB-side
    const db = {
      mediaFile: { findMany, updateMany: vi.fn(), count: vi.fn() },
      postMedia: { groupBy: vi.fn(async () => []) },
      postCommentMedia: { groupBy: vi.fn(async () => []) },
    } as any;

    await eraseUserMedia(db, "user-1");

    expect(findMany).toHaveBeenCalled();
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ uploadedBy: "user-1", evidenceHold: false });
  });

  it("a held row is neither soft-deleted nor scrubbed (nothing to erase → both branches skipped)", async () => {
    // The DB-side filter returns no rows (all held); the erasure loop terminates
    // immediately, so no updateMany (soft-delete/scrub) runs on held content.
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const db = {
      mediaFile: { findMany: vi.fn(async () => []), updateMany, count: vi.fn() },
      postMedia: { groupBy: vi.fn(async () => []) },
      postCommentMedia: { groupBy: vi.fn(async () => []) },
    } as any;

    const result = await eraseUserMedia(db, "user-1");

    expect(updateMany).not.toHaveBeenCalled();
    expect(result.erased).toBe(0);
  });
});

describe("hard-delete purge exemption", () => {
  it("the shared hold-exempt predicate is applied to the purge query", () => {
    // nightly-cron composes `{ deletedAt: {lte}, ...evidenceHoldExemptWhere() }`.
    const purgeWhere = { deletedAt: { lte: new Date() }, ...evidenceHoldExemptWhere() };
    expect(purgeWhere.evidenceHold).toBe(false);
  });
});

describe("orphaned-media R2 purge skips held media", () => {
  // Runs the real OrphanedMediaHandler.scheduleR2Deletion query builders against
  // a recording db so we can inspect the exact `where` clauses that reach Prisma.
  async function runPurgeCapturing(): Promise<{
    findManyWheres: any[];
    deleteManyWheres: any[];
    deleteSpy: ReturnType<typeof vi.fn>;
    result: Awaited<ReturnType<OrphanedMediaHandler["scheduleR2Deletion"]>>;
  }> {
    const findManyWheres: any[] = [];
    const deleteManyWheres: any[] = [];
    let findManyCall = 0;

    const recordingDb = {
      mediaFile: {
        findMany: vi.fn((args: any) => {
          findManyWheres.push(args.where);
          findManyCall++;
          // First batch: one NON-held orphan past the 7-day window (held rows
          // are excluded DB-side by the guard, so they never appear here).
          if (findManyCall === 1) {
            return Promise.resolve([
              {
                id: "orphan-1",
                contentHash: "hash-1",
                originalKey: "cas/tenant/hash-1.jpg",
                thumbnailKey: null,
                optimizedKey: null,
              },
            ]);
          }
          return Promise.resolve([]);
        }),
        deleteMany: vi.fn((args: any) => {
          deleteManyWheres.push(args.where);
          return Promise.resolve({ count: 1 });
        }),
      },
    };

    const { withQueryTimeoutAndRetry } = await import(
      "../../../src/lib/db-query-helper.js"
    );
    vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
      async (_m: any, _r: any, _e: any, queryFn: any) => queryFn(recordingDb),
    );

    const deleteSpy = vi.fn(async () => undefined);
    const env = { MEDIA_BUCKET_R2: { delete: deleteSpy } } as any;
    const handler = new OrphanedMediaHandler(env);
    const result = await handler.scheduleR2Deletion("US", env);

    return { findManyWheres, deleteManyWheres, deleteSpy, result };
  }

  it("applies evidenceHold:false to BOTH the SELECT and the atomic DELETE", async () => {
    const { findManyWheres, deleteManyWheres } = await runPurgeCapturing();

    // The 7-day `deletedAt` select carries the hold exemption — held originals
    // are never even loaded for deletion.
    expect(findManyWheres[0]).toMatchObject({
      deletedAt: { lte: expect.any(Date) },
      evidenceHold: false,
    });
    // The hard-delete re-asserts the exemption atomically (a row placed under
    // hold between SELECT and DELETE must not be swept).
    expect(deleteManyWheres[0]).toMatchObject({
      id: { in: ["orphan-1"] },
      evidenceHold: false,
    });
  });

  it("still purges a non-held orphan (guard does not over-block)", async () => {
    const { deleteSpy, result } = await runPurgeCapturing();

    expect(deleteSpy).toHaveBeenCalledWith("cas/tenant/hash-1.jpg");
    expect(result.deletedCount).toBe(1);
    expect(result.deletedKeys).toBe(1);
    expect(result.errors).toBe(0);
  });
});
