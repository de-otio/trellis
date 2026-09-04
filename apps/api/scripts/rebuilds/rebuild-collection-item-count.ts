/**
 * Rebuild `Collection.itemCount` from the actual `CollectionItem` row count.
 * Worked example for the rebuild convention — see ./README.md.
 *
 * Batched, idempotent (a correct collection is left untouched), and
 * `--dry-run` by DEFAULT: pass `--apply` to actually write corrections.
 *
 * Run with:
 *   npx tsx apps/api/scripts/rebuilds/rebuild-collection-item-count.ts            # dry run (default)
 *   npx tsx apps/api/scripts/rebuilds/rebuild-collection-item-count.ts --apply    # writes corrections
 *
 * Environment variables:
 *   DATABASE_URL          - required, direct (non-pooler) connection string
 *   REBUILD_BATCH_SIZE    - optional, default 10000 (rule: batched ~10k)
 *   REBUILD_THROTTLE_MS   - optional, default 200
 */

import { PrismaClient } from "@prisma/client";
import {
  computeCorrections,
  emptySummary,
  mergeSummary,
  toBatches,
  type CollectionRow,
  type RebuildSummary,
} from "./rebuild-collection-item-count.logic.js";

const BATCH_SIZE = Number(process.env.REBUILD_BATCH_SIZE ?? 10_000);
const THROTTLE_MS = Number(process.env.REBUILD_THROTTLE_MS ?? 200);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logProgress(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function parseApplyFlag(argv: readonly string[]): boolean {
  return argv.includes("--apply");
}

/**
 * Fetches all collection ids in stable cursor order, batched.
 */
async function* iterateCollectionBatches(
  prisma: PrismaClient,
  batchSize: number,
): AsyncGenerator<CollectionRow[]> {
  let cursor: string | undefined;

  for (;;) {
    const rows: CollectionRow[] = await (prisma as any).collection.findMany({
      select: { id: true, itemCount: true },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (rows.length === 0) {
      return;
    }

    yield rows;
    cursor = rows[rows.length - 1]!.id;

    if (rows.length < batchSize) {
      return;
    }
  }
}

/**
 * Given a batch of collection ids, groups `CollectionItem` rows by
 * collectionId and returns actual counts as a Map.
 */
async function actualItemCounts(
  prisma: PrismaClient,
  collectionIds: readonly string[],
): Promise<Map<string, number>> {
  const grouped = await (prisma as any).collectionItem.groupBy({
    by: ["collectionId"],
    where: { collectionId: { in: [...collectionIds] } },
    _count: { _all: true },
  });

  const counts = new Map<string, number>();
  for (const row of grouped as Array<{
    collectionId: string;
    _count: { _all: number };
  }>) {
    counts.set(row.collectionId, row._count._all);
  }
  return counts;
}

async function runRebuild(
  prisma: PrismaClient,
  apply: boolean,
): Promise<RebuildSummary> {
  let summary = emptySummary();
  let batchNumber = 0;

  for await (const batch of iterateCollectionBatches(prisma, BATCH_SIZE)) {
    batchNumber += 1;
    const actual = await actualItemCounts(
      prisma,
      batch.map((c) => c.id),
    );
    const corrections = computeCorrections(batch, actual);

    let applied = 0;
    if (apply) {
      for (const correction of corrections) {
        // Conditional write: only overwrite if the stored value still
        // matches what we read (guards against a concurrent writer racing
        // this rebuild) — idempotent, so a no-op re-run is safe.
        const result = await (prisma as any).collection.updateMany({
          where: {
            id: correction.collectionId,
            itemCount: correction.storedItemCount,
          },
          data: { itemCount: correction.actualItemCount },
        });
        applied += result.count;
      }
    }

    summary = mergeSummary(summary, {
      collectionsExamined: batch.length,
      correctionsFound: corrections.length,
      correctionsApplied: applied,
    });

    logProgress({
      event: "rebuild_batch",
      batchNumber,
      mode: apply ? "apply" : "dry-run",
      batchSize: batch.length,
      correctionsFound: corrections.length,
      correctionsApplied: applied,
      corrections: corrections.slice(0, 20), // cap logged detail per batch
    });

    await sleep(THROTTLE_MS);
  }

  return summary;
}

async function main(): Promise<void> {
  const apply = parseApplyFlag(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set (see this file's header doc)");
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

  try {
    logProgress({
      event: "rebuild_start",
      mode: apply ? "apply" : "dry-run",
      batchSize: BATCH_SIZE,
      throttleMs: THROTTLE_MS,
    });

    const summary = await runRebuild(prisma, apply);

    logProgress({ event: "rebuild_complete", mode: apply ? "apply" : "dry-run", ...summary });

    if (!apply && summary.correctionsFound > 0) {
      logProgress({
        event: "rebuild_dry_run_hint",
        message: "Re-run with --apply to write these corrections.",
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logProgress({
      event: "rebuild_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
