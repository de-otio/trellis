// Adapts a completion-store fake written before the transactional seam existed
// to the current `CompletionStore` contract.
//
//  - `persistMediaStatus` gains the compare-and-set: it reads the row first and
//    reports `count: 0` when the lifecycle is not `expectedFrom`.
//  - `inTransaction` runs the callback against the store itself. There is no
//    isolation and no rollback — suites that need real transaction semantics
//    use the store in completion-ordering.test.ts instead.

import type { CompletionStore } from "../../../../src/lib/workers/media-completion.js";
import type { MediaLifecycle } from "../../../../src/lib/media/media-lifecycle.js";

export type LegacyCompletionStore = Omit<
  CompletionStore,
  "persistMediaStatus" | "inTransaction"
> & {
  persistMediaStatus(mediaId: string, status: MediaLifecycle): Promise<void>;
};

export function adaptLegacyStore(legacy: LegacyCompletionStore): CompletionStore {
  const store: CompletionStore = {
    ...legacy,
    async persistMediaStatus(mediaId, status, options) {
      const media = await legacy.findMedia(mediaId);
      if (media !== null && media.lifecycle !== options.expectedFrom) {
        return { count: 0 };
      }
      await legacy.persistMediaStatus(mediaId, status);
      return { count: 1 };
    },
    inTransaction: (_mediaId, fn) => fn(store),
  };
  return store;
}
