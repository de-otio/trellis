/**
 * Pure computation/batching logic for rebuild-collection-item-count.ts,
 * split out so it can be unit tested without a database (repo convention:
 * pure functions for business logic, I/O isolated at the edges).
 */

export interface CollectionRow {
  id: string;
  itemCount: number;
}

export interface CollectionCorrection {
  collectionId: string;
  storedItemCount: number;
  actualItemCount: number;
}

/**
 * Compares each collection's stored `itemCount` against the actual
 * `CollectionItem` row count (as a Map keyed by collectionId — collections
 * with zero items simply have no entry in the map) and returns only the
 * collections whose stored value is wrong.
 *
 * Pure function: no I/O, deterministic, safe to unit test directly.
 */
export function computeCorrections(
  collections: readonly CollectionRow[],
  actualCounts: ReadonlyMap<string, number>,
): CollectionCorrection[] {
  const corrections: CollectionCorrection[] = [];

  for (const collection of collections) {
    const actual = actualCounts.get(collection.id) ?? 0;
    if (actual !== collection.itemCount) {
      corrections.push({
        collectionId: collection.id,
        storedItemCount: collection.itemCount,
        actualItemCount: actual,
      });
    }
  }

  return corrections;
}

/**
 * Splits an array into fixed-size batches. Pure, so the batching boundary
 * itself is unit-testable independent of any DB pagination.
 */
export function toBatches<T>(items: readonly T[], batchSize: number): T[][] {
  if (batchSize <= 0) {
    throw new Error("batchSize must be > 0");
  }
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

export interface RebuildSummary {
  collectionsExamined: number;
  correctionsFound: number;
  correctionsApplied: number;
}

export function emptySummary(): RebuildSummary {
  return { collectionsExamined: 0, correctionsFound: 0, correctionsApplied: 0 };
}

export function mergeSummary(
  a: RebuildSummary,
  b: Partial<RebuildSummary>,
): RebuildSummary {
  return {
    collectionsExamined: a.collectionsExamined + (b.collectionsExamined ?? 0),
    correctionsFound: a.correctionsFound + (b.correctionsFound ?? 0),
    correctionsApplied: a.correctionsApplied + (b.correctionsApplied ?? 0),
  };
}
