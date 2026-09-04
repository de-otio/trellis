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

/**
 * Extract every `catch (...) { ... }` block with REAL brace matching (any
 * nesting depth), instead of a fixed-depth regex. Lexical only: a `}` inside
 * a string literal would end a block early — acceptable for this gate, which
 * exists to catch structural regressions, and dispatch.ts contains no braces
 * inside string literals within catch blocks.
 */
function extractCatchBlocks(src: string): string[] {
  const blocks: string[] = [];
  const re = /\bcatch\b\s*(\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1; // index of the opening brace
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          blocks.push(src.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return blocks;
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

  it("GATE (code shape): no delete/ack primitive is lexically reachable from ANY catch block (full nesting)", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../../worker/src/dispatch.ts"),
      "utf-8",
    );
    // Every catch block via real brace matching (critic F4: the old regex
    // tolerated only ONE nesting level and only the literal
    // `queue.deleteMessage(` — a helper alias, a `.delete(` call, or a
    // receipt-handle handed to any function inside a deeply nested catch
    // would have slipped through).
    const catchBlocks = extractCatchBlocks(src);
    expect(catchBlocks.length).toBeGreaterThan(0);
    for (const block of catchBlocks) {
      // Any spelling of the ack/delete primitive:
      expect(block).not.toMatch(/deleteMessage/);
      expect(block).not.toMatch(/\.delete\s*\(/);
      // And no receipt handle may even be PASSED anywhere inside a catch —
      // that is the raw material for an out-of-band ack.
      expect(block).not.toMatch(/receiptHandle/i);
    }
    // And there is exactly one transport delete call site: safeDelete's try
    // (the switch's ack/ack-drop paths share it).
    const calls = src.match(/queue\.deleteMessage\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});
