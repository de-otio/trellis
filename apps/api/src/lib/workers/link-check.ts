/**
 * Link-check (link threat-intel) worker core — NOT YET IMPLEMENTED
 * (WS-2 T5, extracted from `lambda/link-check-worker.ts`).
 *
 * This queue is a LIVE SECURITY CONTROL: post/comment creation enqueues
 * async link checks here, and the deployment wires the threat-intel API key
 * for this worker. Until the actual check is implemented, this core FAILS
 * CLOSED: it throws, so nothing is acked — on AWS the batch returns to the
 * queue, is retried, and dead-letters onto the DLQ where the DLQ alarm
 * pages; in the container the dispatcher's throw-is-always-fail rule
 * (finding 3) leaves the message in flight.
 *
 * Do NOT replace the throw with a silent return (and NEVER convert it into
 * a returned ack-drop); implementing the real link check is the only valid
 * way to make this worker succeed.
 */

import type { WorkerContext } from "./context.js";

export type LinkCheckContext = Pick<WorkerContext, "logger">;

export async function runLinkCheck(
  _payload: unknown,
  ctx: LinkCheckContext,
): Promise<never> {
  ctx.logger.error(
    "link-check-worker is not implemented — failing closed; batch will retry and dead-letter",
  );
  throw new Error(
    "link-check-worker: not implemented — failing closed so link-security checks are not silently dropped",
  );
}
