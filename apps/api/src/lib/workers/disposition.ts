/**
 * Per-message worker disposition (WS-2 §3.3, security finding 3).
 *
 * The disposition is a RETURNED value, never a thrown one:
 *
 * - `"ack"`      — work done; delete the message.
 * - `"ack-drop"` — EXPLICIT drop decision (poison / duplicate / illegal
 *                  transition). Delete the message so it cannot DLQ-loop.
 * - `"fail"`     — transient fault; do NOT delete; the message redelivers
 *                  via visibility timeout and dead-letters per the queue's
 *                  redrive policy.
 *
 * Contract (finding 3 — the silent-drop-of-security-work guard):
 * a `throw` from any worker is ALWAYS treated as `"fail"` (no-ack). There is
 * no "unknown error → ack" branch and there must never be one. A worker that
 * wants a message dropped must RETURN `"ack-drop"`; a worker that is unsure
 * must throw (or return `"fail"`), and the message survives.
 *
 * AWS entrypoints map the same values onto `batchItemFailures`:
 * `fail` → include the messageId; `ack` / `ack-drop` → omit it.
 */
export type WorkerDisposition = "ack" | "fail" | "ack-drop";
