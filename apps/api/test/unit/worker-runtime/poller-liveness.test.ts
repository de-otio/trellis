/** W6 — a wedged poller loop must make /readyz report unready. */
import { describe, expect, it, vi } from "vitest";
import { QueuePoller } from "../../../../worker/src/consumer.js";
import { pollerStaleMs, pollersLive } from "../../../../worker/src/health.js";
import type { QueueClient, ReceivedMessage } from "../../../../worker/src/dispatch.js";
import type { Logger } from "../../../src/lib/logger.js";

const logger = (): Logger => ({
  error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn(),
});
const noWork = async (): Promise<"ack"> => "ack";
const STALE = 1000;

function poller(queue: QueueClient, clock: { t: number }, backoffMs?: number): QueuePoller {
  return new QueuePoller(queue, noWork, {
    queueName: "q",
    concurrency: 1,
    logger: logger(),
    now: () => clock.t,
    backoff: backoffMs ? { baseMs: backoffMs, maxMs: backoffMs, random: () => 0 } : undefined,
  });
}

const idle = (): QueueClient => ({
  receive: async (): Promise<ReceivedMessage[]> => {
    await new Promise((r) => setTimeout(r, 1));
    return [];
  },
  deleteMessage: async () => {},
});

describe("poller liveness (W6)", () => {
  it("healthy, cycling poller -> ready", async () => {
    const clock = { t: 10_000 };
    const p = poller(idle(), clock);
    p.start();
    await new Promise((r) => setTimeout(r, 20));
    clock.t += 500;
    expect(pollersLive([p], clock.t, STALE)).toBe(true);
    await p.stop();
  });

  it("stalled poller past threshold -> unready", async () => {
    const clock = { t: 10_000 };
    // receive never resolves: the loop is wedged after start().
    const p = poller({ receive: () => new Promise(() => {}), deleteMessage: async () => {} }, clock);
    p.start();
    clock.t += STALE + 1;
    expect(pollersLive([p], clock.t, STALE)).toBe(false);
    void p.stop();
  });

  it("poller in a long backoff that keeps cycling -> ready", async () => {
    const clock = { t: 10_000 };
    const failing: QueueClient = {
      receive: async () => { throw new Error("down"); },
      deleteMessage: async () => {},
    };
    const p = poller(failing, clock, 5);
    p.start();
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 30));
      clock.t += 400; // total time far exceeds STALE, but every cycle re-stamps
      const before = p.lastAttemptAt!;
      await new Promise((r) => setTimeout(r, 30));
      expect(p.lastAttemptAt!).toBeGreaterThanOrEqual(before);
    }
    expect(p.receiveHealthy).toBe(false);
    expect(pollersLive([p], clock.t, STALE)).toBe(true);
    await p.stop();
  });

  it("a long-running job on every slot keeps the poller live, past the threshold", async () => {
    const clock = { t: 10_000 };
    let finish!: () => void;
    const jobDone = new Promise<void>((r) => (finish = r));
    let delivered = false;
    const oneMessage: QueueClient = {
      receive: async (): Promise<ReceivedMessage[]> => {
        if (delivered) return new Promise(() => {}); // after the job: wedge
        delivered = true;
        return [{ messageId: "m1", receiptHandle: "r1", body: "{}" }];
      },
      deleteMessage: async () => {},
    };
    const p = new QueuePoller(oneMessage, async () => { await jobDone; return "ack" as const; }, {
      queueName: "q", concurrency: 1, logger: logger(), now: () => clock.t,
    });
    p.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(p.inFlightCount).toBe(1);
    clock.t += STALE * 10; // the job runs far longer than the threshold
    expect(pollersLive([p], clock.t, STALE)).toBe(true);

    finish(); // job settles; the slot stamps, then wedges in receive
    await new Promise((r) => setTimeout(r, 10));
    expect(p.inFlightCount).toBe(0);
    expect(pollersLive([p], clock.t, STALE)).toBe(true); // fresh stamp
    clock.t += STALE + 1;
    expect(pollersLive([p], clock.t, STALE)).toBe(false); // now genuinely stuck
    void p.stop();
  });

  it("a poller never started (federation disabled) does not count", () => {
    const skipped = poller(idle(), { t: 0 }); // never start()ed, never pushed in prod
    expect(skipped.lastAttemptAt).toBeUndefined();
    expect(pollersLive([skipped], 1e9, STALE)).toBe(true);
  });

  it("stale threshold: env override, else derived default", () => {
    expect(pollerStaleMs({ WORKER_POLLER_STALE_MS: "5000" })).toBe(5000);
    expect(pollerStaleMs({})).toBeGreaterThan(80_000);
    expect(pollerStaleMs({ WORKER_POLLER_STALE_MS: "junk" })).toBe(pollerStaleMs({}));
  });
});
