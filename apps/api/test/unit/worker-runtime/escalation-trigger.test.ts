/**
 * The trigger, and the one error class it is allowed to swallow.
 *
 * Plan 031 §2 says a repeated trigger "is a no-op at the engine". It is not —
 * hatchet-lite v0.104.7 throws `IdempotencyCollisionError` — and because the
 * cascade route runs inside the inline lane under its 5000 ms deadline, an
 * uncaught throw there fails closed to `REVIEW`. That is the content-loss path
 * the deferred lane exists to prevent, reintroduced on the retry path.
 *
 * So the tests that matter are the two directions: a collision must NOT
 * propagate, and everything else MUST.
 */

import { describe, expect, it, vi } from "vitest";

import { IdempotencyCollisionError } from "@hatchet-dev/typescript-sdk/util/errors/idempotency-collision-error.js";

import {
  isIdempotencyCollision,
  triggerEscalation,
  type EscalationWorkflowHandle,
} from "../../../../worker/src/moderation/escalation-trigger.js";
import type { EscalationInput } from "../../../../worker/src/moderation/escalation-run.js";

const INPUT: EscalationInput = {
  jobId: "mock-job-1",
  mediaId: "mock-media-1",
  tenantId: "mock-tenant-1",
  track: "VISUAL",
  contentHash: "mock-hash",
  dedupeKey: "mock-dedupe-key",
  cause: "grey-band",
  confidence: 0.4,
};

function handle(impl: () => Promise<unknown>): EscalationWorkflowHandle {
  return { runNoWait: vi.fn(impl) };
}

describe("triggerEscalation", () => {
  it("reports `started` on a first fire", async () => {
    const h = handle(async () => ({ runId: "r1" }));
    await expect(triggerEscalation(h, INPUT)).resolves.toEqual({ kind: "started" });
  });

  it("REPEATS SAFELY: a collision is a success, not a failure", async () => {
    const h = handle(async () => {
      throw new IdempotencyCollisionError("existing-run-1");
    });
    await expect(triggerEscalation(h, INPUT)).resolves.toEqual({
      kind: "already-running",
      existingRunId: "existing-run-1",
    });
  });

  it("recognises a collision from a SECOND copy of the SDK", async () => {
    // An SDK bundled twice (npm nesting, a linked workspace) produces an error
    // whose prototype chain is a different class object. An `instanceof`-only
    // check would rethrow it — and rethrowing a collision is what fails the
    // inline lane.
    const foreign = Object.assign(new Error("idempotency key collision"), {
      name: "IdempotencyCollisionError",
      existingRunExternalId: "existing-run-2",
    });
    const h = handle(async () => {
      throw foreign;
    });
    await expect(triggerEscalation(h, INPUT)).resolves.toEqual({
      kind: "already-running",
      existingRunId: "existing-run-2",
    });
  });

  it("survives a collision that carries no run id", async () => {
    const h = handle(async () => {
      throw Object.assign(new Error("collision"), { name: "IdempotencyCollisionError" });
    });
    await expect(triggerEscalation(h, INPUT)).resolves.toEqual({
      kind: "already-running",
      existingRunId: "",
    });
  });

  it("NEGATIVE CONTROL: every other error propagates", async () => {
    // Without this, a `catch { return }` would pass every test above while
    // silently disabling escalation for good — a lane that escalates nothing
    // looks exactly like a lane with nothing to escalate.
    for (const err of [
      new Error("engine unreachable"),
      Object.assign(new Error("x"), { name: "UNAVAILABLE" }),
      "a string",
      null,
    ]) {
      const h = handle(async () => {
        throw err;
      });
      await expect(triggerEscalation(h, INPUT)).rejects.toBeDefined();
    }
  });

  it("uses runNoWait — never a blocking run", async () => {
    // Awaiting a 13–20 s workflow from inside the inline lane's 5000 ms
    // deadline would convert every escalation into a deadline breach.
    const h = handle(async () => ({}));
    await triggerEscalation(h, INPUT);
    expect(h.runNoWait).toHaveBeenCalledTimes(1);
    expect(h.runNoWait).toHaveBeenCalledWith(INPUT);
    expect(Object.keys(h)).toEqual(["runNoWait"]);
  });
});

describe("isIdempotencyCollision", () => {
  it("is true for the SDK's own error", () => {
    expect(isIdempotencyCollision(new IdempotencyCollisionError("r"))).toBe(true);
  });

  it("is false for anything else, including near-misses", () => {
    expect(isIdempotencyCollision(new Error("idempotency key collision"))).toBe(false);
    expect(isIdempotencyCollision({ name: "IdempotencyCollision" })).toBe(false);
    expect(isIdempotencyCollision(null)).toBe(false);
    expect(isIdempotencyCollision(undefined)).toBe(false);
    expect(isIdempotencyCollision("IdempotencyCollisionError")).toBe(false);
  });
});
