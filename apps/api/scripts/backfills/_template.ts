/**
 * Backfill template — copy to `YYYYMMDD-<what-it-does>.ts` and fill in the
 * marked sections. See ./README.md for the rules this template enforces:
 * script-in-repo, idempotent, batched (~10k), throttled, resumable,
 * observable, run via the one-off task mechanism, dual-write toggle ON
 * before running.
 *
 * Run with: npx tsx apps/api/scripts/backfills/<your-file>.ts
 *
 * Environment variables:
 *   DATABASE_URL       - required, the direct (non-pooler) connection string
 *   BACKFILL_BATCH_SIZE  - optional, default 10000 (rule: batched ~10k)
 *   BACKFILL_THROTTLE_MS - optional, default 200 (rule: throttled; runtime
 *                          config, not a compiled constant)
 *   BACKFILL_MAX_BATCHES - optional, default unlimited; set for a bounded
 *                          dry run or a resumed partial pass
 */

import { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// Runtime config (threshold-secrecy: these are env vars with defaults, never
// compiled-in constants sprinkled at call sites).
// ---------------------------------------------------------------------------

const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE ?? 10_000);
const THROTTLE_MS = Number(process.env.BACKFILL_THROTTLE_MS ?? 200);
const MAX_BATCHES = process.env.BACKFILL_MAX_BATCHES
  ? Number(process.env.BACKFILL_MAX_BATCHES)
  : Number.POSITIVE_INFINITY;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logProgress(event: Record<string, unknown>): void {
  // Structured, one JSON line per event (rule: observable). Never log raw
  // client metadata (IP/UA/device ids) — this script touches domain rows
  // only.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

// ---------------------------------------------------------------------------
// FILL IN: replace `ExampleModel` and the where/update shape with the real
// backfill target. The "already done" predicate in `where` is what makes
// batch selection idempotent AND resumable — the same query that selects
// unfinished rows also naturally skips rows already backfilled.
// ---------------------------------------------------------------------------

async function runBackfill(prisma: PrismaClient): Promise<void> {
  let batchNumber = 0;
  let totalExamined = 0;
  let totalChanged = 0;

  for (;;) {
    if (batchNumber >= MAX_BATCHES) {
      logProgress({
        event: "backfill_max_batches_reached",
        batchNumber,
        totalExamined,
        totalChanged,
      });
      break;
    }

    // FILL IN: select the next batch of not-yet-backfilled rows. Ordering by
    // id keeps the cursor stable across restarts.
    const rows = await (prisma as any).exampleModel.findMany({
      where: { backfilledField: null }, // FILL IN: "already done" predicate
      select: { id: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });

    if (rows.length === 0) {
      logProgress({
        event: "backfill_complete",
        batchNumber,
        totalExamined,
        totalChanged,
      });
      break;
    }

    let changedInBatch = 0;
    for (const row of rows) {
      // FILL IN: compute the new value and write it. Prefer a conditional
      // updateMany (guard predicate repeated in `where`) over a bare
      // `update` so a concurrent writer can't be raced/overwritten.
      const result = await (prisma as any).exampleModel.updateMany({
        where: { id: row.id, backfilledField: null },
        data: { backfilledField: "computed-value" }, // FILL IN
      });
      changedInBatch += result.count;
    }

    totalExamined += rows.length;
    totalChanged += changedInBatch;
    batchNumber += 1;

    logProgress({
      event: "backfill_batch",
      batchNumber,
      batchSize: rows.length,
      changedInBatch,
      totalExamined,
      totalChanged,
    });

    // Throttle: give the primary room to breathe between batches.
    await sleep(THROTTLE_MS);
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set (see this file's header doc)");
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

  try {
    logProgress({
      event: "backfill_start",
      batchSize: BATCH_SIZE,
      throttleMs: THROTTLE_MS,
    });
    await runBackfill(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly (not when imported, e.g. by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logProgress({
      event: "backfill_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
