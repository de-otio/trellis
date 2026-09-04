/**
 * Federation-outbox (ActivityPub outbound delivery) worker core — NOT YET
 * IMPLEMENTED, feature-gated (WS-2 T5, extracted from
 * `lambda/federation-outbox-worker.ts`).
 *
 * Two-mode disposition (must be preserved exactly):
 *
 * - Feature OFF (default): stay INERT — log-and-RETURN (ack). Nothing
 *   enqueues outbound deliveries while federation is disabled, so any
 *   message that arrives is spurious; dropping it loses nothing, and
 *   throwing would page for a feature that is off.
 * - Feature ON: FAIL CLOSED like the other unimplemented workers — throw,
 *   so nothing is acked (AWS: retry → DLQ → page; container:
 *   throw-is-always-fail, finding 3).
 *
 * The feature flag arrives on `ctx.federationEnabled` — the core never
 * reads `process.env` (the entrypoint resolves `ACTIVITYPUB_ENABLED`).
 */

import type { WorkerContext } from "./context.js";

export type FederationOutboxContext = Pick<WorkerContext, "logger"> & {
  readonly federationEnabled: boolean;
};

export async function runFederationOutbox(
  _payload: unknown,
  ctx: FederationOutboxContext,
): Promise<void> {
  if (!ctx.federationEnabled) {
    ctx.logger.warn(
      "federation-outbox-worker invoked while federation is disabled (ACTIVITYPUB_ENABLED != 'true') — dropping; nothing should be enqueueing to this queue",
    );
    return;
  }

  ctx.logger.error(
    "federation-outbox-worker is not implemented — failing closed; batch will retry and dead-letter",
  );
  throw new Error(
    "federation-outbox-worker: not implemented — failing closed so outbound federation deliveries are not silently dropped",
  );
}
