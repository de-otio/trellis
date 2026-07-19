/**
 * T7a PRE-MERGE GATES — poller semantics over the 1-msg-per-slot model:
 * partial-batch parity, whole-batch-throw parity, at-least-once under crash,
 * drain-without-loss.
 */

import { describe, expect, it, vi } from "vitest";
import { QueuePoller } from "../../../../worker/src/consumer.js";
import { FakeQueue } from "./fake-queue.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(5);
  }
}

describe("QueuePoller", () => {
  it("GATE: partial-batch parity — exactly the k failed messages remain, N−k deleted", async () => {
    const q = new FakeQueue();
    const N = 8;
    for (let i = 0; i < N; i++) {
      q.enqueue(JSON.stringify({ n: i, fail: i % 3 === 0 })); // 0,3,6 fail → k=3
    }
    const poller = new QueuePoller(
      q,
      async (payload) => ((payload as { fail: boolean }).fail ? "fail" : "ack"),
      { queueName: "q", concurrency: 3, logger: makeLogger() },
    );
    poller.start();
    await waitFor(() => q.pending.length === 0 && poller.inFlightCount === 0);
    await poller.stop();

    expect(q.deleted).toHaveLength(N - 3);
    expect(q.inflight.size).toBe(3); // exactly the failed ones, still in flight
    const failedBodies = [...q.inflight.values()].map((m) => JSON.parse(m.body).n).sort();
    expect(failedBodies).toEqual([0, 3, 6]);
  });

  it("GATE: whole-batch-throw parity — a throwing (stub) worker acks NOTHING; receive count advances", async () => {
    const q = new FakeQueue();
    q.enqueue(JSON.stringify({ a: 1 }));
    q.enqueue(JSON.stringify({ a: 2 }));
    const poller = new QueuePoller(
      q,
      async () => {
        throw new Error("link-check: not implemented — failing closed");
      },
      { queueName: "link-check", concurrency: 2, logger: makeLogger() },
    );
    poller.start();
    await waitFor(() => q.pending.length === 0 && poller.inFlightCount === 0);
    await poller.stop();

    expect(q.deleted).toHaveLength(0);
    expect(q.inflight.size).toBe(2);
    for (const m of q.inflight.values()) expect(m.receiveCount).toBe(1);

    // Visibility expiry → redelivery advances the receive count (the queue's
    // maxReceiveCount redrive → DLQ is queue infra, driven by exactly this).
    q.redeliver();
    const poller2 = new QueuePoller(
      q,
      async () => {
        throw new Error("still failing closed");
      },
      { queueName: "link-check", concurrency: 2, logger: makeLogger() },
    );
    poller2.start();
    await waitFor(() => q.pending.length === 0 && poller2.inFlightCount === 0);
    await poller2.stop();
    for (const m of q.inflight.values()) expect(m.receiveCount).toBe(2);
    expect(q.deleted).toHaveLength(0);
  });

  it("GATE: at-least-once under crash — work done but delete fails ⇒ redelivery ⇒ idempotent second run, then deleted", async () => {
    const q = new FakeQueue();
    q.enqueue(JSON.stringify({ userId: "u1" }));
    q.failNextDeletes = 1; // crash between "work done" and ack
    const workRuns = vi.fn(async () => "ack" as const);

    const poller = new QueuePoller(q, workRuns, {
      queueName: "delete-account",
      concurrency: 1,
      logger: makeLogger(),
    });
    poller.start();
    await waitFor(() => workRuns.mock.calls.length === 1 && poller.inFlightCount === 0);

    expect(q.deleted).toHaveLength(0); // ack failed — message survives
    q.redeliver();
    await waitFor(() => q.deleted.length === 1);
    await poller.stop();

    expect(workRuns).toHaveBeenCalledTimes(2); // idempotency absorbs the rerun
    expect(q.remaining).toBe(0);
  });

  it("drain: stop() waits for in-flight work; nothing is lost", async () => {
    const q = new FakeQueue();
    q.enqueue(JSON.stringify({ slow: true }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let finished = false;
    const poller = new QueuePoller(
      q,
      async () => {
        await gate;
        finished = true;
        return "ack";
      },
      { queueName: "q", concurrency: 1, logger: makeLogger() },
    );
    poller.start();
    await waitFor(() => poller.inFlightCount === 1);

    const stopping = poller.stop();
    let stopped = false;
    void stopping.then(() => (stopped = true));
    await sleep(20);
    expect(stopped).toBe(false); // still draining the in-flight message

    release();
    await stopping;
    expect(finished).toBe(true);
    expect(q.deleted).toHaveLength(1); // finished work was acked, not lost
  });

  it("backpressure is structural: with 1 slot, messages are processed strictly one at a time", async () => {
    const q = new FakeQueue();
    for (let i = 0; i < 5; i++) q.enqueue(JSON.stringify({ i }));
    let concurrent = 0;
    let maxConcurrent = 0;
    const poller = new QueuePoller(
      q,
      async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(5);
        concurrent--;
        return "ack";
      },
      { queueName: "q", concurrency: 1, logger: makeLogger() },
    );
    poller.start();
    await waitFor(() => q.deleted.length === 5);
    await poller.stop();
    expect(maxConcurrent).toBe(1);
  });
});
