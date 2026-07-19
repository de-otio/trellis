/**
 * consumer.ts — long-poll queue consumer (WS-2 T7a, §3.2/§3.3).
 *
 * Model: **1 message per slot, N concurrent slots** (the §3.3
 * recommendation). Each slot long-polls for a single message and runs it
 * through `dispatchMessage`, so "partial-batch failure" collapses to "this
 * one message failed → don't delete it" — behavior-equivalent to Lambda's
 * `batchItemFailures`, and whole-batch-throw parity falls out naturally (a
 * throw leaves that slot's message in flight).
 *
 * Backpressure is structural: a slot only calls `receive` when it is free
 * (§3.6) — there is no prefetch buffer to overflow.
 *
 * Draining (`stop()`): stop issuing new receives, wait for in-flight
 * dispatches to settle (bounded by the caller's grace period). In-flight
 * messages that do not finish are simply not acked → they redeliver
 * (at-least-once holds).
 */

import type { Logger } from "../../api/src/lib/logger.js";
import {
  dispatchMessage,
  type MessageWorker,
  type QueueClient,
} from "./dispatch.js";

export interface QueuePollerOptions {
  readonly queueName: string;
  /** Concurrent 1-message slots (media: keep low, e.g. 2–4). */
  readonly concurrency: number;
  /** SQS long-poll wait (seconds). Default 20. */
  readonly waitTimeSeconds?: number;
  /** Per-receive visibility override, when the queue default is too short. */
  readonly visibilityTimeoutSeconds?: number;
  readonly logger: Logger;
}

export class QueuePoller {
  private running = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly queue: QueueClient,
    private readonly worker: MessageWorker,
    private readonly options: QueuePollerOptions,
  ) {}

  /** Start N slot loops. Returns immediately. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (let slot = 0; slot < this.options.concurrency; slot++) {
      void this.slotLoop(slot);
    }
  }

  /** Stop receiving and drain in-flight work (unbounded; callers race it
   *  against their grace-period timer). */
  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled([...this.inFlight]);
  }

  /** True while at least one dispatch is in flight (readiness signal). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  private async slotLoop(slot: number): Promise<void> {
    const { queueName, logger } = this.options;
    while (this.running) {
      let messages;
      try {
        messages = await this.queue.receive({
          maxMessages: 1,
          waitTimeSeconds: this.options.waitTimeSeconds ?? 20,
          visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds,
        });
      } catch (err) {
        logger.error("receive failed — backing off", { queue: queueName, slot, error: err });
        await sleep(this.running ? 1000 : 0);
        continue;
      }
      if (!this.running) {
        // Stopped between receive and dispatch: do NOT ack — the received
        // message redelivers after its visibility timeout (at-least-once).
        return;
      }
      for (const message of messages) {
        // One message per slot: dispatch inline (per-message try/catch lives
        // inside dispatchMessage — a poison message never kills the slot).
        const work = dispatchMessage(
          this.queue,
          queueName,
          this.worker,
          message,
          logger,
        ).then(() => undefined);
        this.inFlight.add(work);
        try {
          await work;
        } finally {
          this.inFlight.delete(work);
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
