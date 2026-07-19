/**
 * Deterministic in-memory QueueClient fake with visibility semantics.
 * `redeliver()` simulates visibility-timeout expiry (in-flight → pending).
 */

import type { QueueClient, ReceivedMessage } from "../../../../worker/src/dispatch.js";

interface FakeMsg {
  readonly messageId: string;
  readonly body: string;
  receiptHandle: string;
  receiveCount: number;
}

export class FakeQueue implements QueueClient {
  readonly pending: FakeMsg[] = [];
  readonly inflight = new Map<string, FakeMsg>();
  readonly deleted: FakeMsg[] = [];
  /** When set, the next N deleteMessage calls throw (crash simulation). */
  failNextDeletes = 0;
  private seq = 0;

  enqueue(body: string, messageId?: string): void {
    this.pending.push({
      messageId: messageId ?? `m-${++this.seq}`,
      body,
      receiptHandle: "",
      receiveCount: 0,
    });
  }

  async receive(input: {
    maxMessages: number;
    waitTimeSeconds?: number;
    visibilityTimeoutSeconds?: number;
  }): Promise<ReceivedMessage[]> {
    if (this.pending.length === 0) {
      // Simulate long-poll: yield to the event loop so poller loops don't
      // starve timers in tests.
      await new Promise((r) => setTimeout(r, 1));
      return [];
    }
    const out: ReceivedMessage[] = [];
    while (out.length < input.maxMessages && this.pending.length > 0) {
      const msg = this.pending.shift()!;
      msg.receiveCount += 1;
      msg.receiptHandle = `${msg.messageId}#rc${msg.receiveCount}`;
      this.inflight.set(msg.receiptHandle, msg);
      out.push({
        messageId: msg.messageId,
        receiptHandle: msg.receiptHandle,
        body: msg.body,
        receiveCount: msg.receiveCount,
      });
    }
    return out;
  }

  async deleteMessage(receiptHandle: string): Promise<void> {
    if (this.failNextDeletes > 0) {
      this.failNextDeletes -= 1;
      throw new Error("simulated delete failure (crash before ack)");
    }
    const msg = this.inflight.get(receiptHandle);
    if (msg) {
      this.inflight.delete(receiptHandle);
      this.deleted.push(msg);
    }
  }

  /** Visibility-timeout expiry: everything in flight goes back to pending. */
  redeliver(): void {
    for (const [handle, msg] of this.inflight) {
      this.inflight.delete(handle);
      this.pending.push(msg);
    }
  }

  get remaining(): number {
    return this.pending.length + this.inflight.size;
  }
}
