// media-completion-worker.ts — thin AWS entrypoint (WS-2 T6).
//
// The completion shell (`processCompletion` + the untrusted-pointer parsers +
// the seam types) moved to `lib/workers/media-completion.ts`; this file
// re-exports that public surface (existing deep imports keep resolving) and
// keeps only `makeHandler` — the SQS adapter factory the consuming app calls
// with its concrete deps at cold start.

import type { SQSHandler, SQSRecord } from "aws-lambda";
import {
  processCompletion,
  type CompletionDeps,
} from "../lib/workers/media-completion.js";

export {
  extractJobPointer,
  refetchTrackDecision,
  processCompletion,
} from "../lib/workers/media-completion.js";
export type {
  ModerationJobRow,
  CompletionStore,
  OtherTrackState,
  MediaCoords,
  VisualVerdictReinterpreter,
  CompletionDeps,
  RecordOutcome,
} from "../lib/workers/media-completion.js";

/**
 * Build the SQS handler from injected deps. The consuming app provides the
 * concrete adapters; tests provide mocks and call {@link processCompletion}
 * directly.
 *
 * A record that yields `kind: "retry"` (or throws) is reported as a batch-item
 * failure so SQS retries / DLQs it. Every other outcome is an ack (the message
 * is consumed): duplicates, unroutable pointers, and illegal transitions are all
 * fail-closed ack-drops — they must never DLQ-loop.
 */
export function makeHandler(deps: CompletionDeps): SQSHandler {
  return async (event) => {
    const failedIds: string[] = [];

    for (const record of event.Records as SQSRecord[]) {
      try {
        const outcome = await processCompletion(record.body, deps);
        if (outcome.kind === "retry") {
          deps.log?.error?.("completion: retry", {
            messageId: record.messageId,
            reason: outcome.reason,
          });
          failedIds.push(record.messageId);
        }
      } catch (err) {
        // Unexpected (transient I/O) failure — return to the queue for retry.
        deps.log?.error?.("completion: unexpected failure — retry", {
          messageId: record.messageId,
          error: String(err),
        });
        failedIds.push(record.messageId);
      }
    }

    if (failedIds.length > 0) {
      return { batchItemFailures: failedIds.map((id) => ({ itemIdentifier: id })) };
    }
  };
}
