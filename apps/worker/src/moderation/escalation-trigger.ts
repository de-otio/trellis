/**
 * escalation-trigger.ts — firing `axis-a-escalate` from the inline lane.
 *
 * ⚠ EVALUATION SCAFFOLDING (plan 030 / plan 031).
 *
 * ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
 *
 * Plan 031 §2 states the trigger's safety property like this:
 *
 * > **The trigger must be safe to repeat.** The inline lane retries;
 * > `cascade-route` can therefore run more than once for the same job. With the
 * > derived key that is **a no-op at the engine**, which is the property being
 * > relied on.
 *
 * **That is not what the engine does.** Verified against hatchet-lite v0.104.7
 * on 2026-08-23 by firing `runNoWait` twice with the same `input.dedupeKey`:
 * the second call does not no-op and does not return the first run's handle. It
 * **throws**:
 *
 *     IdempotencyCollisionError: idempotency key collision:
 *     existing run cb13c3b3-… already exists
 *
 * The spec asked for exactly this to be tested rather than assumed — "C1 should
 * test the repeat explicitly rather than assuming the engine's dedupe covers
 * it" — and the assumption was wrong in the direction that costs the most.
 *
 * ── WHY THAT WOULD HAVE BEEN A CONTENT-LOSS BUG ────────────────────────────
 *
 * The cascade route runs INSIDE the inline lane, under its 5000 ms deadline. An
 * uncaught throw from `runNoWait` is a throw inside the inline lane, which fails
 * closed to `REVIEW` — a queue nobody drains. So the shape a reasonable person
 * writes, trusting the spec:
 *
 *     if (route.kind === "escalate") await workflow.runNoWait(input);
 *
 * turns *every retry of the inline lane* into the exact silent content loss the
 * deferred lane was built to prevent, and does it only on the retry path, which
 * is the path least likely to be exercised in testing.
 *
 * ── THE ONE THING THIS MODULE DOES ─────────────────────────────────────────
 *
 * Swallow `IdempotencyCollisionError`, and NOTHING else. A collision means the
 * escalation is already running — which is success, not failure, and is the
 * behaviour the spec described even though the mechanism differs. Every other
 * error propagates, because a trigger that swallows broadly is a trigger that
 * silently stops escalating while reporting nothing, and a lane that escalates
 * nothing is indistinguishable from a lane with nothing to escalate.
 */

import { IdempotencyCollisionError } from "@hatchet-dev/typescript-sdk/util/errors/idempotency-collision-error.js";

import type { EscalationInput } from "./escalation-run.js";

/** What the trigger did. Both values are successes; neither is an error. */
export type TriggerOutcome =
  /** A new run was started. */
  | { readonly kind: "started" }
  /** A run for this key already exists — the repeat did its job. */
  | { readonly kind: "already-running"; readonly existingRunId: string };

/** The narrow slice of a workflow handle the trigger needs. */
export interface EscalationWorkflowHandle {
  runNoWait(input: EscalationInput): Promise<unknown>;
}

/**
 * Structural rather than `instanceof`, for the reason
 * `isModerationProviderError` already gives in core: an SDK bundled twice (npm
 * nesting, a linked workspace) produces an error whose prototype chain is a
 * DIFFERENT class object, and an `instanceof` check would silently demote it to
 * the fallback — which here means rethrowing a collision and failing the inline
 * lane. The `instanceof` is kept as the fast path.
 */
export function isIdempotencyCollision(err: unknown): boolean {
  if (err instanceof IdempotencyCollisionError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "IdempotencyCollisionError"
  );
}

/** Pull the existing run id out of a collision, without trusting its shape. */
function existingRunIdOf(err: unknown): string {
  const id = (err as { existingRunExternalId?: unknown }).existingRunExternalId;
  return typeof id === "string" ? id : "";
}

/**
 * Fire the deferred lane for one job.
 *
 * ALWAYS `runNoWait`, never `run`. The cascade route executes inside the inline
 * lane under a 5000 ms deadline; awaiting a 13–20 s workflow from there would
 * convert every escalation into a deadline breach — the exact failure the lane
 * exists to prevent, reintroduced at the trigger.
 *
 * Returns rather than throws for a collision. Throws for everything else.
 */
export async function triggerEscalation(
  workflow: EscalationWorkflowHandle,
  input: EscalationInput,
): Promise<TriggerOutcome> {
  try {
    await workflow.runNoWait(input);
    return { kind: "started" };
  } catch (err) {
    // NOT a broad catch. Exactly one error class is a success in disguise, and
    // it is named. Anything else is a real failure and must reach the caller.
    if (isIdempotencyCollision(err)) {
      return { kind: "already-running", existingRunId: existingRunIdOf(err) };
    }
    throw err;
  }
}
