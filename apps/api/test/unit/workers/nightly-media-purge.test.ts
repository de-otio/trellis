/**
 * The nightly soft-deleted-media purge (nightly-cron.ts step 1).
 *
 * Why this suite exists: the purge WAS tested — and the test asserted the bug.
 * `test/unit/lambda/nightly-cron.test.ts` carried "tolerates an S3 batch
 * failure and still hard-deletes the DB rows", which pinned the following as
 * intended behaviour rather than leaving it as an oversight:
 *
 *     try { await ctx.objectStore.deleteObjects(batch) }
 *     catch (err) { logger.error(...) }        // <- swallowed
 *     await db.mediaFile.deleteMany({ ... })   // <- ran regardless
 *
 * The MediaFile row is the ONLY remaining record of which objects exist, so
 * hard-deleting it after a failed object delete strands those bytes with no key
 * left to derive and no way to reclaim them. Cumulative, irreversible, and
 * silent — no 5xx, no throw reaching a caller, just a logged error on a job
 * nobody reads when it is green.
 *
 * "Tolerates" was the right instinct aimed at the wrong subject: the cron must
 * not throw (one bad batch cannot take down the other four steps), but
 * tolerating a failure means KEEPING the row, not discarding it. That old test
 * is now reversed, and this suite covers the cases a single assertion on the
 * Lambda entrypoint could not reach — partial batches, multi-key rows, and
 * rows with no keys at all.
 *
 * These tests assert OUTCOMES on the fake Prisma (which ids were passed to
 * `deleteMany`), not log text, because the log was already correct — it was the
 * deletion that was wrong.
 */

import { describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import { runNightlyCron } from "../../../src/lib/workers/nightly-cron.js";
import { evidenceHoldExemptWhere } from "../../../src/lib/compliance/restrict-content.js";
import { makeKvCronLock } from "../../../src/lib/workers/cron-lock.js";
import { noopMetrics } from "../../../src/lib/workers/metrics-port.js";
import type { Logger } from "../../../src/lib/logger.js";

const DAY = 24 * 60 * 60 * 1000;
/** Any instant; the cron derives its 7-day cutoff from it. Frozen, not `now`. */
const NOW = new Date("2026-03-01T02:00:00.000Z").getTime();

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

interface Row {
  id: string;
  originalKey: string | null;
  thumbnailKey: string | null;
  optimizedKey: string | null;
  c2paSidecarKey: string | null;
}

/** A soft-deleted row well past the 7-day window, with `n` distinct keys. */
function row(id: string, ...keys: (string | null)[]): Row {
  return {
    id,
    originalKey: keys[0] ?? null,
    thumbnailKey: keys[1] ?? null,
    optimizedKey: keys[2] ?? null,
    c2paSidecarKey: keys[3] ?? null,
  };
}

function makeDb(mediaToDelete: Row[]) {
  return {
    mediaFile: {
      findMany: vi.fn().mockResolvedValue(mediaToDelete),
      deleteMany: vi.fn().mockImplementation(async ({ where }: any) => ({
        count: where.id.in.length,
      })),
    },
    invitation: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn().mockResolvedValue({}),
    },
    deletionAuditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

/** Run the cron with a store whose `deleteObjects` behaves as given. */
async function run(rows: Row[], deleteObjects: (keys: readonly string[]) => Promise<void>) {
  const db = makeDb(rows);
  const logger = makeLogger();
  const spy = vi.fn(deleteObjects);
  await runNightlyCron({
    getDb: async () => db as never,
    logger,
    metrics: noopMetrics,
    cronLock: makeKvCronLock(new MemoryKvStore()),
    clock: () => NOW,
    resolvePseudonymSecret: async () => "a-non-empty-pseudonym-secret",
    deleteStagingObjects: async () => ({ requested: 0, failedBatches: 0, truncated: false }),
    objectStore: { deleteObjects: spy },
  } as never);
  return { db, logger, spy };
}

/** The ids handed to `deleteMany`, flattened across calls. */
function hardDeleted(db: ReturnType<typeof makeDb>): string[] {
  return db.mediaFile.deleteMany.mock.calls.flatMap((c: any[]) => c[0]?.where?.id?.in ?? []);
}

describe("nightly purge — a row outlives a failed object delete", () => {
  it("hard-deletes rows whose objects were deleted", async () => {
    const rows = [row("m1", "cas/t/a"), row("m2", "cas/t/b")];
    const { db, spy } = await run(rows, async () => {});

    expect(spy).toHaveBeenCalledTimes(1);
    expect(hardDeleted(db).sort()).toEqual(["m1", "m2"]);
  });

  it("does NOT hard-delete a row whose object delete threw", async () => {
    // The regression. Old behaviour: deleteMany called with BOTH ids.
    const rows = [row("m1", "cas/t/a")];
    const { db, logger } = await run(rows, async () => {
      throw new Error("ENOTFOUND s3.example.invalid");
    });

    expect(hardDeleted(db)).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      "S3 batch delete failed",
      expect.objectContaining({ batchSize: 1 }),
    );
  });

  it("purges the unaffected rows and defers only the failed batch's owners", async () => {
    // 1001 keys → two batches; the second (one key, owned by m-last) fails.
    // Proves the deferral is per-owner, not all-or-nothing: a single bad key
    // must not strand 1000 healthy rows, and must not take its own row with it.
    const rows: Row[] = [];
    for (let i = 0; i < 1000; i++) rows.push(row(`m${i}`, `cas/t/k${i}`));
    rows.push(row("m-last", "cas/t/tail"));

    const { db } = await run(rows, async (keys) => {
      if (keys.includes("cas/t/tail")) throw new Error("boom");
    });

    const deleted = hardDeleted(db);
    expect(deleted).toHaveLength(1000);
    expect(deleted).not.toContain("m-last");
  });

  it("defers EVERY row in a failed batch, not just the first", async () => {
    // Two rows share one batch; the batch fails. Both must survive — an
    // owner-map that only recorded the last writer would drop one.
    const rows = [row("m1", "cas/t/a"), row("m2", "cas/t/b")];
    const { db } = await run(rows, async () => {
      throw new Error("boom");
    });
    expect(hardDeleted(db)).toEqual([]);
  });

  it("keeps a multi-key row whose FIRST key failed, even if its others succeeded", async () => {
    // A row owns three keys spread across two batches. Partial success is not
    // success: one surviving object is one orphan.
    const many: Row[] = [];
    for (let i = 0; i < 999; i++) many.push(row(`f${i}`, `cas/t/f${i}`));
    // 999 filler keys + this row's 3 keys = 1002 → keys 1000-1002 land in
    // batch 2, so "split" owns keys in both batches.
    const split = row("split", "cas/t/x1", "cas/t/x2", "cas/t/x3");
    const { db } = await run([...many, split], async (keys) => {
      if (keys.includes("cas/t/x1")) throw new Error("boom");
    });

    expect(hardDeleted(db)).not.toContain("split");
  });

  it("still purges a row that owns no object keys at all", async () => {
    // Nothing to strand, so nothing to defer — the row must not get stuck
    // forever occupying the take:200 budget.
    const { db, spy } = await run([row("m-keyless", null, null, null)], async () => {});
    expect(spy).not.toHaveBeenCalled();
    expect(hardDeleted(db)).toEqual(["m-keyless"]);
  });

  it("reports the deferred count so a permanently-stuck key is observable", async () => {
    const { logger } = await run([row("m1", "cas/t/a")], async () => {
      throw new Error("boom");
    });
    expect(logger.info).toHaveBeenCalledWith(
      "Soft-deleted media purged",
      expect.objectContaining({ dbDeleted: 0, purgeDeferred: 1 }),
    );
  });

  it("issues no deleteMany at all when every row is deferred", async () => {
    // `deleteMany({ id: { in: [] } })` would be a no-op, but issuing it says
    // "I purged" to anyone reading query logs. Say nothing instead.
    const { db } = await run([row("m1", "cas/t/a")], async () => {
      throw new Error("boom");
    });
    expect(db.mediaFile.deleteMany).not.toHaveBeenCalled();
  });

  it("selects only rows soft-deleted before the 7-day cutoff", async () => {
    // Non-vacuity for the whole suite: proves the window is derived from the
    // injected clock, so these fixtures are inside a real query, not accepted
    // by a `findMany` that ignores its `where`.
    const { db } = await run([], async () => {});
    const where = db.mediaFile.findMany.mock.calls[0][0].where;
    expect(where.deletedAt.lte.getTime()).toBe(NOW - 7 * DAY);
  });

  it("excludes content under a live evidence hold (compliance plan 08 §2.3)", async () => {
    // The guard has to sit on THIS query. Main split the cron into a thin
    // Lambda entrypoint plus this worker; the compliance branch had patched the
    // pre-split file, so a naive merge would have left the real purge
    // unguarded and hard-deleted originals while an authority case was open.
    const { db } = await run([], async () => {});
    const where = db.mediaFile.findMany.mock.calls[0][0].where;
    expect(where.evidenceHold).toBe(false);
    // Same predicate the account-deletion cascade and the orphan purge use.
    expect(where).toMatchObject(evidenceHoldExemptWhere());
  });
});

describe("nightly purge — the C2PA manifest sidecar", () => {
  // A kept manifest is MORE identifying than the pixels it describes: camera
  // model and serial number, capture times, edit history, often an identity
  // claim. An erasure that reclaimed the image and left the sidecar would
  // delete the least sensitive half of the upload. GDPR Art. 17 routes through
  // this purge (user-media-erasure.ts soft-deletes; this is what reclaims the
  // bytes), so it is the one place the sidecar MUST be covered.

  it("selects the sidecar key, so the purge can even see it", async () => {
    const { db } = await run([], async () => {});
    const select = db.mediaFile.findMany.mock.calls[0][0].select;
    expect(select.c2paSidecarKey).toBe(true);
  });

  it("deletes the sidecar alongside the media object", async () => {
    const { spy } = await run(
      [row("m1", "cas/t/a", null, null, "cas/t/a.c2pa")],
      async () => {},
    );
    const keys = spy.mock.calls.flatMap((c: any[]) => [...c[0]]);
    expect(keys).toContain("cas/t/a.c2pa");
    expect(keys).toContain("cas/t/a");
  });

  it("does NOT hard-delete the row when only the sidecar delete failed", async () => {
    // The row is the only record of the sidecar's key. Dropping it here would
    // strand the manifest permanently, with nothing left to derive the key
    // from — the exact failure this suite exists to prevent, applied to the
    // most sensitive object of the set.
    const { db } = await run(
      [row("m1", "cas/t/a", null, null, "cas/t/a.c2pa")],
      async (keys) => {
        if (keys.includes("cas/t/a.c2pa")) throw new Error("boom");
      },
    );
    expect(hardDeleted(db)).toEqual([]);
  });

  it("purges normally for a row that never carried a manifest", async () => {
    const { db, spy } = await run([row("m1", "cas/t/a")], async () => {});
    const keys = spy.mock.calls.flatMap((c: any[]) => [...c[0]]);
    expect(keys).toEqual(["cas/t/a"]);
    expect(hardDeleted(db)).toEqual(["m1"]);
  });
});
