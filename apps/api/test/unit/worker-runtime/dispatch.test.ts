/**
 * T7a PRE-MERGE GATE — dispatch/ack semantics (finding 3).
 *
 * The single worst regression to miss is a silent drop of security work:
 * an unrecognized/untyped throw MUST leave the message in flight, and
 * ack-drop MUST be reachable only via an explicit returned disposition.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatchMessage, type ReceivedMessage } from "../../../../worker/src/dispatch.js";
import { FakeQueue } from "./fake-queue.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

function received(queue: FakeQueue): Promise<ReceivedMessage> {
  return queue.receive({ maxMessages: 1, waitTimeSeconds: 0 }).then((m) => m[0]);
}

describe("dispatchMessage (finding 3)", () => {
  it("returned 'ack' (or void) deletes the message", async () => {
    for (const ret of ["ack" as const, undefined]) {
      const q = new FakeQueue();
      q.enqueue(JSON.stringify({ userId: "u1" }));
      const m = await received(q);
      const out = await dispatchMessage(q, "q", async () => ret, m, makeLogger());
      expect(out.disposition).toBe("ack");
      expect(q.deleted).toHaveLength(1);
      expect(q.remaining).toBe(0);
    }
  });

  it("returned 'ack-drop' deletes the message (EXPLICIT drop only)", async () => {
    const q = new FakeQueue();
    q.enqueue(JSON.stringify({ poison: true }));
    const m = await received(q);
    const out = await dispatchMessage(q, "q", async () => "ack-drop", m, makeLogger());
    expect(out.disposition).toBe("ack-drop");
    expect(q.deleted).toHaveLength(1);
  });

  it("returned 'fail' leaves the message in flight (no delete)", async () => {
    const q = new FakeQueue();
    q.enqueue(JSON.stringify({}));
    const m = await received(q);
    const out = await dispatchMessage(q, "q", async () => "fail", m, makeLogger());
    expect(out.disposition).toBe("fail");
    expect(q.deleted).toHaveLength(0);
    expect(q.inflight.size).toBe(1);
  });

  it("GATE: an UNRECOGNIZED/untyped throw is fail — message survives", async () => {
    class NovelError extends Error {
      constructor() {
        super("never seen before");
        this.name = "NovelWorkerError";
      }
    }
    const q = new FakeQueue();
    q.enqueue(JSON.stringify({ security: "work" }));
    const m = await received(q);
    const out = await dispatchMessage(
      q,
      "link-check",
      async () => {
        throw new NovelError();
      },
      m,
      makeLogger(),
    );
    expect(out.disposition).toBe("fail");
    expect(q.deleted).toHaveLength(0);
    expect(q.inflight.size).toBe(1); // survives → redelivery → DLQ
  });

  it("GATE: an unrecognized RETURNED value defaults to NO-ACK", async () => {
    const q = new FakeQueue();
    q.enqueue(JSON.stringify({}));
    const m = await received(q);
    const out = await dispatchMessage(
      q,
      "q",
      async () => "drop" as never, // not a valid disposition
      m,
      makeLogger(),
    );
    expect(out.disposition).toBe("fail");
    expect(out.reason).toBe("unrecognized-disposition");
    expect(q.deleted).toHaveLength(0);
  });

  it("an unparseable body is fail (in flight for the DLQ), never an inferred drop", async () => {
    const q = new FakeQueue();
    q.enqueue("not json at all");
    const m = await received(q);
    const worker = vi.fn();
    const out = await dispatchMessage(q, "q", worker, m, makeLogger());
    expect(out).toEqual({ disposition: "fail", reason: "unparseable-body" });
    expect(worker).not.toHaveBeenCalled();
    expect(q.deleted).toHaveLength(0);
  });

  it("a failed delete is contained: message redelivers (at-least-once), no throw", async () => {
    const q = new FakeQueue();
    q.enqueue(JSON.stringify({}));
    const m = await received(q);
    q.failNextDeletes = 1;
    const out = await dispatchMessage(q, "q", async () => "ack", m, makeLogger());
    expect(out.disposition).toBe("ack");
    expect(q.deleted).toHaveLength(0);
    q.redeliver();
    expect(q.pending).toHaveLength(1); // will be processed again (idempotency)
  });

  it("GATE (code shape): no deleteMessage call is lexically reachable from a catch block", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../../worker/src/dispatch.ts"),
      "utf-8",
    );
    // Every catch block, with nested-brace tolerance one level deep.
    const catchBlocks = src.match(/catch[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
    expect(catchBlocks.length).toBeGreaterThan(0);
    for (const block of catchBlocks) {
      expect(block).not.toContain("deleteMessage");
    }
    // And there are exactly two delete call sites: the switch's ack/ack-drop
    // paths share safeDelete; safeDelete's try calls the transport once.
    const calls = src.match(/queue\.deleteMessage\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});
