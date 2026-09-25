/**
 * W7 — receive-failure backoff. A persistent receive failure (expired MNQ key,
 * revoked policy, a queue that was never provisioned) must settle into a
 * capped, jittered retry — not the old fixed 1 s loop — and must surface as
 * `receiveHealthy === false`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { QueuePoller, receiveBackoffMs } from "../../../../worker/src/consumer.js";
import type { QueueClient, ReceivedMessage } from "../../../../worker/src/dispatch.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

/** Throws on the first `failures` receives, then returns empty long-polls. */
class FlakyQueue implements QueueClient {
  receives = 0;
  constructor(private failures: number) {}
  async receive(): Promise<ReceivedMessage[]> {
    this.receives += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("AWS.SimpleQueueService.NonExistentQueue");
    }
    // A real long-poll returns after waitTimeSeconds; one timer tick is enough
    // to keep the loop off the microtask queue.
    await new Promise((r) => setTimeout(r, 1));
    return [];
  }
  async deleteMessage(): Promise<void> {}
}

const noWork = async (): Promise<"ack"> => "ack";

describe("receiveBackoffMs", () => {
  it("stays within [ceiling/2, ceiling] of the capped exponential, never above maxMs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 600_000 }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        (attempt, baseMs, extra, r) => {
          const maxMs = baseMs + extra;
          const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 30));
          const delay = receiveBackoffMs(attempt, baseMs, maxMs, () => r);
          expect(delay).toBeGreaterThanOrEqual(Math.round(ceiling / 2));
          expect(delay).toBeLessThanOrEqual(ceiling);
          expect(delay).toBeLessThanOrEqual(maxMs);
        },
      ),
    );
  });

  it("never shrinks as attempts grow (same jitter draw)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 600_000 }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        (attempt, baseMs, extra, r) => {
          const maxMs = baseMs + extra;
          expect(receiveBackoffMs(attempt + 1, baseMs, maxMs, () => r)).toBeGreaterThanOrEqual(
            receiveBackoffMs(attempt, baseMs, maxMs, () => r),
          );
        },
      ),
    );
  });

  it("treats a non-positive attempt as the first", () => {
    expect(receiveBackoffMs(0, 1000, 60_000, () => 0)).toBe(500);
    expect(receiveBackoffMs(-3, 1000, 60_000, () => 0)).toBe(500);
  });
});

