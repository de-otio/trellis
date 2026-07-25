/**
 * dispatch.ts — the semantics core of the worker runtime (WS-2 T7a, §3.3).
 *
 * FINDING 3 — the non-negotiable ack rules:
 *
 *  - The ack-drop decision is made ONLY from an explicit typed RETURN value,
 *    NEVER inferred from a thrown error.
 *  - A `throw` from any worker — transient OR unrecognized — is ALWAYS
 *    treated as `fail` (no-ack → visibility-timeout redelivery → DLQ via the
 *    queue's redrive policy). There is no "unknown error → ack" branch and
 *    there must never be one.
 *  - A worker that wants a message dropped must RETURN `"ack-drop"`.
 *  - A `void` return means success (= `"ack"`): the extracted cores like
 *    `runDeleteAccount` signal success by returning.
 *  - Any OTHER returned value (an unrecognized disposition) is treated as
 *    `fail` — default NO-ACK on anything unrecognized.
 *
 * CODE-REVIEW INVARIANT (T7a gate): there is exactly ONE delete path per ack
 * branch and NO `deleteMessage` call reachable from any `catch` block. The
 * test suite scans this source for that property in addition to the
 * behavioral assertions.
 *
 * An unparseable body is left in flight (`fail`) so the DLQ can inspect it —
 * ack-drop is a DECISION a worker makes, not something the dispatcher infers
 * from a parse failure (§3.3).
 */

import type { WorkerDisposition } from "../../api/src/lib/workers/disposition.js";
import type { Logger } from "../../api/src/lib/logger.js";

/** One received queue message (provider-neutral slice of an SQS message). */
export interface ReceivedMessage {
  readonly messageId: string;
  readonly receiptHandle: string;
  readonly body: string;
  /** Approximate delivery count, when the transport provides it. */
  readonly receiveCount?: number;
}

/** Narrow queue transport seam (SQS-backed in production; fake in tests). */
export interface QueueClient {
  /** Long-poll receive. Returns up to `maxMessages` messages. */
  receive(input: {
    readonly maxMessages: number;
    readonly waitTimeSeconds: number;
    readonly visibilityTimeoutSeconds?: number;
  }): Promise<ReceivedMessage[]>;
  /** Delete (ack) one message. */
  deleteMessage(receiptHandle: string): Promise<void>;
  /** Extend a message's visibility (long-job heartbeat). Optional. */
  changeVisibility?(receiptHandle: string, timeoutSeconds: number): Promise<void>;
}

/**
 * A queue worker binding: receives the PARSED payload plus the raw message,
 * returns a disposition (or void = success/ack), or THROWS (always fail).
 */
export type MessageWorker = (
  payload: unknown,
  raw: ReceivedMessage,
) => Promise<WorkerDisposition | void>;

export interface DispatchOutcome {
  readonly disposition: WorkerDisposition;
  readonly reason: string;
}

const VALID_DISPOSITIONS: ReadonlySet<string> = new Set(["ack", "fail", "ack-drop"]);

/**
 * Process ONE message end-to-end: parse → worker → disposition → ack/no-ack.
 * Never throws; the poller loop treats the returned outcome as final.
 */
export async function dispatchMessage(
  queue: QueueClient,
  queueName: string,
  worker: MessageWorker,
  message: ReceivedMessage,
  logger: Logger,
): Promise<DispatchOutcome> {
  const started = Date.now();

  let payload: unknown;
  try {
    payload = JSON.parse(message.body);
  } catch {
    // A body we cannot even parse is left IN FLIGHT (fail): ack-drop is a
    // worker's decision, and the DLQ is where a permanently-malformed body
    // becomes inspectable. No delete on this path.
    const outcome: DispatchOutcome = { disposition: "fail", reason: "unparseable-body" };
    logOutcome(logger, queueName, message, outcome, started);
    return outcome;
  }

  let returned: WorkerDisposition | void;
  try {
    returned = await worker(payload, message);
  } catch (err) {
    // ANY throw — transient OR unrecognized — is fail. NEVER ack on a throw.
    logger.error("worker threw — leaving message in flight (no-ack)", {
      queue: queueName,
      messageId: message.messageId,
      error: err,
    });
    const outcome: DispatchOutcome = { disposition: "fail", reason: "worker-threw" };
    logOutcome(logger, queueName, message, outcome, started);
    return outcome;
  }

  // Normalize the returned disposition. `void` = success; anything not in
  // the typed set is UNRECOGNIZED and defaults to NO-ACK (finding 3).
  let disposition: WorkerDisposition;
  let reason: string;
  if (returned === undefined) {
    disposition = "ack";
    reason = "returned";
  } else if (VALID_DISPOSITIONS.has(returned)) {
    disposition = returned;
    reason = `returned-${returned}`;
  } else {
    disposition = "fail";
    reason = "unrecognized-disposition";
    logger.error("worker returned an unrecognized disposition — treating as fail (no-ack)", {
      queue: queueName,
      messageId: message.messageId,
      returned: String(returned),
    });
  }

  // The ONLY delete paths. Note: not reachable from any catch block.
  switch (disposition) {
    case "ack":
      await safeDelete(queue, queueName, message, logger);
      break;
    case "ack-drop":
      logger.warn("worker returned ack-drop — deleting message (explicit drop)", {
        queue: queueName,
        messageId: message.messageId,
      });
      await safeDelete(queue, queueName, message, logger);
      break;
    case "fail":
      // Leave in flight → visibility timeout → redelivery → DLQ.
      break;
  }

  const outcome: DispatchOutcome = { disposition, reason };
  logOutcome(logger, queueName, message, outcome, started);
  return outcome;
}

/**
 * Delete with failure containment: a failed delete leaves the message to
 * redeliver (at-least-once holds; idempotency absorbs it). The failure is
 * logged, never rethrown — and this helper NEVER converts into an ack of a
 * different message.
 */
async function safeDelete(
  queue: QueueClient,
  queueName: string,
  message: ReceivedMessage,
  logger: Logger,
): Promise<void> {
  try {
    await queue.deleteMessage(message.receiptHandle);
  } catch (err) {
    logger.warn("message delete (ack) failed — message will redeliver (at-least-once)", {
      queue: queueName,
      messageId: message.messageId,
      error: err,
    });
  }
}

function logOutcome(
  logger: Logger,
  queueName: string,
  message: ReceivedMessage,
  outcome: DispatchOutcome,
  startedMs: number,
): void {
  logger.info("message outcome", {
    queue: queueName,
    messageId: message.messageId,
    disposition: outcome.disposition,
    reason: outcome.reason,
    durationMs: Date.now() - startedMs,
  });
}
