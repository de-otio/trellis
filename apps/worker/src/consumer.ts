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
 *
 * Receive failures (W7): each slot backs off exponentially with equal jitter
 * up to a ceiling, so a persistent failure (expired key, revoked policy, a
 * queue that was never provisioned) settles at about one request per slot
 * per ceiling instead of a fixed 1 s hot loop. After `unhealthyAfter`
 * consecutive failed receives, `receiveHealthy` goes false; any successful
 * receive restores it. `stop()` wakes sleeping slots so the drain is not
 * held up by a backoff timer.
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
  /** Receive-failure backoff (W7). Defaults: 1 s base, 60 s ceiling. */
  readonly backoff?: ReceiveBackoffOptions;
  readonly logger: Logger;
}

export interface ReceiveBackoffOptions {
  /** Ceiling of the first retry delay (ms). Default 1000. */
  readonly baseMs?: number;
  /** Ceiling of any single retry delay (ms). Default 60000. */
  readonly maxMs?: number;
  /** Consecutive failed receives (across this poller's slots) after which
   *  `receiveHealthy` reports false. Default 5. */
  readonly unhealthyAfter?: number;
  /** Jitter source in [0, 1). Default `Math.random`; tests pin it. */
  readonly random?: () => number;
}

const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;
const DEFAULT_UNHEALTHY_AFTER = 5;

/**
 * Delay before retry number `attempt` (1-based) after a failed receive:
 * exponential ceiling `min(maxMs, baseMs · 2^(attempt−1))`, with equal jitter
 * — half the ceiling fixed, half random. The fixed half keeps the delay
 * growing (full jitter can draw ~0 and re-create the hot loop); the random
 * half de-synchronises the slots and the pods.
 */
export function receiveBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 30);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export class QueuePoller {
  private running = false;
  private readonly inFlight = new Set<Promise<void>>();
  /** Wake-ups for slots sleeping in a backoff; `stop()` fires them. */
  private readonly sleepers = new Set<() => void>();
  private consecutiveReceiveFailures = 0;

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
    for (const wake of [...this.sleepers]) wake();
    await Promise.allSettled([...this.inFlight]);
  }

  /** True while at least one dispatch is in flight (readiness signal). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** False once `unhealthyAfter` receives in a row have failed; true again
   *  after the next successful receive (W7 — the signal `/readyz` reads). */
  get receiveHealthy(): boolean {
    return this.consecutiveReceiveFailures < this.unhealthyAfter;
  }

  private get unhealthyAfter(): number {
    return this.options.backoff?.unhealthyAfter ?? DEFAULT_UNHEALTHY_AFTER;
  }

  private async slotLoop(slot: number): Promise<void> {
    const { queueName, logger } = this.options;
    const backoff = this.options.backoff;
    const baseMs = backoff?.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const maxMs = backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
    const random = backoff?.random ?? Math.random;
    // Per-slot attempt count: a slot's delay grows with its OWN failures, so
    // a second failing slot does not make the first back off faster.
    let slotFailures = 0;
    while (this.running) {
      let messages;
      try {
        messages = await this.queue.receive({
          maxMessages: 1,
          waitTimeSeconds: this.options.waitTimeSeconds ?? 20,
          visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds,
        });
      } catch (err) {
        if (!this.running) return;
        slotFailures += 1;
        this.consecutiveReceiveFailures += 1;
        const delayMs = receiveBackoffMs(slotFailures, baseMs, maxMs, random);
        logger.error("receive failed — backing off", {
          queue: queueName,
          slot,
          consecutiveFailures: this.consecutiveReceiveFailures,
          delayMs,
          error: err,
        });
        if (this.consecutiveReceiveFailures === this.unhealthyAfter) {
          logger.error("queue poller unhealthy — receives keep failing", {
            queue: queueName,
            consecutiveFailures: this.consecutiveReceiveFailures,
          });
        }
        await this.pause(delayMs);
        continue;
      }
      slotFailures = 0;
      if (this.consecutiveReceiveFailures > 0) {
        logger.info("receive recovered", {
          queue: queueName,
          slot,
          afterFailures: this.consecutiveReceiveFailures,
        });
        this.consecutiveReceiveFailures = 0;
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

  /** A backoff sleep that `stop()` can cut short. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }
}
