/**
 * Followers-events worker core — NOT YET IMPLEMENTED
 * (WS-2 T5, extracted from `lambda/followers-events-worker.ts`).
 *
 * Nothing currently enqueues to this queue (the FOLLOWERS_EVENTS_QUEUE env
 * binding exists but has no producer), so this core should never run. If a
 * producer is added before the worker is implemented, this core FAILS
 * CLOSED: it throws, so nothing is acked (AWS: retry → DLQ → page;
 * container: throw-is-always-fail, finding 3).
 *
 * Do NOT replace the throw with a silent return.
 */

import type { WorkerContext } from "./context.js";

export type FollowersEventsContext = Pick<WorkerContext, "logger">;

export async function runFollowersEvents(
  _payload: unknown,
  ctx: FollowersEventsContext,
): Promise<never> {
  ctx.logger.error(
    "followers-events-worker is not implemented — failing closed; batch will retry and dead-letter",
  );
  throw new Error(
    "followers-events-worker: not implemented — failing closed so follower events are not silently dropped",
  );
}
