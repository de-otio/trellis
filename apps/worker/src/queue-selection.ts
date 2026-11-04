/**
 * queue-selection.ts — which queues this worker process consumes.
 *
 * `WORKER_ENABLED_QUEUES` is a comma-separated list of queue names.
 *
 *  - UNSET (or blank): every queue is enabled, except a queue whose
 *    dependencies are not wired in this process, which is skipped. Today that
 *    is the two media queues; the stock worker does not wire them, so an
 *    existing deployment does not poll them.
 *  - SET: exactly the listed queues. A listed queue whose dependencies are
 *    missing, or a name that is not a queue, is a configuration error and the
 *    process must not start.
 *
 * Pure: reads nothing from the environment itself, so it is unit-testable and
 * main.ts stays the one place in apps/worker that touches process.env.
 */

import type { WorkerQueueName } from "./workers.js";

/** Every queue this runtime knows how to consume. */
export const ALL_QUEUES: readonly WorkerQueueName[] = [
  "delete-account",
  "media-processing",
  "media-completion",
  "link-check",
  "followers-events",
  "federation-outbox",
  "user-export",
];

/**
 * Queues that are consumed only when their dependencies are wired. The other
 * queues keep their existing behaviour (including the deliberate fail-closed
 * stance of an un-wired `user-export`: a data-subject request must dead-letter,
 * never be dropped).
 */
export const DEPENDENCY_GATED_QUEUES: readonly WorkerQueueName[] = [
  "media-processing",
  "media-completion",
];

export class QueueSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueSelectionError";
  }
}

export interface QueueSelectionInput {
  /** Raw `WORKER_ENABLED_QUEUES` value. */
  readonly raw: string | undefined;
  /** Which dependency-gated queues have their dependencies wired. */
  readonly depsAvailable: Readonly<Partial<Record<WorkerQueueName, boolean>>>;
}

export interface QueueSelection {
  readonly queues: ReadonlySet<WorkerQueueName>;
  readonly explicit: boolean;
  /** Queues left out of an unset-default because their deps are not wired. */
  readonly skippedForMissingDeps: readonly WorkerQueueName[];
}

export function resolveEnabledQueues(input: QueueSelectionInput): QueueSelection {
  const names = (input.raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const wired = (q: WorkerQueueName): boolean =>
    !DEPENDENCY_GATED_QUEUES.includes(q) || input.depsAvailable[q] === true;

  if (names.length === 0) {
    const queues = ALL_QUEUES.filter(wired);
    return {
      queues: new Set(queues),
      explicit: false,
      skippedForMissingDeps: ALL_QUEUES.filter((q) => !wired(q)),
    };
  }

  const known = new Set<string>(ALL_QUEUES);
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    throw new QueueSelectionError(
      `WORKER_ENABLED_QUEUES lists unknown queue name(s): ${unknown.join(", ")}. ` +
        `Valid names: ${ALL_QUEUES.join(", ")}`,
    );
  }
  const requested = [...new Set(names)] as WorkerQueueName[];
  const unwired = requested.filter((q) => !wired(q));
  if (unwired.length > 0) {
    throw new QueueSelectionError(
      `WORKER_ENABLED_QUEUES enables queue(s) whose dependencies are not wired in this process: ` +
        `${unwired.join(", ")}. Wire the dependencies, or remove the queue from the list ` +
        `(the stock worker does not wire the media queues; host them in your own process).`,
    );
  }
  return { queues: new Set(requested), explicit: true, skippedForMissingDeps: [] };
}