describe("QueuePoller receive backoff (W7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an always-failing receive backs off 1 s → 60 s by the defaults, and never retries early", async () => {
    const q = new FlakyQueue(Number.POSITIVE_INFINITY);
    const logger = makeLogger();
    // random = 0 pins the jitter to the fixed half: delay = ceiling / 2.
    const poller = new QueuePoller(q, noWork, {
      queueName: "federation-outbox",
      concurrency: 1,
      backoff: { random: () => 0 },
      logger,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(q.receives).toBe(1);

    const expected = [500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000];
    for (const [i, delay] of expected.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(q.receives, `retry ${i + 1} fired before its ${delay} ms delay`).toBe(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(q.receives).toBe(i + 2);
    }

    const logged = vi
      .mocked(logger.error)
      .mock.calls.filter(([msg]) => msg === "receive failed — backing off")
      .map(([, meta]) => (meta as { delayMs: number }).delayMs);
    expect(logged.slice(0, expected.length)).toEqual(expected);

    await poller.stop();
  });

  it("the jitter spreads the delay across the upper half of the ceiling", async () => {
    const q = new FlakyQueue(Number.POSITIVE_INFINITY);
    const logger = makeLogger();
    const poller = new QueuePoller(q, noWork, {
      queueName: "q",
      concurrency: 1,
      backoff: { baseMs: 1000, maxMs: 8000, random: () => 0.5 },
      logger,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [750, 1500, 3000, 6000, 6000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    const logged = vi
      .mocked(logger.error)
      .mock.calls.filter(([msg]) => msg === "receive failed — backing off")
      .map(([, meta]) => (meta as { delayMs: number }).delayMs);
    expect(logged.slice(0, 5)).toEqual([750, 1500, 3000, 6000, 6000]);
    await poller.stop();
  });

  it("reports unhealthy after unhealthyAfter consecutive failures, and healthy again on the next good receive", async () => {
    const q = new FlakyQueue(3);
    const logger = makeLogger();
    const poller = new QueuePoller(q, noWork, {
      queueName: "delete-account",
      concurrency: 1,
      backoff: { baseMs: 100, maxMs: 100, unhealthyAfter: 3, random: () => 0 },
      logger,
    });
    expect(poller.receiveHealthy).toBe(true);
    poller.start();

    await vi.advanceTimersByTimeAsync(0); // failure 1
    expect(poller.receiveHealthy).toBe(true);
    await vi.advanceTimersByTimeAsync(50); // failure 2
    expect(poller.receiveHealthy).toBe(true);
    await vi.advanceTimersByTimeAsync(50); // failure 3
    expect(poller.receiveHealthy).toBe(false);

    const unhealthyLogs = () =>
      vi
        .mocked(logger.error)
        .mock.calls.filter(([msg]) => msg === "queue poller unhealthy — receives keep failing");
    expect(unhealthyLogs()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50); // receive 4 issued, long-poll pending
    expect(poller.receiveHealthy).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // … and returns empty: a good receive
    expect(poller.receiveHealthy).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      "receive recovered",
      expect.objectContaining({ queue: "delete-account", afterFailures: 3 }),
    );

    // Keeps polling normally afterwards, and the unhealthy log fired once.
    const before = q.receives;
    await vi.advanceTimersByTimeAsync(10);
    expect(q.receives).toBeGreaterThan(before);
    expect(unhealthyLogs()).toHaveLength(1);

    await poller.stop();
  });

  it("a successful receive resets the delay back to the base", async () => {
    // Fail 3, succeed once, then fail forever: the fourth failure's delay is
    // the first-attempt delay again, not the fourth-attempt one.
    let calls = 0;
    const q: QueueClient = {
      async receive() {
        calls += 1;
        if (calls === 4) return [];
        throw new Error("receive failed");
      },
      async deleteMessage() {},
    };
    const logger = makeLogger();
    const poller = new QueuePoller(q, noWork, {
      queueName: "q",
      concurrency: 1,
      backoff: { random: () => 0 },
      logger,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000); // failures 1–3, success, failure 4
    const logged = vi
      .mocked(logger.error)
      .mock.calls.filter(([msg]) => msg === "receive failed — backing off")
      .map(([, meta]) => (meta as { delayMs: number }).delayMs);
    expect(logged).toEqual([500, 1000, 2000, 500]);
    await poller.stop();
  });

  it("stop() cuts a backoff sleep short and leaves no timer or further receive behind", async () => {
    const q = new FlakyQueue(Number.POSITIVE_INFINITY);
    const poller = new QueuePoller(q, noWork, {
      queueName: "q",
      concurrency: 2,
      backoff: { baseMs: 60_000, maxMs: 60_000, random: () => 0 },
      logger: makeLogger(),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(q.receives).toBe(2); // one per slot, both now sleeping 30 s
    expect(vi.getTimerCount()).toBe(2);

    await poller.stop(); // resolves without any timer advancing
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(q.receives).toBe(2);
  });

  it("a receive that fails after stop() does not back off or count as a failure", async () => {
    let reject!: (err: Error) => void;
    const q: QueueClient = {
      receive: () => new Promise<ReceivedMessage[]>((_, rej) => (reject = rej)),
      async deleteMessage() {},
    };
    const logger = makeLogger();
    const poller = new QueuePoller(q, noWork, { queueName: "q", concurrency: 1, logger });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = poller.stop();
    reject(new Error("connection reset during shutdown"));
    await stopping;
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.error).not.toHaveBeenCalled();
    expect(poller.receiveHealthy).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
